"""A concrete ``Upstream`` speaking the OpenAI-compatible wire protocol.

One class covers every backend the platform will ever talk to, because they all
converge on ``POST /v1/chat/completions``: our own vLLM fleet, a dedicated
Hugging Face Inference Endpoint, and the multi-provider Hugging Face Inference
Router. Swapping between them is a ``base_url`` change (Doc 03 §1, ADR-0007).

Two distinctions here are load-bearing and are not merely defensive coding.

**Terminal vs transient.** ``ModelRouter`` fails over to the next candidate on
any exception. That is right for "this model is broken" and actively harmful for
"this account cannot pay", where every candidate is guaranteed to fail the same
way — the retry burns latency and emits a misleading audit trail blaming three
models for one billing problem. Failures are therefore typed at the boundary
that actually knows: HTTP 401/402/403 and a malformed request are terminal, and
``TerminalUpstreamError`` is re-raised past the failover loop.

**Cold start is not failure.** A scale-to-zero endpoint answers 503 while it
boots, which for a large model is minutes. Treating that as a dead model would
make the cheapest deployment mode look like the least reliable one, so 503 and
429 are retried against the *same* model with backoff before the router is ever
told the candidate failed.

Error bodies are truncated and the API key is never placed in a header dict that
could reach a log: it is written into the request at dispatch and the exception
types below carry no credential material (invariant I5).
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Final

from .errors import (
    TerminalUpstreamError,
    TransientUpstreamError,
    UpstreamHTTPError,
)
from .upstream import UpstreamRequest, UpstreamResult

#: Error bodies are attacker-influenced (a provider may echo the prompt) and can
#: be megabytes. Enough to diagnose, never enough to fill a log.
_MAX_ERROR_CHARS: Final = 400

#: Retried against the same model rather than failed over. 503 is the documented
#: scale-to-zero cold-start signal; 429 is rate limiting; 5xx is a bad backend.
_TRANSIENT_STATUSES: Final[frozenset[int]] = frozenset({429, 500, 502, 503, 504})

#: No fallback can fix these, so trying one only wastes time and muddies audit.
_TERMINAL_STATUSES: Final[frozenset[int]] = frozenset({400, 401, 402, 403, 404, 422})


@dataclass(frozen=True, slots=True)
class UpstreamEndpoint:
    """Where an OpenAI-compatible backend lives, and how to be a good client of it.

    Attributes:
        base_url: root of the API, with or without a trailing ``/v1``.
        provider: Inference-Router provider pin (e.g. ``"featherless-ai"``).
            Left unset, Hugging Face picks a provider for you, which means the
            data-retention terms your prompts are subject to can change without
            notice. For a platform that puts customer source code in prompts,
            pinning is a compliance control, not a performance tweak.
        bill_to: value for ``X-HF-Bill-To``, to charge an organisation.
        timeout_s: per-attempt socket timeout. The default is deliberately
            above the live latency distribution observed for implementation-tier
            reasoning calls (37s, 58s, 145s, 158s): these models can spend most
            of the wall clock thinking before they emit the first byte, so a
            conventional short HTTP timeout converts healthy work into a false
            provider failure.
        max_attempts: total attempts per model, including the first.
        backoff_s: base delay; doubles per retry.
        scale_up_timeout_s: sent as ``X-Scale-Up-Timeout`` so a scale-to-zero
            endpoint holds the request open instead of returning 503.
        extra_headers: additional headers, never credentials.
    """

    base_url: str
    provider: str | None = None
    bill_to: str | None = None
    timeout_s: float = 180.0
    max_attempts: int = 3
    backoff_s: float = 1.0
    scale_up_timeout_s: int | None = None
    extra_headers: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.base_url.startswith(("http://", "https://")):
            raise ValueError(
                f"base_url must be an http(s) URL, got {self.base_url!r}; "
                "a model endpoint is never reached over another scheme"
            )
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        for name in self.extra_headers:
            if name.lower() == "authorization":
                raise ValueError(
                    "extra_headers must not carry credentials; the api_key is injected "
                    "per request by the router (invariant I5)"
                )

    @property
    def completions_url(self) -> str:
        """Absolute URL of the chat-completions route."""
        root = self.base_url.rstrip("/")
        if not root.endswith("/v1"):
            root = f"{root}/v1"
        return f"{root}/chat/completions"


def _truncate(text: str) -> str:
    if len(text) <= _MAX_ERROR_CHARS:
        return text
    return f"{text[:_MAX_ERROR_CHARS]}… ({len(text)} chars total)"


def build_payload(
    request: UpstreamRequest, *, provider: str | None = None, stream: bool = False
) -> dict[str, Any]:
    """Translate an ``UpstreamRequest`` into an OpenAI chat-completions body.

    Structured output is expressed as ``response_format``/``json_schema`` rather
    than as a plea in the prompt, so the serving engine constrains decoding and
    the result is parseable by construction (Doc 03 §4).
    """
    model = request.model
    if provider:
        model = f"{model}:{provider}"

    payload: dict[str, Any] = {
        "model": model,
        "messages": [dict(message) for message in request.messages],
        "temperature": request.temperature,
        "stream": stream,
    }
    if stream:
        # Ask for a terminal usage chunk so streamed calls stay billable.
        # Providers that ignore it just omit usage, which the parser reads
        # as zero-cost rather than an error.
        payload["stream_options"] = {"include_usage": True}
    if request.max_output_tokens is not None:
        payload["max_tokens"] = request.max_output_tokens
    if request.response_schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "loopit_response",
                "strict": True,
                "schema": dict(request.response_schema),
            },
        }
        # GLM (vLLM) and Qwen (SGLang) both spend the output budget on a
        # reasoning scratchpad before the JSON object. Unbounded thinking
        # holds the socket until the 180s read timeout, which the console
        # surfaces as a stuck "working" spinner. Constrained decoding does
        # not need the scratchpad; this flag is a no-op on engines that
        # ignore it and was verified live against both dedicated endpoints.
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    return payload


def parse_result(body: Mapping[str, Any], *, requested_model: str) -> UpstreamResult:
    """Read a chat-completions response into an ``UpstreamResult``.

    A response with no choices is an error, not an empty string: silently
    returning ``""`` would let the agent loop treat a broken call as a model
    that had nothing to say, and burn an iteration on it.

    The same reasoning applies to the failure mode that reasoning models make
    easy to hit. They write their scratchpad to ``reasoning_content`` and the
    answer to ``content``; if the token budget runs out mid-thought the response
    is a well-formed 200 with an *empty answer*. That must be raised, not
    returned — verified live against Qwen3.5-9B, which spent all 200 tokens
    deliberating over a one-word reply.
    """
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise TerminalUpstreamError(
            f"model {requested_model!r} returned no choices; response keys were {sorted(body)}"
        )

    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    message_map: Mapping[str, Any] = message if isinstance(message, Mapping) else {}
    raw_content = message_map.get("content")
    content = raw_content if isinstance(raw_content, str) else ""
    raw_reasoning = message_map.get("reasoning_content") or message_map.get("reasoning")
    reasoning = raw_reasoning if isinstance(raw_reasoning, str) else ""
    raw_calls = message_map.get("tool_calls")
    tool_calls = (
        tuple(call for call in raw_calls if isinstance(call, Mapping))
        if isinstance(raw_calls, list)
        else ()
    )
    finish_reason = str(first.get("finish_reason") or "stop") if isinstance(first, dict) else "stop"

    usage = body.get("usage")
    usage_map: Mapping[str, Any] = usage if isinstance(usage, Mapping) else {}
    details = usage_map.get("prompt_tokens_details")
    cached = 0
    if isinstance(details, Mapping):
        cached = int(details.get("cached_tokens") or 0)

    if not content and not tool_calls and finish_reason == "length":
        # Terminal on purpose. Decoding is deterministic at temperature 0, so a
        # retry buys the identical truncation at full price, and our fallbacks
        # are the same weights on another provider. The budget is the bug.
        thought = f" after {len(reasoning)} characters of reasoning" if reasoning else ""
        raise TerminalUpstreamError(
            f"model {requested_model!r} hit the output token limit{thought} "
            "without producing an answer; reasoning models need budget for the "
            "scratchpad as well as the reply — the default is unbounded, so an "
            "explicit max_output_tokens pin is the likely cause",
            body=_truncate(reasoning),
        )

    return UpstreamResult(
        content=content,
        input_tokens=int(usage_map.get("prompt_tokens") or 0),
        output_tokens=int(usage_map.get("completion_tokens") or 0),
        cached_input_tokens=cached,
        finish_reason=finish_reason,
        model=str(body.get("model") or requested_model),
        reasoning=reasoning,
        tool_calls=tool_calls,
    )


def classify_status(status: int, *, body: str, model: str) -> UpstreamHTTPError:
    """Turn an HTTP status into the error type that tells the router what to do."""
    detail = _truncate(body)
    if status in _TRANSIENT_STATUSES:
        hint = (
            " (endpoint is scaling up from zero; this is expected on a cold start)"
            if status == 503
            else ""
        )
        return TransientUpstreamError(
            f"model {model!r} returned HTTP {status}{hint}: {detail}",
            status=status,
            body=detail,
        )
    if status in _TERMINAL_STATUSES:
        hint = ""
        if status == 402:
            hint = " — the account has no inference credits; no other model will succeed either"
        elif status in (401, 403):
            hint = " — the injected credential was rejected"
        return TerminalUpstreamError(
            f"model {model!r} returned HTTP {status}{hint}: {detail}",
            status=status,
            body=detail,
        )
    return TransientUpstreamError(
        f"model {model!r} returned unexpected HTTP {status}: {detail}",
        status=status,
        body=detail,
    )


class OpenAICompatibleUpstream:
    """An ``Upstream`` backed by a real HTTP endpoint.

    Satisfies the ``Upstream`` protocol, so ``ModelRouter`` cannot tell whether
    it is talking to vLLM, a dedicated endpoint, or a hosted router.
    """

    def __init__(
        self,
        endpoint: UpstreamEndpoint,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._endpoint = endpoint
        self._sleep = sleep

    @property
    def endpoint(self) -> UpstreamEndpoint:
        return self._endpoint

    def complete(self, request: UpstreamRequest) -> UpstreamResult:
        endpoint = (
            replace(self._endpoint, base_url=request.upstream_base_url)
            if request.upstream_base_url
            else self._endpoint
        )
        payload = build_payload(request, provider=endpoint.provider)
        raw = json.dumps(payload).encode("utf-8")

        last: UpstreamHTTPError | None = None
        for attempt in range(endpoint.max_attempts):
            try:
                body = self._post(
                    raw, api_key=request.api_key, model=request.model, endpoint=endpoint
                )
            except TerminalUpstreamError:
                raise
            except TransientUpstreamError as error:
                last = error
                if attempt + 1 < endpoint.max_attempts:
                    self._sleep(endpoint.backoff_s * (2**attempt))
                continue
            return parse_result(body, requested_model=request.model)

        assert last is not None
        raise last

    def complete_stream(
        self, request: UpstreamRequest, on_token: Callable[[str], None]
    ) -> UpstreamResult:
        """Complete with server-sent events, firing ``on_token`` per content delta.

        Retry semantics are deliberately narrower than ``complete``'s: a failure
        before the first token is safe to retry (nothing was shown), but once
        any token has been emitted a retry would duplicate content the caller
        already mirrored to an operator — so a mid-stream failure is terminal
        for this turn, and the partial text stays visible as evidence.
        """
        endpoint = (
            replace(self._endpoint, base_url=request.upstream_base_url)
            if request.upstream_base_url
            else self._endpoint
        )
        payload = build_payload(request, provider=endpoint.provider, stream=True)
        raw = json.dumps(payload).encode("utf-8")

        emitted = False

        def tracking_on_token(text: str) -> None:
            nonlocal emitted
            if text:
                emitted = True
            on_token(text)

        last: UpstreamHTTPError | None = None
        for attempt in range(endpoint.max_attempts):
            try:
                return self._post_stream(
                    raw,
                    api_key=request.api_key,
                    model=request.model,
                    endpoint=endpoint,
                    on_token=tracking_on_token,
                )
            except TerminalUpstreamError:
                raise
            except TransientUpstreamError as error:
                if emitted:
                    raise TerminalUpstreamError(
                        f"stream from {request.model!r} broke after partial output; "
                        "not retrying because the partial turn was already mirrored"
                    ) from error
                last = error
                if attempt + 1 < endpoint.max_attempts:
                    self._sleep(endpoint.backoff_s * (2**attempt))
                continue

        assert last is not None
        raise last

    def _post_stream(
        self,
        raw: bytes,
        *,
        api_key: str,
        model: str,
        endpoint: UpstreamEndpoint,
        on_token: Callable[[str], None],
    ) -> UpstreamResult:
        url = endpoint.completions_url
        req = urllib.request.Request(  # noqa: S310 - scheme validated in __post_init__
            url,
            data=raw,
            headers=_headers_for(endpoint, api_key),
            method="POST",
        )
        try:
            response = urllib.request.urlopen(  # noqa: S310 - scheme validated in __post_init__
                req, timeout=endpoint.timeout_s
            )
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise classify_status(error.code, body=detail, model=model) from None
        except urllib.error.URLError as error:
            raise TransientUpstreamError(f"could not reach {url}: {error.reason}") from None
        except TimeoutError as error:
            raise TransientUpstreamError(f"timed out reading from {url}: {error}") from None
        except OSError as error:
            raise TransientUpstreamError(f"transport error reading from {url}: {error}") from None

        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        finish_reason = "stop"
        result_model = model
        input_tokens = 0
        output_tokens = 0
        cached_input_tokens = 0

        try:
            with response:
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(chunk, dict):
                        continue

                    usage = chunk.get("usage")
                    if isinstance(usage, Mapping):
                        input_tokens = int(usage.get("prompt_tokens") or input_tokens)
                        output_tokens = int(usage.get("completion_tokens") or output_tokens)
                        details = usage.get("prompt_tokens_details")
                        if isinstance(details, Mapping):
                            cached_input_tokens = int(details.get("cached_tokens") or 0)

                    if isinstance(chunk.get("model"), str):
                        result_model = str(chunk["model"])

                    choices = chunk.get("choices")
                    if not isinstance(choices, list) or not choices:
                        continue
                    first = choices[0]
                    if not isinstance(first, Mapping):
                        continue
                    if isinstance(first.get("finish_reason"), str):
                        finish_reason = str(first["finish_reason"])
                    delta = first.get("delta")
                    if not isinstance(delta, Mapping):
                        continue
                    piece = delta.get("content")
                    if isinstance(piece, str) and piece:
                        content_parts.append(piece)
                        on_token(piece)
                    thinking = delta.get("reasoning_content") or delta.get("reasoning")
                    if isinstance(thinking, str) and thinking:
                        reasoning_parts.append(thinking)
        except (OSError, TimeoutError) as error:
            raise TransientUpstreamError(f"stream from {url} broke mid-read: {error}") from None

        content = "".join(content_parts)
        reasoning = "".join(reasoning_parts)
        if not content and finish_reason == "length":
            thought = f" after {len(reasoning)} characters of reasoning" if reasoning else ""
            raise TerminalUpstreamError(
                f"model {model!r} hit the output token limit{thought} without "
                "producing an answer; reasoning models need budget for the "
                "scratchpad as well as the reply",
                body=_truncate(reasoning),
            )

        return UpstreamResult(
            content=content,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_input_tokens=cached_input_tokens,
            finish_reason=finish_reason,
            model=result_model,
            reasoning=reasoning,
        )

    def _headers(self, api_key: str) -> dict[str, str]:
        return _headers_for(self._endpoint, api_key)

    def _post(
        self,
        raw: bytes,
        *,
        api_key: str,
        model: str,
        endpoint: UpstreamEndpoint | None = None,
    ) -> Mapping[str, Any]:
        resolved = endpoint or self._endpoint
        url = resolved.completions_url
        req = urllib.request.Request(  # noqa: S310 - scheme validated in __post_init__
            url,
            data=raw,
            headers=_headers_for(resolved, api_key),
            method="POST",
        )
        try:
            with urllib.request.urlopen(  # noqa: S310 - scheme validated in __post_init__
                req, timeout=resolved.timeout_s
            ) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise classify_status(error.code, body=detail, model=model) from None
        except urllib.error.URLError as error:
            raise TransientUpstreamError(f"could not reach {url}: {error.reason}") from None
        except TimeoutError as error:
            raise TransientUpstreamError(f"timed out reading from {url}: {error}") from None
        except OSError as error:
            raise TransientUpstreamError(f"transport error reading from {url}: {error}") from None
        except json.JSONDecodeError as error:
            raise TransientUpstreamError(f"{url} returned a non-JSON body: {error}") from None

        if not isinstance(decoded, dict):
            raise TransientUpstreamError(
                f"{url} returned {type(decoded).__name__}, expected object"
            )
        return decoded


def _headers_for(endpoint: UpstreamEndpoint, api_key: str) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if endpoint.bill_to:
        headers["X-HF-Bill-To"] = endpoint.bill_to
    if endpoint.scale_up_timeout_s is not None:
        headers["X-Scale-Up-Timeout"] = str(endpoint.scale_up_timeout_s)
    headers.update(endpoint.extra_headers)
    return headers
