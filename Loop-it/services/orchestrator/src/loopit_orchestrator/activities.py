"""Activities for the durable run workflow.

The activities are the only place I/O happens: Temporal workflow code never opens
network sockets, invokes models, or touches sandbox files. Generated code is only
addressed through scheduler-issued sandbox leases and signed data-plane calls.
"""

from __future__ import annotations

import errno
import json
import os
import re
import select
import socket
import ssl
import threading
import time
import urllib.parse
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from loopit_agent_core.config import require_secret
from loopit_agent_core.gates import approval_binding_hash, gate_id_for
from loopit_agent_core.model import ModelResponse
from loopit_agent_core.observation import untrusted
from loopit_policy import FailureClass, classify_action, classify_failure
from loopit_policy.actions import GateRequirement
from temporalio import activity
from temporalio.exceptions import ApplicationError, CancelledError

from .types import (
    AcquireLeaseInput,
    AgentStepInput,
    AgentStepResult,
    AuditEventInput,
    CheckpointInput,
    CheckpointResult,
    GateRequest,
    LeaseInfo,
    ReleaseLeaseInput,
    RenewLeaseInput,
    StepOutcome,
    TranscriptMessage,
    UsageDelta,
    VerificationInput,
    VerificationResult,
)

# Router failover can spend 2 candidates * 3 attempts * 180s upstream timeout.
ROUTER_FAILOVER_TIMEOUT_SECONDS = 2 * 3 * 180
ROUTER_HTTP_HEADROOM_SECONDS = 180
ROUTER_HTTP_TIMEOUT_SECONDS = ROUTER_FAILOVER_TIMEOUT_SECONDS + ROUTER_HTTP_HEADROOM_SECONDS
# Match router-svc DEFAULT_MAX_OUTPUT_TOKENS. Omitting max_tokens lets a
# reasoning model think until the 180s socket timeout; the UI then sits on
# "working" for the Temporal retry budget (~30 min) and never gets a tool call.
DEFAULT_MAX_OUTPUT_TOKENS = 16384
WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS = 7 * 60
VERIFY_HTTP_TIMEOUT_SECONDS = 19 * 60
POST_JSON_HEARTBEAT_INTERVAL_SECONDS = 10.0
POST_JSON_CANCEL_POLL_SECONDS = 1.0


class ActivitySettings:
    def __init__(self) -> None:
        self.scheduler_url = os.environ.get("LOOPIT_SCHEDULER_URL", "http://scheduler:8004")
        self.scheduler_service_token = require_secret(os.environ, "LOOPIT_SERVICE_TOKEN")
        self.router_url = os.environ.get("LOOPIT_ROUTER_URL", "http://router-svc:8001")
        self.workspace_dispatch_url = os.environ.get("LOOPIT_WORKSPACE_DISPATCH_URL", "")
        self.router_timeout_seconds = _env_float_at_least(
            "LOOPIT_ROUTER_HTTP_TIMEOUT_SECONDS", ROUTER_HTTP_TIMEOUT_SECONDS
        )
        self.workspace_dispatch_timeout_seconds = _env_float_at_least(
            "LOOPIT_WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS",
            WORKSPACE_DISPATCH_HTTP_TIMEOUT_SECONDS,
        )
        self.verify_timeout_seconds = _env_float_at_least(
            "LOOPIT_VERIFY_HTTP_TIMEOUT_SECONDS", VERIFY_HTTP_TIMEOUT_SECONDS
        )


@activity.defn
def acquire_sandbox_lease(payload: AcquireLeaseInput) -> LeaseInfo:
    settings = ActivitySettings()
    body = {
        "tenant_id": payload.tenant_id,
        "run_id": payload.run_id,
        "project_id": payload.project_id,
        "base_checkpoint_id": payload.base_checkpoint_id,
        "ttl_seconds": payload.ttl_seconds,
        "allowed_tools": list(payload.allowed_tools),
    }
    data = _post_json(
        f"{settings.scheduler_url}/leases",
        body,
        headers={"X-Loopit-Service-Token": settings.scheduler_service_token},
    )
    return LeaseInfo(
        lease_id=str(data["lease_id"]),
        lease_token=str(data["lease_token"]),
        sandbox_id=str(data["sandbox_id"]),
        expires_at=str(data["expires_at"]),
        allowed_tools=tuple(str(tool) for tool in data.get("allowed_tools", ())),
    )


@activity.defn
def renew_sandbox_lease(payload: RenewLeaseInput) -> LeaseInfo:
    settings = ActivitySettings()
    data = _post_json(
        f"{settings.scheduler_url}/leases/{payload.lease_id}/renew",
        {"tenant_id": payload.tenant_id, "ttl_seconds": payload.ttl_seconds},
        headers={"X-Loopit-Service-Token": settings.scheduler_service_token},
    )
    return LeaseInfo(
        lease_id=str(data["lease_id"]),
        lease_token=str(data["lease_token"]),
        sandbox_id=str(data["sandbox_id"]),
        expires_at=str(data["expires_at"]),
        allowed_tools=tuple(str(tool) for tool in data.get("allowed_tools", ())),
    )


def _max_output_tokens() -> int:
    raw = os.environ.get("LOOPIT_MAX_OUTPUT_TOKENS", "").strip()
    if not raw:
        return DEFAULT_MAX_OUTPUT_TOKENS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_OUTPUT_TOKENS
    return value if value > 0 else DEFAULT_MAX_OUTPUT_TOKENS


# The wire shape of the tool-call contract (contracts/schemas/tool-call.schema.json).
# Constrained decoding is what makes the reply parseable by construction;
# without it the model free-chats markdown and every run stalls on "no tool
# call". RouterModelClient defaults to this envelope in-process; the raw HTTP
# path to router-svc must send it explicitly.
TOOL_CALL_RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "loopit_response",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "enum": [
                        "read_file",
                        "search_code",
                        "apply_patch",
                        "run_shell",
                        "install_package",
                        "start_dev_server",
                        "read_logs",
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
        },
    },
}


@activity.defn
def release_sandbox_lease(payload: ReleaseLeaseInput) -> None:
    settings = ActivitySettings()
    try:
        _post_json(
            f"{settings.scheduler_url}/leases/{payload.lease_id}/release",
            {"tenant_id": payload.tenant_id, "reason": payload.reason},
            headers={"X-Loopit-Service-Token": settings.scheduler_service_token},
        )
    except ApplicationError as exc:
        if "not found" not in str(exc).lower():
            raise


@activity.defn
def execute_agent_step(payload: AgentStepInput) -> AgentStepResult:
    """Run one model/tool turn against a leased sandbox.

    Router access is HTTP and authenticated by the lease token. Tool execution is
    delegated to a workspace dispatch endpoint when configured; absent that
    endpoint, the activity returns a non-retryable hard error rather than falling
    back to local execution in the control plane.
    """

    settings = ActivitySettings()
    messages = _chat_messages(payload)
    response = _post_json(
        f"{settings.router_url}/v1/chat/completions",
        {
            "messages": messages,
            "difficulty": payload.run.difficulty,
            "max_tokens": _max_output_tokens(),
            "response_format": TOOL_CALL_RESPONSE_FORMAT,
        },
        headers={"Authorization": f"Bearer {payload.lease.lease_token}"},
        timeout_seconds=settings.router_timeout_seconds,
    )
    model = _model_response(response)
    tool_call = _extract_tool_call(model.content, response)
    usage = UsageDelta(iterations=1, tokens=model.total_tokens, credits=float(model.credits))
    if tool_call is None:
        return AgentStepResult(
            StepOutcome.STALLED,
            "the agent produced no tool call",
            usage,
            transcript_delta=(TranscriptMessage("assistant", model.content),),
        )

    tool = str(tool_call.get("tool", ""))
    coerced_args = _coerce_tool_args(tool_call.get("args"))
    if coerced_args is None:
        return AgentStepResult(
            StepOutcome.STALLED,
            (
                "the agent emitted tool arguments that are not a JSON object; respond with "
                'exactly one JSON object {"tool", "args", "reason"} where args is an object'
            ),
            usage,
            transcript_delta=(TranscriptMessage("assistant", model.content),),
        )
    args = coerced_args
    verdict = classify_action({"tool": tool, "args": args})
    consumed_gate_binding: str | None = None
    if verdict.required_gate is GateRequirement.HUMAN_CONFIRM:
        binding = approval_binding_hash(tool, args, payload.run.run_id)
        if binding not in payload.approved_gate_bindings:
            # Unapproved gated action: raise a fresh approval gate whether or
            # not earlier bindings exist. When the model revises its command
            # after an approval (e.g. to fix a typo), the stale binding no
            # longer matches; failing the whole run for that is worse than
            # asking the operator to bless the revised command. The iteration
            # budget still bounds gate ping-pong.
            now = datetime.now(UTC)
            reason = (
                "approval binding mismatch: actual tool arguments differ from "
                "the approved gate; approve or reject the revised command"
                if payload.approved_gate_bindings
                else verdict.reason
            )
            return AgentStepResult(
                StepOutcome.AWAITING_GATE,
                reason,
                usage,
                GateRequest(
                    gate_id_for(tool, args, payload.run.run_id),
                    tool,
                    dict(args),
                    reason,
                    now.isoformat(),
                    binding,
                    (now + timedelta(minutes=30)).isoformat(),
                ),
            )
        consumed_gate_binding = binding
    if tool == "browser" and payload.run.browser_device_id:
        bridged = _paired_browser_step(payload, args)
        if bridged is not None:
            summary, ok = bridged
            return AgentStepResult(
                StepOutcome.CONTINUE if ok else StepOutcome.STALLED,
                summary,
                usage,
                failure_class=None if ok else classify_failure(summary).value,
                consumed_gate_binding=consumed_gate_binding,
                transcript_delta=_transcript_delta(model.content, tool, args, summary),
            )
    if not settings.workspace_dispatch_url:
        _raise_non_retryable(FailureClass.HARD_ERROR, "LOOPIT_WORKSPACE_DISPATCH_URL is not set")

    try:
        dispatch = _post_json(
            settings.workspace_dispatch_url,
            {"lease_id": payload.lease.lease_id, "tool": tool, "args": args},
            headers={"Authorization": f"Bearer {payload.lease.lease_token}"},
            timeout_seconds=settings.workspace_dispatch_timeout_seconds,
        )
    except ApplicationError as exc:
        if _http_status_from_application_error(exc) in (422, 403):
            # Schema-rejected tool call or lease-denied tool: record the
            # rejection in the transcript and keep looping so the next model
            # turn can re-emit the call. Returning STALLED here would fail the
            # whole run (the workflow breaks on any stall) with no corrective
            # turn; premature verification of a rejected no-op is harmless
            # because an unverified run simply loops again.
            rejection = str(exc)
            return AgentStepResult(
                StepOutcome.CONTINUE,
                rejection,
                usage,
                transcript_delta=_transcript_delta(model.content, tool, args, rejection),
            )
        raise
    ok = bool(dispatch.get("ok", True))
    summary = str(dispatch.get("summary") or dispatch.get("output") or "step completed")
    return AgentStepResult(
        StepOutcome.CONTINUE if ok else StepOutcome.STALLED,
        summary,
        usage,
        failure_class=None if ok else classify_failure(str(dispatch)).value,
        consumed_gate_binding=consumed_gate_binding,
        transcript_delta=_transcript_delta(model.content, tool, args, summary),
    )


@activity.defn
def run_verification(payload: VerificationInput) -> VerificationResult:
    settings = ActivitySettings()
    if not settings.workspace_dispatch_url:
        return VerificationResult(False, "verification dispatch is not configured")
    try:
        result = _post_json(
            settings.workspace_dispatch_url,
            {"lease_id": payload.lease.lease_id, "tool": "verify", "args": {}},
            headers={"Authorization": f"Bearer {payload.lease.lease_token}"},
            timeout_seconds=settings.verify_timeout_seconds,
        )
    except ApplicationError as exc:
        if _http_status_from_application_error(exc) == 503 and (
            "base checkpoint not found" in str(exc)
        ):
            # Read-only turns mutate nothing, so workspace-dispatch has no base
            # checkpoint to diff against. Nothing is verifiable yet: report
            # unverified so the workflow keeps iterating (the first mutating
            # tool call establishes the base checkpoint).
            return VerificationResult(False, "nothing to verify yet: workspace has no baseline")
        raise
    verified = bool(result.get("verified", False))
    checkpoint_created = result.get("checkpoint_created", False)
    checkpoint_id = result.get("checkpoint_id")
    if not isinstance(checkpoint_created, bool):
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "workspace dispatch response missing boolean checkpoint_created for verification",
        )
    checkpoint_created = cast(bool, checkpoint_created)
    if checkpoint_created and (
        not isinstance(checkpoint_id, str) or not checkpoint_id.startswith("ckpt_")
    ):
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "workspace dispatch response missing or malformed checkpoint_id for verification",
        )
    if verified and not checkpoint_created:
        _raise_non_retryable(
            FailureClass.HARD_ERROR,
            "successful verification did not create a checkpoint",
        )
    return VerificationResult(
        verified=verified,
        summary=str(result.get("summary", "verification completed")),
        usage=UsageDelta(
            tokens=int(result.get("tokens", 0)), credits=float(result.get("credits", 0))
        ),
        failure_class=None if verified else FailureClass.VERIFICATION.value,
        checkpoint_id=cast(str | None, checkpoint_id),
        checkpoint_created=checkpoint_created,
    )


@activity.defn
def write_checkpoint(payload: CheckpointInput) -> CheckpointResult:
    checkpoint_id = f"ckpt_{payload.run.run_id}_{payload.lease.lease_id}"
    return CheckpointResult(checkpoint_id=checkpoint_id, summary=payload.summary)


@activity.defn
def emit_audit_event(payload: AuditEventInput) -> None:
    activity.logger.info("audit %s %s", payload.event_type, asdict(payload))


def _post_json(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        _raise_non_retryable(FailureClass.HARD_ERROR, "activity URL must use HTTP(S)")
    body = json.dumps(payload).encode("utf-8")
    heartbeat_stop = threading.Event()
    cancel_requested = threading.Event()
    heartbeat_thread = _start_heartbeat_thread(
        heartbeat_stop,
        cancel_requested,
        phase="http-post",
        timeout_seconds=timeout_seconds,
    )
    try:
        status_code, raw_body = _post_json_bytes(
            url,
            body,
            {"Content-Type": "application/json", **(headers or {})},
            timeout_seconds,
            cancel_requested,
        )
    except TimeoutError as exc:
        raise ApplicationError(
            f"timed out after {timeout_seconds:g}s calling {url}",
            type=FailureClass.TRANSIENT.value,
        ) from exc
    except CancelledError:
        raise
    except OSError as exc:
        raise ApplicationError(str(exc), type=FailureClass.TRANSIENT.value) from exc
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=1.0)
    if status_code >= 400:
        failure = FailureClass.TRANSIENT if 500 <= status_code < 600 else FailureClass.HARD_ERROR
        _raise_non_retryable(
            failure, f"HTTP {status_code} calling {url}: {_error_detail(raw_body)}"
        )
    raw = raw_body.decode("utf-8")
    decoded = json.loads(raw or "{}")
    data = cast(Any, decoded)
    if not isinstance(data, dict):
        _raise_non_retryable(FailureClass.HARD_ERROR, "JSON response was not an object")
    return cast(dict[str, Any], data)


def _start_heartbeat_thread(
    stop: threading.Event,
    cancel_requested: threading.Event,
    *,
    phase: str,
    timeout_seconds: float,
) -> threading.Thread:
    """Keep long blocking HTTP activities observable and cancellation-aware.

    Synchronous activities run outside the worker event loop, but their network
    wait can still be minutes long. A separate heartbeat loop means the server
    can distinguish a slow model call from a dead worker, and the HTTP loop can
    promptly close its socket when Temporal requests cancellation.
    """

    activity_context = None
    try:
        import contextvars

        activity.info()
        activity_context = contextvars.copy_context()
    except RuntimeError:
        activity_context = None

    def beat() -> None:
        started = time.monotonic()
        while not stop.wait(POST_JSON_HEARTBEAT_INTERVAL_SECONDS):
            if _activity_cancelled(activity_context):
                cancel_requested.set()
                return
            details = {
                "phase": phase,
                "elapsed_seconds": int(time.monotonic() - started),
                "timeout_seconds": timeout_seconds,
            }
            try:
                if activity_context is None:
                    activity.heartbeat(details)
                else:
                    activity_context.run(activity.heartbeat, details)
            except RuntimeError:
                return
            except CancelledError:
                cancel_requested.set()
                return

    thread = threading.Thread(target=beat, name="loopit-activity-heartbeat", daemon=True)
    thread.start()
    return thread


def _activity_cancelled(context: Any | None = None) -> bool:
    try:
        if context is None:
            return activity.is_cancelled()
        return bool(context.run(activity.is_cancelled))
    except RuntimeError:
        return False


def _post_json_bytes(
    url: str,
    body: bytes,
    headers: dict[str, str],
    timeout_seconds: float,
    cancel_requested: threading.Event,
) -> tuple[int, bytes]:
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname
    if parsed.scheme not in {"http", "https"} or host is None:
        _raise_non_retryable(FailureClass.HARD_ERROR, "activity URL must use HTTP(S)")
    assert host is not None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    target = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    host_header = host if parsed.port is None else f"{host}:{port}"
    request = _http_request_bytes(target, host_header, body, headers)
    deadline = time.monotonic() + timeout_seconds
    sock = _connect_socket(host, port, parsed.scheme == "https", deadline, cancel_requested)
    try:
        _send_all(sock, request, deadline, cancel_requested)
        return _read_http_response(sock, deadline, cancel_requested)
    finally:
        sock.close()


def _nonblocking_connect_in_progress_errors() -> set[int]:
    values = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY}
    for name in ("WSAEWOULDBLOCK", "WSAEINPROGRESS", "WSAEALREADY"):
        value = getattr(errno, name, None)
        if value is not None:
            values.add(value)
    return values


def _http_request_bytes(target: str, host: str, body: bytes, headers: dict[str, str]) -> bytes:
    header_lines = {
        "Host": host,
        "Accept": "application/json",
        "Content-Length": str(len(body)),
        "Connection": "close",
        **headers,
    }
    rendered = "".join(f"{name}: {value}\r\n" for name, value in header_lines.items())
    return f"POST {target} HTTP/1.1\r\n{rendered}\r\n".encode("ascii") + body


def _connect_socket(
    host: str,
    port: int,
    use_tls: bool,
    deadline: float,
    cancel_requested: threading.Event,
) -> socket.socket:
    last_error: OSError | None = None
    for family, socktype, proto, _, address in socket.getaddrinfo(
        host, port, type=socket.SOCK_STREAM
    ):
        sock = socket.socket(family, socktype, proto)
        sock.setblocking(False)
        try:
            err = sock.connect_ex(address)
            if err not in {0, *_nonblocking_connect_in_progress_errors()}:
                raise OSError(err, os.strerror(err))
            _wait_for_socket(sock, write=True, deadline=deadline, cancel_requested=cancel_requested)
            connect_error = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if connect_error:
                raise OSError(connect_error, os.strerror(connect_error))
            if use_tls:
                context = ssl.create_default_context()
                tls_sock = context.wrap_socket(
                    sock,
                    server_hostname=host,
                    do_handshake_on_connect=False,
                )
                tls_sock.setblocking(False)
                _tls_handshake(tls_sock, deadline, cancel_requested)
                return tls_sock
            return sock
        except OSError as exc:
            last_error = exc
            sock.close()
    if last_error is not None:
        raise last_error
    raise OSError(f"could not resolve {host}")


def _tls_handshake(sock: ssl.SSLSocket, deadline: float, cancel_requested: threading.Event) -> None:
    while True:
        _raise_if_cancelled(cancel_requested)
        try:
            sock.do_handshake()
            return
        except ssl.SSLWantReadError:
            _wait_for_socket(sock, read=True, deadline=deadline, cancel_requested=cancel_requested)
        except ssl.SSLWantWriteError:
            _wait_for_socket(sock, write=True, deadline=deadline, cancel_requested=cancel_requested)


def _send_all(
    sock: socket.socket,
    payload: bytes,
    deadline: float,
    cancel_requested: threading.Event,
) -> None:
    view = memoryview(payload)
    sent = 0
    while sent < len(payload):
        _raise_if_cancelled(cancel_requested)
        try:
            sent_now = sock.send(view[sent:])
            if sent_now == 0:
                raise OSError("connection closed while sending HTTP request")
            sent += sent_now
        except (BlockingIOError, ssl.SSLWantWriteError):
            _wait_for_socket(sock, write=True, deadline=deadline, cancel_requested=cancel_requested)
        except ssl.SSLWantReadError:
            _wait_for_socket(sock, read=True, deadline=deadline, cancel_requested=cancel_requested)


def _read_http_response(
    sock: socket.socket, deadline: float, cancel_requested: threading.Event
) -> tuple[int, bytes]:
    buffer = bytearray()
    while b"\r\n\r\n" not in buffer:
        chunk = _recv_some(sock, deadline, cancel_requested)
        if not chunk:
            raise OSError("connection closed before HTTP response headers")
        buffer.extend(chunk)
    header_blob, body_start = bytes(buffer).split(b"\r\n\r\n", 1)
    status_code, response_headers = _parse_response_headers(header_blob)
    transfer_encoding = response_headers.get("transfer-encoding", "").lower()
    if "chunked" in transfer_encoding:
        body = _read_chunked_body(sock, bytearray(body_start), deadline, cancel_requested)
    elif "content-length" in response_headers:
        length = int(response_headers["content-length"])
        body_buffer = bytearray(body_start)
        while len(body_buffer) < length:
            chunk = _recv_some(sock, deadline, cancel_requested)
            if not chunk:
                raise OSError("connection closed before HTTP response body completed")
            body_buffer.extend(chunk)
        body = bytes(body_buffer[:length])
    else:
        body_buffer = bytearray(body_start)
        while True:
            chunk = _recv_some(sock, deadline, cancel_requested)
            if not chunk:
                body = bytes(body_buffer)
                break
            body_buffer.extend(chunk)
    return status_code, body


def _parse_response_headers(header_blob: bytes) -> tuple[int, dict[str, str]]:
    lines = header_blob.decode("iso-8859-1").split("\r\n")
    status_parts = lines[0].split(" ", 2)
    if len(status_parts) < 2 or not status_parts[1].isdigit():
        raise OSError(f"malformed HTTP status line: {lines[0]}")
    response_headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        response_headers[name.strip().lower()] = value.strip()
    return int(status_parts[1]), response_headers


def _read_chunked_body(
    sock: socket.socket,
    buffer: bytearray,
    deadline: float,
    cancel_requested: threading.Event,
) -> bytes:
    body = bytearray()
    while True:
        while b"\r\n" not in buffer:
            chunk = _recv_some(sock, deadline, cancel_requested)
            if not chunk:
                raise OSError("connection closed before HTTP chunk header")
            buffer.extend(chunk)
        line, remainder = bytes(buffer).split(b"\r\n", 1)
        buffer = bytearray(remainder)
        size = int(line.split(b";", 1)[0], 16)
        while len(buffer) < size + 2:
            chunk = _recv_some(sock, deadline, cancel_requested)
            if not chunk:
                raise OSError("connection closed before HTTP chunk completed")
            buffer.extend(chunk)
        if size == 0:
            return bytes(body)
        body.extend(buffer[:size])
        buffer = buffer[size + 2 :]


def _recv_some(sock: socket.socket, deadline: float, cancel_requested: threading.Event) -> bytes:
    while True:
        _raise_if_cancelled(cancel_requested)
        _wait_for_socket(sock, read=True, deadline=deadline, cancel_requested=cancel_requested)
        try:
            return sock.recv(65536)
        except (BlockingIOError, ssl.SSLWantReadError):
            continue
        except ssl.SSLWantWriteError:
            _wait_for_socket(sock, write=True, deadline=deadline, cancel_requested=cancel_requested)


def _wait_for_socket(
    sock: socket.socket,
    *,
    deadline: float,
    cancel_requested: threading.Event,
    read: bool = False,
    write: bool = False,
) -> None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("HTTP request timed out")
    _raise_if_cancelled(cancel_requested)
    wait_for = min(remaining, POST_JSON_CANCEL_POLL_SECONDS)
    readable = [sock] if read else []
    writable = [sock] if write else []
    ready_read, ready_write, _ = select.select(readable, writable, [], wait_for)
    if (read and ready_read) or (write and ready_write):
        return
    _raise_if_cancelled(cancel_requested)
    if time.monotonic() >= deadline:
        raise TimeoutError("HTTP request timed out")


def _raise_if_cancelled(cancel_requested: threading.Event) -> None:
    if cancel_requested.is_set() or _activity_cancelled():
        cancel_requested.set()
        raise CancelledError("HTTP request cancelled")


def _env_float_at_least(name: str, minimum: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return minimum
    try:
        value = float(raw)
    except ValueError:
        return minimum
    return max(value, minimum)


_SYSTEM_PROMPT = (
    "You are Loop-it's sandboxed app-building agent. You operate a remote Linux "
    "workspace by emitting exactly one JSON object per turn: "
    '{"tool": "...", "args": {...}}. '
    "The workspace starts EMPTY. python (3.11), pip, uv, node 20 and pnpm are "
    "preinstalled; build projects in the workspace root. Outbound network goes "
    "through the egress allowlist (npm/pypi and friends).\n"
    "TOOLS (exact arguments):\n"
    "- apply_patch(patch=<unified diff>): rules - start with '--- a/file' / "
    "'+++ b/file' headers; every hunk header counts MUST equal the actual body "
    "lines (each context line begins with a single space, removed lines with '-', "
    "added lines with '+'); NEVER wrap the diff in code fences or commentary. To "
    "create a new file use a /dev/null source header.\n"
    "- If apply_patch is rejected twice for the same file, STOP patching it and "
    "instead rewrite the whole file atomically: run_shell with "
    "\"cat > file <<'PY_EOF'\\n<entire file contents>\\nPY_EOF\".\n"
    "- run_shell(command=<string>): executes in /workspace; chain with && / ; as "
    "needed; stdout+stderr return to you.\n"
    "- install_package(package=<name>, manager=npm|pnpm|yarn|pip|uv, dev?=bool): "
    "install a dependency inside the sandbox.\n"
    "- start_dev_server(command?=string, cwd?=path): start the app detached; "
    "logs go to /tmp/loopit-dev-server.log by default.\n"
    "- read_logs(path?=string, lines?=int): tail sandbox or dev-server logs.\n"
    "- read_file(path=<string>), list_files(glob=<string>), "
    "search_files(query=<string>, glob=<string>).\n"
    "STRATEGY: write files first, then RUN the program (e.g. python spray.py "
    "--selftest) and iterate on its real output until it demonstrates the "
    "requested behavior. Treat tool-rejection text as instructions to CHANGE "
    "approach, never to retry the identical call. Emit ONLY the JSON object."
)


def _paired_browser_step(
    payload: AgentStepInput, args: dict[str, Any]
) -> tuple[str, bool] | None:
    """Forward a personal-browser action to the Node bridge. Smoke stays on preview."""
    import urllib.error
    import urllib.request

    action = str(args.get("action") or "")
    mapped: dict[str, tuple[str, dict[str, Any]]] = {
        "goto": ("browser_navigate", {"url": str(args.get("path") or "")}),
        "click": ("browser_click", {"selector": str(args.get("selector") or "")}),
        "fill": (
            "browser_type",
            {"selector": str(args.get("selector") or ""), "text": str(args.get("value") or "")},
        ),
        "screenshot": ("browser_screenshot", {}),
        "console_errors": ("browser_console", {}),
        "assert_text": ("browser_snapshot", {}),
    }
    chosen = mapped.get(action)
    if chosen is None:
        return None
    tool, call_args = chosen
    secret = os.environ.get("BROWSER_BRIDGE_SECRET", "").strip()
    if not secret:
        return ("Paired browser is not configured: set BROWSER_BRIDGE_SECRET.", False)
    base = os.environ.get("LOOP_API_URL", "http://127.0.0.1:3001").rstrip("/")
    body = json.dumps(
        {
            "userId": payload.run.actor_id,
            "deviceId": payload.run.browser_device_id,
            "runId": payload.run.run_id,
            "tool": tool,
            "args": call_args,
            "source": "build",
            **({"grantId": payload.run.browser_grant_id} if getattr(payload.run, "browser_grant_id", "") else {}),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/api/browser/invoke",
        data=body,
        headers={"Content-Type": "application/json", "x-loop-browser-bridge": secret},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        return (f"Paired browser call failed ({exc.code}): {detail}", False)
    except OSError as exc:
        return (f"Paired browser is unreachable: {exc}", False)
    try:
        decoded = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return ("Paired browser returned a non-JSON result.", False)
    if not isinstance(decoded, dict):
        return ("Paired browser returned an unexpected result.", False)
    content = str(decoded.get("content") or decoded.get("error") or "")
    return (content, not bool(decoded.get("isError")))


def _chat_messages(payload: AgentStepInput) -> list[dict[str, str]]:
    system = _SYSTEM_PROMPT
    if payload.run.browser and payload.run.browser_device_id:
        system += (
            " A paired browser is available via the browser tool. An .onion URL "
            "works only when that device paired as Tor Browser. smoke still "
            "checks the project preview, not the paired browser."
        )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": payload.run.prompt},
    ]
    for item in payload.transcript:
        # OpenAI-compatible chat APIs require native tool_calls/tool_call_id
        # pairing for role "tool" messages. The Loop-it envelope protocol
        # encodes tool calls as bare JSON content and never mints tool_call
        # ids, so observations are presented as user-role continuation
        # messages (kept untrusted-fenced by the transcript producer).
        role = "user" if item.role == "tool" else item.role
        messages.append({"role": role, "content": item.content})
    return messages


def _transcript_delta(
    model_content: str, tool: str, args: dict[str, Any], summary: str
) -> tuple[TranscriptMessage, ...]:
    assistant_content = model_content or json.dumps(
        {"tool": tool, "args": args},
        sort_keys=True,
        separators=(",", ":"),
    )
    return (
        TranscriptMessage("assistant", assistant_content),
        TranscriptMessage("tool", untrusted(summary, source=tool)),
    )


def _model_response(response: dict[str, Any]) -> ModelResponse:
    choice = cast(dict[str, Any], cast(list[Any], response.get("choices", [{}]))[0])
    message = cast(dict[str, Any], choice.get("message", {}))
    usage = cast(dict[str, Any], response.get("usage", {}))
    return ModelResponse(
        content=str(message.get("content") or ""),
        model=str(response.get("model", "unknown")),
        input_tokens=int(usage.get("prompt_tokens", 0)),
        output_tokens=int(usage.get("completion_tokens", 0)),
        credits=float(usage.get("credits", 0)),
        finish_reason=str(choice.get("finish_reason", "stop")),
    )


def _extract_tool_call(content: str, response: dict[str, Any]) -> dict[str, Any] | None:
    choice = cast(dict[str, Any], cast(list[Any], response.get("choices", [{}]))[0])
    message = cast(dict[str, Any], choice.get("message", {}))
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        first = cast(dict[str, Any], tool_calls[0])
        function = cast(dict[str, Any], first.get("function", {}))
        raw_args = function.get("arguments", {})
        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        return {"tool": function.get("name"), "args": args if isinstance(args, dict) else {}}
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _error_detail(raw_body: bytes) -> str:
    """Best-effort extraction of an HTTP error body for failure messages.

    Keeps the diagnostic (FastAPI ``detail``, upstream validation message)
    visible in workflow history instead of surfacing only the status code.
    Size-capped so oversized HTML error pages cannot flood event payloads.
    """
    try:
        text = raw_body.decode("utf-8", errors="replace").strip()
    except Exception:  # pragma: no cover - decode with replacement rarely fails
        return ""
    if not text:
        return ""
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        snippet = " ".join(text.split())
        return snippet[:400]
    if isinstance(decoded, dict):
        parts: list[str] = []
        for key in ("detail", "message", "error"):
            value = decoded.get(key)
            if isinstance(value, str) and value:
                parts.append(value)
            elif isinstance(value, list):
                rendered = "; ".join(
                    json.dumps(item) if isinstance(item, dict) else str(item) for item in value
                )
                if rendered:
                    parts.append(rendered)
        if parts:
            return " ".join(parts)[:400]
    return json.dumps(decoded)[:400]


_HTTP_STATUS_MESSAGE_PATTERN = re.compile(r"\bHTTP (\d{3})\b")


def _http_status_from_application_error(exc: ApplicationError) -> int | None:
    """Extract the HTTP status embedded by ``_post_json`` failure messages.

    ``str(ApplicationError)`` prefixes the failure type (for example
    ``"hard_error: HTTP 422 ..."``), so search anywhere in the rendered
    message instead of anchoring at position zero.
    """
    match = _HTTP_STATUS_MESSAGE_PATTERN.search(str(exc))
    return int(match.group(1)) if match else None


def _coerce_tool_args(value: Any) -> dict[str, Any] | None:
    """Normalize model-emitted tool arguments to a JSON object.

    Not every provider enforces strict ``json_schema`` responses, so a
    malformed ``args`` value is coerced where lossless (absent/null -> {},
    string-encoded JSON -> decoded object) and rejected otherwise. Rejecting
    lets the step stall with an actionable message instead of dying with an
    opaque 422 from workspace-dispatch.
    """
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return {}
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return None
        return dict(decoded) if isinstance(decoded, dict) else None
    return None


def _raise_non_retryable(failure: FailureClass, message: str) -> None:
    raise ApplicationError(
        message, type=failure.value, non_retryable=failure is not FailureClass.TRANSIENT
    )
