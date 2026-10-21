"""Attach workspace-dispatch to a live E2B sandbox (hosted Firecracker).

The scheduler owns create/destroy. This module reconnects by sandbox_id and
drives the same signed ``loopit_agent_runtime`` JSON-lines protocol used for
Docker. Generated code still runs only in the E2B microVM (I1).
"""

from __future__ import annotations

import base64
import json
import os
import shlex
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib import import_module
from typing import Any, Protocol, runtime_checkable

from loopit_agent_runtime.serde import envelope_from_dict, envelope_to_dict
from loopit_sandbox_sdk import Envelope, Lease, derive_lease_signing_key, sign
from loopit_tools import RemoteWorkspace
from loopit_tools.transport import RemoteWorkspaceClient

from .workspace import BlobWriter, WorkspaceUnavailable, _b64, _runtime_result_to_workspace_response


@runtime_checkable
class E2BCommandSession(Protocol):
    sandbox_id: str

    def run(self, command: str, *, env: Mapping[str, str], stdin: str = "") -> str: ...


E2BConnect = Callable[[str], E2BCommandSession]


class E2BJsonLineClient(RemoteWorkspaceClient):
    """One envelope per E2B command: runtime reads stdin until EOF."""

    def __init__(
        self,
        session: E2BCommandSession,
        *,
        env: Mapping[str, str],
        signing_key: bytes,
        workspace: str,
    ) -> None:
        self._session = session
        self._env = dict(env)
        self._signing_key = signing_key
        self._workspace = workspace

    def send(self, envelope: Envelope) -> Mapping[str, Any]:
        signed = sign(envelope, self._signing_key)
        payload = json.dumps(envelope_to_dict(signed), sort_keys=True) + "\n"
        command = f"python -m loopit_agent_runtime --workspace {self._workspace}"
        stdout = self._session.run(command, env=self._env, stdin=payload)
        line = stdout.strip().splitlines()[-1] if stdout.strip() else ""
        if not line:
            raise WorkspaceUnavailable("E2B runtime returned no JSON line")
        try:
            response = envelope_from_dict(json.loads(line))
        except (json.JSONDecodeError, TypeError, KeyError) as error:
            raise WorkspaceUnavailable(f"E2B runtime wrote non-JSON: {line!r}") from error
        payload_out = response.args
        if not bool(payload_out.get("ok", False)):
            error_payload = payload_out.get("error", {})
            message = error_payload.get("message") if isinstance(error_payload, Mapping) else None
            return {
                "output": f"runtime REJECTED: {message or error_payload}",
                "detail": {"ok": False},
            }
        result = payload_out.get("result", {})
        if not isinstance(result, Mapping):
            result = {}
        return _runtime_result_to_workspace_response(envelope.tool, result)


class E2BRuntimeWorkspace(RemoteWorkspace):
    def __init__(
        self,
        *,
        lease: Lease,
        signing_key: bytes,
        client: RemoteWorkspaceClient,
        session: E2BCommandSession,
        workspace: str,
    ) -> None:
        super().__init__(
            lease=lease,
            tenant_id=lease.tenant_id,
            run_id=lease.run_id,
            signing_key=signing_key,
            client=client,
        )
        self._session = session
        self._workspace = workspace

    def snapshot_manifest(self) -> Mapping[str, str]:
        return _json_map(
            self._session.run(
                "python -c " + repr(_MANIFEST_SCRIPT) + f" {self._workspace}",
                env={},
            )
        )

    def snapshot_state(self) -> Mapping[str, str]:
        return _json_map(
            self._session.run(
                "python -c " + repr(_STATE_SCRIPT) + f" {self._workspace}",
                env={},
            )
        )

    def snapshot_contents_for_paths(self, paths: Sequence[str]) -> Mapping[str, bytes]:
        if not paths:
            return {}
        command = (
            "python -c "
            + shlex.quote(_CONTENTS_SCRIPT)
            + " "
            + shlex.quote(self._workspace)
            + " "
            + shlex.quote(json.dumps(list(paths)))
        )
        raw = self._session.run(command, env={})
        decoded = json.loads(raw.strip().splitlines()[-1] if raw.strip() else "{}")
        if not isinstance(decoded, Mapping):
            raise WorkspaceUnavailable("sandbox checkpoint contents were invalid")
        return {str(path): base64.b64decode(str(encoded)) for path, encoded in decoded.items()}

    def store_blobs_for_paths(
        self, blob_writer: BlobWriter, paths: Sequence[str]
    ) -> Mapping[str, str]:
        contents = self.snapshot_contents_for_paths(paths)
        return {path: blob_writer.put(data) for path, data in contents.items()}


@dataclass(frozen=True, slots=True)
class E2BRuntimeWorkspaceFactory:
    """Reconnect to an E2B sandbox the scheduler already leased."""

    root_signing_key: bytes
    connect: E2BConnect
    workspace: str = "/workspace"

    def validate(self) -> None:
        # Import-check only: there is no sandbox to attach until a lease exists.
        if self.connect is default_e2b_connect:
            _load_e2b_sandbox_class()

    def create(self, *, lease: Lease, sandbox_id: str) -> E2BRuntimeWorkspace:
        session = self.connect(sandbox_id)
        signing_key = derive_lease_signing_key(self.root_signing_key, lease)
        env = {
            "LOOPIT_SANDBOX_SIGNING_KEY": _b64(signing_key),
            "LOOPIT_LEASE_ID": lease.lease_id,
            "LOOPIT_TENANT_ID": lease.tenant_id,
            "LOOPIT_RUN_ID": lease.run_id,
            "LOOPIT_BASE_CHECKPOINT_ID": lease.base_checkpoint_id,
            "LOOPIT_LEASE_EXPIRES_AT": lease.expires_at.isoformat(),
            **_egress_proxy_envs(),
        }
        client = E2BJsonLineClient(
            session, env=env, signing_key=signing_key, workspace=self.workspace
        )
        return E2BRuntimeWorkspace(
            lease=lease,
            signing_key=signing_key,
            client=client,
            session=session,
            workspace=self.workspace,
        )


def default_e2b_connect(sandbox_id: str) -> E2BCommandSession:
    sandbox_cls = _load_e2b_sandbox_class()
    handle = sandbox_cls.connect(sandbox_id)
    return SdkE2BSession(handle, sandbox_id=sandbox_id)


class SdkE2BSession:
    def __init__(self, handle: Any, *, sandbox_id: str) -> None:
        self._handle = handle
        self.sandbox_id = sandbox_id

    def run(self, command: str, *, env: Mapping[str, str], stdin: str = "") -> str:
        commands = getattr(self._handle, "commands", None)
        if commands is None or not hasattr(commands, "run"):
            raise WorkspaceUnavailable("E2B sandbox handle has no commands.run")
        result = commands.run(command, envs=dict(env) or None, stdin=stdin or None)
        stdout = getattr(result, "stdout", None)
        if stdout is None:
            stdout = str(result)
        return str(stdout)


def _load_e2b_sandbox_class() -> Any:
    try:
        module: Any = import_module("e2b_code_interpreter")
    except ModuleNotFoundError:
        try:
            module = import_module("e2b")
        except ModuleNotFoundError as exc:
            raise WorkspaceUnavailable(
                "E2B attach requires optional dependency 'e2b-code-interpreter' "
                "(install loopit-scheduler[e2b])"
            ) from exc
    sandbox_cls = getattr(module, "Sandbox", None)
    if sandbox_cls is None or not hasattr(sandbox_cls, "connect"):
        raise WorkspaceUnavailable("E2B SDK Sandbox.connect is unavailable")
    return sandbox_cls


_MANIFEST_SCRIPT = (
    "import hashlib,json,os,sys;root=sys.argv[1];manifest={};\n"
    "for base, dirs, files in os.walk(root):\n"
    "    for name in files:\n"
    "        path=os.path.join(base,name)\n"
    "        rel=os.path.relpath(path,root).replace(os.sep,'/')\n"
    "        h=hashlib.sha256()\n"
    "        with open(path,'rb') as handle:\n"
    "            for chunk in iter(lambda: handle.read(1048576), b''):\n"
    "                h.update(chunk)\n"
    "        manifest[rel]=h.hexdigest()\n"
    "print(json.dumps(manifest, sort_keys=True))"
)
_STATE_SCRIPT = (
    "import json,os,sys;root=sys.argv[1];state={};\n"
    "for base, dirs, files in os.walk(root):\n"
    "    for name in files:\n"
    "        path=os.path.join(base,name)\n"
    "        rel=os.path.relpath(path,root).replace(os.sep,'/')\n"
    "        item=os.stat(path)\n"
    "        state[rel]=f'{item.st_size}:{item.st_mtime_ns}:{item.st_ctime_ns}'\n"
        "print(json.dumps(state, sort_keys=True))"
)
_CONTENTS_SCRIPT = (
    "import base64,json,os,sys;root=sys.argv[1];paths=json.loads(sys.argv[2]);contents={};\n"
    "for rel in paths:\n"
    "    normal=str(rel).replace('\\\\','/')\n"
    "    parts=[part for part in normal.split('/') if part not in {'', '.'}]\n"
    "    if not parts or '..' in parts or normal.startswith(('/', '~')):\n"
    "        raise ValueError('invalid relative path')\n"
    "    path=os.path.join(root,*parts)\n"
    "    if not os.path.isfile(path):\n"
    "        continue\n"
    "    with open(path,'rb') as handle:\n"
    "        contents['/'.join(parts)]=base64.b64encode(handle.read()).decode('ascii')\n"
    "print(json.dumps(contents, sort_keys=True))"
)


def _json_map(stdout: str) -> Mapping[str, str]:
    try:
        decoded = json.loads(stdout.strip().splitlines()[-1] if stdout.strip() else "{}")
    except json.JSONDecodeError as error:
        raise WorkspaceUnavailable("E2B snapshot returned non-JSON") from error
    if not isinstance(decoded, Mapping):
        raise WorkspaceUnavailable("E2B snapshot was invalid")
    return {str(path): str(digest) for path, digest in decoded.items()}


def _egress_proxy_envs() -> dict[str, str]:
    """Inject HTTP(S)_PROXY so runtime shell/npm use egress-proxy (I3)."""
    proxy = (os.environ.get("LOOPIT_EGRESS_PROXY_URL") or "").strip()
    if not proxy:
        return {}
    no_proxy = (os.environ.get("LOOPIT_EGRESS_NO_PROXY") or "localhost,127.0.0.1").strip()
    return {
        "HTTP_PROXY": proxy,
        "HTTPS_PROXY": proxy,
        "ALL_PROXY": proxy,
        "http_proxy": proxy,
        "https_proxy": proxy,
        "all_proxy": proxy,
        "NO_PROXY": no_proxy,
        "no_proxy": no_proxy,
    }
