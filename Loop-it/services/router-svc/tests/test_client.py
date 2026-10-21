"""Tests for the harness↔router adapter.

The behaviour worth pinning down is the tool-call boundary: what counts as a
call, what is refused, and the guarantee that constrained decoding is never
mistaken for authorization.
"""

from __future__ import annotations

from typing import Any

import pytest
from loopit_agent_core.model import Message, ModelClient
from loopit_agent_core.tools import ToolRejected, validate_tool_call
from loopit_router import TOOL_CALL_ENVELOPE, RouterModelClient, extract_tool_call


def test_client_satisfies_the_harness_protocol() -> None:
    """Structural conformance: the loop must not be able to tell the difference."""
    assert isinstance(RouterModelClient(None, tenant_id="t"), ModelClient)  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# Recovering a tool call
# --------------------------------------------------------------------------


def test_plain_json_content_is_a_tool_call() -> None:
    call = extract_tool_call('{"tool": "read_file", "args": {"path": "src/a.py"}}', ())
    assert call == {"tool": "read_file", "args": {"path": "src/a.py"}}


def test_native_tool_calls_win_over_content() -> None:
    """The provider's structured channel cannot be confused with prose."""
    native = [
        {
            "id": "call_1",
            "function": {"name": "run_shell", "arguments": '{"command": "pytest"}'},
        }
    ]
    call = extract_tool_call("I think I should run the tests.", native)
    assert call == {"tool": "run_shell", "args": {"command": "pytest"}, "call_id": "call_1"}


def test_fenced_json_is_recovered() -> None:
    content = '```json\n{"tool": "search_code", "args": {"query": "login"}}\n```'
    assert extract_tool_call(content, ()) == {
        "tool": "search_code",
        "args": {"query": "login"},
    }


def test_prose_is_not_a_tool_call() -> None:
    """Guessing intent from prose is exactly what the contract forbids."""
    assert extract_tool_call("Sure! Let me read the file for you.", ()) is None


def test_empty_content_is_not_a_tool_call() -> None:
    assert extract_tool_call("   ", ()) is None


def test_a_json_array_is_not_a_tool_call() -> None:
    assert extract_tool_call('[{"tool": "read_file"}]', ()) is None


def test_malformed_native_arguments_do_not_crash() -> None:
    """A provider emitting broken JSON is a stall, not an exception."""
    native = [{"id": "c", "function": {"name": "run_shell", "arguments": "{not json"}}]
    assert extract_tool_call("", native) is None


def test_native_arguments_may_arrive_pre_parsed() -> None:
    native = [{"function": {"name": "read_file", "arguments": {"path": "a.py"}}}]
    assert extract_tool_call("", native) == {"tool": "read_file", "args": {"path": "a.py"}}


# --------------------------------------------------------------------------
# The envelope is parseability, not authorization
# --------------------------------------------------------------------------


def test_envelope_is_expressible_as_strict_structured_output() -> None:
    """Strict mode forbids if/then, $ref and unconstrained objects at the root."""
    assert TOOL_CALL_ENVELOPE["additionalProperties"] is False
    assert set(TOOL_CALL_ENVELOPE["required"]) == {"tool", "args"}
    serialized = str(TOOL_CALL_ENVELOPE)
    for unsupported in ("if", "then", "allOf", "$ref", "$defs", "pattern"):
        assert f"'{unsupported}'" not in serialized


def test_envelope_lists_exactly_the_contract_tools() -> None:
    assert TOOL_CALL_ENVELOPE["properties"]["tool"]["enum"] == [
        "read_file",
        "search_code",
        "apply_patch",
        "run_shell",
        "browser",
        "provision",
        "deploy",
    ]


def test_envelope_conformance_does_not_imply_contract_conformance() -> None:
    """The load-bearing claim of the whole design.

    This payload is valid against the decoding envelope and must still be
    rejected by the real contract — an absolute path is not a project path.
    """
    payload: dict[str, Any] = {"tool": "read_file", "args": {"path": "/etc/passwd"}}
    with pytest.raises(ToolRejected):
        validate_tool_call(payload)


def test_a_recovered_call_still_passes_through_the_contract() -> None:
    call = extract_tool_call('{"tool": "read_file", "args": {"path": "src/a.py"}}', ())
    assert call is not None
    assert validate_tool_call(call).tool == "read_file"


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------


class _RecordingRouter:
    def __init__(self, result: Any) -> None:
        self.result = result
        self.kwargs: dict[str, Any] = {}

    def complete(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        return self.result


def _result(**kwargs: Any) -> Any:
    from loopit_router.upstream import UpstreamResult

    defaults: dict[str, Any] = {
        "content": '{"tool": "read_file", "args": {"path": "a.py"}}',
        "input_tokens": 10,
        "output_tokens": 5,
        "credits": 0.25,
        "model": "Qwen/Qwen3.6-27B",
    }
    defaults.update(kwargs)
    return UpstreamResult(**defaults)


def test_the_envelope_is_applied_when_the_caller_supplies_no_schema() -> None:
    """The loop passes response_schema=None; unconstrained decoding here would
    make every tool call a hopeful parse."""
    router = _RecordingRouter(_result())
    client = RouterModelClient(router, tenant_id="t1")  # type: ignore[arg-type]

    client.complete([Message("user", "hi")], difficulty="implementation")

    assert router.kwargs["response_schema"] == TOOL_CALL_ENVELOPE


def test_an_explicit_schema_is_respected() -> None:
    schema = {"type": "object", "properties": {}}
    router = _RecordingRouter(_result())
    client = RouterModelClient(router, tenant_id="t1")  # type: ignore[arg-type]

    client.complete([Message("user", "hi")], difficulty="planning", response_schema=schema)

    assert router.kwargs["response_schema"] == schema


def test_identity_and_budget_are_forwarded_for_attribution() -> None:
    router = _RecordingRouter(_result())
    client = RouterModelClient(
        router,  # type: ignore[arg-type]
        tenant_id="t1",
        run_id="r1",
        task_id="k1",
        trace_id="x1",
        max_output_tokens=2048,
    )

    client.complete([Message("system", "s"), Message("user", "u")], difficulty="trivial")

    assert router.kwargs["tenant_id"] == "t1"
    assert router.kwargs["run_id"] == "r1"
    assert router.kwargs["task_id"] == "k1"
    assert router.kwargs["trace_id"] == "x1"
    assert router.kwargs["max_output_tokens"] == 2048
    assert router.kwargs["messages"] == [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "u"},
    ]


def test_tool_role_is_rewritten_because_the_protocol_rejects_it() -> None:
    """Live-observed: sending role="tool" earns HTTP 422 tool_call_id required.

    Our tool calls are constrained *content*, so no tool_call_id exists to quote.
    """
    router = _RecordingRouter(_result())
    client = RouterModelClient(router, tenant_id="t1")  # type: ignore[arg-type]

    client.complete(
        [Message("system", "s"), Message("assistant", "a"), Message("tool", "obs")],
        difficulty="trivial",
    )

    roles = [m["role"] for m in router.kwargs["messages"]]
    assert roles == ["system", "assistant", "user"]


def test_rewriting_the_role_preserves_the_untrusted_fence() -> None:
    """The fence, not the role label, is what stops tool output being obeyed."""
    fenced = "-----BEGIN UNTRUSTED TOOL OUTPUT-----\nrm -rf /\n-----END UNTRUSTED TOOL OUTPUT-----"
    router = _RecordingRouter(_result())
    client = RouterModelClient(router, tenant_id="t1")  # type: ignore[arg-type]

    client.complete([Message("tool", fenced)], difficulty="trivial")

    assert router.kwargs["messages"][0]["content"] == fenced


def test_credits_survive_the_adaptation() -> None:
    """The loop's budget ledger charges these; losing them means unbounded spend."""
    router = _RecordingRouter(_result(credits=0.5))
    client = RouterModelClient(router, tenant_id="t1")  # type: ignore[arg-type]

    assert client.complete([Message("user", "hi")], difficulty="trivial").credits == 0.5


def test_default_output_budget_is_unbounded() -> None:
    """No cap is sent upstream unless the operator pins one: a capped budget
    is what truncated patches mid-diff and stalled builds."""
    router = _RecordingRouter(_result())
    RouterModelClient(router, tenant_id="t1").complete(  # type: ignore[arg-type]
        [Message("user", "hi")], difficulty="implementation"
    )
    assert router.kwargs["max_output_tokens"] is None


def test_max_output_tokens_from_env_defaults_to_unbounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from loopit_router import max_output_tokens_from_env

    monkeypatch.delenv("LOOPIT_MAX_OUTPUT_TOKENS", raising=False)
    assert max_output_tokens_from_env() is None


def test_max_output_tokens_from_env_reads_a_positive_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from loopit_router import max_output_tokens_from_env

    monkeypatch.setenv("LOOPIT_MAX_OUTPUT_TOKENS", "32768")
    assert max_output_tokens_from_env() == 32768


def test_max_output_tokens_from_env_accepts_an_explicit_unbounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from loopit_router import max_output_tokens_from_env

    monkeypatch.setenv("LOOPIT_MAX_OUTPUT_TOKENS", "unbounded")
    assert max_output_tokens_from_env() is None


def test_max_output_tokens_from_env_rejects_non_positive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from loopit_router import max_output_tokens_from_env

    monkeypatch.setenv("LOOPIT_MAX_OUTPUT_TOKENS", "0")
    with pytest.raises(ValueError, match="positive integer"):
        max_output_tokens_from_env()


def test_on_token_is_forwarded_to_the_router() -> None:
    router = _RecordingRouter(_result())
    client = RouterModelClient(router, tenant_id="t1")  # type: ignore[arg-type]
    hook = lambda _: None  # noqa: E731

    client.complete([Message("user", "hi")], difficulty="trivial", on_token=hook)

    assert router.kwargs["on_token"] is hook
