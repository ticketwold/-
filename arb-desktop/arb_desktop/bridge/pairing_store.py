from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Callable


NONCE_TTL_SEC = 60
CREDENTIAL_TTL_SEC = 365 * 24 * 3600
RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX = 20


@dataclass
class PendingNonce:
    extension_id: str
    expires_at: float


@dataclass
class PairingStore:
    """로컬 페어링 credential 및 허용 확장 ID 관리."""

    credential: str
    allowed_extension_ids: list[str] = field(default_factory=list)
    credential_expires_at: float = 0.0
    last_paired_at: float = 0.0
    on_change: Callable[[], None] | None = None
    _pending: dict[str, PendingNonce] = field(default_factory=dict, repr=False)
    _rate: dict[str, list[float]] = field(default_factory=dict, repr=False)

    @classmethod
    def create(cls) -> PairingStore:
        now = time.time()
        return cls(
            credential=secrets.token_urlsafe(32),
            credential_expires_at=now + CREDENTIAL_TTL_SEC,
        )

    def _notify(self) -> None:
        if self.on_change:
            self.on_change()

    def _check_rate(self, key: str) -> bool:
        now = time.time()
        hits = [t for t in self._rate.get(key, []) if now - t < RATE_LIMIT_WINDOW_SEC]
        if len(hits) >= RATE_LIMIT_MAX:
            return False
        hits.append(now)
        self._rate[key] = hits
        return True

    def _purge_nonces(self) -> None:
        now = time.time()
        expired = [n for n, p in self._pending.items() if p.expires_at <= now]
        for nonce in expired:
            del self._pending[nonce]

    def request_nonce(self, extension_id: str) -> tuple[str, float] | None:
        if not extension_id:
            return None
        if not self._check_rate(extension_id):
            return None
        self._purge_nonces()
        nonce = secrets.token_urlsafe(24)
        expires_at = time.time() + NONCE_TTL_SEC
        self._pending[nonce] = PendingNonce(extension_id=extension_id, expires_at=expires_at)
        return nonce, expires_at

    def confirm_nonce(self, extension_id: str, nonce: str) -> bool:
        if not extension_id or not nonce:
            return False
        if not self._check_rate(f"confirm:{extension_id}"):
            return False
        self._purge_nonces()
        pending = self._pending.pop(nonce, None)
        if not pending or pending.extension_id != extension_id:
            return False
        if pending.expires_at < time.time():
            return False
        if self.allowed_extension_ids and extension_id not in self.allowed_extension_ids:
            self.allowed_extension_ids.append(extension_id)
        elif not self.allowed_extension_ids:
            self.allowed_extension_ids.append(extension_id)
        self.last_paired_at = time.time()
        self._notify()
        return True

    def validate(self, extension_id: str, credential: str) -> bool:
        if not extension_id or not credential:
            return False
        if credential != self.credential:
            return False
        if self.credential_expires_at and time.time() > self.credential_expires_at:
            return False
        if self.allowed_extension_ids and extension_id not in self.allowed_extension_ids:
            return False
        return True

    def rotate_credential(self) -> None:
        now = time.time()
        self.credential = secrets.token_urlsafe(32)
        self.credential_expires_at = now + CREDENTIAL_TTL_SEC
        self._pending.clear()
        self._notify()

    def revoke_extension(self, extension_id: str) -> None:
        self.allowed_extension_ids = [eid for eid in self.allowed_extension_ids if eid != extension_id]
        self._notify()

    def reset_pairing(self) -> None:
        self.rotate_credential()
        self.allowed_extension_ids.clear()
        self.last_paired_at = 0.0
        self._notify()

    def pairing_payload(self) -> dict[str, object]:
        return {
            "ok": True,
            "credential": self.credential,
            "host": "127.0.0.1",
            "port": 18765,
            "protocol_version": 1,
            "expires_at": int(self.credential_expires_at),
        }

    def credential_fingerprint(self) -> str:
        return f"{self.credential[:4]}…{self.credential[-4:]}" if len(self.credential) > 10 else "****"
