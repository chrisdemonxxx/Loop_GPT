"""Wire ``loopit_gitsync`` into Build Mode projects (Phase 2.3).

Offline default uses :class:`FakeGitProvider`. Live GitHub uses
``LOOPIT_GITHUB_TOKEN`` / ``GIT_SYNC_TOKEN`` (or a stub OAuth vault token
passed at bind time). Push runs on verified checkpoints; webhook pull
creates a new checkpoint and refreshes the workspace. Conflicts copy the
current tip to a ``loopit-backup-<ts>`` branch before applying remote.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from loopit_checkpoint import Checkpoint, CheckpointStore
from loopit_gitsync import (
    DEFAULT_BRANCH,
    GIT_SYNC_TOKEN_SECRET,
    BoundRemote,
    FakeGitProvider,
    GitCommit,
    GithubProvider,
    GitSyncError,
    GitSyncService,
    GitTreeEntry,
    materialize_checkpoint_tree,
)

LOGGER = logging.getLogger("loopit.api.gitsync")


@dataclass
class ProjectGitBinding:
    project_id: str
    tenant_id: str
    provider: str
    owner: str
    name: str
    clone_url: str
    default_branch: str = DEFAULT_BRANCH
    last_commit_sha: str | None = None
    last_checkpoint_id: str | None = None
    auto_push: bool = True


class _StaticLease:
    """Minimal lease stand-in when secrets-broker is not wired for offline sync."""

    def __init__(self, token: str) -> None:
        self._token = token
        self.name = GIT_SYNC_TOKEN_SECRET

    def reveal(self) -> str:
        return self._token


class ProjectGitSync:
    """Per-process git sync coordinator with durable binding sidecars."""

    def __init__(
        self,
        projects_root: Path,
        checkpoints: CheckpointStore,
        *,
        provider: FakeGitProvider | GithubProvider | None = None,
    ) -> None:
        self._root = projects_root
        self._checkpoints = checkpoints
        self._fake = isinstance(provider, FakeGitProvider) or provider is None
        self._provider: FakeGitProvider | GithubProvider = provider or FakeGitProvider()
        self._service = GitSyncService(self._provider, checkpoints)
        self._bindings: dict[str, ProjectGitBinding] = {}
        self._load_all()

    @property
    def provider_name(self) -> str:
        return getattr(self._provider, "provider_name", "fake")

    def _bindings_dir(self) -> Path:
        path = self._root / ".gitsync"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _path_for(self, project_id: str) -> Path:
        return self._bindings_dir() / f"{project_id}.json"

    def _load_all(self) -> None:
        directory = self._bindings_dir()
        for path in directory.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                binding = ProjectGitBinding(**data)
                self._bindings[binding.project_id] = binding
                remote = BoundRemote(
                    binding.provider,
                    binding.owner,
                    binding.name,
                    binding.clone_url,
                    binding.default_branch,
                )
                self._service._remotes[binding.project_id] = remote  # noqa: SLF001
                if isinstance(self._provider, FakeGitProvider):
                    self._provider.remotes[(binding.owner, binding.name)] = remote
            except Exception:
                LOGGER.warning("skip corrupt gitsync binding %s", path)

    def _save(self, binding: ProjectGitBinding) -> None:
        self._bindings[binding.project_id] = binding
        path = self._path_for(binding.project_id)
        path.write_text(json.dumps(asdict(binding), indent=2), encoding="utf-8")

    def status(self, project_id: str) -> dict[str, Any]:
        binding = self._bindings.get(project_id)
        if binding is None:
            return {
                "bound": False,
                "provider": self.provider_name,
                "mode": "fake" if self._fake else "live",
            }
        return {
            "bound": True,
            "provider": binding.provider,
            "mode": "fake" if self._fake else "live",
            "owner": binding.owner,
            "name": binding.name,
            "clone_url": binding.clone_url,
            "default_branch": binding.default_branch,
            "last_commit_sha": binding.last_commit_sha,
            "last_checkpoint_id": binding.last_checkpoint_id,
            "auto_push": binding.auto_push,
        }

    def bind(
        self,
        *,
        project_id: str,
        tenant_id: str,
        owner: str,
        name: str,
        create: bool = True,
        auto_push: bool = True,
        access_token: str | None = None,
    ) -> dict[str, Any]:
        if access_token and isinstance(self._provider, GithubProvider):
            # Re-bind live provider with the OAuth/App token for this session.
            self._provider = GithubProvider(
                access_token,
                credential_resolver=lambda lease: lease.reveal()
                if hasattr(lease, "reveal")
                else access_token,
            )
            self._service = GitSyncService(self._provider, self._checkpoints)
            # Re-attach previously known remotes for other projects is best-effort.
            for existing in self._bindings.values():
                self._service._remotes[existing.project_id] = BoundRemote(  # noqa: SLF001
                    existing.provider,
                    existing.owner,
                    existing.name,
                    existing.clone_url,
                    existing.default_branch,
                )
        remote = self._service.create_or_bind_remote(
            project_id, owner=owner, name=name, create=create
        )
        binding = ProjectGitBinding(
            project_id=project_id,
            tenant_id=tenant_id,
            provider=remote.provider,
            owner=remote.owner,
            name=remote.name,
            clone_url=remote.clone_url,
            default_branch=remote.default_branch,
            auto_push=auto_push,
        )
        self._save(binding)
        return self.status(project_id)

    def unbind(self, project_id: str) -> None:
        self._bindings.pop(project_id, None)
        self._service._remotes.pop(project_id, None)  # noqa: SLF001
        path = self._path_for(project_id)
        if path.exists():
            path.unlink()

    def _credential(self, access_token: str | None = None) -> Any:
        token = (
            access_token
            or os.environ.get("LOOPIT_GITHUB_TOKEN", "").strip()
            or os.environ.get("GIT_SYNC_TOKEN", "").strip()
            or "fake-git-sync-token"
        )
        return _StaticLease(token)

    def push_checkpoint(
        self,
        checkpoint: Checkpoint,
        *,
        run_id: str,
        access_token: str | None = None,
        branch: str | None = None,
    ) -> dict[str, Any]:
        if not checkpoint.verified:
            raise GitSyncError("only green checkpoints may be synced")
        binding = self._bindings.get(checkpoint.project_id)
        if binding is None:
            raise GitSyncError(f"project {checkpoint.project_id!r} has no bound remote")
        commit = self._service.sync_checkpoint(
            checkpoint,
            run_id=run_id,
            credential=self._credential(access_token),
            branch=branch or binding.default_branch,
        )
        binding.last_commit_sha = commit.commit_sha
        binding.last_checkpoint_id = checkpoint.checkpoint_id
        self._save(binding)
        return {
            "commit_sha": commit.commit_sha,
            "branch": commit.branch,
            "checkpoint_id": checkpoint.checkpoint_id,
            "clone_url": commit.remote.clone_url,
        }

    def maybe_auto_push(
        self,
        checkpoint: Checkpoint,
        *,
        run_id: str,
    ) -> dict[str, Any] | None:
        binding = self._bindings.get(checkpoint.project_id)
        if binding is None or not binding.auto_push or not checkpoint.verified:
            return None
        try:
            return self.push_checkpoint(checkpoint, run_id=run_id)
        except GitSyncError as error:
            LOGGER.info("auto git push skipped for %s: %s", checkpoint.project_id, error)
            return None

    def _backup_branch_name(self) -> str:
        return f"loopit-backup-{int(time.time())}"

    def apply_remote_tree(
        self,
        *,
        project_id: str,
        tenant_id: str,
        tree: dict[str, bytes],
        label: str,
        conflict: bool = False,
        workspace_writer: Any | None = None,
    ) -> dict[str, Any]:
        """Create a checkpoint from a remote tree; optionally backup on conflict."""
        binding = self._bindings.get(project_id)
        backup_branch: str | None = None
        if conflict and binding is not None and isinstance(self._provider, FakeGitProvider):
            remote = BoundRemote(
                binding.provider,
                binding.owner,
                binding.name,
                binding.clone_url,
                binding.default_branch,
            )
            backup_branch = self._backup_branch_name()
            tip = self._provider.copy_branch(
                remote, source_branch=binding.default_branch, backup_branch=backup_branch
            )
            if tip is None:
                backup_branch = None

        if workspace_writer is not None:
            workspace_writer(tree)

        checkpoint = self._checkpoints.snapshot(
            project_id=project_id,
            tenant_id=tenant_id,
            files=tree,
            verified=True,
            label=label,
        )
        if binding is not None:
            binding.last_checkpoint_id = checkpoint.checkpoint_id
            self._save(binding)
        return {
            "checkpoint_id": checkpoint.checkpoint_id,
            "backup_branch": backup_branch,
            "files": sorted(tree.keys()),
        }

    def handle_webhook_push(
        self,
        *,
        project_id: str,
        tenant_id: str,
        payload: dict[str, Any],
        workspace_writer: Any | None = None,
    ) -> dict[str, Any]:
        """Ingest a GitHub-style push webhook (or fake payload with ``files``)."""
        binding = self._bindings.get(project_id)
        if binding is None:
            raise GitSyncError(f"project {project_id!r} has no bound remote")

        files_payload = payload.get("files")
        if isinstance(files_payload, dict):
            tree = {
                str(path): (
                    value.encode("utf-8") if isinstance(value, str) else bytes(value)
                )
                for path, value in files_payload.items()
            }
            conflict = bool(payload.get("conflict"))
            return self.apply_remote_tree(
                project_id=project_id,
                tenant_id=tenant_id,
                tree=tree,
                label=str(payload.get("label") or "git pull"),
                conflict=conflict,
                workspace_writer=workspace_writer,
            )

        # Fake provider path: read tip tree from in-memory store.
        if isinstance(self._provider, FakeGitProvider):
            remote = BoundRemote(
                binding.provider,
                binding.owner,
                binding.name,
                binding.clone_url,
                binding.default_branch,
            )
            commit_sha = str(payload.get("after") or payload.get("commit_sha") or "")
            commit = None
            if commit_sha:
                try:
                    entries = self._provider.tree_for(commit_sha)
                except GitSyncError:
                    entries = ()
                    commit = self._provider.head_commit(
                        remote, branch=binding.default_branch
                    )
                    if commit is not None:
                        entries = self._provider.tree_for(commit.commit_sha)
            else:
                commit = self._provider.head_commit(remote, branch=binding.default_branch)
                if commit is None:
                    raise GitSyncError("remote has no commits to pull")
                entries = self._provider.tree_for(commit.commit_sha)
            tree = {entry.path: entry.content for entry in entries}
            conflict = bool(payload.get("conflict"))
            result = self.apply_remote_tree(
                project_id=project_id,
                tenant_id=tenant_id,
                tree=tree,
                label="git pull (webhook)",
                conflict=conflict,
                workspace_writer=workspace_writer,
            )
            if commit is not None:
                binding.last_commit_sha = commit.commit_sha
                self._save(binding)
            return result

        raise GitSyncError(
            "live GitHub webhook pull requires a files payload or checkout agent "
            "(LOOPIT_GITHUB_WEBHOOK_CHECKOUT=1 not implemented offline)"
        )


def gitsync_from_env(projects_root: Path, checkpoints: CheckpointStore) -> ProjectGitSync:
    token = os.environ.get("LOOPIT_GITHUB_TOKEN", "").strip()
    mode = (os.environ.get("LOOPIT_GITSYNC_PROVIDER") or "fake").strip().lower()
    if mode == "github" and token:
        provider: FakeGitProvider | GithubProvider = GithubProvider(
            token,
            credential_resolver=lambda lease: lease.reveal()
            if hasattr(lease, "reveal")
            else token,
        )
        return ProjectGitSync(projects_root, checkpoints, provider=provider)
    return ProjectGitSync(projects_root, checkpoints, provider=FakeGitProvider())


def tree_bytes_from_checkpoint(
    checkpoint: Checkpoint, store: CheckpointStore
) -> dict[str, bytes]:
    entries = materialize_checkpoint_tree(checkpoint, store)
    return {entry.path: entry.content for entry in entries}
