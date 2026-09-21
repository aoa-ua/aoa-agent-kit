"""The default urllib transport against a local HTTP server (no internet)."""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from aoa_sdk import AoaApiError, AoaClient


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # keep test output clean
        pass

    def _send(self, status: int, body: dict, headers: dict = None) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path.startswith("/api/v1/events?"):
            self._send(
                200,
                {"data": [{"id": "e1"}], "meta": {"query": self.path.split("?", 1)[1]}},
                {"RateLimit-Policy": '"default";q=60;w=60', "RateLimit": '"default";r=58;t=60'},
            )
        elif self.path == "/api/v1/redirect/x":
            self.send_response(302)
            self.send_header("Location", "https://example.com/elsewhere")
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self._send(404, {"error": {"code": "not_found", "message": "Nope"}})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        received = json.loads(self.rfile.read(length) or b"{}")
        self._send(
            200,
            {
                "data": {
                    "body": received,
                    "idempotencyKey": self.headers.get("Idempotency-Key"),
                    "authorization": self.headers.get("Authorization"),
                }
            },
        )


class UrllibTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.base_url = f"http://{host}:{port}/api/v1"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_get_with_query_and_rate_limit(self) -> None:
        client = AoaClient(api_key="", base_url=self.base_url)
        response = client.search_events(city="Kyiv", limit=2)
        self.assertEqual(response.data, [{"id": "e1"}])
        self.assertEqual(response.meta["query"], "city=Kyiv&limit=2")
        self.assertEqual(client.rate_limit.remaining, 58)

    def test_http_error_becomes_api_error(self) -> None:
        client = AoaClient(api_key="", base_url=self.base_url)
        with self.assertRaises(AoaApiError) as caught:
            client.get_event("missing")
        self.assertEqual((caught.exception.status, caught.exception.code), (404, "not_found"))

    def test_post_json(self) -> None:
        client = AoaClient(api_key="aoa_live_test_key_not_real", base_url=self.base_url)
        response = client.create_ticket_reservation(
            event_id="e1", tickets=[{"ticketTypeId": "tt1", "quantity": 1}]
        )
        self.assertEqual(response.data["body"]["eventId"], "e1")
        self.assertEqual(response.data["authorization"], "Bearer aoa_live_test_key_not_real")

    def test_redirects_are_not_followed(self) -> None:
        client = AoaClient(api_key="aoa_live_test_key_not_real", base_url=self.base_url)
        with self.assertRaises(AoaApiError) as caught:
            client.request("GET", "/redirect/x")
        self.assertEqual(caught.exception.status, 302)


if __name__ == "__main__":
    unittest.main()
