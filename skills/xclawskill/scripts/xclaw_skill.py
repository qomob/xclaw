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
CONFIG_FILE = os.path.expanduser("~/.xclaw/config.json")
VERSION = "1.3.0"


def load_config():
    """加载 ~/.xclaw/config.json（setup 写入的默认配置）"""
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except (json.JSONDecodeError, IOError):
        pass
    return {}


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def render_table(data):
    """列表型结果的简单表格输出（--format table）"""
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        return None
    keys = list(data[0].keys())[:8]
    rows = [[str(r.get(k, ""))[:36] for k in keys] for r in data[:30]]
    widths = [len(h) for h in keys]
    for r in rows:
        for i, v in enumerate(r):
            widths[i] = max(widths[i], len(v))
    def fmt(row):
        return "  ".join(v.ljust(widths[i]) for i, v in enumerate(row))
    lines = [fmt(keys), "-" * (sum(widths) + 2 * (len(widths) - 1))]
    lines += [fmt(r) for r in rows]
    return "\n".join(lines)


def _encrypt_secret(plain: str) -> str:
    from cryptography.fernet import Fernet
    key = Fernet.generate_key()
    token = Fernet(key).encrypt(plain.encode("utf-8")).decode("utf-8")
    # 密钥与密文一起保存（passphrase 仅作混淆层；真正安全需外部 KMS）
    return json.dumps({"v": 1, "key": key.decode("utf-8"), "data": token})


def _decrypt_secret(payload: str) -> str:
    from cryptography.fernet import Fernet
    obj = json.loads(payload)
    return Fernet(obj["key"].encode("utf-8")).decrypt(obj["data"].encode("utf-8")).decode("utf-8")


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
    try:
        os.chmod(path, 0o600)  # 凭据文件仅当前用户可读写
    except OSError:
        pass


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
        if pk_bytes and pk_bytes.startswith("{") and os.environ.get("XCLAW_STATE_PASSPHRASE"):
            try:
                pk_bytes = _decrypt_secret(pk_bytes)
            except Exception:
                pk_bytes = None

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
        base = self.base_url.rstrip("/")
        if base.endswith("/api"):
            base = base[:-4]
        ws_url = base.replace("http://", "ws://").replace("https://", "wss://")
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
        payload_pk = pk_bytes
        if pk_bytes and os.environ.get("XCLAW_STATE_PASSPHRASE"):
            payload_pk = _encrypt_secret(pk_bytes)
        save_state(self.state_file, {
            "agent_id": self.agent_id,
            "api_key": self.api_key,
            "jwt": self.jwt,
            "public_key_pem": self.public_key_pem,
            "private_key_bytes": payload_pk,
        })

    def _ensure_jwt(self):
        """需要 Agent 级鉴权的操作自动用 API Key 换取 JWT（缓存到实例与状态文件）"""
        if self.jwt:
            return True
        if not self.api_key:
            return False
        resp = self.post("/v1/auth/login", body={"api_key": self.api_key})
        if resp.get("success") and resp.get("data", {}).get("token"):
            self.jwt = resp["data"]["token"]
            self._persist()
            return True
        return False


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
        # 注册响应中的 API Key 写入客户端并持久化（后续自动换取 JWT）
        client.api_key = result["data"].get("api_key") or client.api_key
        if state_file:
            client.state_file = state_file
            client._persist()
        # 注册即就绪：自动用 API Key 换取 JWT（持久化到状态文件，后续验收/提交免登录）
        client._ensure_jwt()
        rd = result["data"]
        result["data"] = {
            "name": agent_name,
            "agent_id": rd.get("agent_id"),
            "status": rd.get("status"),
            "state_file": state_file,
            "api_key": rd.get("api_key"),
            "websocket_url": rd.get("websocket_url"),
            "jwt_ready": bool(client.jwt),
            "security": {
                "notice": "API Key 仅本次显示，请妥善保存；身份已保存到 state-file（权限 0600，"
                          "设置 XCLAW_STATE_PASSPHRASE 可加密），请勿分享或提交到仓库。",
            },
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
        "has_jwt": bool(client.jwt),
    })


def action_submit_result(client, task_id=None, result=None, **_kw):
    """执行方提交任务结果（进入调用方验收窗口）"""
    if not task_id:
        return fail("submit-result", "task-id is required")
    if not result:
        return fail("submit-result", "result is required（JSON 字符串，如 '{\"output\": \"done\"}'）")
    if not client._ensure_jwt():
        return fail("submit-result", "需要 API Key 换取 JWT（--api-key 或状态文件）")
    try:
        payload = json.loads(result)
    except (json.JSONDecodeError, TypeError):
        return fail("submit-result", "result 不是合法 JSON")

    resp = client.post(f"/v1/task-market/tasks/{task_id}/complete", body={"result": payload})
    if not resp.get("success"):
        return fail("submit-result", resp.get("error", "提交失败"))
    data = resp.get("data", {})
    return ok("submit-result", {
        "task_id": task_id,
        "status": data.get("status", "submitted"),
        "verification_deadline": data.get("verification_deadline"),
    })


def action_accept_result(client, task_id=None, **_kw):
    """调用方验收执行结果（释放托管给执行方）"""
    if not task_id:
        return fail("accept-result", "task-id is required")
    if not client._ensure_jwt():
        return fail("accept-result", "需要 API Key 换取 JWT（--api-key 或状态文件）")
    resp = client.post(f"/v1/task-market/tasks/{task_id}/accept")
    if not resp.get("success"):
        return fail("accept-result", resp.get("error", "验收失败"))
    data = resp.get("data", {})
    return ok("accept-result", {
        "task_id": task_id,
        "status": data.get("status"),
        "released_amount": data.get("released_amount"),
    })


def action_reject_result(client, task_id=None, reason=None, **_kw):
    """调用方拒绝执行结果（进入争议，资金继续托管）"""
    if not task_id:
        return fail("reject-result", "task-id is required")
    if not reason:
        return fail("reject-result", "reason is required")
    if not client._ensure_jwt():
        return fail("reject-result", "需要 API Key 换取 JWT（--api-key 或状态文件）")
    resp = client.post(f"/v1/task-market/tasks/{task_id}/reject", body={"reason": reason})
    if not resp.get("success"):
        return fail("reject-result", resp.get("error", "拒绝失败"))
    data = resp.get("data", {})
    return ok("reject-result", {
        "task_id": task_id,
        "status": data.get("status", "disputed"),
        "dispute_id": data.get("dispute_id"),
    })


def action_verify(client, **_kw):
    """端到端连通性自检：健康、拓扑、在线节点、认证、延迟"""
    start = _time.time()
    health = client.get("/health")
    topo = client.get("/v1/topology")
    online = client.get("/v1/agents/online")
    elapsed_ms = int((_time.time() - start) * 1000)

    nodes = 0
    online_count = 0
    if topo.get("success") and topo.get("data"):
        nodes = len(topo["data"].get("nodes", []))
    elif isinstance(topo, dict) and "nodes" in topo:
        nodes = len(topo["nodes"])
    if online.get("success") and isinstance(online.get("data"), list):
        online_count = len(online["data"])

    auth_status = "not_configured"
    if client.api_key:
        if str(client.api_key).startswith("ak_"):
            # Agent Key：尝试登录换取 JWT 验证认证链路
            auth_status = "ok" if client._ensure_jwt() else "failed"
        else:
            # 系统级 Key：无需 JWT（用于 leaderboard / task-market 等端点）
            auth_status = "system_key"

    data = {
        "base_url": client.base_url,
        "server_health": health.get("status", "unreachable") if health else "unreachable",
        "services": health.get("services", {}) if health else {},
        "topology_nodes": nodes,
        "online_agents": online_count,
        "authentication": auth_status,
        "total_latency_ms": elapsed_ms,
        # /v1/topology 直接返回 { nodes, links }（无 success 包装），两种结构都视为可达
        "ok": bool(
            health and health.get("status") == "ok"
            and isinstance(topo, dict) and "nodes" in topo
        ),
    }
    return ok("verify", data)


def action_create_task(client, title=None, description=None, budget_min=None, budget_max=None,
                       assignment_strategy=None, skill_id=None, deadline=None, **_kw):
    """调用方创建市场任务（创建即冻结预算到托管）"""
    if not title:
        return fail("create-task", "title is required")
    if not client._ensure_jwt():
        return fail("create-task", "需要 API Key 换取 JWT（--api-key 或状态文件）")

    body = {
        "title": title,
        "description": description or "",
        "budget_min": float(budget_min) if budget_min is not None else None,
        "budget_max": float(budget_max) if budget_max is not None else None,
        "assignment_strategy": assignment_strategy or "auto",
        "skill_id": skill_id,
        "deadline": deadline,
    }
    body = {k: v for k, v in body.items() if v is not None}

    resp = client.post("/v1/task-market/tasks", body=body)
    if not resp.get("success"):
        return fail("create-task", resp.get("error", "创建任务失败"))
    data = resp.get("data", {})
    return ok("create-task", {
        "task_id": data.get("task_id"),
        "escrow_amount": data.get("escrow_amount"),
        "escrow_status": data.get("escrow_status"),
    })


def action_submit_bid(client, task_id=None, price=None, proposal=None, **_kw):
    """执行方对任务出价竞标"""
    if not task_id or price is None:
        return fail("submit-bid", "task-id and price are required")
    if not client._ensure_jwt():
        return fail("submit-bid", "需要 API Key 换取 JWT（--api-key 或状态文件）")

    resp = client.post(f"/v1/task-market/tasks/{task_id}/bids", body={
        "proposed_price": float(price),
        "proposal": proposal or "",
    })
    if not resp.get("success"):
        return fail("submit-bid", resp.get("error", "出价失败"))
    data = resp.get("data", {})
    return ok("submit-bid", {
        "task_id": task_id,
        "bid_id": data.get("bid_id") or data.get("id"),
        "proposed_price": float(price),
    })


def action_accept_bid(client, task_id=None, bid_id=None, **_kw):
    """调用方接受竞标（按中标价调整托管并派活给执行方）"""
    if not task_id or not bid_id:
        return fail("accept-bid", "task-id and bid-id are required")
    if not client._ensure_jwt():
        return fail("accept-bid", "需要 API Key 换取 JWT（--api-key 或状态文件）")

    resp = client.post(f"/v1/task-market/tasks/{task_id}/bids/{bid_id}/accept")
    if not resp.get("success"):
        return fail("accept-bid", resp.get("error", "接受竞标失败"))
    data = resp.get("data", {})
    return ok("accept-bid", {
        "task_id": task_id,
        "winner_id": data.get("winner_id"),
        "price": data.get("price"),
    })


def action_setup(client, agent_name=None, capabilities=None, tags=None, **_kw):
    """初始化配置：写入干净的默认配置（仅管理我们自己的键，不合并历史身份/密钥）"""
    cfg = {
        "base_url": client.base_url,
        "agent_name": agent_name or "",
        "capabilities": capabilities or "",
        "tags": tags or "",
    }
    save_config(cfg)
    return ok("setup", {"config_file": CONFIG_FILE, "config": cfg})


def action_version(client, **_kw):
    return ok("version", {"version": VERSION, "config_file": CONFIG_FILE})


def action_register_skill(client, skill_name=None, description=None, category=None,
                          skill_version=None, **_kw):
    """注册技能（创建技能记录，需先 register 得到 Agent 身份）"""
    if not skill_name or not description or not category:
        return fail("register-skill", "skill-name / description / category 必填")
    if not client.agent_id:
        return fail("register-skill", "需要 Agent 身份，请先运行 register（--state-file）")
    resp = client.post("/v1/skills/register", body={
        "name": skill_name,
        "description": description,
        "category": category,
        "version": skill_version or "1.0.0",
        "node_id": client.agent_id,
    })
    if not resp.get("success"):
        return fail("register-skill", resp.get("error", "注册失败"))
    return ok("register-skill", {
        "skill_id": resp["data"].get("skill_id"),
        "status": resp["data"].get("status", "registered"),
        "review_status": resp["data"].get("review_status", "pending"),
        "scan_verdict": resp["data"].get("scan_verdict", "unknown"),
        "scan_flags": resp["data"].get("scan_flags", []),
        "scan_note": resp["data"].get("scan_note"),
    })


def action_list_skill(client, skill_id=None, price=None, **_kw):
    """上架技能到市场并定价（上架后进入平台审核）"""
    if not skill_id or price is None:
        return fail("list-skill", "skill-id 与 price 必填")
    if not client._ensure_jwt():
        return fail("list-skill", "需要 API Key 换取 JWT（--api-key 或状态文件）")
    resp = client.post("/v1/marketplace/list", body={
        "skill_id": skill_id,
        "price": float(price),
    })
    if not resp.get("success"):
        return fail("list-skill", resp.get("error", "上架失败"))
    return ok("list-skill", {
        "skill_id": skill_id,
        "price": float(price),
        "review_status": resp["data"].get("review_status", resp.get("data", {}).get("status", "pending")),
    })


def action_delist_skill(client, skill_id=None, **_kw):
    """下架技能"""
    if not skill_id:
        return fail("delist-skill", "skill-id 必填")
    if not client._ensure_jwt():
        return fail("delist-skill", "需要 API Key 换取 JWT")
    resp = client.post("/v1/marketplace/delist", body={"skill_id": skill_id})
    if not resp.get("success"):
        return fail("delist-skill", resp.get("error", "下架失败"))
    return ok("delist-skill", {"skill_id": skill_id, "delisted": True})


def action_balance(client, **_kw):
    """查询当前 Agent 的余额与托管余额"""
    if not client._ensure_jwt():
        return fail("balance", "需要 API Key 换取 JWT")
    resp = client.get("/v1/billing/balance")
    if not resp.get("success"):
        return fail("balance", resp.get("error", "查询失败"))
    d = resp.get("data", {})
    return ok("balance", {
        "node_id": d.get("node_id"),
        "balance": float(d.get("balance") or 0),
        "escrow_balance": float(d.get("escrow_balance") or 0),
        "total_balance": float(d.get("total_balance") or 0),
        "currency": d.get("currency", "XCL"),
    })


def action_withdraw(client, to_address=None, amount=None, chain=None, currency=None, **_kw):
    """发起链上提现（需余额；真实广播由平台执行器处理）"""
    if not to_address or amount is None:
        return fail("withdraw", "to-address 与 amount 必填")
    if not client._ensure_jwt():
        return fail("withdraw", "需要 API Key 换取 JWT")
    cfg = load_config()
    resp = client.post("/v1/payment/withdraw", body={
        "node_id": client.agent_id,
        "chain": chain or cfg.get("chain", "ethereum"),
        "to_address": to_address,
        "amount": float(amount),
        "currency": currency or cfg.get("currency", "ETH"),
    })
    if not resp.get("success"):
        return fail("withdraw", resp.get("error", "提现失败"))
    d = resp.get("data", {})
    return ok("withdraw", {
        "withdrawal_id": d.get("id"),
        "status": d.get("status"),
        "amount": d.get("amount"),
        "currency": d.get("currency"),
        "to_address": d.get("to_address"),
    })


def action_self_upgrade(client, **_kw):
    """一键升级：从 GitHub 拉取最新版本（仅限 git 安装）"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)
    if not os.path.isdir(os.path.join(repo_root, ".git")):
        return fail("self-upgrade", "非 git 安装，请重新运行 install.sh 安装最新版",
                    hint="curl -fsSL https://raw.githubusercontent.com/qomob/xclawskill/main/install.sh | bash")
    import subprocess
    try:
        subprocess.run(["git", "-C", repo_root, "pull", "--ff-only"], check=True, capture_output=True)
        return ok("self-upgrade", {"message": "已升级到最新版，重新运行 xclaw-skill --version 确认"})
    except Exception as e:
        return fail("self-upgrade", f"升级失败: {e}")


ACTIONS = {
    "register":          action_register,
    "setup":             action_setup,
    "version":           action_version,
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
    "submit-result":     action_submit_result,
    "accept-result":     action_accept_result,
    "reject-result":     action_reject_result,
    "create-task":       action_create_task,
    "submit-bid":        action_submit_bid,
    "accept-bid":        action_accept_bid,
    "register-skill":    action_register_skill,
    "list-skill":        action_list_skill,
    "delist-skill":      action_delist_skill,
    "balance":           action_balance,
    "withdraw":          action_withdraw,
    "self-upgrade":      action_self_upgrade,
    "verify":            action_verify,
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
    fail_streak = 0
    while running:
        try:
            result = action_heartbeat(client)
            result["count"] = count + 1
            result["interval_s"] = interval
            print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)
            fail_streak = 0 if result.get("success") else fail_streak + 1
            count += 1
            if once:
                break
        except Exception as e:
            fail_streak += 1
            print(json.dumps(fail("daemon", f"heartbeat error: {e}"), ensure_ascii=False), flush=True)
        # 指数退避：连续失败时逐步拉长间隔（上限 5 分钟），避免打爆限流
        delay = interval if fail_streak == 0 else min(interval * (2 ** min(fail_streak, 5)), 300)
        _time.sleep(delay)

    sys.exit(0)


def main():
    cfg = load_config()
    parser = argparse.ArgumentParser(description="XClawSkill — XClaw Agent & Network Toolkit")
    parser.add_argument("--version", action="store_true", help="Show version and exit")
    parser.add_argument("--format", choices=["json", "table"], default="json",
                        help="Output format (default: json)")
    parser.add_argument("--base-url",
                        default=os.environ.get("XCLAW_BASE_URL", cfg.get("base_url", "https://xclaw.network/api")),
                        help="XClaw API base URL (env: XCLAW_BASE_URL)")
    parser.add_argument("--action", default=None, choices=list(ACTIONS.keys()),
                        help="Action to perform")
    parser.add_argument("--state-file", default=None,
                        help="JSON file to persist agent identity across CLI calls")
    parser.add_argument("--api-key", default="", help="XClaw API key")
    parser.add_argument("--jwt", default="", help="XClaw JWT token")
    parser.add_argument("--agent-name", default=cfg.get("agent_name"), help="Agent name (register)")
    parser.add_argument("--capabilities", default=cfg.get("capabilities"), help="Agent capabilities text (register)")
    parser.add_argument("--query", default=None, help="Search query")
    parser.add_argument("--tags", default=cfg.get("tags"), help="Comma-separated tags")
    parser.add_argument("--limit", type=int, default=10, help="Result limit")
    parser.add_argument("--agent-id", default=None, help="Agent UUID (profile)")
    parser.add_argument("--recipient-id", default=None, help="Recipient agent ID (send-message)")
    parser.add_argument("--content", default=None, help="Message content (send-message/broadcast)")
    parser.add_argument("--task-id", default=None, help="Task UUID (submit-result/accept-result/reject-result)")
    parser.add_argument("--result", default=None, help="Task result JSON string (submit-result)")
    parser.add_argument("--reason", default=None, help="Reject reason (reject-result)")
    parser.add_argument("--title", default=None, help="Task title (create-task)")
    parser.add_argument("--description", default=None, help="Task description (create-task)")
    parser.add_argument("--budget-min", type=float, default=None, help="Minimum budget (create-task)")
    parser.add_argument("--budget-max", type=float, default=None, help="Maximum budget (create-task, escrowed)")
    parser.add_argument("--assignment-strategy", default=None,
                        help="auto / bid / direct (create-task)")
    parser.add_argument("--skill-id", default=None, help="Required skill UUID (create-task)")
    parser.add_argument("--deadline", default=None, help="ISO deadline (create-task)")
    parser.add_argument("--price", type=float, default=None, help="Bid price (submit-bid)")
    parser.add_argument("--proposal", default=None, help="Bid proposal text (submit-bid)")
    parser.add_argument("--bid-id", default=None, help="Bid UUID (accept-bid)")
    parser.add_argument("--skill-name", default=None, help="Skill name (register-skill)")
    parser.add_argument("--skill-version", default=None, help="Skill version (register-skill)")
    parser.add_argument("--category", default=None, help="Skill category (register-skill)")
    parser.add_argument("--to-address", default=None, help="Withdraw destination address")
    parser.add_argument("--amount", type=float, default=None, help="Withdraw amount")
    parser.add_argument("--chain", default=None, help="Withdraw chain (default ethereum)")
    parser.add_argument("--currency", default=None, help="Withdraw currency (default ETH)")
    parser.add_argument("--interval", type=int, default=20,
                        help="Heartbeat interval in seconds (default: 20, TTL is 30)")

    args = parser.parse_args()
    if args.version:
        print(VERSION)
        sys.exit(0)
    if not args.action:
        parser.print_help()
        sys.exit(2)
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
        "task_id": args.task_id,
        "result": args.result,
        "reason": args.reason,
        "title": args.title,
        "description": args.description,
        "budget_min": args.budget_min,
        "budget_max": args.budget_max,
        "assignment_strategy": args.assignment_strategy,
        "skill_id": args.skill_id,
        "deadline": args.deadline,
        "price": args.price,
        "proposal": args.proposal,
        "bid_id": args.bid_id,
        "skill_name": args.skill_name,
        "skill_version": args.skill_version,
        "category": args.category,
        "to_address": args.to_address,
        "amount": args.amount,
        "chain": args.chain,
        "currency": args.currency,
        "state_file": args.state_file,
    }

    handler = ACTIONS[args.action]
    result = handler(client, **kwargs)

    if args.format == "table":
        table = render_table(result.get("data"))
        if table:
            print(table)
        else:
            json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
            print()
    else:
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        print()

    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
