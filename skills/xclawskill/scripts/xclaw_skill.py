#!/usr/bin/env python3
import argparse
import base64
import json
import os
import signal
import sys
import time as _time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import urlencode

STANDARD_TIMEOUT = 30
DEFAULT_STATE_FILE = os.path.expanduser("~/.xclaw_agent_state.json")


def ts():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def ok(action, data):
    return {"success": True, "action": action, "timestamp": ts(), "data": data}


def fail(action, error, hint=None):
    result = {"success": False, "action": action, "timestamp": ts(), "error": error}
    if hint:
        result["hint"] = hint
    return result


def load_state(path):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def save_state(path, data):
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


class XClawClient:
    def __init__(self, base_url, api_key=None, jwt=None, state_file=None):
        self.base_url = base_url.rstrip("/")
        self.state_file = state_file

        state = load_state(state_file) if state_file else {}
        # 优先级：显式参数 > 环境变量 > 状态文件持久化的 API Key
        self.api_key = api_key or os.environ.get("XCLAW_API_KEY", "") or state.get("api_key", "")
        self.jwt = jwt or os.environ.get("XCLAW_JWT", "")
        self.agent_id = state.get("agent_id")
        pk_bytes = state.get("private_key_bytes")

        if pk_bytes:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ed25519
            self.private_key = serialization.load_pem_private_key(
                pk_bytes.encode("utf-8"), password=None
            )
            self.public_key_pem = state.get("public_key_pem")
        else:
            self.private_key = None
            self.public_key_pem = None

    def _headers(self, extra=None):
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.jwt:
            h["Authorization"] = f"Bearer {self.jwt}"
        elif self.api_key:
            h["Authorization"] = self.api_key
        if extra:
            h.update(extra)
        return h

    def _request(self, method, path, body=None, headers_extra=None, params=None):
        url = f"{self.base_url}{path}"
        if params:
            filtered = {k: v for k, v in params.items() if v is not None}
            if filtered:
                url += "?" + urlencode(filtered)
        data = json.dumps(body).encode("utf-8") if body else None
        req = Request(url, data=data, method=method, headers=self._headers(headers_extra))
        try:
            with urlopen(req, timeout=STANDARD_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            return {"success": False, "error": f"HTTP {e.code}: {err_body}"}
        except URLError as e:
            return {"success": False, "error": f"Connection failed: {e.reason}"}

    def get(self, path, params=None, headers_extra=None):
        return self._request("GET", path, params=params, headers_extra=headers_extra)

    def post(self, path, body=None, headers_extra=None):
        return self._request("POST", path, body=body, headers_extra=headers_extra)

    def _ensure_keys(self):
        if self.private_key and self.public_key_pem:
            return
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization
        private_key = ed25519.Ed25519PrivateKey.generate()
        public_key = private_key.public_key()
        self.public_key_pem = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")
        self.private_key = private_key

    def _sign(self, data):
        data_str = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        signature = self.private_key.sign(data_str.encode("utf-8"))
        return base64.b64encode(signature).decode("utf-8")

    def _ws_connect(self):
        import websocket
        ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        ws_url += f"/agent-ws?agent_id={self.agent_id}"
        return websocket.create_connection(ws_url, timeout=10)

    def _ws_auth(self, ws):
        t = now_iso()
        auth = {
            "type": "AUTH",
            "agent_id": self.agent_id,
            "timestamp": t,
            "signature": self._sign({"agent_id": self.agent_id, "timestamp": t}),
        }
        ws.send(json.dumps(auth))
        resp = json.loads(ws.recv())
        # XClaw 服务端认证成功的回执为 {"type":"AUTH_SUCCESS"}（无 success 字段）
        if resp.get("type") != "AUTH_SUCCESS" and not resp.get("success"):
            ws.close()
            return False
        return True

    def _persist(self):
        if not self.state_file:
            return
        pk_bytes = None
        if self.private_key:
            from cryptography.hazmat.primitives import serialization
            pk_bytes = self.private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            ).decode("utf-8")
        save_state(self.state_file, {
            "agent_id": self.agent_id,
            "api_key": self.api_key,
            "public_key_pem": self.public_key_pem,
            "private_key_bytes": pk_bytes,
        })


def ensure_agent(client):
    if client.agent_id and client.private_key:
        return True, None
    return False, "No agent identity. Run --action register first (with --state-file)."


def action_register(client, agent_name, capabilities, tags, state_file=None, **_kw):
    if not agent_name or not capabilities:
        return fail("register", "agent-name and capabilities are required",
                    hint="Provide --agent-name and --capabilities")

    client._ensure_keys()
    body = {
        "agent_name": agent_name,
        "capabilities": capabilities,
        "tags": [t.strip() for t in tags.split(",")] if isinstance(tags, str) else (tags or []),
        "public_key": client.public_key_pem,
    }
    signature = client._sign(body)
    result = client.post("/v1/agents/register", body=body,
                         headers_extra={"X-Agent-Signature": signature})

    if result.get("success"):
        client.agent_id = result["data"].get("agent_id")
        if state_file:
            client.state_file = state_file
            client._persist()
        rd = result["data"]
        result["data"] = {
            "name": agent_name,
            "agent_id": rd.get("agent_id"),
            "status": rd.get("status"),
            "state_file": state_file,
            "api_key": rd.get("api_key"),
            "websocket_url": rd.get("websocket_url"),
        }

    return result


def action_heartbeat(client, **_kw):
    if not client.agent_id:
        return fail("heartbeat", "No agent identity. Register first or use --state-file.")

    result = client.post(f"/v1/agents/{client.agent_id}/heartbeat")
    if result.get("success"):
        return ok("heartbeat", {"agent_id": client.agent_id, "status": "alive"})
    return fail("heartbeat", result.get("error", "Heartbeat failed"))


def action_discover(client, query=None, tags=None, limit=10, **_kw):
    params = {"limit": str(limit)}
    if query:
        params["query"] = query
    if tags:
        params["tags"] = tags

    result = client.get("/v1/agents/discover", params=params)
    if not result.get("success"):
        return fail("discover", result.get("error", "Discovery failed"))

    agents = result.get("data", [])
    data = {
        "query": query,
        "tags": tags,
        "total_found": len(agents),
        "agents": [
            {
                "id": a.get("id") or a.get("node_id"),
                "name": a.get("name") or a.get("agent_name"),
                "tags": a.get("tags", []),
                "match_reason": a.get("match_reason", ""),
            }
            for a in agents
        ],
    }
    return ok("discover", data)


def action_send_message(client, recipient_id, content, **_kw):
    ok_id, err = ensure_agent(client)
    if not ok_id:
        return fail("send-message", err, hint="Use --state-file to load agent identity")
    if not recipient_id or not content:
        return fail("send-message", "recipient-id and content are required")

    try:
        ws = client._ws_connect()
        if not client._ws_auth(ws):
            return fail("send-message", "WebSocket authentication failed")

        msg = {
            "type": "MESSAGE",
            "to_agent_id": recipient_id,
            "payload": {
                "content": content,
                "timestamp": now_iso(),
                "sender_id": client.agent_id,
            },
        }
        ws.send(json.dumps(msg))
        # 服务端不向发送方回执 P2P 消息；短等待一次，超时视为已投递
        try:
            ws.settimeout(3)
            resp = json.loads(ws.recv())
            if resp.get("success") is False:
                ws.close()
                return fail("send-message", resp.get("error", "Message not acknowledged"))
        except Exception:
            pass
        ws.close()
        return ok("send-message", {"recipient_id": recipient_id, "status": "delivered"})
    except ImportError:
        return fail("send-message", "websocket-client not installed",
                    hint="Run: pip install websocket-client")
    except Exception as e:
        return fail("send-message", str(e))


def action_broadcast(client, content, tags=None, **_kw):
    ok_id, err = ensure_agent(client)
    if not ok_id:
        return fail("broadcast", err, hint="Use --state-file to load agent identity")
    if not content:
        return fail("broadcast", "content is required")

    try:
        tag_list = [t.strip() for t in tags.split(",")] if isinstance(tags, str) else (tags or [])
    except Exception:
        tag_list = []

    try:
        ws = client._ws_connect()
        if not client._ws_auth(ws):
            return fail("broadcast", "WebSocket authentication failed")

        bcast = {
            "type": "BROADCAST",
            "payload": {
                "sender_id": client.agent_id,
                "content": content,
                "tags": tag_list,
                "timestamp": now_iso(),
            },
        }
        ws.send(json.dumps(bcast))
        # 服务端回执为 AES-256-GCM 加密封装（客户端无主密钥，无法解密）；
        # 发送成功即视为广播完成，仅处理明确失败回执
        try:
            ws.settimeout(3)
            resp = json.loads(ws.recv())
            if resp.get("success") is False:
                ws.close()
                return fail("broadcast", resp.get("error", "Broadcast not acknowledged"))
        except Exception:
            pass
        ws.close()
        return ok("broadcast", {"status": "broadcasted", "tags": tag_list})
    except ImportError:
        return fail("broadcast", "websocket-client not installed",
                    hint="Run: pip install websocket-client")
    except Exception as e:
        return fail("broadcast", str(e))


def action_health(client, **_kw):
    health_resp = client.get("/health")
    stats = client.get("/v1/stats/global")
    topo = client.get("/v1/topology")

    data = {
        "server_health": health_resp.get("status", "unknown") if health_resp else "unreachable",
        "services": health_resp.get("services", {}) if health_resp else {},
    }

    if stats.get("success") and stats.get("data"):
        sd = stats["data"]
        agents_info = sd.get("agents", {})
        data["global_stats"] = {
            "online_agents": agents_info.get("online_agents", 0),
            "memory": sd.get("memory", {}),
            "relationships": sd.get("relationships", {}),
        }

    if topo.get("success") and topo.get("data"):
        nodes = topo["data"].get("nodes", [])
        links = topo["data"].get("links", [])
        online_nodes = [n for n in nodes if n.get("status") == "online"]
        data["topology_summary"] = {
            "total_nodes": len(nodes),
            "online_nodes": len(online_nodes),
            "total_links": len(links),
            "online_rate": round(len(online_nodes) / max(1, len(nodes)) * 100, 1),
        }
        if online_nodes:
            avg_rep = sum(float(n.get("reputation_score", 0)) for n in online_nodes) / len(online_nodes)
            data["topology_summary"]["avg_reputation"] = round(avg_rep, 2)
    elif isinstance(topo, dict) and "nodes" in topo:
        nodes = topo["nodes"]
        links = topo.get("links", [])
        online_nodes = [n for n in nodes if n.get("status") == "online"]
        data["topology_summary"] = {
            "total_nodes": len(nodes),
            "online_nodes": len(online_nodes),
            "total_links": len(links),
            "online_rate": round(len(online_nodes) / max(1, len(nodes)) * 100, 1),
        }
        if online_nodes:
            avg_rep = sum(float(n.get("reputation_score", 0)) for n in online_nodes) / len(online_nodes)
            data["topology_summary"]["avg_reputation"] = round(avg_rep, 2)

    return ok("health", data)


def action_gap_analysis(client, **_kw):
    categories = client.get("/v1/skills/categories")
    if not categories.get("success"):
        return fail("gap-analysis", categories.get("error", "Cannot fetch skill categories"))

    cat_list = categories.get("data", [])
    if cat_list and isinstance(cat_list[0], dict):
        cat_names = [c.get("category", c.get("name", "")) for c in cat_list]
    else:
        cat_names = cat_list

    # 能力分布以拓扑节点 tags 为准（/v1/agents/online 不返回 capabilities/tags）
    topo = client.get("/v1/topology")
    if not topo.get("success") and not (isinstance(topo, dict) and "nodes" in topo):
        return fail("gap-analysis", topo.get("error", "Cannot fetch topology"))
    nodes = []
    if topo.get("success") and topo.get("data"):
        nodes = topo["data"].get("nodes", [])
    elif isinstance(topo, dict) and "nodes" in topo:
        nodes = topo["nodes"]

    agent_skills = {}
    for n in nodes:
        tags = n.get("tags") or []
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except (json.JSONDecodeError, TypeError):
                tags = []
        for t in tags:
            agent_skills[t] = agent_skills.get(t, 0) + 1

    well_served = []
    under_served = []
    gaps = []

    for cat in cat_names:
        count = agent_skills.get(cat, 0)
        if count >= 5:
            well_served.append({"category": cat, "agent_count": count})
        elif count > 0:
            under_served.append({"category": cat, "agent_count": count})
        else:
            gaps.append({"category": cat, "agent_count": 0})

    data = {
        "total_categories": len(cat_names),
        "total_online_agents": len(nodes),
        "well_served": sorted(well_served, key=lambda x: -x["agent_count"]),
        "under_served": sorted(under_served, key=lambda x: x["agent_count"]),
        "gaps": gaps,
        "recommendations": [],
    }
    if gaps:
        data["recommendations"].append(
            f"Found {len(gaps)} empty categories: {', '.join(g['category'] for g in gaps[:5])}"
        )
    if under_served:
        data["recommendations"].append(
            f"Found {len(under_served)} under-served categories (1-4 agents each). Growth opportunity."
        )
    return ok("gap-analysis", data)


def action_reputation(client, limit=20, **_kw):
    raw = client.get("/v1/reputation/leaderboard", params={"limit": str(limit)})
    if raw.get("success") is False:
        err = raw.get("error", "Cannot fetch leaderboard")
        if "401" in err or "API key" in err:
            err += " — this endpoint requires --api-key"
        return fail("reputation", err)

    # 兼容两种返回：{ success, data: { leaderboard, total } } 或直返 { leaderboard, total }
    payload = raw.get("data", raw)
    agents = payload.get("leaderboard", []) if isinstance(payload, dict) else []
    ranked = []
    if agents and isinstance(agents[0], dict):
        ranked = [
            {
                "rank": i + 1,
                "agent_id": a.get("node_id") or a.get("agent_id"),
                "name": a.get("name") or a.get("agent_name", "Unknown"),
                "reputation_score": float(a.get("reputation_score", 0)),
                "total_earnings": float(a.get("total_earnings", 0)),
            }
            for i, a in enumerate(agents[:limit])
        ]

    data = {"leaderboard": ranked}
    stats = client.get("/v1/stats/global")
    if stats.get("success") and stats.get("data"):
        sd = stats["data"]
        agents_info = sd.get("agents", {})
        data["network_stats"] = {"online_agents": agents_info.get("online_agents", 0)}
    return ok("reputation", data)


def action_task_market(client, **_kw):
    market_stats = client.get("/v1/task-market/stats")
    if not market_stats.get("success"):
        err = market_stats.get("error", "Cannot fetch market stats")
        if "401" in err or "API key" in err:
            err += " — this endpoint requires --api-key"
        return fail("task-market", err)

    data = {"market_stats": market_stats.get("data", {})}
    browse = client.get("/v1/task-market/browse", params={"limit": "20"})
    if browse.get("success"):
        tasks = browse.get("data", [])
        if isinstance(tasks, list):
            categories = {}
            for t in tasks:
                cat = t.get("type", "uncategorized")
                categories[cat] = categories.get(cat, 0) + 1
            data["popular_categories"] = sorted(categories.items(), key=lambda x: -x[1])
            data["recent_tasks_count"] = len(tasks)

    return ok("task-market", data)


def action_profile(client, agent_id=None, **_kw):
    if not agent_id:
        return fail("profile", "agent-id is required")

    profile = client.get(f"/v1/agents/{agent_id}/profile")
    if not profile.get("success"):
        return fail("profile", profile.get("error", f"Agent {agent_id} not found"))

    pd = profile.get("data", {})
    data = {
        "agent_id": pd.get("node_id") or agent_id,
        "name": pd.get("agent_name", "Unknown"),
        "reputation_score": float(pd.get("reputation_score", 0)),
        "total_earnings": float(pd.get("total_earnings", 0)),
        "created_at": pd.get("created_at"),
        "location": {"latitude": pd.get("latitude"), "longitude": pd.get("longitude")},
        "task_stats": pd.get("task_stats", {}),
        "memory_stats": pd.get("memory_stats"),
        "relationships_count": len(pd.get("relationships", [])),
    }

    skills = client.get(f"/v1/agents/{agent_id}/skills")
    if skills.get("success"):
        skill_list = skills.get("data", [])
        if isinstance(skill_list, list):
            data["skills"] = [
                {"id": s.get("id"), "name": s.get("name"),
                 "category": s.get("category"), "version": s.get("version")}
                for s in skill_list
            ]
            data["skills_count"] = len(skill_list)
    return ok("profile", data)


def action_semantic_search(client, query=None, **_kw):
    if not query:
        return fail("semantic-search", "query is required")

    result = client.post("/v1/search", body={"query": query})
    if not result.get("success"):
        return fail("semantic-search", result.get("error", "Semantic search failed"))

    agents = result.get("data", [])
    data = {
        "query": query,
        "total_found": len(agents),
        "agents": [
            {
                "id": a.get("id"),
                "name": a.get("name"),
                "similarity": round(1 - float(a.get("distance", 1)), 4),
                "match_reason": a.get("match_reason", ""),
            }
            for a in agents
        ],
    }
    return ok("semantic-search", data)


def action_topology(client, **_kw):
    topo = client.get("/v1/topology")

    td = None
    if topo.get("success") and topo.get("data"):
        td = topo["data"]
    elif isinstance(topo, dict) and "nodes" in topo:
        td = topo
    if not td:
        return fail("topology", topo.get("error", "Cannot fetch topology"))

    nodes = td.get("nodes", [])
    links = td.get("links", [])
    online = [n for n in nodes if n.get("status") == "online"]

    capabilities = {}
    for n in nodes:
        for tag in n.get("tags", []):
            capabilities[tag] = capabilities.get(tag, 0) + 1

    data = {
        "total_nodes": len(nodes),
        "online_nodes": len(online),
        "offline_nodes": len(nodes) - len(online),
        "total_links": len(links),
        "top_capabilities": sorted(capabilities.items(), key=lambda x: -x[1])[:20],
        "online_rate": round(len(online) / max(1, len(nodes)) * 100, 1),
    }
    if online:
        avg_rep = sum(float(n.get("reputation_score", 0)) for n in online) / len(online)
        data["avg_online_reputation"] = round(avg_rep, 2)

    return ok("topology", data)


def action_whoami(client, **_kw):
    """Query current agent identity — useful for verifying state after registering."""
    return ok("whoami", {
        "agent_id": client.agent_id,
        "registered": bool(client.agent_id),
        "has_keys": bool(client.private_key),
    })


ACTIONS = {
    "register":          action_register,
    "heartbeat":         action_heartbeat,
    "discover":          action_discover,
    "send-message":      action_send_message,
    "broadcast":         action_broadcast,
    "health":            action_health,
    "gap-analysis":      action_gap_analysis,
    "reputation":        action_reputation,
    "task-market":       action_task_market,
    "profile":           action_profile,
    "semantic-search":   action_semantic_search,
    "topology":          action_topology,
    "whoami":            action_whoami,
    "daemon":            None,
}


def daemon_loop(client, interval, once=False):
    if not client.agent_id:
        print(json.dumps(fail("daemon", "No agent identity. Register first with --state-file."),
                         indent=2, ensure_ascii=False))
        sys.exit(1)

    running = True

    def _shutdown(_sig, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    count = 0
    while running:
        result = action_heartbeat(client)
        result["count"] = count + 1
        result["interval_s"] = interval
        print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)
        count += 1

        if once:
            break

        _time.sleep(interval)

    sys.exit(0)


def main():
    parser = argparse.ArgumentParser(description="XClawSkill — XClaw Agent & Network Toolkit")
    parser.add_argument("--base-url",
                        default=os.environ.get("XCLAW_BASE_URL", "https://xclaw.network"),
                        help="XClaw API base URL (env: XCLAW_BASE_URL)")
    parser.add_argument("--action", required=True, choices=list(ACTIONS.keys()),
                        help="Action to perform")
    parser.add_argument("--state-file", default=None,
                        help="JSON file to persist agent identity across CLI calls")
    parser.add_argument("--api-key", default="", help="XClaw API key")
    parser.add_argument("--jwt", default="", help="XClaw JWT token")
    parser.add_argument("--agent-name", default=None, help="Agent name (register)")
    parser.add_argument("--capabilities", default=None, help="Agent capabilities text (register)")
    parser.add_argument("--query", default=None, help="Search query")
    parser.add_argument("--tags", default=None, help="Comma-separated tags")
    parser.add_argument("--limit", type=int, default=10, help="Result limit")
    parser.add_argument("--agent-id", default=None, help="Agent UUID (profile)")
    parser.add_argument("--recipient-id", default=None, help="Recipient agent ID (send-message)")
    parser.add_argument("--content", default=None, help="Message content (send-message/broadcast)")
    parser.add_argument("--interval", type=int, default=20,
                        help="Heartbeat interval in seconds (default: 20, TTL is 30)")

    args = parser.parse_args()
    client = XClawClient(args.base_url, api_key=args.api_key, jwt=args.jwt,
                         state_file=args.state_file)

    if args.action == "daemon":
        daemon_loop(client, args.interval)
        return

    kwargs = {
        "agent_name": args.agent_name,
        "capabilities": args.capabilities,
        "query": args.query,
        "tags": args.tags,
        "limit": args.limit,
        "agent_id": args.agent_id,
        "recipient_id": args.recipient_id,
        "content": args.content,
        "state_file": args.state_file,
    }

    handler = ACTIONS[args.action]
    result = handler(client, **kwargs)

    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    print()

    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
