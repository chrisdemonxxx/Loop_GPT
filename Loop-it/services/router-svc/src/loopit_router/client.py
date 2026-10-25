"""Adapter: the agent harness's ``ModelClient``, backed by the real router.

``agent-core`` defines ``ModelClient`` and ships only a scripted implementation,
because the harness must not know that HTTP or model vendors exist. This is the
one place the two halves meet, and it lives in ``router-svc`` — which already
depends on ``agent-core`` — so the dependency arrow never reverses and the
sandbox-side package stays free of transport code (invariant I5).

The interesting work here is tool calls. The contract in
``packages/contracts/schemas/tool-call.schema.json`` is expressive — per-tool
``if``/``then`` branches, ``additionalProperties: false``, a path pattern with
negative lookaheads — and none of that survives a translation to the strict
subset of JSON Schema that constrained decoding supports. So the two jobs are
split the way the schema's own description says they should be: decoding is
constrained by a simple *envelope* that guarantees well-formed JSON with the
right shape, and the full contract is enforced on receipt by
``validate_tool_call``. Constrained decoding buys parseability; it is not, and
must not be mistaken for, authorization.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

#: Reasoning models spend the scratchpad before the answer. Measured live, a
#: 4096 budget truncates the coder class mid-thought (well-formed HTTP 200,
#: empty content). 16384 is the floor the HF runbook and RouterModelClient share.
DEFAULT_MAX_OUTPUT_TOKENS: Final[int] = 16384


def max_output_tokens_from_env(default: int | None = None) -> int | None:
    """Operator override for the per-call output budget.

    Unset (or ``unbounded``/``none``) means unbounded: no ``max_tokens`` is
    sent upstream, so the model writes until it is done. A positive int pins
    a budget. Anything else is a configuration error, not a silent fallback —
    the reasoning floor this function used to default to (16384) masked
    empty-answer truncations by capping output, which is exactly the failure
    the operator reported as builds dying mid-patch.
    """
    raw = os.environ.get("LOOPIT_MAX_OUTPUT_TOKENS", "").strip()
    if not raw or raw.lower() in {"unbounded", "none"}:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(
            f"LOOPIT_MAX_OUTPUT_TOKENS must be a positive integer, not {raw!r}"
        ) from exc
    if value <= 0:
        raise ValueError(f"LOOPIT_MAX_OUTPUT_TOKENS must be a positive integer, not {value}")
    return value

from loopit_agent_core.model import Difficulty, Message, ModelResponse

from .router import ModelRouter

#: The envelope that constrained decoding can actually express. Deliberately
#: permissive about ``args``: per-tool argument rules are enforced after receipt
#: against the real contract, where a rejection produces a correction the agent
#: can act on rather than a decoding failure it cannot see.
TOOL_CALL_ENVELOPE: Final[Mapping[str, Any]] = {
    "type": "object",
    "properties": {
        "tool": {
            "type": "string",
            "enum": [
                "read_file",
                "search_code",
                "apply_patch",
                "run_shell",
                "browser",
                "provision",
                "deploy",
            ],
        },
        "args": {"type": "object"},
        "reason": {"type": "string"},
    },
    "required": ["tool", "args"],
    "additionalProperties": False,
}


def _coerce_native_tool_call(call: Mapping[str, Any]) -> dict[str, Any] | None:
    """Translate an OpenAI-style ``tool_calls`` entry into our contract shape.

    Providers differ on whether a constrained response arrives as content or as
    a native tool call, so both paths are supported. ``arguments`` is a JSON
    *string* in the OpenAI protocol; a provider that emits invalid JSON there
    yields ``None`` and is handled as "no tool call", which the loop already
    treats as a stall rather than a crash.
    """
    function = call.get("function")
    if not isinstance(function, Mapping):
        return None
    name = function.get("name")
    if not isinstance(name, str):
        return None

    raw_args = function.get("arguments")
    if isinstance(raw_args, Mapping):
        args: Any = dict(raw_args)
    elif isinstance(raw_args, str):
        try:
            args = json.loads(raw_args or "{}")
        except json.JSONDecodeError:
            return None
    else:
        args = {}
    if not isinstance(args, dict):
        return None

    payload: dict[str, Any] = {"tool": name, "args": args}
    call_id = call.get("id")
    if isinstance(call_id, str) and call_id:
        payload["call_id"] = call_id
    return payload


def extract_tool_call(
    content: str, tool_calls: Sequence[Mapping[str, Any]]
) -> dict[str, Any] | None:
    """Recover a contract-shaped tool call from a completion.

    Native ``tool_calls`` win when present: they are the provider's own
    structured channel and cannot be confused with prose. Otherwise the content
    is parsed as JSON, which is safe to attempt only because decoding was
    constrained to the envelope. Free-form parsing of unconstrained prose is
    exactly what the contract forbids, so anything unparseable returns ``None``
    and the loop reports a stall instead of guessing at intent.
    """
    for call in tool_calls:
        coerced = _coerce_native_tool_call(call)
        if coerced is not None:
            return coerced

    text = content.strip()
    if not text:
        return None
    # Some models fence JSON even under constrained decoding.
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[: -len("```")]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


#: Roles the OpenAI chat protocol accepts without additional bookkeeping.
#: ``tool`` is absent on purpose — see ``_wire_messages``.
_PASSTHROUGH_ROLES: Final[frozenset[str]] = frozenset({"system", "user", "assistant"})


_CANNOT_SEE_IMAGES = "This model cannot see images, so the attached image was not sent."


def _vision_enabled() -> bool:
    import os

    return os.environ.get("LOOPIT_VISION_ENABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _model_accepts_images(router: Any, difficulty: str) -> bool:
    """True when vision expansion is on and the routed model can take images."""
    if not _vision_enabled():
        return False
    policy = getattr(router, "policy", None)
    candidates = getattr(policy, "candidates", None)
    if not callable(candidates):
        return False
    try:
        specs = candidates(difficulty)
    except Exception:
        return False
    if not specs:
        return False
    tags = getattr(specs[0], "capability_tags", ()) or ()
    return "vision" in tags


def _redact_unseen_images(content: str) -> str:
    """Replace image attachment URLs the routed model would ignore."""
    import re

    image_ext_re = re.compile(r"\.(png|jpe?g|gif|webp|bmp)(\?|$)", re.IGNORECASE)
    lines: list[str] = []
    in_attachments = False
    for line in content.splitlines():
        if line.startswith("ATTACHMENTS"):
            in_attachments = True
            lines.append(line)
            continue
        if in_attachments and line.startswith("- http"):
            url = line[2:].strip()
            if image_ext_re.search(url) or "/api/files/" in url:
                lines.append(f"- {_CANNOT_SEE_IMAGES}")
                continue
        if in_attachments and line and not line.startswith("-") and not line.startswith(" "):
            in_attachments = False
        lines.append(line)
    return "\n".join(lines)


def _wire_messages(
    messages: Sequence[Message], *, accepts_images: bool = False
) -> list[dict[str, Any]]:
    """Render the harness transcript as OpenAI chat messages.

    ``role: "tool"`` is rewritten to ``"user"``. When the routed model can take
    images, user turns that list image attachment URLs are expanded to OpenAI
    multimodal ``image_url`` parts. Otherwise those URLs are replaced with a
    note — a URL the model cannot see is not sent.
    """
    wire: list[dict[str, Any]] = []
    for message in messages:
        role = message.role if message.role in _PASSTHROUGH_ROLES else "user"
        content: Any = message.content
        if role == "user" and isinstance(message.content, str) and "ATTACHMENTS" in message.content:
            if not accepts_images:
                content = _redact_unseen_images(message.content)
            else:
                urls = _attachment_image_urls(message.content)
                if urls:
                    parts: list[dict[str, Any]] = [{"type": "text", "text": message.content}]
                    for url in urls[:8]:
                        parts.append({"type": "image_url", "image_url": {"url": url}})
                    content = parts
        wire.append({"role": role, "content": content})
    return wire


def _attachment_image_urls(content: str) -> list[str]:
    """Image URLs listed under ATTACHMENTS, not every link in the turn.

    A pasted Build image is either a file with an image extension or the
    ``/api/files/…/content`` fallback. Other https links stay text.
    """
    import re

    image_ext_re = re.compile(r"\.(png|jpe?g|gif|webp|bmp)(\?|$)", re.IGNORECASE)
    urls: list[str] = []
    in_attachments = False
    for line in content.splitlines():
        if line.startswith("ATTACHMENTS"):
            in_attachments = True
            continue
        if in_attachments and line.startswith("- http"):
            url = line[2:].strip()
            if image_ext_re.search(url) or "/api/files/" in url:
                urls.append(url)
            continue
        if in_attachments and line and not line.startswith("-") and not line.startswith(" "):
            in_attachments = False
    return urls


class RouterModelClient:
    """A ``ModelClient`` that dispatches through ``ModelRouter``.

    Satisfies ``loopit_agent_core.model.ModelClient`` structurally, so the loop
    cannot tell it apart from the scripted client used in tests.
    """

    def __init__(
        self,
        router: ModelRouter,
        *,
        tenant_id: str,
        run_id: str | None = None,
        task_id: str | None = None,
        trace_id: str | None = None,
        # Unbounded by default: no max_tokens is sent upstream, so the model
        # writes until it is done. Pin a positive int only to cap spend; a
        # capped budget is exactly what truncated patches mid-diff.
        max_output_tokens: int | None = None,
    ) -> None:
        self._router = router
        self._tenant_id = tenant_id
        self._run_id = run_id
        self._task_id = task_id
        self._trace_id = trace_id
        self._max_output_tokens = max_output_tokens

    def complete(
        self,
        messages: Sequence[Message],
        *,
        difficulty: Difficulty,
        response_schema: Mapping[str, Any] | None = None,
        on_token: Callable[[str], None] | None = None,
    ) -> ModelResponse:
        result = self._router.complete(
            tenant_id=self._tenant_id,
            difficulty=difficulty,
            messages=_wire_messages(
                messages,
                accepts_images=_model_accepts_images(self._router, difficulty),
            ),
            response_schema=response_schema if response_schema is not None else TOOL_CALL_ENVELOPE,
            max_output_tokens=self._max_output_tokens,
            run_id=self._run_id,
            task_id=self._task_id,
            trace_id=self._trace_id,
            on_token=on_token,
        )
        return ModelResponse(
            content=result.content,
            model=result.model,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cached_input_tokens=result.cached_input_tokens,
            credits=result.credits,
            tool_call=extract_tool_call(result.content, result.tool_calls),
            finish_reason=result.finish_reason,
        )
