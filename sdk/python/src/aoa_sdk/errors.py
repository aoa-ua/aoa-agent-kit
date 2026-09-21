"""Errors raised by the AOA SDK."""

from __future__ import annotations

from typing import Any, Optional

from .rate_limit import RateLimitInfo

#: Codes a later identical request may fix (wait ``Retry-After`` or back off).
RETRYABLE_CODES = frozenset({"rate_limited", "internal_error"})


class AoaError(Exception):
    """Base class for every error raised by this package."""


class AoaApiError(AoaError):
    """Error response of the AOA API: ``{"error": {"code", "message", "hint"}}``.

    Branch on ``code``, never on ``message``: messages are meant for people and
    some of them are in Ukrainian. A response outside this envelope (for
    example an HTML page from a proxy) gets ``code = "http_<status>"``.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        hint: Optional[str] = None,
        rate_limit: Optional[RateLimitInfo] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.rate_limit = rate_limit
        self.body = body

    @property
    def retryable(self) -> bool:
        """True for ``rate_limited`` and ``internal_error``.

        Retry writes only with the same ``Idempotency-Key``.
        """
        return self.code in RETRYABLE_CODES

    def __repr__(self) -> str:
        return (
            f"AoaApiError(status={self.status!r}, code={self.code!r}, "
            f"message={self.message!r}, hint={self.hint!r})"
        )


class AoaConnectionError(AoaError):
    """The request never produced an HTTP response (DNS, TLS, timeout)."""


class WebhookSignatureError(AoaError):
    """``AOA-Signature`` is missing, malformed, stale or does not match."""


def error_from_response(
    status: int,
    reason: str,
    body: Any,
    rate_limit: Optional[RateLimitInfo],
) -> AoaApiError:
    envelope = body.get("error") if isinstance(body, dict) else None
    if isinstance(envelope, dict) and isinstance(envelope.get("code"), str):
        message = envelope.get("message")
        hint = envelope.get("hint")
        return AoaApiError(
            status=status,
            code=envelope["code"],
            message=message if isinstance(message, str) else reason,
            hint=hint if isinstance(hint, str) else None,
            rate_limit=rate_limit,
            body=body,
        )
    return AoaApiError(
        status=status,
        code=f"http_{status}",
        message=reason or f"HTTP {status}",
        rate_limit=rate_limit,
        body=body,
    )
