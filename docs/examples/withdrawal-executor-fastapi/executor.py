#!/usr/bin/env python3
"""XClaw 提现执行器 — FastAPI 生产骨架

功能：HMAC 验签、SQLite 持久化幂等、模拟/真实广播、指数退避重试回调、Prometheus 监控。

运行：
  pip install -r requirements.txt
  EXECUTOR_SECRET=xxx EXECUTOR_CALLBACK_URL=http://127.0.0.1:8081/api/v1/payment/withdrawals \
    uvicorn executor:app --host 0.0.0.0 --port 9090

真实以太坊广播：安装 web3 后设置 EXECUTOR_RPC_URL / EXECUTOR_PRIVATE_KEY，
自动切换为 send_transaction 真实广播（见 broadcast_live）。
"""
import hashlib
import hmac
import json
import os
import sqlite3
import threading
import time
import urllib.request
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

SECRET = os.environ.get("EXECUTOR_SECRET", "").encode("utf-8")
CALLBACK_URL = os.environ.get("EXECUTOR_CALLBACK_URL", "").rstrip("/")
DB_PATH = os.environ.get("EXECUTOR_STATE_FILE", str(Path(__file__).parent / "data" / "state.db"))
RPC_URL = os.environ.get("EXECUTOR_RPC_URL", "")
PRIVATE_KEY = os.environ.get("EXECUTOR_PRIVATE_KEY", "")
MAX_RETRIES = int(os.environ.get("EXECUTOR_CALLBACK_MAX_RETRIES", "5"))
TIMEOUT = int(os.environ.get("EXECUTOR_CALLBACK_TIMEOUT_MS", "15000"))


def _db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS processed (idem TEXT PRIMARY KEY, reference TEXT, at TEXT)")
    return conn


def _sign(raw: bytes) -> str:
    return hmac.new(SECRET, raw, hashlib.sha256).hexdigest()


def _verify(raw: bytes, signature: str) -> bool:
    if not signature or not signature.startswith("sha256="):
        return False
    expected = _sign(raw)
    return hmac.compare_digest(signature[len("sha256="):], expected)


def _is_live() -> bool:
    return bool(RPC_URL and PRIVATE_KEY)


def _broadcast_simulated(withdrawal: dict) -> str:
    print(f"[executor] SIMULATED broadcast: {withdrawal.get('chain')} "
          f"{withdrawal.get('amount')} {withdrawal.get('currency')} "
          f"-> {withdrawal.get('to_address')}")
    digest = hashlib.sha256(str(withdrawal.get("withdrawal_id", "")).encode()).hexdigest()
    return f"0xSIM{digest[:58]}"


def _broadcast_live(withdrawal: dict) -> str:
    """真实以太坊广播（web3.py）。ERC-20 需扩展为合约 transfer。"""
    from web3 import Web3
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        raise RuntimeError("RPC 不可达")
    account = w3.eth.account.from_key(PRIVATE_KEY)
    tx = {
        "to": withdrawal["to_address"],
        "value": w3.to_wei(float(withdrawal["amount"]), "ether"),
        "gas": 21000,
        "nonce": w3.eth.get_transaction_count(account.address),
    }
    tx["gasPrice"] = w3.eth.gas_price
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    return receipt["transactionHash"].hex()


def _broadcast(withdrawal: dict) -> tuple[str, bool]:
    if _is_live():
        return _broadcast_live(withdrawal), False
    return _broadcast_simulated(withdrawal), True


def _callback(withdrawal_id: str, status: str, tx_hash: str | None = None, error: str | None = None) -> bool:
    if not CALLBACK_URL:
        print(f"[executor] callback-url 未配置，跳过回调 ({withdrawal_id} -> {status})")
        return False
    body = json.dumps({"status": status, "tx_hash": tx_hash, "error": error}).encode()
    sig = _sign(body)
    req = urllib.request.Request(
        f"{CALLBACK_URL}/{withdrawal_id}/callback",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-XClaw-Signature": f"sha256={sig}"},
    )
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT / 1000) as resp:
                print(f"[executor] callback ok: HTTP {resp.status}")
                return True
        except Exception as exc:  # noqa: BLE001
            print(f"[executor] callback attempt {attempt}/{MAX_RETRIES} failed: {exc}")
            if attempt < MAX_RETRIES:
                time.sleep(1 * 2 ** (attempt - 1))
    return False


app = FastAPI(title="XClaw Withdrawal Executor")
metrics = {
    "http_requests_total": 0,
    "dispatch_ok": 0,
    "dispatch_duplicate": 0,
    "dispatch_sig_fail": 0,
    "broadcast_ok": 0,
    "broadcast_fail": 0,
    "callback_ok": 0,
    "callback_fail": 0,
}
metrics_lock = threading.Lock()


def _inc(name: str):
    with metrics_lock:
        metrics[name] += 1


@app.post("/broadcast")
async def broadcast(request: Request):
    _inc("http_requests_total")
    raw = await request.body()
    signature = request.headers.get("x-xclaw-signature", "")
    if not _verify(raw, signature):
        _inc("dispatch_sig_fail")
        return JSONResponse({"error": "invalid signature"}, status_code=401)

    data = json.loads(raw)
    idem = request.headers.get("x-idempotency-key") or data.get("idempotency_key")
    conn = _db()
    row = conn.execute("SELECT reference FROM processed WHERE idem = ?", (idem,)).fetchone()
    if row:
        _inc("dispatch_duplicate")
        return {"accepted": True, "duplicate": True, "reference": row[0]}

    try:
        tx_hash, simulated = _broadcast(data)
        conn.execute(
            "INSERT OR REPLACE INTO processed (idem, reference, at) VALUES (?, ?, ?)",
            (idem, tx_hash, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        )
        conn.commit()
        _inc("dispatch_ok")
        _inc("broadcast_ok")

        threading.Thread(
            target=lambda: _inc("callback_ok") if _callback(
                data["withdrawal_id"], "completed", tx_hash=tx_hash
            ) else _inc("callback_fail"),
            daemon=True,
        ).start()
        return {"accepted": True, "reference": tx_hash, "simulated": simulated}
    except Exception as exc:  # noqa: BLE001
        _inc("broadcast_fail")
        return JSONResponse({"accepted": False, "error": str(exc)}, status_code=502)


@app.get("/health")
def health():
    conn = _db()
    processed = conn.execute("SELECT COUNT(*) FROM processed").fetchone()[0]
    return {"status": "ok", "live_broadcast": _is_live(),
            "callback_url": bool(CALLBACK_URL), "processed": processed}


@app.get("/metrics", response_class=PlainTextResponse)
def metrics_endpoint():
    lines = [f"{k} {v}" for k, v in metrics.items()]
    return "\n".join(lines) + "\n"

