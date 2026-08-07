from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any
from urllib.parse import urlparse

from arb_desktop.bridge.pairing_store import PairingStore

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1


def _valid_extension_origin(origin: str) -> bool:
    return origin.startswith("chrome-extension://")


def _reject_web_origin(origin: str, referer: str) -> bool:
    if origin and not _valid_extension_origin(origin):
        return True
    if referer and referer.startswith(("http://", "https://")):
        return True
    return False


class PairingHTTPServer:
    """127.0.0.1 전용 페어링 HTTP API."""

    def __init__(self, store: PairingStore, *, host: str = "127.0.0.1", port: int = 18766) -> None:
        self._store = store
        self._host = host
        self._port = port
        self._server: asyncio.Server | None = None

    @property
    def port(self) -> int:
        return self._port

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle_client, self._host, self._port)

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if not request_line:
                return
            parts = request_line.decode("utf-8", errors="ignore").strip().split(" ")
            if len(parts) < 2:
                return
            method, path = parts[0].upper(), parts[1]

            headers: dict[str, str] = {}
            while True:
                line = await reader.readline()
                if not line or line in (b"\r\n", b"\n"):
                    break
                text = line.decode("utf-8", errors="ignore").strip()
                if ":" in text:
                    key, val = text.split(":", 1)
                    headers[key.strip().lower()] = val.strip()

            content_length = int(headers.get("content-length", "0") or "0")
            body = b""
            if content_length > 0:
                body = await reader.readexactly(content_length)

            origin = headers.get("origin", "")
            referer = headers.get("referer", "")
            route = urlparse(path).path

            if method == "OPTIONS":
                await self._respond(
                    writer,
                    204,
                    {},
                    origin=origin if _valid_extension_origin(origin) else "",
                )
                return

            if _reject_web_origin(origin, referer):
                await self._respond(writer, 403, {"ok": False, "error": "origin-forbidden"})
                return

            if origin and not _valid_extension_origin(origin):
                await self._respond(writer, 403, {"ok": False, "error": "origin-forbidden"})
                return

            if method == "GET" and route == "/health":
                await self._respond(
                    writer,
                    200,
                    {"ok": True, "app": "arb-desktop", "protocol_version": PROTOCOL_VERSION},
                    origin=origin if _valid_extension_origin(origin) else "",
                )
                return

            if method != "POST":
                await self._respond(writer, 405, {"ok": False, "error": "method-not-allowed"})
                return

            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                await self._respond(writer, 400, {"ok": False, "error": "invalid-json"})
                return

            cors_origin = origin if _valid_extension_origin(origin) else ""

            if route == "/pair/request":
                await self._pair_request(writer, payload, cors_origin)
            elif route == "/pair/confirm":
                await self._pair_confirm(writer, payload, cors_origin)
            else:
                await self._respond(writer, 404, {"ok": False, "error": "not-found"}, origin=cors_origin)
        except Exception:
            logger.debug("pairing request failed", exc_info=True)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _pair_request(
        self, writer: asyncio.StreamWriter, payload: dict[str, Any], origin: str = ""
    ) -> None:
        extension_id = str(payload.get("extension_id") or "")
        result = self._store.request_nonce(extension_id)
        if not result:
            await self._respond(writer, 429, {"ok": False, "error": "rate-limited"}, origin=origin)
            return
        nonce, expires_at = result
        logger.info("pair request extension_id=%s…%s", extension_id[:6], extension_id[-4:] if extension_id else "")
        await self._respond(
            writer, 200, {"ok": True, "nonce": nonce, "expires_at": int(expires_at)}, origin=origin
        )

    async def _pair_confirm(
        self, writer: asyncio.StreamWriter, payload: dict[str, Any], origin: str = ""
    ) -> None:
        extension_id = str(payload.get("extension_id") or "")
        nonce = str(payload.get("nonce") or "")
        if not self._store.confirm_nonce(extension_id, nonce):
            await self._respond(writer, 403, {"ok": False, "error": "invalid-nonce"}, origin=origin)
            return
        logger.info("pair confirmed extension_id=%s…%s", extension_id[:6], extension_id[-4:] if extension_id else "")
        await self._respond(writer, 200, self._store.pairing_payload(), origin=origin)

    async def _respond(
        self, writer: asyncio.StreamWriter, status: int, data: dict[str, Any], *, origin: str = ""
    ) -> None:
        body = json.dumps(data).encode("utf-8") if data else b""
        reason = {
            200: "OK",
            204: "No Content",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            405: "Method Not Allowed",
            429: "Too Many Requests",
        }.get(status, "Error")
        cors = ""
        if origin and _valid_extension_origin(origin):
            cors = f"Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"
        header = (
            f"HTTP/1.1 {status} {reason}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"{cors}"
            "Connection: close\r\n"
            "\r\n"
        ).encode("utf-8")
        writer.write(header + body)
        await writer.drain()
