#!/usr/bin/env python3
"""XClawSkill 冒烟测试 mock 服务器。

镜像后端（backend/gateway/api.js + authService）的鉴权语义，防止客户端与服务端
鉴权协议漂移时冒烟测试仍然误绿：
  - requireAuth      ：`Authorization: Bearer <JWT>` 或 `X-API-KEY: <agent key>`
  - verifyApiKeyOrAgent：系统 Key（裸 Authorization）先行，否则回退 requireAuth 语义
  - 裸 Authorization 携带 Agent Key（历史客户端 bug）必须 401
  - 注册验签：Ed25519，签名材料 "{timestamp}:{body}"，时间戳窗口 5 分钟
"""
import base64
import json
import sys
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18099

SYSTEM_KEY = "sys_test_key"
AGENT_ID = "550e8400-e29b-41d4-a716-446655440000"
TASK_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
BID_ID = "b7c9e262-5f6e-4a3b-8a1d-2c4e6f8a9b01"

AGENT_KEYS = {"ak_test": AGENT_ID}  # api_key -> agent_id（register 会复用 ak_test）
SIG_WINDOW_MS = 300000

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519
    HAVE_CRYPTO = True
except ImportError:
    HAVE_CRYPTO = False


def make_token(agent_id, ttl=3600):
    payload = base64.urlsafe_b64encode(
        json.dumps({"agent_id": agent_id, "exp": int(time.time()) + ttl}).encode()
    ).decode().rstrip("=")
    return f"mock.{payload}.sig"


def token_agent(token):
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        if int(data.get("exp", 0)) < time.time():
            return None
        return data.get("agent_id")
    except Exception:
        return None


def authenticate(headers):
    """镜像后端 authMiddleware：Bearer JWT 或 X-API-KEY；裸 Authorization 仅系统 Key"""
    auth = headers.get("Authorization") or ""
    if auth.startswith("Bearer "):
        agent = token_agent(auth[7:])
        return (agent, None) if agent else (None, 401)
    xkey = headers.get("X-API-KEY")
    if xkey:
        agent = AGENT_KEYS.get(xkey)
        return (agent, None) if agent else (None, 401)
    if auth == SYSTEM_KEY:
        return "system", None
    # 包含裸 Authorization 携带 ak_ Agent Key 的情况：后端同样拒绝
    return None, 401


def authenticate_admin_or_agent(headers):
    """镜像 verifyApiKeyOrAgent：系统 Key 直接放行（isAdmin），否则走 authMiddleware"""
    if (headers.get("Authorization") or "") == SYSTEM_KEY:
        return "system", None
    return authenticate(headers)


def ts_fresh_ms(ts):
    try:
        t = int(ts.strip()) if ts.strip().isdigit() else None
        if t is None:
            t = int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return False
    return abs(time.time() * 1000 - t) <= SIG_WINDOW_MS


def verify_register_signature(headers, body):
    """镜像后端 registerNode：旧格式（仅 body）兼容但已废弃；新格式校验时间戳窗口"""
    sig = headers.get("X-Agent-Signature")
    if not sig:
        return False, "缺少签名"
    ts = headers.get("X-Agent-Timestamp")
    if ts is not None and not ts_fresh_ms(ts):
        return False, "签名时间戳过期或无效"
    if not HAVE_CRYPTO:
        return True, None  # 无 cryptography 时降级为仅校验头存在
    data_str = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    if ts is not None:
        data_str = f"{ts}:{data_str}"
    try:
        pk = serialization.load_pem_public_key(body.get("public_key", "").encode())
        pk.verify(base64.b64decode(sig), data_str.encode("utf-8"))
        return True, None
    except Exception:
        return False, "签名验证失败"


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, data, status=200):
        self._send({"success": True, "data": data}, status)

    def _authed(self, admin_or_agent=False):
        """返回已认证 agent_id；失败时直接回 401 并返回 None"""
        fn = authenticate_admin_or_agent if admin_or_agent else authenticate
        agent, err = fn(self.headers)
        if err:
            self._send({"success": False, "error": "Unauthorized"}, err)
            return None
        return agent

    def _own_node(self, agent):
        """镜像 requireOwnNode：body.node_id 必须等于认证主体"""
        body = self._body()
        if body.get("node_id") != agent:
            self._send({"success": False, "error": "无权操作该节点"}, 403)
            return None
        return body

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}

    # ── GET ──────────────────────────────────────────────────────────────
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            self._send({"status": "ok", "services": {"database": "up", "redis": "up"}})
        elif path == "/api/v1/topology":
            # 后端 /v1/topology 无 success 包装，保持一致
            self._send({"nodes": [{"id": AGENT_ID, "status": "online", "tags": ["AI"],
                                   "reputation_score": 5}],
                        "links": []})
        elif path == "/api/v1/agents/online":
            self._ok([{"id": AGENT_ID, "name": "MockAgent"}])
        elif path == "/api/v1/agents/discover" or path == "/api/v1/agents/search":
            self._ok([{"id": AGENT_ID, "name": "MockAgent", "tags": ["AI"],
                       "match_reason": "tag"}])
        elif path == "/api/v1/search":
            self._ok([{"id": AGENT_ID, "name": "MockAgent", "distance": 0.2}])
        elif path == "/api/v1/skills/categories":
            self._ok(["general", "nlp", "data"])
        elif path == "/api/v1/stats/global":
            self._ok({"agents": {"online_agents": 1}, "memory": {}, "relationships": {}})
        elif path == "/api/v1/reputation/leaderboard":
            if self._authed(admin_or_agent=True):
                self._ok({"leaderboard": [{"node_id": AGENT_ID, "agent_name": "MockAgent",
                                           "reputation_score": "5", "total_earnings": "0"}],
                          "total": 1})
        elif path == "/api/v1/task-market/stats":
            if self._authed(admin_or_agent=True):
                self._ok({"published_count": 1, "completion_rate": 100,
                          "avg_budget": 10, "active_bids": 0})
        elif path == "/api/v1/task-market/browse":
            if self._authed(admin_or_agent=True):
                self._ok([{"id": TASK_ID, "type": "general", "title": "mock task"}])
        elif path == "/api/v1/billing/balance":
            agent = self._authed()
            if agent:
                self._ok({"node_id": agent, "balance": "100", "escrow_balance": "0",
                          "total_balance": "100", "currency": "XCL"})
        elif path == f"/api/v1/agents/{AGENT_ID}/profile":
            self._ok({"node_id": AGENT_ID, "agent_name": "MockAgent",
                      "reputation_score": 5, "total_earnings": 0,
                      "task_stats": {}, "relationships": []})
        elif path == f"/api/v1/agents/{AGENT_ID}/skills":
            self._ok([{"id": "sk-1", "name": "mock", "category": "general",
                       "version": "1.0.0"}])
        else:
            self._send({"success": False, "error": f"mock 未实现该路由: {path}"}, 404)

    # ── POST ─────────────────────────────────────────────────────────────
    def do_POST(self):
        path = self.path.split("?")[0]

        if path == "/api/v1/agents/register":
            body = self._body()
            valid, err = verify_register_signature(self.headers, body)
            if not valid:
                self._send({"success": False, "error": err}, 401)
                return
            self._ok({"agent_id": AGENT_ID, "status": "registered",
                      "api_key": "ak_test",
                      "websocket_url": "ws://127.0.0.1/agent-ws"})
        elif path == "/api/v1/auth/login":
            body = self._body()
            agent = AGENT_KEYS.get(body.get("api_key"))
            if not agent:
                self._send({"success": False, "error": "无效的 API Key"}, 401)
            else:
                self._ok({"token": make_token(agent), "agent_id": agent})
        elif path == "/api/v1/skills/register":
            # 后端 2026-08 起对该端点启用 requireAuth——裸 Agent Key 必须被拒
            if self._authed() is None:
                return
            self._ok({"skill_id": "sk-test", "status": "registered",
                      "review_status": "pending", "scan_verdict": "clean",
                      "scan_flags": []})
        elif path == "/api/v1/marketplace/list":
            if self._authed() is None:
                return
            self._ok({"review_status": "pending"})
        elif path == "/api/v1/marketplace/delist":
            if self._authed() is None:
                return
            self._ok({"delisted": True})
        elif path == "/api/v1/task-market/tasks":
            if self._authed() is None:
                return
            self._ok({"task_id": TASK_ID, "escrow_amount": 10, "escrow_status": "held"},
                     status=201)
        elif path == f"/api/v1/task-market/tasks/{TASK_ID}/bids":
            if self._authed() is None:
                return
            self._ok({"bid_id": BID_ID, "proposed_price": self._body().get("proposed_price")},
                     status=201)
        elif path == f"/api/v1/task-market/tasks/{TASK_ID}/bids/{BID_ID}/accept":
            if self._authed() is None:
                return
            self._ok({"winner_id": AGENT_ID, "price": 8})
        elif path == f"/api/v1/task-market/tasks/{TASK_ID}/complete":
            if self._authed() is None:
                return
            self._ok({"status": "submitted", "verification_deadline": None})
        elif path == f"/api/v1/task-market/tasks/{TASK_ID}/accept":
            if self._authed() is None:
                return
            self._ok({"status": "completed", "released_amount": 8})
        elif path == f"/api/v1/task-market/tasks/{TASK_ID}/reject":
            if self._authed() is None:
                return
            self._ok({"status": "disputed", "dispute_id": "dp-1"})
        elif path == f"/api/v1/task-market/tasks/{TASK_ID}/cancel":
            if self._authed() is None:
                return
            self._ok({"task_id": TASK_ID, "status": "cancelled", "escrow_refunded": True})
        elif path == "/api/v1/payment/withdraw":
            agent = self._authed()
            if agent is None:
                return
            body = self._own_node(agent)
            if body is not None:
                self._ok({"id": "tx-1", "status": "pending", "amount": body.get("amount"),
                          "currency": body.get("currency"), "to_address": body.get("to_address")})
        elif path == f"/api/v1/agents/{AGENT_ID}/heartbeat":
            self._ok({"status": "alive"})
        else:
            self._send({"success": False, "error": f"mock 未实现该路由: {path}"}, 404)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
