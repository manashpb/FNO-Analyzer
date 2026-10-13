"""Browser URL resolution against an HTTP proxy that strips the deployment prefix."""
import json
from pathlib import Path
import re
import sys
from threading import Thread
from types import SimpleNamespace
import unittest
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fno_analyzer.http_server import ApplicationHandler, Server


class SubpathDeploymentTests(unittest.TestCase):
    def test_assets_get_and_post_stay_inside_app_prefix(self):
        calls = []

        def dispatch(path, query):
            calls.append((path, query))
            return {"status": "ok"}, 200

        app = SimpleNamespace(settings={"static_path": str(Path(__file__).resolve().parents[1] / "frontend")}, dispatch=dispatch)
        backend = Server(("127.0.0.1", 0), ApplicationHandler, app)
        backend_url = f"http://127.0.0.1:{backend.server_port}"

        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def forward(self):
                if not self.path.startswith("/fnoanalyzer/"):
                    self.send_error(404)
                    return
                path = self.path.removeprefix("/fnoanalyzer")
                with urlopen(Request(backend_url + path, method=self.command)) as response:
                    body = response.read()
                    self.send_response(response.status)
                    self.send_header("Content-Type", response.headers["Content-Type"])
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            do_GET = forward
            do_POST = forward

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        threads = [Thread(target=s.serve_forever, daemon=True) for s in (backend, proxy)]
        for thread in threads:
            thread.start()
        try:
            for base in (backend_url + "/", f"http://127.0.0.1:{proxy.server_port}/fnoanalyzer/"):
                with urlopen(base) as response:
                    html = response.read().decode()
                assets = re.findall(r'(?:src|href)="([^" ]+\.(?:js|css))"', html)
                self.assertGreater(len(assets), 10)
                for asset in assets:
                    with urlopen(urljoin(base, asset)) as response:
                        self.assertEqual(response.status, 200)
                with urlopen(urljoin(base, "api/health")) as response:
                    self.assertEqual(json.load(response)["status"], "ok")
                with urlopen(Request(urljoin(base, "api/scanners/iv/start?falling=false&rising=false"), method="POST")) as response:
                    self.assertEqual(response.status, 200)
            self.assertEqual(calls[-1], ("/api/scanners/iv/start", {"falling": ["false"], "rising": ["false"]}))
        finally:
            for server in (proxy, backend):
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()
