"""Rate-limit headers of the AOA API.

AOA sends the IETF draft pair ``RateLimit-Policy`` (``"default";q=60;w=60``)
and ``RateLimit`` (``"default";r=59;t=60``), the historical
``X-RateLimit-Limit`` / ``X-RateLimit-Remaining``, and ``Retry-After`` with 429.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Dict, Mapping, Optional


@dataclass(frozen=True)
class RateLimitInfo:
    #: Requests allowed per window (``q`` or ``X-RateLimit-Limit``).
    limit: Optional[int] = None
    #: Requests left in the current window (``r`` or ``X-RateLimit-Remaining``).
    remaining: Optional[int] = None
    #: Upper bound, in seconds, until the quota refills (``t``).
    reset_seconds: Optional[int] = None
    #: Window length in seconds (``w``).
    window_seconds: Optional[int] = None
    #: ``Retry-After``: wait before retrying a 429, or the polling interval of a 202.
    retry_after_seconds: Optional[int] = None


def _to_int(value: Optional[str]) -> Optional[int]:
    if value is None or not value.strip():
        return None
    try:
        return int(float(value.strip()))
    except ValueError:
        return None


def _structured_params(value: Optional[str]) -> Dict[str, str]:
    params: Dict[str, str] = {}
    if not value:
        return params
    for part in value.split(";")[1:]:
        key, sep, raw = part.partition("=")
        if sep:
            params[key.strip()] = raw.strip()
    return params


def _retry_after(value: Optional[str], now: float) -> Optional[int]:
    if not value:
        return None
    seconds = _to_int(value)
    if seconds is not None:
        return max(0, seconds)
    try:
        moment = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0, int(moment.timestamp() - now + 0.999))


def parse_rate_limit(
    headers: Mapping[str, str], now: Optional[float] = None
) -> Optional[RateLimitInfo]:
    """Parse rate-limit headers (keys case-insensitive); ``None`` if absent."""
    lowered = {key.lower(): value for key, value in headers.items()}
    policy = _structured_params(lowered.get("ratelimit-policy"))
    state = _structured_params(lowered.get("ratelimit"))
    limit = _to_int(policy.get("q"))
    remaining = _to_int(state.get("r"))
    info = RateLimitInfo(
        limit=limit if limit is not None else _to_int(lowered.get("x-ratelimit-limit")),
        remaining=remaining
        if remaining is not None
        else _to_int(lowered.get("x-ratelimit-remaining")),
        reset_seconds=_to_int(state.get("t")),
        window_seconds=_to_int(policy.get("w")),
        retry_after_seconds=_retry_after(
            lowered.get("retry-after"), time.time() if now is None else now
        ),
    )
    if all(value is None for value in info.__dict__.values()):
        return None
    return info
