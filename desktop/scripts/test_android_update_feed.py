import hashlib
import json
import socket
import socketserver
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from android_update_feed import UpdateFeedHandler, load_release
from http.server import ThreadingHTTPServer


class AndroidUpdateFeedTest(unittest.TestCase):
    def make_release(self, root: Path, contents: bytes = b"signed-apk"):
        apk = root / "Codex-Monitor-Android.apk"
        apk.write_bytes(contents)
        manifest = {
            "versionCode": 48,
            "versionName": "0.11.20",
            "size": len(contents),
            "sha256": hashlib.sha256(contents).hexdigest(),
            "downloadPath": "/android/apk",
        }
        (root / "android-latest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return manifest

    def test_load_release_requires_matching_size_and_sha256(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_release(root)
            manifest, apk = load_release(root)
            self.assertEqual(48, manifest["versionCode"])
            self.assertEqual(b"signed-apk", apk.read_bytes())

            (root / "Codex-Monitor-Android.apk").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "size|SHA-256"):
                load_release(root)

    def test_http_feed_serves_manifest_apk_and_health_without_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.make_release(root)
            handler = lambda *args, **kwargs: UpdateFeedHandler(*args, root=root, **kwargs)
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urllib.request.urlopen(f"{base}/health", timeout=2) as response:
                    self.assertEqual(200, response.status)
                    self.assertTrue(json.load(response)["ok"])
                with urllib.request.urlopen(f"{base}/android/latest.json?token=ignored", timeout=2) as response:
                    self.assertEqual(manifest, json.load(response))
                with urllib.request.urlopen(f"{base}/android/apk?token=ignored", timeout=2) as response:
                    self.assertEqual(b"signed-apk", response.read())
                with self.assertRaises(urllib.error.HTTPError) as missing:
                    urllib.request.urlopen(f"{base}/private", timeout=2)
                self.assertEqual(404, missing.exception.code)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_upgrade_bridge_proxies_websocket_bytes_to_existing_monitor(self):
        seen_requests = []

        class UpstreamHandler(socketserver.BaseRequestHandler):
            def handle(self):
                request = b""
                while b"\r\n\r\n" not in request:
                    request += self.request.recv(4096)
                seen_requests.append(request)
                self.request.sendall(
                    b"HTTP/1.1 101 Switching Protocols\r\n"
                    b"Upgrade: websocket\r\n"
                    b"Connection: Upgrade\r\n\r\n"
                )
                self.assert_payload()

            def assert_payload(self):
                payload = self.request.recv(4)
                if payload == b"ping":
                    self.request.sendall(b"pong")

        upstream = socketserver.ThreadingTCPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_release(root)
            handler = lambda *args, **kwargs: UpdateFeedHandler(
                *args,
                root=root,
                monitor_upstream=upstream.server_address,
                **kwargs,
            )
            bridge = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            bridge_thread = threading.Thread(target=bridge.serve_forever, daemon=True)
            bridge_thread.start()
            client = socket.create_connection(bridge.server_address, timeout=2)
            try:
                client.sendall(
                    b"GET /monitor?token=secret HTTP/1.1\r\n"
                    b"Host: 127.0.0.1\r\n"
                    b"Connection: Upgrade\r\n"
                    b"Upgrade: websocket\r\n\r\n"
                )
                response = b""
                while b"\r\n\r\n" not in response:
                    response += client.recv(4096)
                self.assertIn(b"101 Switching Protocols", response)
                client.sendall(b"ping")
                self.assertEqual(b"pong", client.recv(4))
                self.assertIn(b"GET /monitor?token=secret", seen_requests[0])
            finally:
                client.close()
                bridge.shutdown()
                bridge.server_close()
                bridge_thread.join(timeout=2)
                upstream.shutdown()
                upstream.server_close()
                upstream_thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
