"""Git sync for generated apps, sourced from immutable checkpoint blobs.

The module deliberately works from :class:`loopit_checkpoint.Checkpoint` data and
never from a live sandbox path. That keeps commits aligned with verified
checkpoints and avoids giving sandboxes durable repository credentials.
"""

from __future__ import annotations

import base64
import hashlib
import io
import ipaddress
import math
import re
import tarfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlsplit

from loopit_agent_core.audit import AuditEvent, AuditSink, Outcome
from loopit_agent_core.config import is_placeholder_secret
from loopit_checkpoint import Checkpoint, CheckpointStore
from loopit_secrets import Lease, SecretsBroker, StepContext

DEFAULT_BRANCH = "main"
GIT_SYNC_TOKEN_SECRET = "GIT_SYNC_TOKEN"  # noqa: S105 - secret name, not a value.
# Secrets are scored against their own alphabet rather than an absolute Shannon floor;
# see _looks_high_entropy. The alphabet minimum keeps repetitive padding out.
MIN_SECRET_ALPHABET = 10
MIN_SECRET_ENTROPY_RATIO = 0.85

# TODO: unify this with evals.redteam.SECRET_ENV_NAME and agent-core audit redaction keys.
SECRETISH_NAME_RE = re.compile(
    r"""(?ix)
    (?:secret|token|password|passwd|credential|authorization|session|dsn|encryption)
    | (?:api|private|access|signing|root)[_-]?key
    | (?:^|[_.-])key(?:$|[_.-])
    """
)
ASSIGNMENT_RE = re.compile(
    r"""(?ix)
    (?P<name>
        [A-Z0-9_.-]*
        (?:
            SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|SESSION|DSN|ENCRYPTION
            |API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SIGNING[_-]?KEY|ROOT[_-]?KEY
            |(?:^|[_.-])KEY
        )
        [A-Z0-9_.-]*
    )
    \s*[:=]\s*
    (?P<quote>["']?)
    (?P<value>[A-Za-z0-9_./+=:-]{24,})
    (?P=quote)
    """
)
PROVIDER_SECRET_RES = (
    re.compile(r"\bsk-(?!(?:test_|test\b))[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgh[opsu]_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
)
PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")
CONNECTION_STRING_SCHEMES = {
    "postgres",
    "postgresql",
    "redis",
    "rediss",
    "mongodb",
    "mongodb+srv",
    "amqp",
    "amqps",
    "mysql",
}
BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class GitSyncError(RuntimeError):
    """Git sync/export failed without exposing credentials."""


class ExportRefusal(GitSyncError):
    """A checkpoint cannot be exported because it contains unsafe coupling."""


class ExportSafetyRefusal(ExportRefusal):
    """A checkpoint contains one or more unsafe export safety violations."""

    def __init__(
        self,
        message: str,
        *,
        platform_paths: frozenset[str] = frozenset(),
        secret_paths: frozenset[str] = frozenset(),
    ) -> None:
        super().__init__(message)
        self.platform_paths = platform_paths
        self.secret_paths = secret_paths

    @property
    def is_secret_scan_only(self) -> bool:
        return bool(self.secret_paths) and not self.platform_paths


class IncompleteExportRefusal(ExportRefusal):
    """A portable archive cannot be produced because required export files are missing."""


class PlatformCouplingRefusal(ExportSafetyRefusal):
    """A checkpoint contains Loop-it platform internals that must not be exported."""


class SecretScanRefusal(ExportSafetyRefusal):
    """A checkpoint contains content that looks like a credential."""


class PartialPushError(GitSyncError):
    """Provider wrote a commit but failed before the ref was safely updated."""

    def __init__(self, message: str, *, commit_sha: str | None = None) -> None:
        super().__init__(message)
        self.commit_sha = commit_sha


class ExportFormat(StrEnum):
    ZIP = "zip"
    TAR = "tar"


@dataclass(frozen=True, slots=True)
class BoundRemote:
    provider: str
    owner: str
    name: str
    clone_url: str
    default_branch: str = DEFAULT_BRANCH


@dataclass(frozen=True, slots=True)
class GitTreeEntry:
    path: str
    content: bytes = field(repr=False)

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.content).hexdigest()


@dataclass(frozen=True, slots=True)
class GitCommit:
    commit_sha: str
    tree_sha: str
    message: str
    remote: BoundRemote
    branch: str
    checkpoint_id: str
    run_id: str


@dataclass(frozen=True, slots=True)
class ExportArchive:
    filename: str
    format: ExportFormat
    content: bytes = field(repr=False)
    checkpoint_id: str = ""


@dataclass(frozen=True, slots=True)
class SecretScanOverride:
    """Explicit operator break-glass approval for exporting suspected secrets."""

    actor_id: str
    reason: str

    def __post_init__(self) -> None:
        if not self.actor_id.strip() or not self.reason.strip():
            raise GitSyncError("secret scan override requires actor_id and reason")


@runtime_checkable
class GitProvider(Protocol):
    """Repository operations implemented by GitHub first and fakes in tests."""

    def create_repository(self, owner: str, name: str, *, private: bool = True) -> BoundRemote: ...

    def bind_repository(self, owner: str, name: str) -> BoundRemote: ...

    def push_commit(
        self,
        remote: BoundRemote,
        *,
        branch: str,
        tree: tuple[GitTreeEntry, ...],
        message: str,
        credential: Lease,
    ) -> GitCommit: ...

    def rollback_push(self, remote: BoundRemote, *, branch: str, commit_sha: str) -> None: ...


def materialize_checkpoint_tree(
    checkpoint: Checkpoint, store: CheckpointStore
) -> tuple[GitTreeEntry, ...]:
    """Read a deterministic commit tree from checkpoint blobs."""
    return tuple(
        GitTreeEntry(path=path, content=store.read_file(checkpoint, path))
        for path in sorted(checkpoint.files)
        if _exportable_path(path)
    )


def deterministic_tree_sha(tree: tuple[GitTreeEntry, ...]) -> str:
    hasher = hashlib.sha256()
    for entry in tree:
        hasher.update(entry.path.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(entry.digest.encode("ascii"))
        hasher.update(b"\n")
    return hasher.hexdigest()


def commit_message(checkpoint: Checkpoint, *, run_id: str) -> str:
    return (
        f"Export checkpoint {checkpoint.checkpoint_id}\n\n"
        "Generated from an immutable Loop-it checkpoint.\n\n"
        f"Loopit-Checkpoint: {checkpoint.checkpoint_id}\n"
        f"Loopit-Run: {run_id}"
    )


class ScopedGitCredentialIssuer:
    """Issues short-lived repository credentials through the secrets broker."""

    def __init__(self, broker: SecretsBroker, *, ttl: timedelta = timedelta(minutes=5)) -> None:
        self._broker = broker
        self._ttl = ttl

    def issue(self, context: StepContext) -> Lease:
        return self._broker.issue(context, GIT_SYNC_TOKEN_SECRET, ttl=self._ttl)


class GitSyncService:
    """Coordinates provider binding, checkpoint commits, and full exports."""

    def __init__(
        self,
        provider: GitProvider,
        checkpoints: CheckpointStore,
        *,
        audit: AuditSink | None = None,
    ) -> None:
        self._provider = provider
        self._checkpoints = checkpoints
        self._audit = audit
        self._remotes: dict[str, BoundRemote] = {}
        self._synced: dict[tuple[str, str], GitCommit] = {}

    def create_or_bind_remote(
        self, project_id: str, *, owner: str, name: str, create: bool = True
    ) -> BoundRemote:
        remote = (
            self._provider.create_repository(owner, name, private=True)
            if create
            else self._provider.bind_repository(owner, name)
        )
        self._remotes[project_id] = remote
        return remote

    def sync_checkpoint(
        self,
        checkpoint: Checkpoint,
        *,
        run_id: str,
        credential: Lease,
        branch: str = DEFAULT_BRANCH,
        secret_scan_override: SecretScanOverride | None = None,
    ) -> GitCommit:
        if not checkpoint.verified:
            raise GitSyncError("only green checkpoints may be synced")
        try:
            remote = self._remotes[checkpoint.project_id]
        except KeyError as exc:
            raise GitSyncError(f"project {checkpoint.project_id!r} has no bound remote") from exc
        key = (checkpoint.checkpoint_id, branch)
        if key in self._synced:
            return self._synced[key]
        tree = materialize_checkpoint_tree(checkpoint, self._checkpoints)
        self._validate_or_override(
            tree,
            checkpoint,
            run_id=run_id,
            action="gitsync.sync_checkpoint",
            override=secret_scan_override,
            require_complete=False,
        )
        message = commit_message(checkpoint, run_id=run_id)
        try:
            commit = self._provider.push_commit(
                remote,
                branch=branch,
                tree=tree,
                message=message,
                credential=credential,
            )
        except PartialPushError as exc:
            if exc.commit_sha is not None:
                self._provider.rollback_push(remote, branch=branch, commit_sha=exc.commit_sha)
            raise
        self._synced[key] = commit
        return commit

    def export_checkpoint(
        self,
        checkpoint: Checkpoint,
        *,
        fmt: ExportFormat = ExportFormat.ZIP,
        secret_scan_override: SecretScanOverride | None = None,
    ) -> ExportArchive:
        tree = materialize_checkpoint_tree(checkpoint, self._checkpoints)
        self._validate_or_override(
            tree,
            checkpoint,
            run_id=None,
            action="gitsync.export_checkpoint",
            override=secret_scan_override,
            require_complete=True,
        )
        entries = _with_export_docs(tree, checkpoint)
        filename = f"{checkpoint.project_id}-{checkpoint.checkpoint_id}.{fmt.value}"
        if fmt is ExportFormat.ZIP:
            content = _zip(entries)
        else:
            content = _tar(entries)
        return ExportArchive(filename, fmt, content, checkpoint.checkpoint_id)

    def _validate_or_override(
        self,
        tree: tuple[GitTreeEntry, ...],
        checkpoint: Checkpoint,
        *,
        run_id: str | None,
        action: str,
        override: SecretScanOverride | None,
        require_complete: bool,
    ) -> None:
        if override is not None and self._audit is None:
            raise GitSyncError("secret scan override requires an audit sink")
        try:
            _validate_export(tree, require_complete=require_complete)
        except ExportRefusal as exc:
            if override is None or not _refusal_is_secret_scan_only(exc):
                self._audit_event(
                    "gitsync.export_refused",
                    checkpoint,
                    run_id=run_id,
                    outcome="denied",
                    detail={"action": action, "reason": str(exc)},
                )
                raise
            self._audit_event(
                "gitsync.secret_scan_override",
                checkpoint,
                run_id=run_id,
                outcome="allowed",
                actor_id=override.actor_id,
                detail={"action": action, "reason": override.reason, "refusal": str(exc)},
            )

    def _audit_event(
        self,
        event_type: str,
        checkpoint: Checkpoint,
        *,
        run_id: str | None,
        outcome: Outcome,
        detail: dict[str, str],
        actor_id: str | None = None,
    ) -> None:
        if self._audit is None:
            return
        self._audit.emit(
            AuditEvent(
                type=event_type,
                tenant_id=checkpoint.tenant_id,
                actor_kind="user" if actor_id is not None else "system",
                actor_id=actor_id,
                actor_service=None if actor_id is not None else "loopit-gitsync",
                project_id=checkpoint.project_id,
                run_id=run_id,
                plane="data",
                outcome=outcome,
                detail={"checkpoint_id": checkpoint.checkpoint_id, **detail},
            )
        )


def _refusal_is_secret_scan_only(exc: ExportRefusal) -> bool:
    # Deliberately does not special-case SecretScanRefusal: the waiver must depend on the
    # violations actually collected, so a subclass carrying platform coupling can never be
    # waived by virtue of its type alone.
    return isinstance(exc, ExportSafetyRefusal) and exc.is_secret_scan_only


class FakeGitProvider:
    """In-memory provider with deterministic commit ids and rollback hooks."""

    provider_name = "fake"

    def __init__(self) -> None:
        self.remotes: dict[tuple[str, str], BoundRemote] = {}
        self.commits: dict[str, list[GitCommit]] = {}
        #: Trees keyed by commit sha so webhook/pull can materialise files offline.
        self.trees: dict[str, tuple[GitTreeEntry, ...]] = {}
        #: Branch tips keyed by ``f"{clone_url}:{branch}"``.
        self.heads: dict[str, str] = {}
        self.rolled_back: list[str] = []
        self.fail_next_push_after_write = False

    def create_repository(self, owner: str, name: str, *, private: bool = True) -> BoundRemote:
        remote = BoundRemote("fake", owner, name, f"https://example.invalid/{owner}/{name}.git")
        self.remotes[(owner, name)] = remote
        return remote

    def bind_repository(self, owner: str, name: str) -> BoundRemote:
        return self.remotes.setdefault(
            (owner, name),
            BoundRemote("fake", owner, name, f"https://example.invalid/{owner}/{name}.git"),
        )

    def push_commit(
        self,
        remote: BoundRemote,
        *,
        branch: str,
        tree: tuple[GitTreeEntry, ...],
        message: str,
        credential: Lease,
    ) -> GitCommit:
        tree_sha = deterministic_tree_sha(tree)
        commit_sha = hashlib.sha256(
            f"{remote.clone_url}\n{branch}\n{tree_sha}\n{message}".encode()
        ).hexdigest()
        commit = GitCommit(
            commit_sha=commit_sha,
            tree_sha=tree_sha,
            message=message,
            remote=remote,
            branch=branch,
            checkpoint_id=_trailer(message, "Loopit-Checkpoint"),
            run_id=_trailer(message, "Loopit-Run"),
        )
        self.commits.setdefault(remote.clone_url, []).append(commit)
        self.trees[commit_sha] = tree
        self.heads[f"{remote.clone_url}:{branch}"] = commit_sha
        if self.fail_next_push_after_write:
            self.fail_next_push_after_write = False
            raise PartialPushError("provider failed after writing commit", commit_sha=commit_sha)
        return commit

    def head_commit(self, remote: BoundRemote, *, branch: str) -> GitCommit | None:
        tip = self.heads.get(f"{remote.clone_url}:{branch}")
        if tip is None:
            return None
        for commit in reversed(self.commits.get(remote.clone_url, [])):
            if commit.commit_sha == tip:
                return commit
        return None

    def tree_for(self, commit_sha: str) -> tuple[GitTreeEntry, ...]:
        try:
            return self.trees[commit_sha]
        except KeyError as exc:
            raise GitSyncError(f"unknown commit {commit_sha}") from exc

    def copy_branch(
        self, remote: BoundRemote, *, source_branch: str, backup_branch: str
    ) -> str | None:
        """Point ``backup_branch`` at the current tip of ``source_branch`` (conflict backup)."""
        tip = self.heads.get(f"{remote.clone_url}:{source_branch}")
        if tip is None:
            return None
        self.heads[f"{remote.clone_url}:{backup_branch}"] = tip
        return tip

    def rollback_push(self, remote: BoundRemote, *, branch: str, commit_sha: str) -> None:
        self.rolled_back.append(commit_sha)
        self.commits[remote.clone_url] = [
            commit
            for commit in self.commits.get(remote.clone_url, [])
            if commit.commit_sha != commit_sha
        ]
        head_key = f"{remote.clone_url}:{branch}"
        if self.heads.get(head_key) == commit_sha:
            remaining = self.commits.get(remote.clone_url, [])
            if remaining:
                self.heads[head_key] = remaining[-1].commit_sha
            else:
                self.heads.pop(head_key, None)
        self.trees.pop(commit_sha, None)


class GithubProvider:
    """GitHub API provider; imports httpx lazily so tests need no credentials."""

    provider_name = "github"

    def __init__(
        self,
        api_token: str,
        *,
        api_base: str = "https://api.github.com",
        credential_resolver: Callable[[Lease], str] | None = None,
    ) -> None:
        self._api_token = api_token
        self._api_base = api_base.rstrip("/")
        self._credential_resolver = credential_resolver

    def create_repository(self, owner: str, name: str, *, private: bool = True) -> BoundRemote:
        httpx = _httpx()
        response = httpx.post(
            f"{self._api_base}/orgs/{owner}/repos",
            headers=self._headers(),
            json={"name": name, "private": private, "auto_init": False},
            timeout=15,
        )
        if response.status_code == 404:
            response = httpx.post(
                f"{self._api_base}/user/repos",
                headers=self._headers(),
                json={"name": name, "private": private, "auto_init": False},
                timeout=15,
            )
        response.raise_for_status()
        data = response.json()
        return BoundRemote("github", owner, name, str(data["clone_url"]))

    def bind_repository(self, owner: str, name: str) -> BoundRemote:
        httpx = _httpx()
        response = httpx.get(
            f"{self._api_base}/repos/{owner}/{name}", headers=self._headers(), timeout=15
        )
        response.raise_for_status()
        data = response.json()
        return BoundRemote(
            "github",
            owner,
            name,
            str(data["clone_url"]),
            str(data.get("default_branch", DEFAULT_BRANCH)),
        )

    def push_commit(
        self,
        remote: BoundRemote,
        *,
        branch: str,
        tree: tuple[GitTreeEntry, ...],
        message: str,
        credential: Lease,
    ) -> GitCommit:
        httpx = _httpx()
        token = self._scoped_token(credential)
        tree_entries: list[dict[str, str]] = []
        for entry in tree:
            blob = httpx.post(
                f"{self._api_base}/repos/{remote.owner}/{remote.name}/git/blobs",
                headers=self._headers(token),
                json={
                    "content": base64.b64encode(entry.content).decode("ascii"),
                    "encoding": "base64",
                },
                timeout=15,
            )
            blob.raise_for_status()
            tree_entries.append(
                {
                    "path": entry.path,
                    "mode": "100644",
                    "type": "blob",
                    "sha": str(blob.json()["sha"]),
                }
            )
        tree_response = httpx.post(
            f"{self._api_base}/repos/{remote.owner}/{remote.name}/git/trees",
            headers=self._headers(token),
            json={"tree": tree_entries},
            timeout=15,
        )
        tree_response.raise_for_status()
        tree_sha = str(tree_response.json()["sha"])
        parents = self._current_head(remote.owner, remote.name, branch, token)
        commit_response = httpx.post(
            f"{self._api_base}/repos/{remote.owner}/{remote.name}/git/commits",
            headers=self._headers(token),
            json={"message": message, "tree": tree_sha, "parents": parents},
            timeout=15,
        )
        commit_response.raise_for_status()
        commit_sha = str(commit_response.json()["sha"])
        try:
            self._update_ref(
                remote.owner, remote.name, branch, commit_sha, token, exists=bool(parents)
            )
        except Exception as exc:
            raise PartialPushError("GitHub ref update failed", commit_sha=commit_sha) from exc
        return GitCommit(
            commit_sha=commit_sha,
            tree_sha=tree_sha,
            message=message,
            remote=remote,
            branch=branch,
            checkpoint_id=_trailer(message, "Loopit-Checkpoint"),
            run_id=_trailer(message, "Loopit-Run"),
        )

    def rollback_push(self, remote: BoundRemote, *, branch: str, commit_sha: str) -> None:
        httpx = _httpx()
        ref = f"{self._api_base}/repos/{remote.owner}/{remote.name}/git/ref/heads/{branch}"
        current = httpx.get(ref, headers=self._headers(), timeout=15)
        if current.status_code == 404:
            return
        current.raise_for_status()
        if str(current.json()["object"]["sha"]) == commit_sha:
            httpx.delete(ref, headers=self._headers(), timeout=15).raise_for_status()

    def _headers(self, token: str | None = None) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token or self._api_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _scoped_token(self, credential: Lease) -> str:
        if self._credential_resolver is None:
            raise GitSyncError("GithubProvider requires a scoped credential resolver for pushes")
        return self._credential_resolver(credential)

    def _current_head(self, owner: str, name: str, branch: str, token: str) -> list[str]:
        httpx = _httpx()
        response = httpx.get(
            f"{self._api_base}/repos/{owner}/{name}/git/ref/heads/{branch}",
            headers=self._headers(token),
            timeout=15,
        )
        if response.status_code == 404:
            return []
        response.raise_for_status()
        return [str(response.json()["object"]["sha"])]

    def _update_ref(
        self, owner: str, name: str, branch: str, commit_sha: str, token: str, *, exists: bool
    ) -> None:
        httpx = _httpx()
        if exists:
            response = httpx.patch(
                f"{self._api_base}/repos/{owner}/{name}/git/refs/heads/{branch}",
                headers=self._headers(token),
                json={"sha": commit_sha, "force": False},
                timeout=15,
            )
        else:
            response = httpx.post(
                f"{self._api_base}/repos/{owner}/{name}/git/refs",
                headers=self._headers(token),
                json={"ref": f"refs/heads/{branch}", "sha": commit_sha},
                timeout=15,
            )
        response.raise_for_status()


def _httpx() -> Any:
    try:
        import httpx
    except ImportError as exc:
        raise GitSyncError("install httpx to use GithubProvider") from exc
    return httpx


def _trailer(message: str, name: str) -> str:
    prefix = f"{name}: "
    for line in message.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :]
    raise GitSyncError(f"missing {name} trailer")


def _exportable_path(path: str) -> bool:
    clean = path.replace("\\", "/").lstrip("/")
    if clean.startswith((".loopit/", ".git/", "node_modules/")):
        return False
    return clean not in {".loopit", ".git"}


def _validate_export(tree: tuple[GitTreeEntry, ...], *, require_complete: bool = True) -> None:
    if require_complete:
        _validate_export_completeness(tree)
    _validate_export_safety(tree)


def _validate_export_completeness(tree: tuple[GitTreeEntry, ...]) -> None:
    paths = {entry.path.replace("\\", "/") for entry in tree}
    missing: list[str] = []
    if "package.json" not in paths:
        missing.append("package.json")
    if not any(path.startswith("migrations/") for path in paths):
        missing.append("migrations/")
    if ".env.example" not in paths:
        missing.append(".env.example")
    if missing:
        raise IncompleteExportRefusal(
            "checkpoint is not a complete generated app export: " + ", ".join(missing)
        )


def _validate_export_safety(tree: tuple[GitTreeEntry, ...]) -> None:
    forbidden_tokens = ("loopit_", "LOOPIT_", "preview-proxy", "secrets-broker")
    platform_paths: set[str] = set()
    secret_paths: set[str] = set()
    for entry in tree:
        text = entry.content.decode("utf-8", errors="ignore")
        if any(token in text for token in forbidden_tokens):
            platform_paths.add(entry.path)
        if _looks_like_secret(text):
            secret_paths.add(entry.path)
    if platform_paths and secret_paths:
        raise ExportSafetyRefusal(
            _format_safety_refusal(platform_paths=platform_paths, secret_paths=secret_paths),
            platform_paths=frozenset(platform_paths),
            secret_paths=frozenset(secret_paths),
        )
    if platform_paths:
        raise PlatformCouplingRefusal(
            _format_safety_refusal(platform_paths=platform_paths, secret_paths=set()),
            platform_paths=frozenset(platform_paths),
        )
    if secret_paths:
        raise SecretScanRefusal(
            _format_safety_refusal(platform_paths=set(), secret_paths=secret_paths),
            secret_paths=frozenset(secret_paths),
        )


def _format_safety_refusal(*, platform_paths: set[str], secret_paths: set[str]) -> str:
    groups: list[str] = []
    if secret_paths:
        groups.append(
            "secret scan (looks like it contains a secret): " + ", ".join(sorted(secret_paths))
        )
    if platform_paths:
        groups.append("files contain platform coupling: " + ", ".join(sorted(platform_paths)))
    return "checkpoint export safety violations: " + "; ".join(groups)


def _looks_like_secret(text: str) -> bool:
    """Return true for credential shapes while avoiding ordinary generated output.

    Recall comes from exact provider formats, private-key/JWT structure, inline
    credential URIs, and high-entropy values assigned to secret-ish names.
    Precision comes from not treating entropy alone as sufficient: lockfile
    hashes, UUIDs, git SHAs, minified bundles, and base64 assets are ignored
    unless they appear in a clearly secret-bearing assignment. Placeholder
    shapes reuse loopit_agent_core.config so examples such as sk_test_example do
    not make no-lock-in exports unusable.
    """
    if not text:
        return False
    if _contains_provider_secret(text):
        return True
    if PRIVATE_KEY_RE.search(text):
        return True
    if _contains_jwt(text):
        return True
    if _contains_inline_credential_uri(text):
        return True
    return _contains_secretish_high_entropy_assignment(text)


def _contains_provider_secret(text: str) -> bool:
    for pattern in PROVIDER_SECRET_RES:
        for match in pattern.finditer(text):
            if not _is_placeholder_value(match.group(0)):
                return True
    return False


def _contains_jwt(text: str) -> bool:
    for candidate in re.findall(
        r"\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b", text
    ):
        if all(
            BASE64URL_RE.match(part) for part in candidate.split(".")
        ) and not _is_placeholder_value(candidate):
            header = _decode_base64url_json(candidate.split(".", 1)[0])
            if isinstance(header, dict) and ("alg" in header or "typ" in header):
                return True
    return False


def _decode_base64url_json(segment: str) -> Any:
    import json

    padding = "=" * (-len(segment) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(segment + padding))
    except (ValueError, TypeError):
        return None


def _contains_inline_credential_uri(text: str) -> bool:
    for match in re.finditer(
        r"\b(?:postgres(?:ql)?|rediss?|mongodb(?:\+srv)?|amqps?|mysql)://[^\s'\"<>]+", text
    ):
        uri = match.group(0).rstrip(".,;)")
        parsed = urlsplit(uri)
        if parsed.scheme.lower() not in CONNECTION_STRING_SCHEMES:
            continue
        if (
            parsed.username
            and parsed.password
            and not _is_placeholder_value(parsed.password)
            and (
                _uri_host_is_non_local(parsed.hostname)
                or _credential_password_looks_genuine_secret(parsed.password)
            )
        ):
            return True
    return False


def _uri_host_is_non_local(hostname: str | None) -> bool:
    if not hostname:
        return False
    host = hostname.strip("[]").lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "." in host
    return not (address.is_loopback or address.is_private or address.is_link_local)


def _credential_password_looks_genuine_secret(password: str) -> bool:
    # Host locality is a false-positive reduction heuristic, not a security boundary:
    # keep weak development URI pairs usable at local hosts, but refuse random-looking
    # passwords anywhere because repos can later become public and passwords get reused.
    return (
        len(password) >= 32
        and not _is_placeholder_value(password)
        and _looks_high_entropy(password)
    )


def _contains_secretish_high_entropy_assignment(text: str) -> bool:
    for match in ASSIGNMENT_RE.finditer(text):
        name = match.group("name")
        value = match.group("value").strip().strip("\"'`,;")
        if (
            SECRETISH_NAME_RE.search(name)
            and len(value) >= 32
            and not _is_placeholder_value(value)
            and _looks_high_entropy(value)
        ):
            return True
    return False


def _is_placeholder_value(value: str) -> bool:
    return is_placeholder_secret(value) or bool(
        re.search(r"(?i)(?:^|[_-])(?:example|sample|placeholder|test)(?:$|[_-])", value)
    )


def _looks_high_entropy(value: str) -> bool:
    # Absolute Shannon floors encode an assumption about symbol-set size and silently miss
    # narrow-alphabet secrets: per-character entropy is capped at log2(len(alphabet)), which
    # is exactly 4.0 for hex, so no real `openssl rand -hex 32` value can clear a 4.0 floor.
    # Score against the value's own alphabet instead, requiring an alphabet wide enough that
    # repetitive padding ("abab...", which is maximally random for a 2-symbol alphabet) is
    # not mistaken for a credential.
    alphabet = len(set(value))
    if alphabet < MIN_SECRET_ALPHABET:
        return False
    return _shannon_entropy(value) / math.log2(alphabet) >= MIN_SECRET_ENTROPY_RATIO


def _shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    return -sum(
        (count / len(value)) * math.log2(count / len(value))
        for count in (value.count(char) for char in set(value))
    )


def _with_export_docs(
    tree: tuple[GitTreeEntry, ...], checkpoint: Checkpoint
) -> tuple[GitTreeEntry, ...]:
    extra: list[GitTreeEntry] = []
    extra.append(
        GitTreeEntry(
            "EXPORT_README.md",
            (
                f"# Exported generated app\n\n"
                f"Checkpoint: `{checkpoint.checkpoint_id}`\n\n"
                "This archive is self-contained. Install dependencies with `npm install`, "
                "set values from `.env.example`, run `npm run migrate`, then start the app "
                "with the scripts in `package.json`.\n"
            ).encode(),
        )
    )
    return tuple(sorted((*tree, *extra), key=lambda entry: entry.path))


def _zip(entries: tuple[GitTreeEntry, ...]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            info = zipfile.ZipInfo(entry.path)
            info.date_time = (1980, 1, 1, 0, 0, 0)
            archive.writestr(info, entry.content)
    return buf.getvalue()


def _tar(entries: tuple[GitTreeEntry, ...]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as archive:
        for entry in entries:
            info = tarfile.TarInfo(entry.path)
            info.size = len(entry.content)
            info.mtime = 0
            archive.addfile(info, io.BytesIO(entry.content))
    return buf.getvalue()
