import json
import re
import unittest
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

from aoa_sdk import (
    AoaApiError,
    AoaClient,
    HttpRequest,
    HttpResponse,
    __version__,
    parse_rate_limit,
)

TEST_KEY = "aoa_live_test_key_not_real"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
RATE_HEADERS = {
    "content-type": "application/json",
    "ratelimit-policy": '"default";q=60;w=60',
    "ratelimit": '"default";r=59;t=60',
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": "59",
}


class FakeTransport:
    """Records requests and replays queued responses (the last one repeats)."""

    def __init__(self, *responses: HttpResponse) -> None:
        self.responses = list(responses)
        self.requests: List[HttpRequest] = []

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.requests.append(request)
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]

    @property
    def last(self) -> HttpRequest:
        return self.requests[-1]


def ok(body: Dict[str, Any], status: int = 200, headers: Optional[Dict[str, str]] = None) -> HttpResponse:
    return HttpResponse(
        status=status,
        headers=headers or {"content-type": "application/json"},
        body=json.dumps(body).encode("utf-8"),
    )


def query_of(request: HttpRequest) -> Dict[str, List[str]]:
    return parse_qs(urlsplit(request.url).query)


def path_of(request: HttpRequest) -> str:
    return urlsplit(request.url).path


def body_of(request: HttpRequest) -> Any:
    return json.loads(request.body.decode("utf-8")) if request.body else None


class ReadTests(unittest.TestCase):
    def test_search_events_builds_query_without_key(self) -> None:
        transport = FakeTransport(ok({"data": [{"id": "a1b2c3"}], "meta": {"count": 1}}, headers=RATE_HEADERS))
        client = AoaClient(api_key="", transport=transport)
        response = client.search_events(city="Київ", limit=5)

        self.assertEqual(response.data, [{"id": "a1b2c3"}])
        self.assertEqual(response.meta, {"count": 1})
        request = transport.last
        self.assertEqual(request.method, "GET")
        self.assertEqual(path_of(request), "/api/v1/events")
        self.assertEqual(query_of(request), {"city": ["Київ"], "limit": ["5"]})
        self.assertNotIn("Authorization", request.headers)
        self.assertTrue(request.headers["User-Agent"].startswith(f"aoa-sdk-python/{__version__}"))
        self.assertEqual(client.rate_limit.limit, 60)
        self.assertEqual(client.rate_limit.remaining, 59)
        self.assertEqual(client.rate_limit.reset_seconds, 60)

    def test_key_is_sent_on_reads_when_configured(self) -> None:
        transport = FakeTransport(ok({"data": []}))
        AoaClient(api_key=TEST_KEY, transport=transport).search_locations(bookable=False)
        self.assertEqual(transport.last.headers["Authorization"], f"Bearer {TEST_KEY}")
        self.assertEqual(query_of(transport.last), {"bookable": ["false"]})

    def test_path_params_are_encoded_and_required(self) -> None:
        transport = FakeTransport(ok({"data": {"id": "x"}}))
        client = AoaClient(transport=transport)
        client.get_event("a b/c")
        self.assertEqual(path_of(transport.last), "/api/v1/events/a%20b%2Fc")
        with self.assertRaises(ValueError):
            client.get_event("")
        self.assertEqual(len(transport.requests), 1)

    def test_every_read_operation_hits_its_path(self) -> None:
        transport = FakeTransport(ok({"data": {}}))
        client = AoaClient(transport=transport)
        client.get_location("loc1")
        client.get_table_availability("loc1", "2026-10-01")
        client.get_event_ticket_types("e1")
        client.get_event_availability("e1")
        self.assertEqual(
            [path_of(r) for r in transport.requests],
            [
                "/api/v1/locations/loc1",
                "/api/v1/locations/loc1/availability",
                "/api/v1/events/e1/ticket-types",
                "/api/v1/events/e1/availability",
            ],
        )
        self.assertEqual(query_of(transport.requests[1]), {"date": ["2026-10-01"]})


class WriteTests(unittest.TestCase):
    def test_writes_require_a_key_before_any_request(self) -> None:
        transport = FakeTransport(ok({"data": {}}))
        client = AoaClient(api_key="", transport=transport)
        with self.assertRaises(ValueError):
            client.get_order("p1")
        with self.assertRaises(ValueError):
            client.list_webhooks()
        self.assertEqual(transport.requests, [])

    def test_checkout_sends_body_auth_and_generated_idempotency_key(self) -> None:
        transport = FakeTransport(ok({"data": {"paymentId": "p1", "paymentUrl": "https://pay.example/p1"}}))
        client = AoaClient(api_key=TEST_KEY, agent_provider="my-agent", transport=transport)
        response = client.create_ticket_checkout(
            event_id="a1b2c3",
            tickets=[{"ticketTypeId": "tt1", "quantity": 2}],
            buyer={"email": "buyer@example.com", "name": "Test Buyer"},
        )
        self.assertEqual(response.data["paymentId"], "p1")
        request = transport.last
        self.assertEqual((request.method, path_of(request)), ("POST", "/api/v1/checkout"))
        self.assertEqual(
            body_of(request),
            {
                "eventId": "a1b2c3",
                "tickets": [{"ticketTypeId": "tt1", "quantity": 2}],
                "buyer": {"email": "buyer@example.com", "name": "Test Buyer"},
            },
        )
        self.assertEqual(request.headers["Authorization"], f"Bearer {TEST_KEY}")
        self.assertEqual(request.headers["Content-Type"], "application/json")
        self.assertEqual(request.headers["X-Agent-Provider"], "my-agent")
        self.assertRegex(request.headers["Idempotency-Key"], UUID)

    def test_table_reservation_maps_fields_and_keeps_caller_key(self) -> None:
        transport = FakeTransport(ok({"data": {"reservationId": "r1"}}))
        client = AoaClient(api_key=TEST_KEY, transport=transport)
        client.create_table_reservation(
            location_id="loc1",
            date="2026-10-01",
            time="19:00",
            party_size=2,
            guest={"name": "Typed by the guest", "phone": "+380000000000"},
            confirmed_by_user=True,
            idempotency_key="cart-42-booking",
        )
        request = transport.last
        self.assertEqual(path_of(request), "/api/v1/table-reservations")
        self.assertEqual(request.headers["Idempotency-Key"], "cart-42-booking")
        self.assertEqual(
            body_of(request),
            {
                "locationId": "loc1",
                "date": "2026-10-01",
                "time": "19:00",
                "partySize": 2,
                "guest": {"name": "Typed by the guest", "phone": "+380000000000"},
                "confirmedByUser": True,
            },
        )

    def test_table_reservation_requires_explicit_confirmation(self) -> None:
        transport = FakeTransport(ok({"data": {}}))
        client = AoaClient(api_key=TEST_KEY, transport=transport)
        with self.assertRaises(ValueError):
            client.create_table_reservation(
                location_id="loc1",
                date="2026-10-01",
                time="19:00",
                party_size=2,
                guest={"name": "Typed by the guest", "phone": "+380000000000"},
                confirmed_by_user=False,
            )
        self.assertEqual(transport.requests, [])

    def test_ticket_reservation_has_no_idempotency_key(self) -> None:
        transport = FakeTransport(ok({"data": {"reservationId": "r1"}}))
        AoaClient(api_key=TEST_KEY, transport=transport).create_ticket_reservation(
            event_id="e1", tickets=[{"ticketTypeId": "tt1", "quantity": 1}]
        )
        self.assertEqual(path_of(transport.last), "/api/v1/reservations")
        self.assertNotIn("Idempotency-Key", transport.last.headers)

    def test_webhook_management_verbs(self) -> None:
        transport = FakeTransport(ok({"data": {}}))
        client = AoaClient(api_key=TEST_KEY, transport=transport)
        client.list_webhooks()
        client.create_webhook(url="https://example.com/hooks/aoa", events=["order.paid"])
        client.update_webhook("wh1", is_active=True)
        client.delete_webhook("wh1")
        client.get_order("p1")
        self.assertEqual(
            [f"{r.method} {path_of(r)}" for r in transport.requests],
            [
                "GET /api/v1/webhooks",
                "POST /api/v1/webhooks",
                "PATCH /api/v1/webhooks/wh1",
                "DELETE /api/v1/webhooks/wh1",
                "GET /api/v1/orders/p1",
            ],
        )
        self.assertEqual(body_of(transport.requests[2]), {"isActive": True})
        self.assertIsNone(transport.requests[3].body)


class BatchAndAsyncTests(unittest.TestCase):
    def test_batch_operations(self) -> None:
        transport = FakeTransport(ok({"data": [{"id": "a", "status": 200, "body": {"data": {}}}]}))
        response = AoaClient(api_key="", transport=transport).batch_operations(
            [{"id": "a", "path": "/events/e1/availability"}]
        )
        self.assertEqual(response.data[0]["status"], 200)
        request = transport.last
        self.assertEqual((request.method, path_of(request)), ("POST", "/api/v1/batch"))
        self.assertEqual(body_of(request), {"operations": [{"id": "a", "path": "/events/e1/availability"}]})
        self.assertNotIn("Authorization", request.headers)

    def test_checkout_respond_async(self) -> None:
        transport = FakeTransport(
            ok(
                {
                    "data": {
                        "paymentId": "p1",
                        "paymentUrl": "https://pay.example/p1",
                        "status": "PENDING",
                        "statusUrl": "https://aoa.com.ua/api/v1/orders/p1",
                    }
                },
                status=202,
                headers={"content-type": "application/json", "retry-after": "5"},
            )
        )
        response = AoaClient(api_key=TEST_KEY, transport=transport).create_ticket_checkout(
            event_id="e1",
            tickets=[{"ticketTypeId": "tt1", "quantity": 1}],
            buyer={"email": "buyer@example.com", "name": "Test Buyer"},
            respond_async=True,
        )
        self.assertEqual(response.status, 202)
        self.assertEqual(response.data["statusUrl"], "https://aoa.com.ua/api/v1/orders/p1")
        self.assertEqual(transport.last.headers["Prefer"], "respond-async")


class ErrorTests(unittest.TestCase):
    def test_error_envelope(self) -> None:
        transport = FakeTransport(
            ok({"error": {"code": "not_found", "message": "Event not found", "hint": "Check the id"}}, status=404)
        )
        with self.assertRaises(AoaApiError) as caught:
            AoaClient(transport=transport).get_event("missing")
        error = caught.exception
        self.assertEqual((error.status, error.code, error.message, error.hint), (404, "not_found", "Event not found", "Check the id"))
        self.assertFalse(error.retryable)

    def test_non_json_error(self) -> None:
        transport = FakeTransport(HttpResponse(status=502, body=b"<html>bad gateway</html>", reason="Bad Gateway"))
        with self.assertRaises(AoaApiError) as caught:
            AoaClient(transport=transport).search_events()
        self.assertEqual(caught.exception.code, "http_502")
        self.assertEqual(caught.exception.message, "Bad Gateway")

    def test_429_is_not_retried_by_default(self) -> None:
        headers = dict(RATE_HEADERS, ratelimit='"default";r=0;t=42', **{"retry-after": "42"})
        transport = FakeTransport(ok({"error": {"code": "rate_limited", "message": "Too many requests"}}, status=429, headers=headers))
        with self.assertRaises(AoaApiError) as caught:
            AoaClient(transport=transport).search_events()
        self.assertEqual(caught.exception.code, "rate_limited")
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(caught.exception.rate_limit.retry_after_seconds, 42)
        self.assertEqual(len(transport.requests), 1)

    def test_429_retry_reuses_idempotency_key(self) -> None:
        waits: List[float] = []
        transport = FakeTransport(
            ok({"error": {"code": "rate_limited", "message": "slow down"}}, status=429, headers={"retry-after": "3"}),
            ok({"data": {"paymentId": "p1", "paymentUrl": "https://pay.example/p1"}}),
        )
        client = AoaClient(api_key=TEST_KEY, max_retries=2, transport=transport, sleep=waits.append)
        client.create_ticket_checkout(
            event_id="e1",
            tickets=[{"ticketTypeId": "tt1", "quantity": 1}],
            buyer={"email": "buyer@example.com", "name": "Test Buyer"},
        )
        self.assertEqual(waits, [3.0])
        self.assertEqual(len(transport.requests), 2)
        self.assertEqual(
            transport.requests[0].headers["Idempotency-Key"],
            transport.requests[1].headers["Idempotency-Key"],
        )

    def test_long_retry_after_is_raised(self) -> None:
        waits: List[float] = []
        transport = FakeTransport(ok({"error": {"code": "rate_limited", "message": "x"}}, status=429, headers={"retry-after": "600"}))
        client = AoaClient(max_retries=3, max_retry_delay=10, transport=transport, sleep=waits.append)
        with self.assertRaises(AoaApiError):
            client.search_events()
        self.assertEqual(waits, [])


class PaginationTests(unittest.TestCase):
    def test_follows_next_cursor(self) -> None:
        transport = FakeTransport(
            ok({"data": [{"id": 1}, {"id": 2}], "meta": {"nextCursor": "c2", "hasMore": True}}),
            ok({"data": [{"id": 3}], "meta": {"nextCursor": None, "hasMore": False}}),
        )
        client = AoaClient(transport=transport)
        ids = [event["id"] for event in client.paginate(client.search_events, city="Київ")]
        self.assertEqual(ids, [1, 2, 3])
        self.assertNotIn("cursor", query_of(transport.requests[0]))
        self.assertEqual(query_of(transport.requests[1]), {"city": ["Київ"], "cursor": ["c2"]})


class RateLimitTests(unittest.TestCase):
    def test_parse(self) -> None:
        self.assertIsNone(parse_rate_limit({}))
        info = parse_rate_limit({"X-RateLimit-Limit": "600", "X-RateLimit-Remaining": "10"})
        self.assertEqual((info.limit, info.remaining), (600, 10))
        dated = parse_rate_limit({"Retry-After": "Mon, 21 Sep 2026 12:00:30 GMT"}, now=1789992000.0)
        self.assertEqual(dated.retry_after_seconds, 30)


if __name__ == "__main__":
    unittest.main()
