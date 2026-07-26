#!/usr/bin/env python3
"""Small update feed kept outside the signed Mac app bundle.

The Android client verifies APK size and SHA-256 from the manifest, and Android
itself rejects an APK signed by a different application certificate.
"""

import argparse
import hashlib
import json
import select
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


MANIFEST_NAME = "android-latest.json"
APK_NAME = "Codex-Monitor-Android.apk"


def load_release(root):
    root = Path(root)
    manifest_path = root / MANIFEST_NAME
    apk_path = root / APK_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    required = {"versionCode", "versionName", "size", "sha256", "downloadPath"}
    missing = sorted(required.difference(manifest))
    if missing:
        raise ValueError(f"manifest missing: {', '.join(missing)}")
    if manifest["downloadPath"] != "/android/apk":
        raise ValueError("downloadPath must be /android/apk")
    stat = apk_path.stat()
    if stat.st_size != int(manifest["size"]):
        raise ValueError("APK size does not match manifest")
    digest = hashlib.sha256(apk_path.read_bytes()).hexdigest()
    if digest.lower() != str(manifest["sha256"]).lower():
        raise ValueError("APK SHA-256 does not match manifest")
    return manifest, apk_path


class UpdateFeedHandler(BaseHTTPRequestHandler):
    server_version = "CodexMonitorUpdateFeed/1"

    def __init__(self, *args, root, monitor_upstream=("127.0.0.1", 43117), **kwargs):
        self.root = Path(root)
        self.monitor_upstream = monitor_upstream
        super().__init__(*args, **kwargs)

    def do_HEAD(self):
        self._serve(send_body=False)

    def do_GET(self):
        self._serve(send_body=True)

    def _serve(self, send_body):
        path = urlsplit(self.path).path
        if path == "/monitor" and self.headers.get("Upgrade", "").lower() == "websocket":
            self._proxy_websocket()
            return
        try:
            manifest, apk_path = load_release(self.root)
        except Exception as error:
            self._json(503, {"ok": False, "error": str(error)}, send_body)
            return

        if path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "versionCode": manifest["versionCode"],
                    "versionName": manifest["versionName"],
                },
                send_body,
            )
            return
        if path == "/android/latest.json":
            self._json(200, manifest, send_body)
            return
        if path == "/android/apk":
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.android.package-archive")
            self.send_header("Content-Length", str(apk_path.stat().st_size))
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="Codex-Monitor-Android-{manifest["versionName"]}.apk"',
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if send_body:
                with apk_path.open("rb") as source:
                    while chunk := source.read(64 * 1024):
                        self.wfile.write(chunk)
            return
        self._json(404, {"ok": False, "error": "not found"}, send_body)

    def _proxy_websocket(self):
        response_started = False
        try:
            with socket.create_connection(self.monitor_upstream, timeout=5) as upstream:
                host, port = self.monitor_upstream
                lines = [f"{self.command} {self.path} {self.request_version}"]
                for name, value in self.headers.items():
                    if name.lower() == "host":
                        value = f"{host}:{port}"
                    lines.append(f"{name}: {value}")
                upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1"))
                upstream.settimeout(None)
                self.connection.settimeout(None)
                peers = {self.connection: upstream, upstream: self.connection}
                while True:
                    readable, _, _ = select.select(list(peers), [], [], 60)
                    for source in readable:
                        data = source.recv(64 * 1024)
                        if not data:
                            return
                        peers[source].sendall(data)
                        response_started = True
        except Exception:
            if not response_started:
                self.send_error(502, "monitor bridge unavailable")
        finally:
            self.close_connection = True

    def _json(self, status, value, send_body):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def log_message(self, format_string, *args):
        # Never log the pairing token carried in the query string.
        safe_path = urlsplit(self.path).path
        sys.stderr.write(
            f"{self.address_string()} - {self.command} {safe_path} - {args[1] if len(args) > 1 else '-'}\n"
        )


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def serve(root, host="0.0.0.0", port=43118, monitor_host="127.0.0.1", monitor_port=43117):
    handler = lambda *args, **kwargs: UpdateFeedHandler(
        *args,
        root=root,
        monitor_upstream=(monitor_host, monitor_port),
        **kwargs,
    )
    server = ReusableThreadingHTTPServer((host, port), handler)
    print(f"Codex Monitor Android update feed: http://{host}:{port}", flush=True)
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=43118, type=int)
    parser.add_argument("--monitor-host", default="127.0.0.1")
    parser.add_argument("--monitor-port", default=43117, type=int)
    args = parser.parse_args()
    serve(args.root, args.host, args.port, args.monitor_host, args.monitor_port)


if __name__ == "__main__":
    main()
