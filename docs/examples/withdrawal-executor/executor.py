#!/usr/bin/env python3
"""XClaw 提现执行器 — 最小参考实现（零第三方依赖）

功能：
  1. 接收 XClaw 派发的提现请求（HMAC 验签 + 幂等去重）
  2. 模拟链上广播（生产请替换 _broadcast() 为真实签名/广播逻辑）
  3. 回调 XClaw（completed / failed，HMAC 签名）

用法：
  # 启动（auto 模式：模拟广播后自动回调 completed）
  python3 executor.py --secret <HMAC密钥> \
      --callback-url http://127.0.0.1:8081/api/v1/payment/withdrawals \
      --auto --port 9090

  # 手动模式：只接收派发并模拟广播，用另一终端手动触发回调
  python3 executor.py --secret <HMAC密钥> --port 9090
  python3 executor.py --secret <HMAC密钥> --manual-callback <withdrawal_id> completed --tx-hash 0xabc
  python3 executor.py --secret <HMAC密钥> --manual-callback <withdrawal_id> failed --error "insufficient gas"

生产落地提示：
  - 私钥签名、链上 RPC 广播：替换 _broadcast() 中的模拟逻辑
  - 建议给回调增加时间戳窗口与重试（XClaw 端仅 executing 状态可回调，天然防重放）
"""
import argparse
import hashlib
import hmac
import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer


class WithdrawalExecutor:
    def __init__(self, secret, callback_url=None, auto=False, delay=2.0):
        self.secret = secret.encode("utf-8")
        self.callback_url = callback_url.rstrip("/") if callback_url else None
        self.auto = auto
        self.delay = delay
        self.seen = set()  # 幂等去重：已处理的 idempotency_key

    # ── 签名 ────────────────────────────────────────────
    def sign(self, raw_body):
        return hmac.new(self.secret, raw_body, hashlib.sha256).hexdigest()

    def verify(self, raw_body, signature):
        if not signature or not signature.startswith("sha256="):
            return False
        expected = self.sign(raw_body)
        return hmac.compare_digest(signature[len("sha256="):], expected)

    # ── 模拟广播（生产替换为真实链上签名+广播）──────────
    def broadcast(self, withdrawal):
        print(f"[executor] SIMULATED broadcast: {withdrawal['chain']} "
              f"{withdrawal['amount']} {withdrawal['currency']} "
              f"-> {withdrawal['to_address']}")
        time.sleep(self.delay)
        digest = hashlib.sha256(withdrawal["withdrawal_id"].encode("utf-8")).hexdigest()
        return f"0xSIM{digest[:58]}"

    # ── 回调 XClaw ──────────────────────────────────────
    def callback(self, withdrawal_id, status, tx_hash=None, error=None):
        if not self.callback_url:
            print(f"[executor] callback-url 未配置，跳过回调 "
                  f"({withdrawal_id} -> {status})")
            return False
        body = json.dumps({
            "status": status,
            "tx_hash": tx_hash,
            "error": error,
        }).encode("utf-8")
        sig = self.sign(body)
        req = urllib.request.Request(
            f"{self.callback_url}/{withdrawal_id}/callback",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-XClaw-Signature": f"sha256={sig}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body_resp = resp.read().decode("utf-8", errors="replace")
                print(f"[executor] callback ok: HTTP {resp.status} {body_resp[:200]}")
                return True
        except Exception as exc:
            print(f"[executor] callback failed: {exc}")
            return False

    # ── 派发处理 ────────────────────────────────────────
    def handle_dispatch(self, raw_body, headers):
        if not self.verify(raw_body, headers.get("X-XClaw-Signature", "")):
            return 401, {"error": "invalid signature"}
        try:
            data = json.loads(raw_body)
        except json.JSONDecodeError:
            return 400, {"error": "invalid JSON"}

        idem = headers.get("X-Idempotency-Key") or data.get("idempotency_key")
        if idem in self.seen:
            return 200, {"accepted": True, "duplicate": True}
        self.seen.add(idem)

        tx_hash = self.broadcast(data)
        if self.auto:
            threading.Thread(
                target=self.callback,
                args=(data["withdrawal_id"], "completed", tx_hash),
                daemon=True,
            ).start()
        return 200, {"accepted": True, "reference": tx_hash}


def make_handler(executor):
    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, code, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            if self.path == "/broadcast":
                code, payload = executor.handle_dispatch(raw, self.headers)
                self._send_json(code, payload)
            else:
                self._send_json(404, {"error": "not found"})

        def do_GET(self):
            if self.path == "/health":
                self._send_json(200, {"status": "ok"})
            else:
                self._send_json(404, {"error": "not found"})

        def log_message(self, fmt, *args):
            print(f"[executor] {self.address_string()} - {fmt % args}")

    return Handler


def main():
    parser = argparse.ArgumentParser(description="XClaw Withdrawal Executor (reference)")
    parser.add_argument("--secret", required=True, help="HMAC 密钥（与 XClaw WITHDRAWAL_EXECUTOR_SECRET 一致）")
    parser.add_argument("--callback-url", default="",
                        help="XClaw 回调基地址，如 http://127.0.0.1:8081/api/v1/payment/withdrawals")
    parser.add_argument("--auto", action="store_true", help="模拟广播后自动回调 completed")
    parser.add_argument("--delay", type=float, default=2.0, help="模拟广播延迟秒")
    parser.add_argument("--port", type=int, default=9090, help="监听端口")
    parser.add_argument("--manual-callback", metavar="WITHDRAWAL_ID", default="",
                        help="手动触发回调的提现 ID（不启动 HTTP 服务）")
    parser.add_argument("--tx-hash", default="", help="手动回调 completed 的 tx_hash")
    parser.add_argument("--error", default="", help="手动回调 failed 的错误信息")
    args = parser.parse_args()

    executor = WithdrawalExecutor(
        secret=args.secret,
        callback_url=args.callback_url,
        auto=args.auto,
        delay=args.delay,
    )

    if args.manual_callback:
        status = "failed" if args.error else "completed"
        ok = executor.callback(args.manual_callback, status,
                               tx_hash=args.tx_hash or None,
                               error=args.error or None)
        sys.exit(0 if ok else 1)

    server = HTTPServer(("0.0.0.0", args.port), make_handler(executor))
    print(f"[executor] listening on :{args.port} "
          f"(auto={args.auto}, callback={executor.callback_url or 'none'})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[executor] shutdown")
        server.shutdown()


if __name__ == "__main__":
    main()

