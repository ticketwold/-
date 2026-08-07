from __future__ import annotations

import socket
import urllib.error
import urllib.request
from dataclasses import dataclass


@dataclass
class InstanceLockResult:
    ok: bool
    message: str = ""


class InstanceLock:
    """127.0.0.1 포트 점유 여부로 단일 인스턴스 보장 (포트 선점 없음)."""

    def __init__(self, ports: tuple[int, ...] = (18765, 18766)) -> None:
        self._ports = ports

    def acquire(self) -> InstanceLockResult:
        if self._is_arb_desktop_running():
            return InstanceLockResult(
                ok=False,
                message="arb-desktop이 이미 실행 중입니다. 기존 창을 사용하세요.",
            )

        for port in self._ports:
            if self._port_in_use(port):
                return InstanceLockResult(
                    ok=False,
                    message=f"127.0.0.1:{port} 포트가 다른 프로그램에서 사용 중입니다.",
                )
        return InstanceLockResult(ok=True)

    def release(self) -> None:
        return

    @staticmethod
    def _port_in_use(port: int) -> bool:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return False
        except OSError:
            return True
        finally:
            sock.close()

    @staticmethod
    def _is_arb_desktop_running() -> bool:
        try:
            with urllib.request.urlopen("http://127.0.0.1:18766/health", timeout=1.0) as resp:
                return resp.status == 200
        except (urllib.error.URLError, TimeoutError, OSError):
            return False


def ensure_single_instance() -> InstanceLockResult:
    return InstanceLock().acquire()
