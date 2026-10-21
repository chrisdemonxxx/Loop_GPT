from __future__ import annotations

import io
import random
import subprocess
import uuid
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from loopit_agent_core.audit import InMemoryAuditSink
from loopit_checkpoint import Checkpoint, CheckpointStore, InMemoryBlobStore
from loopit_gitsync import (
    BoundRemote,
    ExportRefusal,
    FakeGitProvider,
    GitCommit,
    GitSyncError,
    GitSyncService,
    GitTreeEntry,
    PartialPushError,
    ScopedGitCredentialIssuer,
    SecretScanOverride,
)
from loopit_secrets import (
    Environment,
    Lease,
    LeaseExpired,
    SecretClass,
    SecretsBroker,
    SecretStore,
    SecretValue,
    StepContext,
    StoredSecret,
)

TENANT = "tenant_alpha"
PROJECT = "project_alpha"
RUN = "run_alpha"
TOKEN_NAME = "GIT_SYNC_TOKEN"


class ManualClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, delta: timedelta) -> None:
        self.now += delta


def app_files(extra: dict[str, bytes] | None = None) -> dict[str, bytes]:
    files = {
        "package.json": (
            b'{"scripts":{"start":"node dist/server/index.js",'
            b'"migrate":"node scripts/migrate.mjs"}}'
        ),
        ".env.example": b"DATABASE_URL=\nJWT_SECRET=\nS3_BUCKET=\n",
        "migrations/0001_bootstrap.sql": b"create table schema_migrations(id text primary key);",
        "src/server/index.ts": b"console.log('ready');",
    }
    if extra:
        files.update(extra)
    return files


def checkpoint_store() -> tuple[CheckpointStore, Checkpoint]:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(),
        verified=True,
    )
    return store, checkpoint


def broker(clock: ManualClock) -> SecretsBroker:
    store = SecretStore(Environment.BUILD)
    store.put(
        StoredSecret(
            name=TOKEN_NAME,
            environment=Environment.BUILD,
            secret_class=SecretClass.PROJECT,
            tenant_id=TENANT,
            project_id=PROJECT,
            value=SecretValue("git-sync-runtime-token"),
        )
    )
    return SecretsBroker(store, audit=InMemoryAuditSink(), clock=clock)


def lease(clock: ManualClock) -> Lease:
    context = StepContext(
        run_id=RUN,
        step_id="git-sync",
        tenant_id=TENANT,
        project_id=PROJECT,
        declared_secrets=frozenset({TOKEN_NAME}),
    )
    return ScopedGitCredentialIssuer(broker(clock), ttl=timedelta(minutes=1)).issue(context)


def git(args: list[str], *, cwd: Path, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        text=True,
        capture_output=True,
    )
    return result.stdout.strip()


class LocalGitProvider:
    provider_name = "local"

    def __init__(self, root: Path) -> None:
        self.root = root
        self.remote = root / "remote.git"
        self.worktree = root / "worktree"

    def create_repository(self, owner: str, name: str, *, private: bool = True) -> BoundRemote:
        self.remote.mkdir()
        git(["init", "--bare"], cwd=self.remote)
        return BoundRemote("local", owner, name, str(self.remote))

    def bind_repository(self, owner: str, name: str) -> BoundRemote:
        return BoundRemote("local", owner, name, str(self.remote))

    def push_commit(
        self,
        remote: BoundRemote,
        *,
        branch: str,
        tree: tuple[GitTreeEntry, ...],
        message: str,
        credential: Lease,
    ) -> GitCommit:
        if not self.worktree.exists():
            git(["clone", remote.clone_url, str(self.worktree)], cwd=self.root)
            git(["config", "user.email", "gitsync-test@example.invalid"], cwd=self.worktree)
            git(["config", "user.name", "GitSync Test"], cwd=self.worktree)
        git(["switch", "-C", branch], cwd=self.worktree)
        for entry in tree:
            path = self.worktree / entry.path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(entry.content)
        git(["add", "."], cwd=self.worktree)
        git(["commit", "-m", message], cwd=self.worktree)
        git(["push", "origin", f"HEAD:{branch}"], cwd=self.worktree)
        commit_sha = git(["rev-parse", "HEAD"], cwd=self.worktree)
        tree_sha = git(["rev-parse", "HEAD^{tree}"], cwd=self.worktree)
        return GitCommit(
            commit_sha,
            tree_sha,
            message,
            remote,
            branch,
            _trailer(message, "Loopit-Checkpoint"),
            _trailer(message, "Loopit-Run"),
        )

    def rollback_push(self, remote: BoundRemote, *, branch: str, commit_sha: str) -> None:
        git(["push", "origin", f":{branch}"], cwd=self.worktree)


def _trailer(message: str, name: str) -> str:
    prefix = f"{name}: "
    for line in message.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :]
    raise AssertionError(f"missing {name}")


def test_fake_provider_round_trip_creates_bound_repo_and_commit() -> None:
    store, checkpoint = checkpoint_store()
    provider = FakeGitProvider()
    service = GitSyncService(provider, store)
    remote = service.create_or_bind_remote(PROJECT, owner="owner", name="repo")
    commit = service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    assert remote.clone_url in provider.commits
    assert provider.commits[remote.clone_url] == [commit]
    assert commit.checkpoint_id == checkpoint.checkpoint_id
    assert f"Loopit-Run: {RUN}" in commit.message


def test_checkpoint_commit_is_deterministic_and_uses_checkpoint_tree() -> None:
    store, checkpoint = checkpoint_store()
    provider = FakeGitProvider()
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    first = service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))
    second = service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    assert first.commit_sha == second.commit_sha
    assert first.tree_sha == second.tree_sha
    assert len(provider.commits[first.remote.clone_url]) == 1


def test_scoped_credential_expires() -> None:
    clock = ManualClock()
    secrets = broker(clock)
    context = StepContext(RUN, "git-sync", TENANT, PROJECT, frozenset({TOKEN_NAME}))
    token = ScopedGitCredentialIssuer(secrets, ttl=timedelta(seconds=30)).issue(context)

    assert secrets.reveal(token) == "git-sync-runtime-token"
    clock.advance(timedelta(seconds=31))
    with pytest.raises(LeaseExpired):
        secrets.reveal(token)


def test_export_contains_required_files_and_no_secret_or_platform_coupling() -> None:
    store, checkpoint = checkpoint_store()
    archive = GitSyncService(FakeGitProvider(), store).export_checkpoint(checkpoint)
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zf:
        names = set(zf.namelist())
        body = b"\n".join(zf.read(name) for name in names)

    assert {
        "package.json",
        ".env.example",
        "migrations/0001_bootstrap.sql",
        "EXPORT_README.md",
    } <= names
    assert b"git-sync-runtime-token" not in body
    assert b"LOOPIT_" not in body


@pytest.mark.parametrize(
    "secretish",
    [
        "sk" + "-abcdefghijklmnopqrstuvwxyz123456",
        "ghp_abcdefghijklmnopqrstuvwxyzABCDEF123456",
        "github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        "AK" + "IAABCDEFGHIJKLMNOP",
        "xox" + "b-123456789012-abcdefghijklmno",
        "sk_" + "live_abcdefghijklmnopqrstuvwxyz123456",
        "AI" + "zaSyA1234567890abcdefghijklmnopqrstuvwxyz",
        "-----BEGIN " + "PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0."
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        ),
        "API_TOKEN=Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7Xz",
    ],
)
def test_export_refuses_secret_like_content(secretish: str) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files({"src/server/leak.ts": secretish.encode()}),
        verified=True,
    )

    with pytest.raises(ExportRefusal):
        GitSyncService(FakeGitProvider(), store).export_checkpoint(checkpoint)


def test_sync_checkpoint_refuses_secret_before_pushing_to_real_git_remote(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    secret = "postgres://app:super-secret-runtime-password@db.internal/app"
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files({"src/server/leak.ts": f"export const dsn = {secret!r};".encode()}),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(ExportRefusal, match="looks like it contains a secret"):
        service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""


def test_sync_checkpoint_refuses_openai_key_even_with_example_comment(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    openai_key = "sk-proj-Ab3xYz9LmNoPqRsTuVwXyZ01234567890"
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(
            {"src/server/ai.ts": f"export const OPENAI_KEY = {openai_key!r}; // example\n".encode()}
        ),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(ExportRefusal, match="looks like it contains a secret"):
        service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""


def test_sync_checkpoint_refuses_hex_secret_assignment_before_pushing(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    secret = HEX32_SECRET
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(
            {"src/server/auth.ts": f'JWT_SECRET = "{secret}"  # generated by openssl\n'.encode()}
        ),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(ExportRefusal, match="looks like it contains a secret"):
        service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""


def test_sync_checkpoint_refuses_bare_vendor_key_assignment(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    secret = "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7Xz"
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(
            {"src/server/billing.ts": f'export const STRIPE_KEY = "{secret}";\n'.encode()}
        ),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(ExportRefusal, match="looks like it contains a secret"):
        service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""


def test_sync_checkpoint_allows_operator_override_and_audits(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    secret = "postgres://app:super-secret-runtime-password@db.internal/app"
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files({"src/server/leak.ts": f"export const dsn = {secret!r};".encode()}),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    audit = InMemoryAuditSink()
    service = GitSyncService(provider, store, audit=audit)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    service.sync_checkpoint(
        checkpoint,
        run_id=RUN,
        credential=lease(ManualClock()),
        secret_scan_override=SecretScanOverride(
            actor_id="operator_1",
            reason="confirmed user-owned fixture can be exported",
        ),
    )

    pushed = git(
        ["--git-dir", str(provider.remote), "show", "main:src/server/leak.ts"], cwd=tmp_path
    )
    assert secret in pushed
    event = audit.of_type("gitsync.secret_scan_override")[0].to_dict()
    assert event["actor"]["id"] == "operator_1"
    assert event["outcome"] == "allowed"


def test_secret_scan_override_requires_audit_sink(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    secret = "postgres://user:ProdPassword123456789@db.internal/app"
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files({"src/server/leak.ts": f"export const dsn = {secret!r};\n".encode()}),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(GitSyncError, match="audit"):
        service.sync_checkpoint(
            checkpoint,
            run_id=RUN,
            credential=lease(ManualClock()),
            secret_scan_override=SecretScanOverride(
                actor_id="operator_1",
                reason="confirmed user-owned fixture can be exported",
            ),
        )

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""


def test_secret_scan_override_does_not_waive_platform_coupling(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files({"src/server/platform.ts": b"const broker = 'secrets-broker';\n"}),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    audit = InMemoryAuditSink()
    service = GitSyncService(provider, store, audit=audit)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(ExportRefusal, match="platform coupling"):
        service.sync_checkpoint(
            checkpoint,
            run_id=RUN,
            credential=lease(ManualClock()),
            secret_scan_override=SecretScanOverride(
                actor_id="operator_1",
                reason="confirmed user-owned fixture can be exported",
            ),
        )

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""
    assert audit.of_type("gitsync.secret_scan_override") == ()


def test_secret_scan_override_does_not_skip_later_platform_coupling(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    earlier_secret = "sk" + "-abcdefghijklmnopqrstuvwxyz123456"
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(
            {
                "a.env": f"APP_DSN={earlier_secret}\n".encode(),
                "z.py": (b"def handler():\n    broker = 'secrets-broker'\n    return broker\n"),
            }
        ),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    audit = InMemoryAuditSink()
    service = GitSyncService(provider, store, audit=audit)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")
    override = SecretScanOverride(
        actor_id="operator_1",
        reason="confirmed user-owned fixture can be exported",
    )

    with pytest.raises(ExportRefusal, match=r"a\.env.*z\.py|z\.py.*a\.env"):
        service.export_checkpoint(checkpoint, secret_scan_override=override)

    with pytest.raises(ExportRefusal, match=r"a\.env.*z\.py|z\.py.*a\.env"):
        service.sync_checkpoint(
            checkpoint,
            run_id=RUN,
            credential=lease(ManualClock()),
            secret_scan_override=override,
        )

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""
    z_file = git(
        ["--git-dir", str(provider.remote), "cat-file", "-e", "main:z.py"],
        cwd=tmp_path,
        check=False,
    )
    assert z_file == ""
    assert audit.of_type("gitsync.secret_scan_override") == ()


def test_sync_checkpoint_allows_in_progress_scaffold_without_export_completeness(
    tmp_path: Path,
) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files={
            "package.json": b'{"scripts":{"start":"vite --host 0.0.0.0"}}',
            "src/App.tsx": b"export function App() { return <h1>Hello</h1>; }\n",
        },
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    assert git(
        ["--git-dir", str(provider.remote), "show-ref", "--verify", "refs/heads/main"],
        cwd=tmp_path,
    )
    with pytest.raises(ExportRefusal, match="complete generated app export"):
        service.export_checkpoint(checkpoint)


STRONG_CONNECTION_VALUE = "N7qR4vZp9Lm2Xc8Ts5Hy0Bk3Wf6Ea1Ud9Gj4"
# Real generator output, not hand-written uniform strings: narrow-alphabet secrets are the
# class an absolute Shannon floor silently misses, so the fixtures must be genuinely random.
# Derived from fixed seeds so they stay reproducible without embedding secret literals that
# the red-team hardcoded-secret scanner would (correctly) flag.
HEX32_SECRET = random.Random(1337).randbytes(32).hex()
HEX16_SECRET = random.Random(4242).randbytes(16).hex()
UUID4_SECRET = str(uuid.UUID(int=random.Random(7).getrandbits(128), version=4))


def connection_uri(scheme: str, username: str, password: str, host: str, path: str = "/app") -> str:
    return f"{scheme}://{username}:{password}@{host}{path}"


@pytest.mark.parametrize(
    "uri",
    [
        connection_uri("redis", "default", STRONG_CONNECTION_VALUE, "redis", ""),
        connection_uri("postgres", "app", STRONG_CONNECTION_VALUE, "10.0.0.5", "/db"),
        connection_uri("postgres", "app", STRONG_CONNECTION_VALUE, "[fd00::5]", "/db"),
        connection_uri("postgres", "app", "devfixture", "db.internal"),
        connection_uri("postgres", "app", "devfixture", "postgres.default.svc.cluster.local"),
        connection_uri("mongodb+srv", "u", "p", "cluster0.x.mongodb.net"),
        # Narrow-alphabet machine-generated passwords at *local* hosts: refused because the
        # password is a real secret, which is the whole point of keying on the password.
        connection_uri("postgres", "app", HEX32_SECRET, "db:5432", "/appdb"),
        connection_uri("postgres", "app", HEX16_SECRET, "localhost:5432", "/appdb"),
        connection_uri("redis", "default", UUID4_SECRET, "redis", ""),
    ],
)
def test_connection_uri_credential_refusal_boundaries(uri: str, tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(
            {
                "src/server/config.ts": (
                    f"export const DATABASE_URL = {uri!r};\n"
                    "export function config() { return DATABASE_URL; }\n"
                ).encode()
            }
        ),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(ExportRefusal, match="looks like it contains a secret"):
        service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    refs = git(["--git-dir", str(provider.remote), "show-ref"], cwd=tmp_path, check=False)
    assert refs == ""


@pytest.mark.parametrize(
    "uri",
    [
        connection_uri("postgres", "postgres", "postgres", "db:5432", "/appdb"),
        connection_uri("postgres", "user", "password", "db:5432", "/appdb"),
        connection_uri("mysql", "root", "root", "mysql"),
        connection_uri("postgres", "admin", "admin", "postgres"),
        connection_uri("amqp", "guest", "guest", "rabbitmq:5672"),
        connection_uri("redis", "default", "placeholder", "redis:6379", "/0"),
    ],
)
def test_connection_uri_development_fixtures_still_export(uri: str) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(
            {
                ".env.example": (
                    f"DATABASE_URL={uri}\n"
                    "JWT_SECRET=replace-with-jwt-secret\n"
                    "S3_BUCKET=example-bucket\n"
                ).encode()
            }
        ),
        verified=True,
    )

    archive = GitSyncService(FakeGitProvider(), store).export_checkpoint(checkpoint)
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zf:
        assert ".env.example" in zf.namelist()


def test_realistic_generated_app_false_positive_shapes_export_and_sync(tmp_path: Path) -> None:
    store = CheckpointStore(InMemoryBlobStore())
    checkpoint = store.snapshot(
        project_id=PROJECT,
        tenant_id=TENANT,
        files=app_files(
            {
                ".env.example": (
                    b"DATABASE_URL=postgres://postgres:postgres@db:5432/app\n"
                    b"REDIS_URL=redis://user:mypassword@redis:6379/0\n"
                    b"STRIPE_KEY=sk_test_example\n"
                    b"SIGNING_KEY=replace-with-signing-key\n"
                    b"ROOT_KEY=placeholder\n"
                    b"ENCRYPTION_KEY=change-me\n"
                    b"OPENAI_KEY=sk-test_placeholder\n"
                    b"APP_DSN=postgres://user:password@postgres:5432/app\n"
                ),
                "package-lock.json": (
                    b'{"packages":{"":{"version":"1.0.0"}},'
                    b'"integrity":"sha512-lm7qfVHDx0wAAl5m9C0Z7ckm0Uy6xl6r2=="}'
                ),
                "src/server/generated.ts": (
                    b"export const requestId = '550e8400-e29b-41d4-a716-446655440000';\n"
                    b"export const gitSha = '0123456789abcdef0123456789abcdef01234567';\n"
                    b"export const pixel = 'data:image/png;base64,"
                    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
                    b"+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';\n"
                ),
            }
        ),
        verified=True,
    )
    provider = LocalGitProvider(tmp_path)
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    archive = service.export_checkpoint(checkpoint)
    service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    assert archive.content
    assert git(
        ["--git-dir", str(provider.remote), "show-ref", "--verify", "refs/heads/main"],
        cwd=tmp_path,
    )


def test_partial_push_is_rolled_back() -> None:
    store, checkpoint = checkpoint_store()
    provider = FakeGitProvider()
    provider.fail_next_push_after_write = True
    service = GitSyncService(provider, store)
    service.create_or_bind_remote(PROJECT, owner="owner", name="repo")

    with pytest.raises(PartialPushError):
        service.sync_checkpoint(checkpoint, run_id=RUN, credential=lease(ManualClock()))

    assert provider.rolled_back
    assert provider.commits[next(iter(provider.commits))] == []
