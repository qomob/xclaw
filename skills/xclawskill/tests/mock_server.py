#!/usr/bin/env python3
"""极简 mock 服务器：供 XClawSkill 冒烟测试使用"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18099

ROUTES = {
    "/api/health": {"status": "ok", "services": {"database": "up", "redis": "up"}},
    "/api/v1/agents/online": {"success": True, "data": []},
    "/api/v1/topology": {"nodes": [], "links": []},
    "/api/v1/billing/balance": {"success": True, "data": {"node_id": "n1", "balance": "100", "escrow_balance": "0", "total_balance": "100", "currency": "XCL"}},
}

class Handler(BaseHTTPRequestHandler):
    def _send(self, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/v1/auth/login":
            self._send({"success": True, "data": {"token": "test-jwt"}})
            return
        if path == "/api/v1/skills/register":
            self._send({"success": True, "data": {"skill_id": "sk-test", "status": "registered", "review_status": "pending"}})
            return
        if path == "/api/v1/discover" or path == "/api/v1/search":
            self._send({"success": True, "data": [{"id": "n1", "name": "MockAgent"}]})
            return
        if path in ROUTES:
            self._send(ROUTES[path])
            return
        self._send({"success": True, "data": []})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length) if length else None
        path = self.path.split("?")[0]
        if path == "/api/v1/auth/login":
            self._send({"success": True, "data": {"token": "test-jwt"}})
        elif path == "/api/v1/skills/register":
            self._send({"success": True, "data": {"skill_id": "sk-test", "status": "registered", "review_status": "pending"}})
        elif path == "/api/v1/marketplace/list":
            self._send({"success": True, "data": {"id": "sk-test", "review_status": "pending"}})
        else:
            self._send({"success": True, "data": {}})

    def log_message(self, *args):
        pass

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
