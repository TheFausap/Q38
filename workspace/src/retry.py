from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


def retry(fn: Callable[[], T], attempts: int = 3, base_delay: float = 0.2) -> T:
    """Call *fn* until it succeeds. Exponential backoff, last error re-raised."""
    last: BaseException | None = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as err:  # noqa: BLE001 — caller decides what to catch
            last = err
            if i == attempts - 1:
                break
            time.sleep(base_delay * 2**i)
    assert last is not None
    raise last
