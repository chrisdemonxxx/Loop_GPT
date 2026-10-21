"""The upstream boundary: everything behind an OpenAI-compatible surface.

Whether a model is served by our own vLLM fleet or by a hosted API, it is
reached through this one interface. That is what makes model choice a
configuration change rather than a code change, and what keeps a hosted
fallback available on day one without a rewrite (Doc 03 §1, ADR-0007).

Structured output is a first-class field, not a prompt convention: constrained
decoding at the serving layer is what makes tool calls parseable reliably
enough to build a loop on (Doc 03 §4).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class UpstreamRequest:
    """One inference request, after the router has chosen a model.

    ``api_key`` is filled in by the router immediately before dispatch and never
    travels back toward the sandbox (invariant I5).
    """

    model: str
    messages: Sequence[Mapping[str, Any]]
    api_key: str
    upstream_base_url: str | None = None
    response_schema: Mapping[str, Any] | None = None
    max_output_tokens: int | None = None
    temperature: float = 0.0
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def uses_structured_output(self) -> bool:
        return self.response_schema is not None


@dataclass(frozen=True, slots=True)
class UpstreamResult:
    """One inference response, with the token accounting needed to bill it.

    ``reasoning`` is kept separate from ``content`` rather than concatenated.
    Reasoning models emit their scratchpad in a distinct field, and folding it
    into the answer would corrupt every structured parse and every patch the
    agent produces — while discarding it entirely would hide tokens the tenant
    is nonetheless charged for.

    ``credits`` is zero at the transport layer, which knows tokens but not
    prices, and is filled in by the router, which owns the model's rate card.
    """

    content: str
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int = 0
    finish_reason: str = "stop"
    model: str = ""
    reasoning: str = ""
    credits: float = 0.0
    tool_calls: tuple[Mapping[str, Any], ...] = ()

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@runtime_checkable
class Upstream(Protocol):
    """A serving backend reachable over an OpenAI-compatible API."""

    def complete(self, request: UpstreamRequest) -> UpstreamResult: ...


@runtime_checkable
class StreamingUpstream(Protocol):
    """An upstream that can deliver tokens as they are generated.

    Kept separate from :class:`Upstream` so a backend that only speaks the
    one-shot protocol stays a valid ``Upstream``: the router checks for this
    capability and degrades to "one chunk at the end" rather than demanding
    it of every backend.
    """

    def complete_stream(
        self, request: UpstreamRequest, on_token: Callable[[str], None]
    ) -> UpstreamResult: ...


@runtime_checkable
class SecretResolver(Protocol):
    """Resolves a ``credential_ref`` to a live credential, server-side only.

    Production implementation is short-TTL dynamic secrets from Vault
    (ADR-0013). Resolution happens inside the router process; the resolved value
    is never logged, never returned to a caller, and never enters a sandbox.
    """

    def resolve(self, credential_ref: str) -> str: ...


class StaticSecretResolver:
    """A resolver backed by an in-process map, for tests and local development."""

    def __init__(self, secrets: Mapping[str, str]) -> None:
        self._secrets = dict(secrets)

    def resolve(self, credential_ref: str) -> str:
        try:
            return self._secrets[credential_ref]
        except KeyError:
            raise KeyError(f"no credential registered for {credential_ref!r}") from None
