"""The model client interface (Doc 03 §2).

The harness never talks to an inference backend directly. It talks to the
control-plane model router, which injects credentials server-side, enforces
per-tenant quota, routes by task difficulty, and emits cost to the audit log.
That indirection is invariant I5 and it is what makes open model choice safe:
the sandbox holds no key, so there is no key to steal.

Model *selection* is deliberately absent from this module. Never hard-code a
model; the router decides, and the eval harness decides what the router should
prefer.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

Role = Literal["system", "user", "assistant", "tool"]

#: Difficulty classes the router maps to concrete models. Sending a one-line CSS
#: tweak to a 200B planner is the single biggest avoidable cost in the platform.
Difficulty = Literal["trivial", "implementation", "planning"]


@dataclass(frozen=True, slots=True)
class Message:
    """One turn in the conversation sent to the router."""

    role: Role
    content: str


@dataclass(frozen=True, slots=True)
class ModelResponse:
    """A completion, plus the accounting the control plane needs."""

    content: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    credits: float = 0.0
    tool_call: Mapping[str, Any] | None = None
    finish_reason: str = "stop"

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def cache_hit_fraction(self) -> float:
        """Share of prompt tokens served from the prefix cache.

        The harness prefix is long and byte-stable by design, so this should run
        high. A sudden drop usually means something mutable crept in front of
        the stable prefix (Doc 04 §4).
        """
        if self.input_tokens <= 0:
            return 0.0
        return self.cached_input_tokens / self.input_tokens

    def cost_payload(self) -> dict[str, Any]:
        """The ``cost`` block for an audit event."""
        return {
            "model": self.model,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "credits": self.credits,
        }


@runtime_checkable
class ModelClient(Protocol):
    """Anything that can complete a conversation via the router."""

    def complete(
        self,
        messages: Sequence[Message],
        *,
        difficulty: Difficulty,
        response_schema: Mapping[str, Any] | None = None,
        on_token: Callable[[str], None] | None = None,
    ) -> ModelResponse:
        """Complete ``messages``.

        Args:
            messages: the conversation. The stable system prefix must come
                first and stay byte-identical across calls so the router's
                automatic prefix caching keeps hitting.
            difficulty: routing hint. The router owns the mapping to a model.
            response_schema: when supplied, the router constrains decoding to
                this JSON Schema, so tool calls and task DAGs validate by
                construction instead of being parsed hopefully.
            on_token: when supplied, fired with each content fragment as the
                model generates it, so an operator watches the turn being
                written instead of staring at a spinner. Clients that cannot
                stream fire it once with the full content.
        """
        ...


@dataclass(slots=True)
class ScriptedModelClient:
    """A deterministic client for tests and eval fixtures.

    Real inference is non-deterministic, which makes it useless for asserting
    loop mechanics. This replays a fixed script so tests exercise the harness,
    not the model.
    """

    script: list[ModelResponse]
    calls: list[tuple[tuple[Message, ...], Difficulty]] = field(default_factory=list)

    def complete(
        self,
        messages: Sequence[Message],
        *,
        difficulty: Difficulty,
        response_schema: Mapping[str, Any] | None = None,
        on_token: Callable[[str], None] | None = None,
    ) -> ModelResponse:
        self.calls.append((tuple(messages), difficulty))
        if not self.script:
            raise AssertionError("ScriptedModelClient exhausted: the loop made an extra call")
        response = self.script.pop(0)
        if on_token is not None and response.content:
            on_token(response.content)
        return response
