#!/usr/bin/env python3
"""PERF-0 搜索埋点测量：CDP 驱动一次搜索，导出 __searchPerf 记录 + 原生线程采样。

用法：python scripts/perf0_measure.py [关键词] [最长等待秒] [档位标签]
产物：.tmp/perf0/<标签>-<时间戳>.json（埋点记录）+ 同目录 logcat.txt（SpiderPlugin/DrpyPlugin/searchPerf）
"""
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import websocket

APP_ID = "com.qoder.cinema"
ROOT = Path(__file__).resolve().parent.parent


def adb(*args):
    return subprocess.run(["adb", *args], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()


def cdp(ws_url, method, params=None, msg_id=1):
    ws = websocket.create_connection(ws_url, timeout=20, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == msg_id:
                return msg
    finally:
        ws.close()


def evaluate(ws_url, expr):
    resp = cdp(ws_url, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return resp.get("result", {}).get("result", {}).get("value")


def thread_sample(pid):
    out = adb("shell", "ps", "-T", "-p", pid)
    spider = sum(1 for line in out.splitlines() if "spider-worker" in line)
    drpy = sum(1 for line in out.splitlines() if "drpy-worker" in line)
    return spider, drpy


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else "绝命毒师"
    wait_s = float(sys.argv[2]) if len(sys.argv) > 2 else 55
    tier = sys.argv[3] if len(sys.argv) > 3 else "hot"

    pid = adb("shell", "pidof", APP_ID).split()[0]
    adb("logcat", "-G", "16M")
    adb("forward", "tcp:9222", f"localabstract:webview_devtools_remote_{pid}")
    pages = json.load(urllib.request.urlopen("http://localhost:9222/json/list", timeout=10))
    page = next((p for p in pages if p.get("type") == "page" and p.get("url", "").startswith(("http://localhost", "https://localhost", "capacitor://localhost"))), None)
    if page is None:
        print("找不到 App WebView page target：", json.dumps(pages, ensure_ascii=False)[:500])
        sys.exit(1)
    ws_url = page["webSocketDebuggerUrl"]
    origin = page["url"].split("#")[0].rstrip("/")
    print(f"pid={pid} origin={origin} page={page['url']}")

    before = evaluate(ws_url, "window.__searchPerf ? window.__searchPerf.list().length : -1")
    if before == -1:
        print("window.__searchPerf 不存在——埋点未生效或页面未加载新包")
        sys.exit(2)

    target = f"{origin}/#/search?q={urllib.parse.quote(keyword)}&t={int(time.time())}"
    print("navigate:", target)
    cdp(ws_url, "Page.navigate", {"url": target})

    samples = []
    record = None
    deadline = time.time() + wait_s
    while time.time() < deadline:
        time.sleep(3)
        s, d = thread_sample(pid)
        samples.append({"t": round(time.time() % 1000, 1), "spider_workers": s, "drpy_workers": d})
        try:
            n = evaluate(ws_url, "window.__searchPerf ? window.__searchPerf.list().length : -1")
        except Exception:
            continue  # 整页 reload 期间 devtools target 短暂脱离，容忍瞬时断连
        if isinstance(n, int) and n > before:
            records = evaluate(ws_url, "window.__searchPerf.list()")
            record = records[-1]
            break
    if record is None:
        print(f"{wait_s}s 内未产出埋点记录（搜索可能仍在跑或失败）")

    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = ROOT / ".tmp" / "perf0"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{tier}-{ts}.json"
    payload = {"tier": tier, "keyword": keyword, "threadSamples": samples, "record": record}
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    logcat = adb("logcat", "-d", "-v", "time")
    keep = [line for line in logcat.splitlines() if ("SpiderPlugin" in line or "DrpyPlugin" in line or "searchPerf" in line)]
    (out_dir / f"{tier}-{ts}-logcat.txt").write_text("\n".join(keep), encoding="utf-8")

    print(f"记录：{out_file}")
    if record:
        print(json.dumps({k: v for k, v in record.items() if k != "sources"}, ensure_ascii=False))
        print(f"perSource {len(record['sources'])} 条；线程采样峰值 spider={max((x['spider_workers'] for x in samples), default=0)} drpy={max((x['drpy_workers'] for x in samples), default=0)}")


if __name__ == "__main__":
    main()