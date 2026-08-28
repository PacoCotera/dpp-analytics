from __future__ import annotations

import hmac
import ipaddress
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from http.cookies import SimpleCookie


SESSION_COOKIE = "dpp_admin_session"


def admin_client_allowed(address: str, *, allow_remote: bool, secure_cookie: bool) -> bool:
    """Keep password/cookie traffic local unless HTTPS is explicitly enforced."""
    try:
        if ipaddress.ip_address(str(address)).is_loopback:
            return True
    except ValueError:
        return False
    return bool(allow_remote and secure_cookie)


@dataclass(frozen=True)
class AdminSession:
    token: str
    csrf_token: str
    expires_at: float


class AdminAuth:
    """Small, host-secret-backed session owner for the single-operator board."""

    def __init__(
        self,
        password: str,
        *,
        session_seconds: int = 8 * 60 * 60,
        failure_window_seconds: int = 5 * 60,
        max_failures: int = 5,
        clock=time.time,
    ):
        self._password = str(password or "")
        self._session_seconds = session_seconds
        self._failure_window_seconds = failure_window_seconds
        self._max_failures = max_failures
        self._clock = clock
        self._sessions: dict[str, AdminSession] = {}
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.RLock()

    @property
    def configured(self) -> bool:
        return len(self._password) >= 16 and not self._password.startswith("CHANGE_ME")

    def _prune(self, now: float) -> None:
        expired = [token for token, session in self._sessions.items() if session.expires_at <= now]
        for token in expired:
            self._sessions.pop(token, None)

    def _recent_failures(self, client_key: str, now: float) -> deque[float]:
        failures = self._failures[client_key]
        cutoff = now - self._failure_window_seconds
        while failures and failures[0] <= cutoff:
            failures.popleft()
        return failures

    def login(self, password: str, client_key: str) -> tuple[str, AdminSession | None]:
        """Return configured, rate_limited, invalid, or authenticated."""
        now = self._clock()
        client = str(client_key or "unknown")[:120]
        with self._lock:
            self._prune(now)
            if not self.configured:
                return "unconfigured", None
            failures = self._recent_failures(client, now)
            if len(failures) >= self._max_failures:
                return "rate_limited", None
            if not hmac.compare_digest(str(password or ""), self._password):
                failures.append(now)
                return "invalid", None
            failures.clear()
            token = secrets.token_urlsafe(32)
            session = AdminSession(
                token=token,
                csrf_token=secrets.token_urlsafe(24),
                expires_at=now + self._session_seconds,
            )
            self._sessions[token] = session
            return "authenticated", session

    def session(self, cookie_header: str | None) -> AdminSession | None:
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header or "")
        except Exception:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        token = morsel.value if morsel else ""
        if not token:
            return None
        now = self._clock()
        with self._lock:
            self._prune(now)
            session = self._sessions.get(token)
            if not session:
                return None
            # Sliding expiry keeps an active editing session alive without
            # extending a stolen cookie after it goes idle.
            refreshed = AdminSession(token, session.csrf_token, now + self._session_seconds)
            self._sessions[token] = refreshed
            return refreshed

    def verify_csrf(self, session: AdminSession | None, supplied: str | None) -> bool:
        return bool(
            session
            and supplied
            and hmac.compare_digest(session.csrf_token, str(supplied))
        )

    def logout(self, session: AdminSession | None) -> None:
        if not session:
            return
        with self._lock:
            self._sessions.pop(session.token, None)

    @staticmethod
    def cookie_header(session: AdminSession, *, secure: bool = False) -> str:
        parts = [
            f"{SESSION_COOKIE}={session.token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Strict",
            f"Max-Age={8 * 60 * 60}",
        ]
        if secure:
            parts.append("Secure")
        return "; ".join(parts)

    @staticmethod
    def clear_cookie_header(*, secure: bool = False) -> str:
        parts = [f"{SESSION_COOKIE}=", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"]
        if secure:
            parts.append("Secure")
        return "; ".join(parts)
