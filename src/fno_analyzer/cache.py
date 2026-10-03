from collections.abc import Hashable
from threading import RLock
import time
from typing import Any


class TTLCache:
    def __init__(self, ttl_seconds: float):
        self.ttl_seconds = max(0.0, float(ttl_seconds))
        self._values: dict[Hashable, tuple[float, Any]] = {}
        self._lock = RLock()

    def get(self, key: Hashable) -> Any | None:
        with self._lock:
            item = self._values.get(key)
            if item is None:
                return None
            stored_at, value = item
            if time.monotonic() - stored_at >= self.ttl_seconds:
                self._values.pop(key, None)
                return None
            return value

    def set(self, key: Hashable, value: Any) -> None:
        with self._lock:
            self._values[key] = (time.monotonic(), value)

    def clear(self) -> None:
        with self._lock:
            self._values.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._values)
