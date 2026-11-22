#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Standard-library WebSocket client and Volcengine SAUC v3 binary frame codec.
Avoids external dependencies (websockets / httpx) so live recording works out of the box.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import socket
import ssl
import struct
import threading
import urllib.parse
from typing import Any, Dict, Optional, Tuple


WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Volcengine SAUC v3 protocol constants
VOLC_PROTO_VERSION = 0b0001
VOLC_HEADER_WORDS = 0b0001

MSG_FULL_CLIENT_REQUEST = 0b0001
MSG_AUDIO_ONLY_REQUEST = 0b0010
MSG_FULL_SERVER_RESPONSE = 0b1001
MSG_ERROR_RESPONSE = 0b1111

FLAG_NONE = 0b0000
FLAG_HAS_SEQUENCE = 0b0001
FLAG_LAST_PACKAGE = 0b0010

SER_NONE = 0b0000
SER_JSON = 0b0001

COMP_NONE = 0b0000
COMP_GZIP = 0b0001


class WsHandshakeError(Exception):
    """Raised when WebSocket HTTP Upgrade fails."""

    def __init__(self, status: int, headers: Dict[str, str], body: str = "") -> None:
        self.status = status
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.body = body
        api_code = self.headers.get("x-api-status-code", "")
        api_msg = self.headers.get("x-api-message", "")
        log_id = self.headers.get("x-tt-logid", "")
        detail = f"HTTP {status}"
        if api_code or api_msg:
            detail += f" (code={api_code}, msg={api_msg})"
        if log_id:
            detail += f" [logid={log_id}]"
        if body and not api_msg:
            detail += f": {body[:240]}"
        super().__init__(detail)


class WsClosed(Exception):
    """Raised when the WebSocket connection is closed."""

    def __init__(self, code: int = 1000, reason: str = "") -> None:
        self.code = code
        self.reason = reason
        super().__init__(f"WebSocket closed ({code}): {reason}")


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise WsClosed(1006, "EOF while reading WebSocket frame")
        buf.extend(chunk)
    return bytes(buf)


def _read_http_response(sock: socket.socket) -> Tuple[int, Dict[str, str], bytes]:
    raw = bytearray()
    while b"\r\n\r\n" not in raw:
        chunk = sock.recv(4096)
        if not chunk:
            break
        raw.extend(chunk)
        if len(raw) > 65536:
            break
    sep = raw.find(b"\r\n\r\n")
    if sep == -1:
        head_bytes = bytes(raw)
        tail_bytes = b""
    else:
        head_bytes = bytes(raw[:sep])
        tail_bytes = bytes(raw[sep + 4 :])

    lines = head_bytes.decode("utf-8", errors="replace").split("\r\n")
    status_line = lines[0] if lines else ""
    parts = status_line.split(" ", 2)
    status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
    headers: Dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers, tail_bytes


class SimpleWebSocket:
    """Minimal RFC 6455 WebSocket client over stdlib socket/ssl."""

    def __init__(self, sock: socket.socket, initial_buf: bytes = b"") -> None:
        self._sock = sock
        self._send_lock = threading.Lock()
        self._closed = False
        self._buf = bytearray(initial_buf)

    @classmethod
    def connect(
        cls,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 10.0,
    ) -> "SimpleWebSocket":
        parsed = urllib.parse.urlparse(url)
        scheme = (parsed.scheme or "wss").lower()
        if scheme not in ("ws", "wss"):
            raise ValueError(f"Unsupported WebSocket scheme: {scheme}")
        host = parsed.hostname or ""
        if not host:
            raise ValueError(f"Missing host in WebSocket URL: {url}")
        port = parsed.port or (443 if scheme == "wss" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        raw_sock = socket.create_connection((host, port), timeout=timeout)
        sock: socket.socket = raw_sock
        if scheme == "wss":
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        sock.settimeout(timeout)

        ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
        expected_accept = base64.b64encode(
            hashlib.sha1((ws_key + WS_MAGIC_GUID).encode("ascii")).digest()
        ).decode("ascii")

        host_hdr = host if (port in (80, 443) and parsed.port is None) else f"{host}:{port}"
        req_headers: Dict[str, str] = {
            "Host": host_hdr,
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Key": ws_key,
            "Sec-WebSocket-Version": "13",
        }
        if headers:
            for k, v in headers.items():
                req_headers[k] = str(v)

        req_lines = [f"GET {path} HTTP/1.1"]
        for k, v in req_headers.items():
            req_lines.append(f"{k}: {v}")
        req_lines.append("")
        req_lines.append("")
        sock.sendall("\r\n".join(req_lines).encode("utf-8"))

        status, resp_headers, tail = _read_http_response(sock)
        if status != 101:
            body = tail.decode("utf-8", errors="replace")
            try:
                sock.close()
            except Exception:
                pass
            raise WsHandshakeError(status, resp_headers, body)

        accept_val = resp_headers.get("sec-websocket-accept", "")
        if accept_val != expected_accept:
            try:
                sock.close()
            except Exception:
                pass
            raise WsHandshakeError(
                status,
                resp_headers,
                f"Invalid Sec-WebSocket-Accept: {accept_val}",
            )

        sock.settimeout(None)
        return cls(sock, initial_buf=tail)

    def _read_exact(self, n: int) -> bytes:
        if len(self._buf) >= n:
            out = bytes(self._buf[:n])
            del self._buf[:n]
            return out
        need = n - len(self._buf)
        head = bytes(self._buf)
        self._buf.clear()
        return head + _recv_exact(self._sock, need)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask_key = os.urandom(4)
        length = len(payload)
        header = bytearray()
        header.append(0x80 | (opcode & 0x0F))
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack(">H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack(">Q", length))
        header.extend(mask_key)

        masked = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
        with self._send_lock:
            if self._closed:
                raise WsClosed(1000, "Connection already closed")
            self._sock.sendall(bytes(header) + masked)

    def send_binary(self, data: bytes) -> None:
        self._send_frame(0x2, data)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def send_pong(self, payload: bytes = b"") -> None:
        self._send_frame(0xA, payload[:125])

    def recv(self) -> Tuple[int, bytes]:
        """Reads one complete message (reassembling fragmented frames). Handles ping/pong/close."""
        fragments: list[bytes] = []
        msg_opcode: Optional[int] = None

        while True:
            b1, b2 = self._read_exact(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F

            if length == 126:
                (length,) = struct.unpack(">H", self._read_exact(2))
            elif length == 127:
                (length,) = struct.unpack(">Q", self._read_exact(8))

            mask_key = self._read_exact(4) if masked else b""
            payload = self._read_exact(length) if length > 0 else b""
            if masked and payload:
                payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))

            if opcode == 0x9:  # Ping
                try:
                    self.send_pong(payload)
                except Exception:
                    pass
                continue
            if opcode == 0xA:  # Pong
                continue
            if opcode == 0x8:  # Close
                code = 1000
                reason = ""
                if len(payload) >= 2:
                    (code,) = struct.unpack(">H", payload[:2])
                    reason = payload[2:].decode("utf-8", errors="replace")
                try:
                    if not self._closed:
                        self._send_frame(0x8, struct.pack(">H", code))
                except Exception:
                    pass
                self.close()
                raise WsClosed(code, reason)

            if opcode != 0x0:
                msg_opcode = opcode
            fragments.append(payload)
            if fin:
                return (msg_opcode if msg_opcode is not None else 0x2), b"".join(fragments)

    def close(self) -> None:
        with self._send_lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                self._sock.close()
            except Exception:
                pass


def build_volc_frame(
    msg_type: int,
    flags: int,
    payload: bytes,
    serialization: int,
    compression: int,
) -> bytes:
    """Packs a Volcengine SAUC v3 binary frame (4-byte header + 4-byte uint32 payload length + payload)."""
    body = gzip.compress(payload) if compression == COMP_GZIP else payload
    b0 = ((VOLC_PROTO_VERSION & 0x0F) << 4) | (VOLC_HEADER_WORDS & 0x0F)
    b1 = ((msg_type & 0x0F) << 4) | (flags & 0x0F)
    b2 = ((serialization & 0x0F) << 4) | (compression & 0x0F)
    b3 = 0x00
    return bytes([b0, b1, b2, b3]) + struct.pack(">I", len(body)) + body


def build_full_client_request(req_obj: Dict[str, Any]) -> bytes:
    raw = json.dumps(req_obj, ensure_ascii=False).encode("utf-8")
    return build_volc_frame(
        MSG_FULL_CLIENT_REQUEST,
        FLAG_NONE,
        raw,
        SER_JSON,
        COMP_GZIP,
    )


def build_audio_frame(pcm_bytes: bytes, is_last: bool = False) -> bytes:
    flags = FLAG_LAST_PACKAGE if is_last else FLAG_NONE
    return build_volc_frame(
        MSG_AUDIO_ONLY_REQUEST,
        flags,
        pcm_bytes,
        SER_NONE,
        COMP_GZIP,
    )


def parse_volc_frame(data: bytes) -> Dict[str, Any]:
    """Parses a Volcengine SAUC v3 binary response or error frame."""
    if len(data) < 4:
        raise ValueError(f"Frame too short: {len(data)} bytes")
    b0, b1, b2, _b3 = data[0], data[1], data[2], data[3]
    header_bytes = (b0 & 0x0F) * 4
    msg_type = (b1 >> 4) & 0x0F
    flags = b1 & 0x0F
    serialization = (b2 >> 4) & 0x0F
    compression = b2 & 0x0F

    pos = header_bytes
    seq: Optional[int] = None
    if flags & FLAG_HAS_SEQUENCE:
        if len(data) < pos + 4:
            raise ValueError("Truncated sequence field")
        (seq,) = struct.unpack(">i", data[pos : pos + 4])
        pos += 4

    is_last = bool(flags & FLAG_LAST_PACKAGE)

    if msg_type == MSG_FULL_SERVER_RESPONSE:
        if len(data) < pos + 4:
            raise ValueError("Truncated response payload size")
        (payload_size,) = struct.unpack(">I", data[pos : pos + 4])
        pos += 4
        payload_bytes = data[pos : pos + payload_size]
        if compression == COMP_GZIP and payload_bytes:
            payload_bytes = gzip.decompress(payload_bytes)
        if serialization == SER_JSON and payload_bytes:
            payload = json.loads(payload_bytes.decode("utf-8"))
        elif payload_bytes:
            payload = {"raw": payload_bytes.decode("utf-8", errors="replace")}
        else:
            payload = {}
        return {
            "kind": "response",
            "isLast": is_last,
            "seq": seq,
            "payload": payload,
        }

    if msg_type == MSG_ERROR_RESPONSE:
        if len(data) < pos + 8:
            raise ValueError("Truncated error frame")
        (err_code, msg_size) = struct.unpack(">II", data[pos : pos + 8])
        pos += 8
        msg_bytes = data[pos : pos + msg_size]
        if compression == COMP_GZIP and msg_bytes:
            try:
                msg_bytes = gzip.decompress(msg_bytes)
            except Exception:
                pass
        return {
            "kind": "error",
            "isLast": is_last,
            "seq": seq,
            "code": err_code,
            "message": msg_bytes.decode("utf-8", errors="replace"),
        }

    return {
        "kind": "unknown",
        "msgType": msg_type,
        "isLast": is_last,
        "seq": seq,
    }
