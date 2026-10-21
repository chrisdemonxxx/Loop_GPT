"""Tests for the OpenAI-compatible HTTP upstream.

These run against a real ``http.server`` on loopback rather than a mocked
transport. The whole point of this class is its behaviour on the wire — headers,
status codes, retries — and a mock that returns whatever the test says it
returns would assert only that the test author agrees with themselves.
"""

from __future__ import annotations

import json
import threading
import urllib.request
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_router import (
    ModelRouter,
    ModelSpec,
    OpenAICompatibleUpstream,
    QuotaLedger,
    RoutingPolicy,
    TenantQuota,
    TerminalUpstreamError,
    TransientUpstreamError,
    UpstreamEndpoint,
    UpstreamRequest,
    huggingface_router_policy,
)
from loopit_router.openai_upstream import build_payload, classify_status, parse_result
from loopit_router.upstream import StaticSecretResolver

CHAT_OK: dict[str, Any] = {
    "id": "chatcmpl-1",
    "model": "test/model",
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
    ],
    "usage": {
        "prompt_tokens": 120,
        "completion_tokens": 8,
        "prompt_tokens_details": {"cached_tokens": 100},
    },
}


@dataclass
class Recorded:
    """What the fake server saw."""

    path: str
    headers: Mapping[str, str]
    body: dict[str, Any]


@dataclass
class FakeUpstreamServer:
    """A scripted OpenAI-compatible server.

    ``script`` is a list of ``(status, body)`` consumed one per request, so a
    test can make the first call fail and the second succeed and thereby observe
    retry behaviour rather than assume it.
    """

    script: list[tuple[int, Any]]
    requests: list[Recorded] = field(default_factory=list)

    def __post_init__(self) -> None:
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                server_self.requests.append(
                    Recorded(
                        path=self.path,
                        headers={k.lower(): v for k, v in self.headers.items()},
                        body=json.loads(raw) if raw else {},
                    )
                )
                index = min(len(server_self.requests) - 1, len(server_self.script) - 1)
                status, payload = server_self.script[index]
                encoded = (
                    payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
                )
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *args: Any) -> None:
                return

        self._httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host!s}:{port}"

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def server() -> Iterator[FakeUpstreamServer]:
    made: list[FakeUpstreamServer] = []

    def _factory(script: list[tuple[int, Any]]) -> FakeUpstreamServer:
        instance = FakeUpstreamServer(script=script)
        made.append(instance)
        return instance

    yield _factory  # type: ignore[misc]
    for instance in made:
        instance.close()


def request_for(model: str = "test/model", **kwargs: Any) -> UpstreamRequest:
    defaults: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": "hello"}],
        "api_key": "secret-key-value",
    }
    defaults.update(kwargs)
    return UpstreamRequest(**defaults)


# --------------------------------------------------------------------------
# Endpoint configuration
# --------------------------------------------------------------------------


def test_completions_url_appends_v1_once() -> None:
    assert (
        UpstreamEndpoint(base_url="https://x.test").completions_url
        == "https://x.test/v1/chat/completions"
    )
    assert (
        UpstreamEndpoint(base_url="https://x.test/v1/").completions_url
        == "https://x.test/v1/chat/completions"
    )


def test_non_http_scheme_is_refused() -> None:
    with pytest.raises(ValueError, match="http"):
        UpstreamEndpoint(base_url="file:///etc/passwd")


def test_extra_headers_may_not_carry_credentials() -> None:
    """The key belongs to the request, not to static config (invariant I5)."""
    with pytest.raises(ValueError, match="credentials"):
        UpstreamEndpoint(base_url="https://x.test", extra_headers={"Authorization": "Bearer x"})


# --------------------------------------------------------------------------
# Payload construction
# --------------------------------------------------------------------------


def test_schema_becomes_response_format_not_a_prompt() -> None:
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}
    payload = build_payload(request_for(response_schema=schema))
    assert payload["response_format"]["type"] == "json_schema"
    assert payload["response_format"]["json_schema"]["strict"] is True
    assert payload["response_format"]["json_schema"]["schema"] == schema
    # The schema must not have been smuggled into the conversation.
    assert "properties" not in json.dumps(payload["messages"])
    # Constrained JSON does not need a reasoning scratchpad; leaving thinking
    # on is what made dedicated GLM/Qwen endpoints hang until the 180s timeout.
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}


def test_unstructured_payload_leaves_thinking_enabled() -> None:
    payload = build_payload(request_for())
    assert "chat_template_kwargs" not in payload
    assert "response_format" not in payload


def test_provider_pin_is_appended_to_model_id() -> None:
    payload = build_payload(request_for(), provider="deepinfra")
    assert payload["model"] == "test/model:deepinfra"


def test_streaming_is_off() -> None:
    """The router accounts for whole responses; a stream has no usage block."""
    assert build_payload(request_for())["stream"] is False


# --------------------------------------------------------------------------
# Response parsing
# --------------------------------------------------------------------------


def test_cached_tokens_are_parsed_so_they_can_be_discounted() -> None:
    result = parse_result(CHAT_OK, requested_model="test/model")
    assert (result.input_tokens, result.output_tokens, result.cached_input_tokens) == (120, 8, 100)


def test_empty_choices_is_an_error_not_an_empty_string() -> None:
    """Returning '' would look to the agent like a model with nothing to say."""
    with pytest.raises(TerminalUpstreamError, match="no choices"):
        parse_result({"usage": {}}, requested_model="test/model")


def test_missing_usage_does_not_crash_billing() -> None:
    body = {"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}]}
    result = parse_result(body, requested_model="test/model")
    assert (result.input_tokens, result.output_tokens) == (0, 0)


# --------------------------------------------------------------------------
# Reasoning models — observed live, not hypothesised
# --------------------------------------------------------------------------


def test_reasoning_is_captured_separately_from_the_answer() -> None:
    """Folding the scratchpad into content would corrupt every patch and parse."""
    body = {
        "choices": [
            {
                "message": {"content": "ok", "reasoning_content": "let me think..."},
                "finish_reason": "stop",
            }
        ]
    }
    result = parse_result(body, requested_model="test/model")
    assert result.content == "ok"
    assert result.reasoning == "let me think..."


def test_thinking_until_the_budget_runs_out_is_an_error_not_an_empty_answer() -> None:
    """Live-observed: Qwen3.5-9B spent 200 tokens deliberating a one-word reply.

    A well-formed 200 with empty content is the nastiest possible failure — it
    looks like success to every layer above.
    """
    body = {
        "choices": [
            {
                "message": {"content": "", "reasoning_content": "Thinking Process: ..."},
                "finish_reason": "length",
            }
        ],
        "usage": {"prompt_tokens": 17, "completion_tokens": 200},
    }
    with pytest.raises(TerminalUpstreamError, match="hit the output token limit"):
        parse_result(body, requested_model="Qwen/Qwen3.5-9B")


def test_truncation_after_a_partial_answer_is_kept() -> None:
    """Half an answer is still evidence; only a *content-free* truncation is fatal."""
    body = {
        "choices": [{"message": {"content": "def rev(s):"}, "finish_reason": "length"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 10},
    }
    result = parse_result(body, requested_model="test/model")
    assert result.content == "def rev(s):"
    assert result.finish_reason == "length"


# --------------------------------------------------------------------------
# Status classification — the retry/failover contract
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_transient_statuses_are_retryable(status: int) -> None:
    assert isinstance(classify_status(status, body="", model="m"), TransientUpstreamError)


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 422])
def test_terminal_statuses_are_not_retryable(status: int) -> None:
    assert isinstance(classify_status(status, body="", model="m"), TerminalUpstreamError)


def test_cold_start_503_is_explained_rather_than_reported_as_a_dead_model() -> None:
    error = classify_status(503, body="scaling", model="m")
    assert "scaling up from zero" in str(error)


def test_402_says_that_failover_will_not_help() -> None:
    error = classify_status(402, body="no credits", model="m")
    assert "no other model will succeed" in str(error)


def test_error_bodies_are_truncated() -> None:
    error = classify_status(500, body="x" * 10_000, model="m")
    assert len(error.body) < 600
    assert "10000 chars total" in error.body


# --------------------------------------------------------------------------
# Live HTTP behaviour
# --------------------------------------------------------------------------


def test_successful_call_sends_bearer_token_and_returns_usage(server: Any) -> None:
    fake = server([(200, CHAT_OK)])
    upstream = OpenAICompatibleUpstream(UpstreamEndpoint(base_url=fake.base_url))

    result = upstream.complete(request_for())

    assert result.content == "ok"
    assert result.total_tokens == 128
    seen = fake.requests[0]
    assert seen.path == "/v1/chat/completions"
    assert seen.headers["authorization"] == "Bearer secret-key-value"
    assert seen.body["model"] == "test/model"


def test_bill_to_and_scale_up_headers_are_sent(server: Any) -> None:
    fake = server([(200, CHAT_OK)])
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, bill_to="red-kit", scale_up_timeout_s=600)
    )

    upstream.complete(request_for())

    headers = fake.requests[0].headers
    assert headers["x-hf-bill-to"] == "red-kit"
    assert headers["x-scale-up-timeout"] == "600"


def test_cold_start_is_retried_on_the_same_model(server: Any) -> None:
    """503 then 200 must yield a result, not a failure."""
    fake = server([(503, {"error": "scaling"}), (200, CHAT_OK)])
    slept: list[float] = []
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, backoff_s=0.01), sleep=slept.append
    )

    assert upstream.complete(request_for()).content == "ok"
    assert len(fake.requests) == 2
    assert slept == [0.01]


def test_retries_are_bounded_and_back_off(server: Any) -> None:
    fake = server([(503, {"error": "scaling"})])
    slept: list[float] = []
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, max_attempts=3, backoff_s=0.01),
        sleep=slept.append,
    )

    with pytest.raises(TransientUpstreamError):
        upstream.complete(request_for())
    assert len(fake.requests) == 3
    assert slept == [0.01, 0.02]


def test_read_timeout_is_classified_transient_and_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A socket read timeout is retryable; it is not a raw ``TimeoutError``."""
    attempts: list[float] = []
    slept: list[float] = []

    def timeout_urlopen(
        request: urllib.request.Request,
        *,
        timeout: float,
    ) -> object:
        attempts.append(timeout)
        raise TimeoutError("The read operation timed out")

    monkeypatch.setattr(urllib.request, "urlopen", timeout_urlopen)
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(
            base_url="https://x.test",
            timeout_s=0.5,
            max_attempts=3,
            backoff_s=0.01,
        ),
        sleep=slept.append,
    )

    with pytest.raises(TransientUpstreamError, match="timed out reading"):
        upstream.complete(request_for())

    assert attempts == [0.5, 0.5, 0.5]
    assert slept == [0.01, 0.02]


def test_terminal_status_is_not_retried(server: Any) -> None:
    fake = server([(402, {"error": "depleted"})])
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, max_attempts=5), sleep=lambda _: None
    )

    with pytest.raises(TerminalUpstreamError):
        upstream.complete(request_for())
    assert len(fake.requests) == 1, "a billing failure must not be retried"


def test_non_json_body_is_transient(server: Any) -> None:
    fake = server([(200, "<html>gateway</html>")])
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, max_attempts=1), sleep=lambda _: None
    )

    with pytest.raises(TransientUpstreamError, match="non-JSON"):
        upstream.complete(request_for())


def test_api_key_never_appears_in_the_error(server: Any) -> None:
    """A traceback lands in logs; a key in a traceback is a leaked key."""
    fake = server([(500, {"error": "boom"})])
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, max_attempts=1), sleep=lambda _: None
    )

    with pytest.raises(TransientUpstreamError) as caught:
        upstream.complete(request_for(api_key="super-secret-abc123"))
    assert "super-secret-abc123" not in repr(caught.value)


# --------------------------------------------------------------------------
# Integration with ModelRouter
# --------------------------------------------------------------------------


def _router(upstream: Any, policy: RoutingPolicy, sink: InMemoryAuditSink) -> ModelRouter:
    ledger = QuotaLedger()
    ledger.set_quota(TenantQuota(tenant_id="t1", credit_limit=100.0))
    return ModelRouter(
        policy=policy,
        upstream=upstream,
        ledger=ledger,
        secrets=StaticSecretResolver({"secrets://models/hf-router": "k"}),
        audit=sink,
    )


def test_router_end_to_end_over_http(server: Any) -> None:
    fake = server([(200, CHAT_OK)])
    upstream = OpenAICompatibleUpstream(UpstreamEndpoint(base_url=fake.base_url))
    sink = InMemoryAuditSink()

    result = _router(upstream, huggingface_router_policy(), sink).complete(
        tenant_id="t1", difficulty="implementation", messages=[{"role": "user", "content": "hi"}]
    )

    assert result.content == "ok"
    assert fake.requests[0].body["model"] == "Qwen/Qwen3.8-27B:deepinfra"
    success = [e for e in sink.events if e.outcome == "success"]
    assert len(success) == 1
    cost = success[0].cost
    assert cost is not None
    # 20 uncached input tokens and 8 output at the coder's rates.
    assert cost["credits"] == pytest.approx(20 / 1000 * 0.00040 + 8 / 1000 * 0.00300)


def test_router_does_not_fail_over_on_a_billing_failure(server: Any) -> None:
    """The real bug this guards: 402 on every candidate is one fault, not three."""
    fake = server([(402, {"error": "depleted"})])
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, max_attempts=1), sleep=lambda _: None
    )
    sink = InMemoryAuditSink()

    with pytest.raises(TerminalUpstreamError):
        _router(upstream, huggingface_router_policy(), sink).complete(
            tenant_id="t1", difficulty="planning", messages=[{"role": "user", "content": "hi"}]
        )

    assert len(fake.requests) == 1, "must not try the fallback provider"
    failures = [e for e in sink.events if e.outcome == "failure"]
    assert len(failures) == 1
    assert failures[0].detail["terminal"] is True
    assert failures[0].detail["failover_skipped"] == 1


def test_router_still_fails_over_on_a_transient_failure(server: Any) -> None:
    fake = server([(500, {"error": "boom"}), (200, CHAT_OK)])
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=fake.base_url, max_attempts=1), sleep=lambda _: None
    )
    sink = InMemoryAuditSink()

    result = _router(upstream, huggingface_router_policy(), sink).complete(
        tenant_id="t1", difficulty="planning", messages=[{"role": "user", "content": "hi"}]
    )

    assert result.content == "ok"
    # Candidate 1 failed, candidate 2 was tried; the fallback stayed in-class.
    assert fake.requests[1].body["model"] == "zai-org/GLM-5.3:fireworks-ai"


# --------------------------------------------------------------------------
# The live policy
# --------------------------------------------------------------------------


def test_live_policy_pins_a_provider_for_every_model() -> None:
    """An unpinned model can silently change which company holds the prompt."""
    for spec in huggingface_router_policy().routes.values():
        for model in spec:
            assert ":" in model.name, f"{model.name} does not pin a provider"


def test_live_policy_fallbacks_never_change_the_weights() -> None:
    for difficulty, specs in huggingface_router_policy().routes.items():
        repos = {spec.name.split(":")[0] for spec in specs}
        assert len(repos) == 1, f"{difficulty} falls back to different weights: {repos}"


def test_live_policy_tracks_a_license_for_every_model() -> None:
    licenses = huggingface_router_policy().licenses()
    assert set(licenses.values()) <= {"apache-2.0", "mit", "glm-5.3"}
    assert "glm-5.3" in licenses.values()
    assert len(licenses) == 6


def test_live_policy_costs_more_as_difficulty_rises() -> None:
    policy = huggingface_router_policy()
    cost = {
        d: policy.candidates(d)[0].credits_for(1000, 1000)
        for d in ("trivial", "implementation", "planning")
    }
    assert cost["trivial"] < cost["implementation"]
    assert cost["trivial"] < cost["planning"]


def test_a_model_spec_may_not_embed_a_hugging_face_key() -> None:
    # Assembled at runtime: a token-shaped literal in the repo would trip the
    # I2 secret guard, and a guard you teach to ignore test files is not a guard.
    looks_like_a_token = "hf_" + "A" * 34
    with pytest.raises(Exception, match="literal API key"):
        ModelSpec(
            name="Qwen/Qwen3.6-27B",
            backend="managed",
            credential_ref=looks_like_a_token,
            license_id="apache-2.0",
        )


SSE_BODY = (
    'data: {"choices": [{"delta": {"content": "Hel"}, "finish_reason": null}], "model": "test/model"}\n'
    "\n"
    'data: {"choices": [{"delta": {"content": "lo"}, "finish_reason": null}], "model": "test/model"}\n'
    "\n"
    'data: {"choices": [{"delta": {"reasoning_content": "hmm"}, "finish_reason": null}]}\n'
    "\n"
    'data: {"choices": [{"delta": {}, "finish_reason": "stop"}], "model": "test/model"}\n'
    "\n"
    'data: {"usage": {"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 4}}}\n'
    "\n"
    "data: [DONE]\n"
)


def test_complete_stream_fires_tokens_and_keeps_usage(server) -> None:
    srv = server([(200, SSE_BODY)])
    upstream = OpenAICompatibleUpstream(UpstreamEndpoint(base_url=srv.base_url))
    tokens: list[str] = []

    result = upstream.complete_stream(request_for(), tokens.append)

    assert tokens == ["Hel", "lo"]
    assert result.content == "Hello"
    assert result.reasoning == "hmm"
    assert result.input_tokens == 10
    assert result.output_tokens == 2
    assert result.cached_input_tokens == 4
    assert srv.requests[0].body["stream"] is True
    assert srv.requests[0].body["stream_options"] == {"include_usage": True}


def test_complete_stream_retries_a_failure_before_any_token(server) -> None:
    srv = server([(503, {"error": "booting"}), (200, SSE_BODY)])
    upstream = OpenAICompatibleUpstream(
        UpstreamEndpoint(base_url=srv.base_url, backoff_s=0.0), sleep=lambda _: None
    )
    tokens: list[str] = []

    result = upstream.complete_stream(request_for(), tokens.append)

    assert result.content == "Hello"
    assert len(srv.requests) == 2


def test_a_stream_broken_after_partial_output_is_terminal(server) -> None:
    """Once a token has been mirrored to an operator, a retry would duplicate
    it — so a mid-stream failure fails the turn instead of failing over."""
    srv = server([(200, SSE_BODY)])
    upstream = OpenAICompatibleUpstream(UpstreamEndpoint(base_url=srv.base_url, backoff_s=0.0))

    def exploding_token(_: str) -> None:
        raise TransientUpstreamError("simulated mid-stream break")

    with pytest.raises(TerminalUpstreamError, match="partial output"):
        upstream.complete_stream(request_for(), exploding_token)
