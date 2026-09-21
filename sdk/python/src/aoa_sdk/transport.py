"""HTTP transport. The default one uses only the standard library (urllib).

A transport is any callable ``(HttpRequest) -> HttpResponse``. Pass your own
to ``AoaClient(transport=...)`` for tests, proxies or an async bridge.
"""

from __future__ import annotations

import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, Optional, Tuple

from .errors import AoaConnectionError


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: Dict[str, str]
    body: Optional[bytes]
    timeout: float


@dataclass(frozen=True)
class HttpResponse:
    status: int
    #: Header names in lower case.
    headers: Dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    reason: str = ""


Transport = Callable[[HttpRequest], HttpResponse]


def _lower(items: Iterable[Tuple[str, str]]) -> Dict[str, str]:
    return {key.lower(): value for key, value in items}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never replay a request (and its Authorization header) on another URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def urllib_transport(request: HttpRequest) -> HttpResponse:
    """Default transport. Returns non-2xx responses instead of raising."""
    prepared = urllib.request.Request(
        request.url,
        data=request.body,
        method=request.method,
        headers=request.headers,
    )
    try:
        with _opener.open(prepared, timeout=request.timeout) as response:
            return HttpResponse(
                status=response.status,
                headers=_lower(response.headers.items()),
                body=response.read(),
                reason=response.reason or "",
            )
    except urllib.error.HTTPError as error:
        return HttpResponse(
            status=error.code,
            headers=_lower(error.headers.items()) if error.headers else {},
            body=error.read() or b"",
            reason=str(error.reason or ""),
        )
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as error:
        raise AoaConnectionError(f"{request.method} {request.url} failed: {error}") from error
