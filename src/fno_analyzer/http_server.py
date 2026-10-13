import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .application import Application
from .config import load_settings
from .errors import AppError, InvalidParameter

LOG = logging.getLogger("fno_analyzer.http")
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class ApplicationHandler(BaseHTTPRequestHandler):
    server_version = "FNOAnalyzer/2.0"
    sys_version = ""

    def log_message(self, format_string: str, *args: object) -> None:
        LOG.info("%s %s", self.address_string(), format_string % args)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        )

    def _send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, relative_path: str) -> None:
        root = Path(self.server.application.settings["static_path"]).resolve()
        candidate = (root / relative_path.lstrip("/")).resolve()
        if candidate != root and root not in candidate.parents:
            self._send_json({"error": "not found", "code": "NOT_FOUND"}, 404)
            return
        if not candidate.is_file():
            self._send_json({"error": "not found", "code": "NOT_FOUND"}, 404)
            return
        body = candidate.read_bytes()
        extension = candidate.suffix.lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(extension, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if extension in (".html", ".js", ".css") else "public, max-age=3600")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, error: AppError) -> None:
        body = {"error": error.message, "code": error.code, "retryable": error.retryable}
        if error.provider:
            body["provider"] = error.provider
        self._send_json(body, error.status)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._security_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path in ("/api/scanners/iv/start", "/api/scanners/iv/cancel",
                    "/api/history/oi/start", "/api/history/oi/cancel", "/api/scanners/oi-zscore/update", "/api/scanners/oi-levels/run"):
            self._send_json({"error": "Use POST for actions"}, 405)
            return
        if path in ("/", "/index.html"):
            self._send_file("index.html")
            return
        if path.startswith("/static/"):
            self._send_file(path.removeprefix("/static/"))
            return
        query = parse_qs(parsed.query, keep_blank_values=True)
        try:
            result, status = self.server.application.dispatch(path, query)
            self._send_json(result, status)
        except AppError as error:
            self._send_error(error)
        except (TypeError, ValueError) as error:
            self._send_error(InvalidParameter(str(error)))
        except Exception:
            LOG.exception("Unhandled request error for %s", path)
            self._send_json({"error": "internal server error", "code": "INTERNAL_ERROR", "retryable": False}, 500)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path not in ("/api/scanners/iv/start", "/api/scanners/iv/cancel",
                        "/api/history/oi/start", "/api/history/oi/cancel", "/api/scanners/oi-zscore/update", "/api/scanners/oi-levels/run"):
            self._send_json({"error": "not found"}, 404)
            return
        try:
            result, status = self.server.application.dispatch(path, parse_qs(parsed.query, keep_blank_values=True))
            self._send_json(result, status)
        except AppError as error:
            self._send_error(error)
        except (TypeError, ValueError) as error:
            self._send_error(InvalidParameter(str(error)))
        except Exception:
            LOG.exception("Unhandled scan action error")
            self._send_json({"error": "internal server error", "code": "INTERNAL_ERROR"}, 500)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Windows SO_REUSEADDR can let two app processes serve the same port.
    allow_reuse_address = os.name != "nt"

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], application: Application):
        self.application = application
        super().__init__(address, handler)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = load_settings()
    application = Application(settings)
    host = str(settings["server"]["host"])
    port = int(settings["server"]["port"])
    server = Server((host, port), ApplicationHandler, application)
    LOG.info("FNO Analyzer V2 listening on http://%s:%s", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
