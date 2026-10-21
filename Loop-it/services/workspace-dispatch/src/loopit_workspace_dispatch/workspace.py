"""Workspace transports backed by leased sandbox providers.

The dispatcher never interprets a tool by touching the control-plane checkout.
Production dispatch starts the signed ``loopit_agent_runtime`` inside the leased
Docker sandbox and talks over sandbox-sdk envelopes. The in-memory transport is
only a provider double for tests and local dry runs; it models sandbox state
without executing host commands.
"""

from __future__ import annotations

import json
import re
import shlex
import shutil
import subprocess
import tarfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Protocol, runtime_checkable

from loopit_agent_runtime.serde import envelope_from_dict, envelope_to_dict
from loopit_sandbox_sdk import Envelope, Lease, derive_lease_signing_key, sign
from loopit_tools import BrowserActionResult, CommandResult, RemoteWorkspace
from loopit_tools.transport import RemoteWorkspaceClient, WorkspaceError, WorkspaceTransport
from loopit_verify import CommandOutput, CommandRunner


class WorkspaceUnavailable(RuntimeError):
    """The leased sandbox exists, but no safe runtime channel is available."""


DOCKER_CONTAINER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


@runtime_checkable
class WorkspaceFactory(Protocol):
    def create(self, *, lease: Lease, sandbox_id: str) -> WorkspaceTransport: ...


@runtime_checkable
class BlobWriter(Protocol):
    def put(self, content: bytes) -> str: ...


@runtime_checkable
class CheckpointableWorkspace(Protocol):
    def snapshot_manifest(self) -> Mapping[str, str]: ...

    def snapshot_state(self) -> Mapping[str, str]: ...

    def snapshot_contents_for_paths(self, paths: Sequence[str]) -> Mapping[str, bytes]: ...

    def store_blobs_for_paths(
        self, blob_writer: BlobWriter, paths: Sequence[str]
    ) -> Mapping[str, str]: ...


@dataclass(frozen=True, slots=True)
class RefusingWorkspaceFactory:
    """Fail closed for providers that cannot be safely reattached by this service."""

    reason: str

    def create(self, *, lease: Lease, sandbox_id: str) -> WorkspaceTransport:
        del lease, sandbox_id
        raise WorkspaceUnavailable(self.reason)


@dataclass(frozen=True, slots=True)
class DockerRuntimeWorkspaceFactory:
    """Create a signed runtime session with ``docker exec`` in the leased sandbox."""

    root_signing_key: bytes
    workspace: str = "/workspace"

    def validate(self) -> None:
        docker = shutil.which("docker")
        if docker is None:
            raise WorkspaceUnavailable("docker CLI is unavailable for sandbox runtime exec")
        try:
            completed = subprocess.run(  # noqa: S603 - explicit docker provider readiness check.
                [docker, "version", "--format", "{{.Server.Version}}"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise WorkspaceUnavailable("docker sandbox provider is not reachable") from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip()[:500]
            if not detail:
                detail = f"docker version exited with status {completed.returncode}"
            raise WorkspaceUnavailable(f"docker sandbox provider is not reachable: {detail}")

    def create(self, *, lease: Lease, sandbox_id: str) -> WorkspaceTransport:
        docker = shutil.which("docker")
        if docker is None:
            raise WorkspaceUnavailable("docker CLI is unavailable for sandbox runtime exec")
        container_id = _container_id_from_sandbox_id(sandbox_id)
        signing_key = derive_lease_signing_key(self.root_signing_key, lease)
        encoded_key = _b64(signing_key)
        command = [docker, "exec", "-i"]
        for key, value in {
            "LOOPIT_SANDBOX_SIGNING_KEY": encoded_key,
            "LOOPIT_LEASE_ID": lease.lease_id,
            "LOOPIT_TENANT_ID": lease.tenant_id,
            "LOOPIT_RUN_ID": lease.run_id,
            "LOOPIT_BASE_CHECKPOINT_ID": lease.base_checkpoint_id,
            "LOOPIT_LEASE_EXPIRES_AT": lease.expires_at.isoformat(),
        }.items():
            command += ["-e", f"{key}={value}"]
        command += [
            "--",
            container_id,
            "python",
            "-m",
            "loopit_agent_runtime",
            "--workspace",
            self.workspace,
        ]
        process = subprocess.Popen(  # noqa: S603 - data-plane bridge into selected sandbox.
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return DockerRuntimeWorkspace(
            lease=lease,
            tenant_id=lease.tenant_id,
            run_id=lease.run_id,
            signing_key=signing_key,
            client=JsonLineRuntimeClient(process, signing_key=signing_key),
            docker=docker,
            container_id=container_id,
            workspace=self.workspace,
        )


class DockerRuntimeWorkspace(RemoteWorkspace):
    """Remote workspace plus an internal filesystem manifest for checkpoints."""

    def __init__(
        self,
        *,
        lease: Lease,
        tenant_id: str,
        run_id: str,
        signing_key: bytes,
        client: RemoteWorkspaceClient,
        docker: str,
        container_id: str,
        workspace: str,
    ) -> None:
        super().__init__(
            lease=lease,
            tenant_id=tenant_id,
            run_id=run_id,
            signing_key=signing_key,
            client=client,
        )
        self._docker = docker
        self._container_id = _validated_docker_container_id(container_id)
        self._workspace = workspace

    def snapshot_manifest(self) -> Mapping[str, str]:
        script = (
            "import hashlib,json,os,sys;"
            "root=sys.argv[1];manifest={};"
            "\nfor base, dirs, files in os.walk(root):"
            "\n    for name in files:"
            "\n        path=os.path.join(base,name)"
            "\n        rel=os.path.relpath(path,root).replace(os.sep,'/')"
            "\n        h=hashlib.sha256()"
            "\n        with open(path,'rb') as handle:"
            "\n            for chunk in iter(lambda: handle.read(1048576), b''):"
            "\n                h.update(chunk)"
            "\n        manifest[rel]=h.hexdigest()"
            "\nprint(json.dumps(manifest, sort_keys=True))"
        )
        completed = subprocess.run(  # noqa: S603 - internal checkpoint read of leased sandbox.
            [
                self._docker,
                "exec",
                "--",
                self._container_id,
                "python",
                "-c",
                script,
                self._workspace,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise WorkspaceUnavailable(
                "sandbox checkpoint manifest failed: " + completed.stderr[:500]
            )
        decoded = json.loads(completed.stdout)
        if not isinstance(decoded, Mapping):
            raise WorkspaceUnavailable("sandbox checkpoint manifest was invalid")
        return {str(path): str(digest) for path, digest in decoded.items()}

    def snapshot_state(self) -> Mapping[str, str]:
        script = (
            "import json,os,sys;"
            "root=sys.argv[1];state={};"
            "\nfor base, dirs, files in os.walk(root):"
            "\n    for name in files:"
            "\n        path=os.path.join(base,name)"
            "\n        rel=os.path.relpath(path,root).replace(os.sep,'/')"
            "\n        item=os.stat(path)"
            "\n        state[rel]=f'{item.st_size}:{item.st_mtime_ns}:{item.st_ctime_ns}'"
            "\nprint(json.dumps(state, sort_keys=True))"
        )
        completed = subprocess.run(  # noqa: S603 - internal checkpoint metadata read.
            [
                self._docker,
                "exec",
                "--",
                self._container_id,
                "python",
                "-c",
                script,
                self._workspace,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise WorkspaceUnavailable("sandbox checkpoint state failed: " + completed.stderr[:500])
        decoded = json.loads(completed.stdout)
        if not isinstance(decoded, Mapping):
            raise WorkspaceUnavailable("sandbox checkpoint state was invalid")
        return {str(path): str(state) for path, state in decoded.items()}

    def snapshot_manifest_for_paths(self, paths: Sequence[str]) -> Mapping[str, str]:
        if not paths:
            return {}
        script = (
            "import hashlib,json,os,sys;"
            "root=sys.argv[1];paths=json.loads(sys.argv[2]);manifest={};"
            "\nfor rel in paths:"
            "\n    normal=str(rel).replace('\\\\','/')"
            "\n    parts=[part for part in normal.split('/') if part not in {'', '.'}]"
            "\n    if not parts or '..' in parts or normal.startswith(('/', '~')):"
            "\n        raise ValueError(f'invalid relative path: {rel!r}')"
            "\n    path=os.path.join(root,*parts)"
            "\n    if not os.path.isfile(path):"
            "\n        continue"
            "\n    h=hashlib.sha256()"
            "\n    with open(path,'rb') as handle:"
            "\n        for chunk in iter(lambda: handle.read(1048576), b''):"
            "\n            h.update(chunk)"
            "\n    manifest['/'.join(parts)]=h.hexdigest()"
            "\nprint(json.dumps(manifest, sort_keys=True))"
        )
        completed = subprocess.run(  # noqa: S603 - internal checkpoint read of selected files.
            [
                self._docker,
                "exec",
                "--",
                self._container_id,
                "python",
                "-c",
                script,
                self._workspace,
                json.dumps(tuple(paths)),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise WorkspaceUnavailable(
                "sandbox checkpoint manifest failed: " + completed.stderr[:500]
            )
        decoded = json.loads(completed.stdout)
        if not isinstance(decoded, Mapping):
            raise WorkspaceUnavailable("sandbox checkpoint manifest was invalid")
        return {str(path): str(digest) for path, digest in decoded.items()}

    def snapshot_contents_for_paths(self, paths: Sequence[str]) -> Mapping[str, bytes]:
        import base64

        if not paths:
            return {}
        script = (
            "import base64,json,os,sys;"
            "root=sys.argv[1];paths=json.loads(sys.argv[2]);contents={};"
            "\nfor rel in paths:"
            "\n    normal=str(rel).replace('\\\\','/')"
            "\n    parts=[part for part in normal.split('/') if part not in {'', '.'}]"
            "\n    if not parts or '..' in parts or normal.startswith(('/', '~')):"
            "\n        raise ValueError(f'invalid relative path: {rel!r}')"
            "\n    path=os.path.join(root,*parts)"
            "\n    if not os.path.isfile(path):"
            "\n        continue"
            "\n    with open(path,'rb') as handle:"
            "\n        contents['/'.join(parts)]=base64.b64encode(handle.read()).decode('ascii')"
            "\nprint(json.dumps(contents, sort_keys=True))"
        )
        completed = subprocess.run(  # noqa: S603 - internal checkpoint read of selected files.
            [
                self._docker,
                "exec",
                "--",
                self._container_id,
                "python",
                "-c",
                script,
                self._workspace,
                json.dumps(tuple(paths)),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise WorkspaceUnavailable(
                "sandbox checkpoint contents failed: " + completed.stderr[:500]
            )
        decoded = json.loads(completed.stdout)
        if not isinstance(decoded, Mapping):
            raise WorkspaceUnavailable("sandbox checkpoint contents were invalid")
        return {str(path): base64.b64decode(str(encoded)) for path, encoded in decoded.items()}

    def store_blobs_for_paths(
        self, blob_writer: BlobWriter, paths: Sequence[str]
    ) -> Mapping[str, str]:
        if not paths:
            return {}
        script = (
            "import json,os,sys,tarfile;"
            "root=sys.argv[1];paths=json.loads(sys.argv[2]);"
            "stream=sys.stdout.buffer;"
            "\nwith tarfile.open(fileobj=stream, mode='w|') as archive:"
            "\n    for rel in paths:"
            "\n        normal=str(rel).replace('\\\\','/')"
            "\n        parts=[part for part in normal.split('/') if part not in {'', '.'}]"
            "\n        if not parts or '..' in parts or normal.startswith(('/', '~')):"
            "\n            raise ValueError(f'invalid relative path: {rel!r}')"
            "\n        path=os.path.join(root,*parts)"
            "\n        if not os.path.isfile(path):"
            "\n            continue"
            "\n        archive.add(path, arcname='/'.join(parts), recursive=False)"
        )
        process = subprocess.Popen(  # noqa: S603 - streams selected leased sandbox files.
            [
                self._docker,
                "exec",
                "--",
                self._container_id,
                "python",
                "-c",
                script,
                self._workspace,
                json.dumps(tuple(paths)),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if process.stdout is None:
            raise WorkspaceUnavailable("sandbox checkpoint content stream was unavailable")
        manifest: dict[str, str] = {}
        try:
            with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
                for member in archive:
                    if not member.isfile():
                        continue
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        continue
                    manifest[_safe_path(member.name)] = blob_writer.put(extracted.read())
        except (OSError, tarfile.TarError) as error:
            process.kill()
            raise WorkspaceUnavailable("sandbox checkpoint content stream failed") from error
        stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
        try:
            returncode = process.wait(timeout=30)
        except subprocess.TimeoutExpired as error:
            process.kill()
            raise WorkspaceUnavailable("sandbox checkpoint contents timed out") from error
        if returncode != 0:
            raise WorkspaceUnavailable("sandbox checkpoint contents failed: " + stderr[:500])
        return manifest


@dataclass(slots=True)
class JsonLineRuntimeClient(RemoteWorkspaceClient):
    """Client for the sandbox runtime's signed JSON-lines protocol."""

    process: subprocess.Popen[str]
    signing_key: bytes

    def send(self, envelope: Envelope) -> Mapping[str, Any]:
        if self.process.stdin is None or self.process.stdout is None:
            raise WorkspaceUnavailable("sandbox runtime stdio is unavailable")
        # The control plane signs every instruction: the runtime refuses
        # unsigned envelopes, so stamp the lease-derived HMAC before handing
        # the envelope over the stdio bridge.
        signed = sign(envelope, self.signing_key)
        self.process.stdin.write(json.dumps(envelope_to_dict(signed), sort_keys=True) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr is not None else ""
            raise WorkspaceUnavailable(f"sandbox runtime closed the channel: {stderr[:500]}")
        try:
            response = envelope_from_dict(json.loads(line))
        except (json.JSONDecodeError, TypeError, KeyError) as error:
            raise WorkspaceUnavailable(f"sandbox runtime wrote non-JSON line: {line!r}") from error
        payload = response.args
        if not bool(payload.get("ok", False)):
            error_payload = payload.get("error", {})
            message = error_payload.get("message") if isinstance(error_payload, Mapping) else None
            return {
                "output": f"runtime REJECTED: {message or error_payload}",
                "detail": {"ok": False},
            }
        result = payload.get("result", {})
        if not isinstance(result, Mapping):
            result = {}
        return _runtime_result_to_workspace_response(envelope.tool, result)


@dataclass(slots=True)
class InMemoryWorkspaceFactory:
    """Provider double that gives each in-memory sandbox isolated files."""

    command_results: Mapping[str, CommandResult] = field(default_factory=dict)
    _workspaces: dict[str, InMemoryWorkspace] = field(default_factory=dict, init=False)

    def create(self, *, lease: Lease, sandbox_id: str) -> WorkspaceTransport:
        workspace = self._workspaces.get(sandbox_id)
        if workspace is None:
            workspace = InMemoryWorkspace(command_results=self.command_results)
            self._workspaces[sandbox_id] = workspace
        return workspace


@dataclass(slots=True)
class InMemoryWorkspace(WorkspaceTransport):
    """An isolated, non-executing workspace used with ``InMemoryProvider`` tests."""

    command_results: Mapping[str, CommandResult] = field(default_factory=dict)
    files: dict[str, str] = field(default_factory=dict)

    def snapshot_manifest(self) -> Mapping[str, str]:
        import hashlib

        return {
            path: hashlib.sha256(content.encode("utf-8")).hexdigest()
            for path, content in sorted(self.files.items())
        }

    def snapshot_state(self) -> Mapping[str, str]:
        import hashlib

        state = {}
        for path, content in sorted(self.files.items()):
            encoded = content.encode("utf-8")
            state[path] = f"{len(encoded)}:{hashlib.sha256(encoded).hexdigest()}"
        return state

    def snapshot_manifest_for_paths(self, paths: Sequence[str]) -> Mapping[str, str]:
        import hashlib

        return {
            path: hashlib.sha256(self.files[path].encode("utf-8")).hexdigest()
            for path in sorted({_safe_path(path) for path in paths})
            if path in self.files
        }

    def snapshot_contents_for_paths(self, paths: Sequence[str]) -> Mapping[str, bytes]:
        return {
            path: self.files[path].encode("utf-8")
            for path in sorted({_safe_path(path) for path in paths})
            if path in self.files
        }

    def store_blobs_for_paths(
        self, blob_writer: BlobWriter, paths: Sequence[str]
    ) -> Mapping[str, str]:
        return {
            path: blob_writer.put(self.files[path].encode("utf-8"))
            for path in sorted({_safe_path(path) for path in paths})
            if path in self.files
        }

    def read_file(
        self,
        path: str,
        *,
        start_line: int | None = None,
        end_line: int | None = None,
        max_bytes: int,
    ) -> tuple[str, Mapping[str, Any]]:
        relative = _safe_path(path)
        if relative not in self.files:
            raise WorkspaceError(f"{path!r} is not a file")
        text = self.files[relative]
        raw = text.encode("utf-8")
        truncated = len(raw) > max_bytes
        clipped = raw[:max_bytes].decode("utf-8", errors="replace")
        lines = clipped.splitlines()
        start = (start_line or 1) - 1
        end = end_line if end_line is not None else len(lines)
        selected = lines[start:end]
        numbered = "\n".join(f"{start + index + 1}: {line}" for index, line in enumerate(selected))
        return numbered, {
            "path": relative,
            "bytes": min(len(raw), max_bytes),
            "truncated": truncated,
        }

    def list_files(
        self, path: str = ".", *, max_entries: int = 200
    ) -> tuple[str, Mapping[str, Any]]:
        prefix = "" if path == "." else _safe_path(path).rstrip("/") + "/"
        entries = sorted(name for name in self.files if name.startswith(prefix))[:max_entries]
        return "\n".join(entries), {
            "entries": len(entries),
            "truncated": len(entries) >= max_entries,
        }

    def search_code(
        self, query: str, *, glob: str | None = None, max_results: int, max_file_bytes: int
    ) -> tuple[str, Mapping[str, Any]]:
        matches: list[str] = []
        for name, text in sorted(self.files.items()):
            if glob is not None and not PurePosixPath(name).match(glob):
                continue
            if len(text.encode("utf-8")) > max_file_bytes:
                continue
            for line_number, line in enumerate(text.splitlines(), start=1):
                if query in line:
                    matches.append(f"{name}:{line_number}: {line}")
                    if len(matches) >= max_results:
                        return "\n".join(matches), {"matches": len(matches), "truncated": True}
        return "\n".join(matches), {"matches": len(matches), "truncated": False}

    def apply_patch(self, patch: str) -> tuple[str, Mapping[str, Any]]:
        from loopit_patch import PatchError, apply_patch, parse_patch

        try:
            parsed = parse_patch(patch)
            current: dict[str, str] = {}
            for item in parsed:
                for path in (item.old_path, item.new_path):
                    if path is not None and path in self.files:
                        current[path] = self.files[path]
            result = apply_patch(current, patch)
        except PatchError as error:
            return error.observation, {"error": type(error).__name__}
        for name, content in result.files.items():
            relative = _safe_path(name)
            if content is None:
                self.files.pop(relative, None)
            else:
                self.files[relative] = content
        return result.summary(), {
            "created": result.created,
            "modified": result.modified,
            "deleted": result.deleted,
            "hunks_applied": result.hunks_applied,
        }

    def run_shell(
        self, command: str, *, cwd: str | None, timeout_seconds: int, output_bytes: int
    ) -> CommandResult:
        del cwd, timeout_seconds, output_bytes
        result = self.command_results.get(command)
        if result is not None:
            return result
        if command == "npm run build":
            self.files["dist/index.html"] = "built\n"
            return CommandResult(0, stdout="built dist/index.html\n")
        if command.startswith("echo "):
            return CommandResult(0, stdout=shlex.split(command, posix=True)[1] + "\n")
        return CommandResult(
            127, stderr=f"in-memory sandbox has no scripted result for {command!r}"
        )

    def browser_action(self, args: Mapping[str, Any]) -> BrowserActionResult:
        return BrowserActionResult(
            False, "browser REJECTED: no in-memory browser configured", dict(args)
        )


class WorkspaceCommandRunner(CommandRunner):
    """Adapter from tool workspace shell calls to verification command results."""

    def __init__(self, workspace: WorkspaceTransport) -> None:
        self._workspace = workspace

    def run(self, command: tuple[str, ...], *, timeout_seconds: int) -> CommandOutput:
        rendered = " ".join(shlex.quote(part) for part in command)
        result = self._workspace.run_shell(
            rendered, cwd=".", timeout_seconds=timeout_seconds, output_bytes=16_000
        )
        return CommandOutput(
            exit_code=result.exit_code if result.exit_code is not None else 124,
            stdout=result.stdout,
            stderr=result.stderr,
            duration_ms=int(result.duration_seconds * 1000),
            timed_out=result.timed_out,
        )


def _runtime_result_to_workspace_response(
    tool: str, result: Mapping[str, Any]
) -> Mapping[str, Any]:
    if tool == "run_shell":
        return {
            "output": str(result.get("stdout", "")),
            "detail": {
                "exit_code": result.get("exit_code"),
                "stdout": str(result.get("stdout", "")),
                "stderr": str(result.get("stderr", "")),
                "timed_out": bool(result.get("timed_out", False)),
                "duration_seconds": float(result.get("duration_seconds", 0.0)),
                "truncated": bool(result.get("output_truncated", False)),
            },
        }
    if tool == "read_file":
        return {"output": str(result.get("content", "")), "detail": result}
    if tool == "search_code":
        matches = result.get("matches", [])
        if isinstance(matches, list):
            rendered = "\n".join(
                f"{m.get('path')}:{m.get('line')}: {m.get('text')}"
                for m in matches
                if isinstance(m, Mapping)
            )
        else:
            rendered = ""
        return {"output": rendered, "detail": result}
    if tool == "apply_patch":
        return {"output": str(result.get("summary", "patch applied")), "detail": result}
    return {"output": json.dumps(dict(result), sort_keys=True), "detail": result}


def _safe_path(path: str) -> str:
    normalised = path.replace("\\", "/")
    if not normalised or normalised.startswith("/") or normalised.startswith("~"):
        raise WorkspaceError("path must be project-relative")
    parts = tuple(part for part in normalised.split("/") if part not in {"", "."})
    if ".." in parts:
        raise WorkspaceError("parent traversal is not allowed")
    return "/".join(parts) or "."


def _container_id_from_sandbox_id(sandbox_id: str) -> str:
    return _validated_docker_container_id(sandbox_id.removeprefix("docker_"))


def _validated_docker_container_id(container_id: str) -> str:
    if DOCKER_CONTAINER_ID_RE.fullmatch(container_id) is None:
        raise WorkspaceUnavailable("invalid docker sandbox container id")
    return container_id


def _b64(raw: bytes) -> str:
    import base64

    return base64.b64encode(raw).decode("ascii")
