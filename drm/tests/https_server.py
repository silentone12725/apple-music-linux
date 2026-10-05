#!/usr/bin/env python3
"""A TLS server that misbehaves on purpose, for https_fetch_test.c.

Usage: https_server.py CERT KEY PORT
Prints "ready" once it is listening. Every endpoint exercises one behaviour of the C
client's HTTP/1.1 implementation (framing, redirects, cookies, size cap, timeouts...).
"""
import http.server, socketserver, ssl, sys, threading, time

CERT, KEY, PORT = sys.argv[1], sys.argv[2], int(sys.argv[3])
lock = threading.Lock()
conns = 0
hits = {}


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        global conns
        super().setup()
        with lock:
            conns += 1

    def log_message(self, *a):
        pass

    def raw(self, data: bytes):
        self.wfile.write(data)
        self.wfile.flush()

    def ok(self, body: bytes, extra=b"", name=b"Content-Length"):
        self.raw(b"HTTP/1.1 200 OK\r\n" + name + b": " + str(len(body)).encode() + b"\r\n" + extra + b"\r\n" + body)

    def handle_any(self):
        path = self.path.split("?")[0]
        with lock:
            hits[path] = hits.get(path, 0) + 1
        n = int(self.headers.get("Content-Length") or 0)
        body_in = self.rfile.read(n) if n else b""

        if path == "/len":
            self.ok(b"hello")
        elif path == "/lower":
            self.ok(b"hello", name=b"content-length")
        elif path == "/chunked":
            self.raw(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                     b"6\r\nchunk1\r\n6;ext=1\r\nchunk2\r\n0\r\nX-Trailer: 1\r\n\r\n")
        elif path == "/close":
            self.raw(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\ncloseb")
            self.raw(b"ody")
            self.close_connection = True
            try:
                self.request.unwrap()  # send TLS close_notify: an orderly end of a close-delimited body
            except (OSError, ssl.SSLError):
                pass
        elif path == "/redirect":
            self.raw(b"HTTP/1.1 302 Found\r\nLocation: /len\r\nContent-Length: 0\r\n\r\n")
        elif path == "/redirect-abs":
            self.raw(b"HTTP/1.1 302 Found\r\nLocation: https://localhost:%d/len\r\nContent-Length: 0\r\n\r\n" % PORT)
        elif path == "/redirect-http":
            self.raw(b"HTTP/1.1 302 Found\r\nLocation: http://localhost/len\r\nContent-Length: 0\r\n\r\n")
        elif path == "/loop":
            self.raw(b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\n\r\n")
        elif path == "/post303":
            self.raw(b"HTTP/1.1 303 See Other\r\nLocation: /method\r\nContent-Length: 0\r\n\r\n")
        elif path == "/method":
            self.ok(self.command.encode())
        elif path == "/echo":
            self.ok(body_in)
        elif path == "/big":
            self.raw(b"HTTP/1.1 200 OK\r\nContent-Length: 40000000\r\n\r\n")
            try:
                for _ in range(40):
                    self.raw(b"\0" * 1000000)
            except OSError:
                pass
            self.close_connection = True
        elif path == "/trunc":
            self.raw(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123456789")
            self.close_connection = True
        elif path == "/post-trunc":
            self.raw(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n0123")
            self.close_connection = True
        elif path == "/slow":
            self.raw(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n")
            time.sleep(6)
            self.raw(b"hello")
        elif path == "/dropafter":
            self.ok(b"first")
            self.close_connection = True  # keep-alive was promised; the socket is gone anyway
        elif path == "/cookie-set":
            self.raw(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                     b"Set-Cookie: a=1; Path=/\r\n"
                     b"set-cookie: b=2; Path=/sub\r\n"
                     b"Set-Cookie: c=3; Domain=com\r\n"
                     b"Set-Cookie: d=4; Domain=other.example.org\r\n"
                     b"Set-Cookie: e=5; Domain=.example.com\r\n"
                     b"Set-Cookie: f=6; Path=/; Max-Age=3600\r\n\r\nok")
        elif path == "/cookie-update":
            self.raw(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: a=updated; Path=/\r\nSet-Cookie: f=gone; Path=/; Max-Age=0\r\n\r\nok")
        elif path in ("/cookie-echo", "/sub/echo"):
            self.ok((self.headers.get("Cookie") or "").encode())
        elif path == "/auth-echo":
            self.ok(b"yes" if self.headers.get("Authorization") else b"no")
        elif path == "/host-echo":
            self.ok((self.headers.get("Host") or "").encode())
        elif path == "/conns":
            with lock:
                self.ok(str(conns).encode())
        elif path.startswith("/hits"):
            with lock:
                self.ok(str(hits.get(path[5:], 0)).encode())
        else:
            self.raw(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")

    do_GET = do_POST = do_HEAD = handle_any


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)
srv = S(("127.0.0.1", PORT), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print("ready", flush=True)
srv.serve_forever()
