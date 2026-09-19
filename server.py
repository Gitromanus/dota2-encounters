"""Локальный сервер статики без кеширования — удобно для разработки.

Запуск: python server.py [порт]
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8642
    print(f"Serving on http://127.0.0.1:{port} (no-store)")
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
