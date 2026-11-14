"""Serve the web app locally, like Vercel does, but with caching turned off.

Python's built-in server lets the browser keep old copies of app.js and the
WebAssembly file, so after a rebuild you can end up running a mix of old and
new code. This version tells the browser never to cache anything.

Usage:  python scripts/serve.py [port]      (default port 4173)
"""

import functools
import http.server
import pathlib
import sys

WEB_DIR = pathlib.Path(__file__).resolve().parent.parent / "web"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        """Adds HTTP range requests ("give me bytes 1000-2000"), which browsers
        need to seek in videos. Vercel supports these; Python's server doesn't."""
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not rng.startswith("bytes=") or not pathlib.Path(path).is_file():
            return super().send_head()
        size = pathlib.Path(path).stat().st_size
        start_s, _, end_s = rng[6:].split(",")[0].strip().partition("-")
        try:
            if start_s:
                start, end = int(start_s), int(end_s) if end_s else size - 1
            else:  # "bytes=-500" means the last 500 bytes
                start, end = max(0, size - int(end_s)), size - 1
        except ValueError:
            return super().send_head()
        if start >= size:
            self.send_error(416, "Range not satisfiable")
            return None
        end = min(end, size - 1)
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._remaining = None
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    handler = functools.partial(NoCacheHandler, directory=str(WEB_DIR))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Serving {WEB_DIR} at http://localhost:{port}  (Ctrl+C to stop)")
        server.serve_forever()


if __name__ == "__main__":
    main()
