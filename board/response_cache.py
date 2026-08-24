from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock
from time import monotonic
from typing import Callable


@dataclass(frozen=True)
class CacheResult:
    value: bytes
    status: str
    age_seconds: int
    ttl_seconds: int
    build_ms: int


@dataclass(frozen=True)
class _Entry:
    stored_at: float
    value: bytes


class TTLResponseCache:
    """Small bounded process-local cache for immutable JSON response bytes.

    The board currently runs as one Python service, so a process cache is enough.
    Per-key locks prevent concurrent cold requests from stampeding PostgreSQL.
    """

    def __init__(self, max_entries: int = 128):
        self.max_entries = max(1, int(max_entries))
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._key_locks: dict[str, Lock] = {}
        self._guard = Lock()

    def _lookup(self, key: str, ttl_seconds: int) -> CacheResult | None:
        now = monotonic()
        with self._guard:
            entry = self._entries.get(key)
            if entry is None:
                return None
            age = max(0.0, now - entry.stored_at)
            if age >= ttl_seconds:
                self._entries.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return CacheResult(entry.value, "HIT", int(age), ttl_seconds, 0)

    def _lock_for(self, key: str) -> Lock:
        with self._guard:
            lock = self._key_locks.get(key)
            if lock is None:
                lock = Lock()
                self._key_locks[key] = lock
            return lock

    def _store(self, key: str, value: bytes) -> None:
        with self._guard:
            self._entries[key] = _Entry(monotonic(), value)
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)

    def get_or_build(
        self,
        key: str,
        ttl_seconds: int,
        builder: Callable[[], bytes],
        *,
        refresh: bool = False,
    ) -> CacheResult:
        ttl_seconds = max(1, int(ttl_seconds))
        if not refresh:
            cached = self._lookup(key, ttl_seconds)
            if cached is not None:
                return cached

        key_lock = self._lock_for(key)
        with key_lock:
            if not refresh:
                cached = self._lookup(key, ttl_seconds)
                if cached is not None:
                    return cached
            started_at = monotonic()
            value = builder()
            build_ms = max(0, round((monotonic() - started_at) * 1000))
            self._store(key, value)
            return CacheResult(
                value,
                "REFRESH" if refresh else "MISS",
                0,
                ttl_seconds,
                build_ms,
            )

    def clear(self) -> None:
        with self._guard:
            self._entries.clear()
