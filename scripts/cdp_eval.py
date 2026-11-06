#!/usr/bin/env python3
"""Execute JavaScript in WebView via CDP."""
import json
import sys
import websocket

def execute_js(ws_url, js_code):
    """Execute JavaScript in the WebView."""
    ws = websocket.create_connection(ws_url, origin="https://chrome-devtools-frontend.appspot.com")
    try:
        # Send Runtime.evaluate command
        cmd = {
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": js_code,
                "returnByValue": True
            }
        }
        ws.send(json.dumps(cmd))
        result = json.loads(ws.recv())
        return result.get("result", {}).get("result", {}).get("value")
    finally:
        ws.close()

if __name__ == "__main__":
    ws_url = "ws://localhost:9222/devtools/page/7A23FF4333D1F865AAE2AD69A1E918DF"
    js_code = sys.argv[1] if len(sys.argv) > 1 else "document.title"
    result = execute_js(ws_url, js_code)
    print(result)
