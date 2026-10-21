"""Configuration red-team checks for fail-closed service startup."""

from __future__ import annotations

import ast
import os
import re
from dataclasses import dataclass
from pathlib import Path

import pytest

pytestmark = pytest.mark.fast

REPO_ROOT = Path(__file__).resolve().parents[2]
PLACEHOLDER_SECRET = re.compile(
    r"(?i)(?:change-me|replace-with|placeholder|loopit_dev_password|"
    r"dev[-_].*(?:key|secret|token|password)|local-only)"
)
SECRET_SETTING = re.compile(
    r"(?i)(?:secret|token|password|api[_-]?key|private[_-]?key|signing[_-]?key)"
)
SECRET_ENV_NAME = re.compile(
    r"(?i)(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|SIGNING_KEY|DSN|CREDENTIAL|"
    r"ROOT_KEY|ENCRYPTION)"
)
ENVIRON_READ_METHODS = frozenset({"get", "pop", "setdefault"})
COMPOSE_SECRET_ENV_NAME = re.compile(
    r"(?i)(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|SIGNING_KEY|DATABASE_URL|DSN)"
)
KEY_LIKE_CONSTANT = re.compile(
    r"(?i)(?:secret|token|password|api[_-]?key|private[_-]?key|signing[_-]?key|key)$"
)
PLACEHOLDER_SECRET_VALUE = re.compile(
    r"(?i)(?:change-me|replace-with|placeholder|phase1|dev[-_]|local-only)"
)

# Explicit exceptions for optional credentials and test-only fixtures. Keep this
# narrow: entries must name the exact file, env/constant, and why fail-closed
# production startup does not apply.
ALLOWED_SECRET_ENV_GETS: dict[tuple[str, str], str] = {
    ("evals/harness/src/loopit_evals/executors.py", "HF_TOKEN"): "live eval skips without it",
    ("packages/store/tests/test_migrations.py", "LOOPIT_TEST_DSN"): "test fixture opt-in",
    ("packages/store/tests/test_repositories.py", "LOOPIT_TEST_DSN"): "test fixture opt-in",
    ("packages/provision/tests/test_managed_backend.py", "LOOPIT_TEST_DSN"): "test fixture opt-in",
    ("services/abuse-engine/tests/test_server.py", "LOOPIT_SERVICE_TOKEN"): "test fixture",
    ("services/abuse-engine/tests/test_server.py", "LOOPIT_IDENTITY_SECRET"): "test fixture",
    (
        "services/abuse-engine/tests/test_server.py",
        "LOOPIT_OPERATOR_IDENTITY_SECRET",
    ): "test fixture",
    (
        "services/preview-proxy/tests/test_preview_server.py",
        "LOOPIT_PREVIEW_SIGNING_KEY",
    ): "test fixture",
    (
        "services/router-svc/tests/test_router_server.py",
        "LOOPIT_LEASE_TOKEN_SECRET",
    ): "test fixture",
    ("services/router-svc/tests/test_router_server.py", "LOOPIT_IDENTITY_SECRET"): "test fixture",
    ("services/router-svc/tests/test_router_server.py", "LOOPIT_MODEL_API_KEY"): "test fixture",
    ("services/scheduler/tests/test_scheduler_server.py", "LOOPIT_SERVICE_TOKEN"): "test fixture",
    (
        "services/scheduler/tests/test_scheduler_server.py",
        "LOOPIT_LEASE_TOKEN_SECRET",
    ): "test fixture",
}
MAX_ALLOWED_SECRET_ENV_GETS = 13
ALLOWED_SECRET_CONSTANTS: dict[tuple[str, str], str] = {
    ("apps/api/tests/test_api.py", "IDENTITY_SECRET"): "test fixture",
    ("apps/api/tests/test_api.py", "PREVIEW_SECRET"): "test fixture",
    ("evals/redteam/test_escape_and_bypass.py", "KEY"): "test fixture",
    ("packages/enterprise/tests/test_preflight.py", "ROOT_KEY"): "test fixture",
    ("packages/provision/src/loopit_provision/secrets.py", "DATABASE_URL_SECRET"): "secret name",
    ("packages/provision/src/loopit_provision/secrets.py", "JWT_SECRET_SECRET"): "secret name",
    ("packages/sandbox-sdk/tests/test_flows.py", "SECRET"): "test fixture",
    ("packages/sandbox-sdk/tests/test_channel.py", "KEY"): "test fixture",
    ("packages/sandbox-sdk/tests/test_channel.py", "OTHER_KEY"): "test fixture",
    ("packages/tools/tests/test_tools.py", "KEY"): "test fixture",
    ("sandbox/agent-runtime/tests/test_runtime.py", "KEY"): "test fixture",
    ("services/abuse-engine/tests/test_server.py", "KEY"): "test fixture",
    ("services/abuse-engine/tests/test_server.py", "OPERATOR_KEY"): "test fixture",
    ("services/abuse-engine/tests/test_server.py", "SERVICE_TOKEN"): "test fixture",
    ("services/billing/tests/test_billing.py", "SECRET"): "test fixture",
    ("services/billing/tests/test_usage_report.py", "SECRET"): "test fixture",
    ("services/orchestrator/tests/test_activities.py", "SERVICE_TOKEN"): "test fixture",
    ("services/preview-proxy/tests/test_preview_server.py", "KEY_TEXT"): "test fixture",
    ("services/preview-proxy/tests/test_preview_server.py", "KEY"): "test fixture",
    ("services/preview-proxy/tests/test_preview_proxy.py", "KEY"): "test fixture",
    ("services/preview-proxy/tests/test_preview_proxy.py", "OTHER_KEY"): "test fixture",
    ("services/router-svc/tests/test_router_server.py", "IDENTITY_SECRET"): "test fixture",
    ("services/router-svc/tests/test_router_server.py", "MODEL_API_KEY"): "test fixture",
    ("services/router-svc/tests/test_router_server.py", "SECRET"): "test fixture",
    ("services/router-svc/tests/test_router.py", "SECRET"): "test fixture",
    ("services/scheduler/tests/test_scheduler_server.py", "LEASE_SECRET"): "test fixture",
    ("services/scheduler/tests/test_scheduler_server.py", "SERVICE_TOKEN"): "test fixture",
    ("services/orchestrator/tests/test_dag_activities.py", "SERVICE_TOKEN"): "test fixture",
}
MAX_ALLOWED_SECRET_CONSTANTS = 28

COMPOSE_SERVICE_SECRET_ENV: dict[str, frozenset[str]] = {
    "migrate": frozenset({"DATABASE_URL", "LOOPIT_AUDIT_ROLE_PASSWORD"}),
    "router-svc": frozenset(
        {
            "LOOPIT_LEASE_TOKEN_SECRET",
            "LOOPIT_MODEL_API_KEY",
            "LOOPIT_IDENTITY_SECRET",
            "LOOPIT_STORE_DSN",
        }
    ),
    "egress-proxy": frozenset({"LOOPIT_AUDIT_DSN"}),
    "preview-proxy": frozenset({"LOOPIT_PREVIEW_SIGNING_KEY", "LOOPIT_AUDIT_DSN"}),
    # Public app edge: only needs to write I10 audit decisions and authenticate
    # route lookups to domains. It must never get lease/identity/store secrets.
    "app-proxy": frozenset({"LOOPIT_AUDIT_DSN", "LOOPIT_SERVICE_TOKEN"}),
    # Executes tools inside sandboxes: verifies lease bearer tokens, authenticates to
    # the scheduler, signs the sandbox channel, and reads the durable checkpoint store.
    "workspace-dispatch": frozenset(
        {
            "LOOPIT_AUDIT_DSN",
            "LOOPIT_LEASE_TOKEN_SECRET",
            "LOOPIT_SANDBOX_SIGNING_KEY",
            "LOOPIT_SERVICE_TOKEN",
            "LOOPIT_STORE_DSN",
        }
    ),
    "scheduler": frozenset(
        {
            "LOOPIT_AUDIT_DSN",
            "LOOPIT_LEASE_TOKEN_SECRET",
            "LOOPIT_SCHEDULER_STORE_DSN",
            "LOOPIT_SERVICE_TOKEN",
        }
    ),
    "billing": frozenset(
        {
            "LOOPIT_IDENTITY_SECRET",
            "LOOPIT_SERVICE_TOKEN",
            "LOOPIT_STORE_DSN",
            "STRIPE_API_KEY",
            "STRIPE_WEBHOOK_SECRET",
        }
    ),
    "abuse-engine": frozenset(
        {
            "LOOPIT_SERVICE_TOKEN",
            "LOOPIT_IDENTITY_SECRET",
            "LOOPIT_OPERATOR_IDENTITY_SECRET",
        }
    ),
    "orchestrator": frozenset({"LOOPIT_SERVICE_TOKEN"}),
    "domains": frozenset({"CLOUDFLARE_API_TOKEN", "LOOPIT_AUDIT_DSN", "LOOPIT_SERVICE_TOKEN"}),
    "api": frozenset(
        {
            "LOOPIT_IDENTITY_SECRET",
            "LOOPIT_PREVIEW_SIGNING_KEY",
            "LOOPIT_STORE_DSN",
            # Local RunManager fallback only. Orchestrator runs use router-svc keys (I5).
            "HF_TOKEN",
        }
    ),
    # Portal MCP forwards caller JWTs. It must never receive upstream model keys.
    "loopit-mcp": frozenset(),
}

COMPOSE_ALLOWED_SECRET_ENV = {
    "postgres": frozenset({"POSTGRES_PASSWORD"}),
    "grafana": frozenset({"GF_SECURITY_ADMIN_PASSWORD"}),
}


def test_services_do_not_start_with_placeholder_secrets() -> None:
    """Prod services must fail closed instead of accepting bundled default secrets."""
    offenders: list[str] = []
    paths = [
        *(REPO_ROOT / "services").glob("*/src/**/*.py"),
        *(REPO_ROOT / "apps" / "api" / "src").glob("**/*.py"),
    ]
    for path in sorted(paths):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        lines = source.splitlines()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            line = lines[node.lineno - 1].strip()
            if "is_placeholder_secret" in line:
                continue
            if PLACEHOLDER_SECRET.search(node.value) and SECRET_SETTING.search(node.value):
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{node.lineno}: {line}")

    assert not offenders, "placeholder/default service secrets remain:\n" + "\n".join(offenders)


def test_secret_env_reads_fail_closed_without_defaults() -> None:
    """Secret-named env vars must use require_secret unless explicitly allowlisted."""
    offenders: list[str] = []
    for path in _python_paths():
        relative = path.relative_to(REPO_ROOT).as_posix()
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        lines = source.splitlines()
        for read in _secret_env_reads(tree):
            if read.env_name is None or not SECRET_ENV_NAME.search(read.env_name):
                continue
            if read.uses_require_secret or not read.unsafe_read:
                continue
            if (relative, read.env_name) in ALLOWED_SECRET_ENV_GETS:
                continue
            offenders.append(
                f"{relative}:{read.lineno}: {lines[read.lineno - 1].strip()} uses "
                f"{read.env_name}; use require_secret(...) "
                "or add a documented allowlist entry"
            )

    assert not offenders, "secret env reads bypass fail-closed require_secret:\n" + "\n".join(
        offenders
    )


def test_secret_scan_allowlists_remain_frozen_and_out_of_prod_src() -> None:
    assert len(ALLOWED_SECRET_ENV_GETS) <= MAX_ALLOWED_SECRET_ENV_GETS
    assert len(ALLOWED_SECRET_CONSTANTS) <= MAX_ALLOWED_SECRET_CONSTANTS
    offenders = [
        f"{path}: {name}"
        for path, name in (*ALLOWED_SECRET_ENV_GETS, *ALLOWED_SECRET_CONSTANTS)
        if path.startswith(("services/", "apps/")) and "/src/" in path
    ]
    assert not offenders, "production src files must not be allowlisted:\n" + "\n".join(offenders)


@pytest.mark.parametrize(
    "source, expected",
    [
        (
            'import os\nROOT_KEY = os.environ["LOOPIT_SECRETS_ROOT_KEY"]\n',
            "LOOPIT_SECRETS_ROOT_KEY",
        ),
        (
            'import os\nenv = os.environ\ndsn = env.get("LOOPIT_STORE_DSN", "postgresql://x")\n',
            "LOOPIT_STORE_DSN",
        ),
        (
            'class Settings(BaseSettings):\n    signing_key: str = "a" * 32\n',
            "signing_key",
        ),
    ],
)
def test_secret_scan_catches_evasion_fixtures(source: str, expected: str) -> None:
    offenders = _scan_source_for_secret_misconfiguration(source)

    assert any(expected in offender for offender in offenders)


@pytest.mark.parametrize(
    "source, expected",
    [
        pytest.param(
            'import os\nos.environ.setdefault("LOOPIT_IDENTITY_SECRET", "local-only-secret")\n',
            "LOOPIT_IDENTITY_SECRET",
            id="setdefault-fallback",
        ),
        pytest.param(
            'import os\n_FALLBACK = "local-only-secret"\n'
            'os.environ.setdefault("LOOPIT_IDENTITY_SECRET", _FALLBACK)\n',
            "LOOPIT_IDENTITY_SECRET",
            id="setdefault-indirect-fallback",
        ),
        pytest.param(
            "import os\nenv = dict(os.environ)\n"
            'dsn = env.get("LOOPIT_STORE_DSN", "postgresql://placeholder")\n',
            "LOOPIT_STORE_DSN",
            id="dict-environ-copy-read",
        ),
        pytest.param(
            "import os\nenv = os.environ.copy()\n"
            'token = env.setdefault("LOOPIT_SERVICE_TOKEN", "local-only-token")\n',
            "LOOPIT_SERVICE_TOKEN",
            id="environ-copy-mutating-read",
        ),
        pytest.param(
            "from os import environ as e\n"
            'root = e.pop("LOOPIT_SECRETS_ROOT_KEY", "local-only-root-key")\n',
            "LOOPIT_SECRETS_ROOT_KEY",
            id="pop-fallback",
        ),
        pytest.param(
            "from os import environ as e\n_FALLBACK = 'local-only-root-key'\n"
            'root = e.pop("LOOPIT_SECRETS_ROOT_KEY", _FALLBACK)\n',
            "LOOPIT_SECRETS_ROOT_KEY",
            id="pop-indirect-fallback",
        ),
        pytest.param(
            "import os as o\n"
            'token = getattr(o.environ, "get")("LOOPIT_SERVICE_TOKEN", "local-only-token")\n',
            "LOOPIT_SERVICE_TOKEN",
            id="getattr-environ",
        ),
        pytest.param(
            'import os\ntoken = os.environ.get("LOOPIT_SERVICE_TOKEN") or "local-only-token"\n',
            "LOOPIT_SERVICE_TOKEN",
            id="boolop-or-fallback",
        ),
        pytest.param(
            'from os import getenv\ntoken = getenv("LOOPIT_SERVICE_TOKEN") or "local-only-token"\n',
            "LOOPIT_SERVICE_TOKEN",
            id="imported-getenv-boolop",
        ),
        pytest.param(
            'import os as o\nroot = o.getenv("LOOPIT_SECRETS_ROOT_KEY", "local-only-root-key")\n',
            "LOOPIT_SECRETS_ROOT_KEY",
            id="aliased-os-getenv",
        ),
    ],
)
def test_secret_scan_catches_env_fallback_evasions(source: str, expected: str) -> None:
    offenders = _scan_source_for_secret_misconfiguration(source)

    assert any(expected in offender for offender in offenders)


def test_secret_scan_ignores_benign_non_secret_env_default() -> None:
    offenders = _scan_source_for_secret_misconfiguration(
        'import os\nLOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")\n'
    )

    assert not offenders


def test_module_level_secret_constants_are_test_allowlisted() -> None:
    """Hardcoded shared keys must not ship in src; test fixtures need an explicit allowlist."""
    offenders: list[str] = []
    for path in _python_paths():
        relative = path.relative_to(REPO_ROOT).as_posix()
        source = path.read_text(encoding="utf-8")
        offenders.extend(
            _scan_source_for_secret_misconfiguration(
                source,
                relative=relative,
                allowed_constants=ALLOWED_SECRET_CONSTANTS,
                allowed_env=ALLOWED_SECRET_ENV_GETS,
            )
        )

    assert not offenders, "hardcoded secret/key constants remain:\n" + "\n".join(offenders)


def _scan_source_for_secret_misconfiguration(
    source: str,
    *,
    relative: str = "<fixture>",
    allowed_constants: dict[tuple[str, str], str] | None = None,
    allowed_env: dict[tuple[str, str], str] | None = None,
) -> list[str]:
    allowed = allowed_constants or {}
    env_allowed = allowed_env or {}
    offenders: list[str] = []
    tree = ast.parse(source)
    lines = source.splitlines()
    for body in _assignment_bodies(tree):
        for node in body:
            name, value = _module_constant_assignment(node)
            if name is None or value is None:
                continue
            if (relative, name) in allowed:
                continue
            if not KEY_LIKE_CONSTANT.search(name):
                continue
            text = value.decode("utf-8", errors="ignore") if isinstance(value, bytes) else value
            if len(text) >= 16 or PLACEHOLDER_SECRET_VALUE.search(text):
                lineno = getattr(node, "lineno", 1)
                offenders.append(f"{relative}:{lineno}: {lines[lineno - 1].strip()}")
    for read in _secret_env_reads(tree):
        if (
            read.env_name
            and SECRET_ENV_NAME.search(read.env_name)
            and read.unsafe_read
            and not read.uses_require_secret
            and (relative, read.env_name) not in env_allowed
        ):
            offenders.append(f"{relative}:{read.lineno}: unsafe env read {read.env_name}")
    return offenders


def test_compose_grants_only_declared_service_secrets() -> None:
    """Compose must not merge high-value secrets into services that do not read them."""
    service_env = _compose_service_env(REPO_ROOT / "docker-compose.yml")
    offenders: list[str] = []
    for service, env in sorted(service_env.items()):
        secret_names = {name for name in env if _is_secret_env_name(name)}
        allowed = COMPOSE_SERVICE_SECRET_ENV.get(service, COMPOSE_ALLOWED_SECRET_ENV.get(service))
        if allowed is None:
            if secret_names:
                offenders.append(f"{service}: unexpected secret env {sorted(secret_names)}")
            continue
        extras = secret_names - allowed
        missing = allowed - secret_names
        if extras:
            offenders.append(f"{service}: over-scoped secret env {sorted(extras)}")
        if missing:
            offenders.append(f"{service}: missing required secret env {sorted(missing)}")

    assert not offenders, "docker-compose secret scoping drift:\n" + "\n".join(offenders)


def _python_paths() -> list[Path]:
    """Python modules under the service tree.

    ``Path.glob('**/*.py')`` raises ``FileNotFoundError`` when a directory
    junction points at a missing target, and that aborts the rest of the tree.
    Skip unreadable directories and keep every other readable module.
    """
    roots = ["services", "apps", "packages", "sandbox", "evals"]
    found: list[Path] = []
    pending: list[Path] = [REPO_ROOT / root for root in roots]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                pending.append(Path(entry.path))
            elif entry.name.endswith(".py"):
                found.append(Path(entry.path))
    return sorted(found)


@dataclass(frozen=True, slots=True)
class EnvRead:
    env_name: str | None
    lineno: int
    uses_require_secret: bool
    unsafe_read: bool


def _secret_env_reads(tree: ast.AST) -> list[EnvRead]:
    os_names, getenv_names, environ_names = _env_import_names(tree)
    environ_aliases = _environ_alias_names(tree, os_names, environ_names)

    reads: list[EnvRead] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _is_require_secret_call(node):
            reads.append(EnvRead(_constant_arg(node, 1), node.lineno, True, False))
            continue
        if isinstance(node, ast.BoolOp):
            read = _boolop_env_fallback_read(node, os_names, getenv_names, environ_aliases)
            if read is not None:
                reads.append(read)
            continue
        if isinstance(node, ast.Call):
            env_name = _env_call_name(node, os_names, getenv_names, environ_aliases)
            if env_name is not None:
                reads.append(EnvRead(env_name, node.lineno, False, _call_has_secret_default(node)))
            continue
        if isinstance(node, ast.Subscript) and _is_environ_expr(
            node.value, os_names, environ_aliases
        ):
            reads.append(EnvRead(_constant_slice(node.slice), node.lineno, False, True))
    return reads


def _env_import_names(tree: ast.AST) -> tuple[set[str], set[str], set[str]]:
    os_names = {"os"}
    getenv_names: set[str] = set()
    environ_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "os":
                    os_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module == "os":
            for alias in node.names:
                if alias.name == "getenv":
                    getenv_names.add(alias.asname or alias.name)
                elif alias.name == "environ":
                    environ_names.add(alias.asname or alias.name)
    return os_names, getenv_names, environ_names


def _environ_alias_names(tree: ast.AST, os_names: set[str], environ_names: set[str]) -> set[str]:
    environ_aliases = set(environ_names)
    # This fixed-point pass tracks simple local/global aliases such as
    # env = os.environ, env = environ, env2 = env, env = dict(os.environ), and
    # env = os.environ.copy(). It deliberately does not try to model control
    # flow, shadowing, or aliases to getattr(os.environ, "get") callables.
    changed = True
    while changed:
        changed = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if not _is_environ_alias_expr(node.value, os_names, environ_aliases):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id not in environ_aliases:
                    environ_aliases.add(target.id)
                    changed = True
    return environ_aliases


def _is_environ_alias_expr(node: ast.AST, os_names: set[str], environ_aliases: set[str]) -> bool:
    if _is_environ_expr(node, os_names, environ_aliases):
        return True
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if _is_name_in(func, {"dict"}) and len(node.args) == 1:
        return _is_environ_expr(node.args[0], os_names, environ_aliases)
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "copy"
        and _is_environ_expr(func.value, os_names, environ_aliases)
    )


def _env_call_name(
    node: ast.Call,
    os_names: set[str],
    getenv_names: set[str],
    environ_aliases: set[str],
) -> str | None:
    func = node.func
    if isinstance(func, ast.Attribute) and func.attr in ENVIRON_READ_METHODS:
        if _is_environ_expr(func.value, os_names, environ_aliases):
            return _constant_arg(node, 0)
    if _is_getattr_environ_call(func, os_names, environ_aliases):
        return _constant_arg(node, 0)
    if (
        isinstance(func, ast.Attribute)
        and func.attr == "getenv"
        and _is_name_in(func.value, os_names)
    ):
        return _constant_arg(node, 0)
    if _is_name_in(func, getenv_names):
        return _constant_arg(node, 0)
    return None


def _is_getattr_environ_call(node: ast.AST, os_names: set[str], environ_aliases: set[str]) -> bool:
    if not isinstance(node, ast.Call):
        return False
    if not _is_name_in(node.func, {"getattr"}):
        return False
    if not node.args or not _is_environ_expr(node.args[0], os_names, environ_aliases):
        return False
    method_name = _constant_arg(node, 1)
    return method_name is None or method_name in ENVIRON_READ_METHODS


def _boolop_env_fallback_read(
    node: ast.BoolOp,
    os_names: set[str],
    getenv_names: set[str],
    environ_aliases: set[str],
) -> EnvRead | None:
    if not isinstance(node.op, ast.Or):
        return None
    for index, value in enumerate(node.values[:-1]):
        if all(_expr_is_empty_default(fallback) for fallback in node.values[index + 1 :]):
            continue
        if isinstance(value, ast.Call):
            env_name = _env_call_name(value, os_names, getenv_names, environ_aliases)
            if env_name is not None and not _call_has_secret_default(value):
                return EnvRead(env_name, value.lineno, False, True)
    return None


def _is_require_secret_call(node: ast.Call) -> bool:
    func = node.func
    return (isinstance(func, ast.Name) and func.id == "require_secret") or (
        isinstance(func, ast.Attribute) and func.attr == "require_secret"
    )


def _is_environ_expr(node: ast.AST, os_names: set[str], environ_aliases: set[str]) -> bool:
    if _is_name_in(node, environ_aliases):
        return True
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "environ"
        and _is_name_in(node.value, os_names)
    )


def _is_name_in(node: ast.AST, names: set[str]) -> bool:
    return isinstance(node, ast.Name) and node.id in names


def _constant_arg(node: ast.Call, index: int) -> str | None:
    if len(node.args) <= index:
        return None
    arg = node.args[index]
    if not isinstance(arg, ast.Constant):
        return None
    return arg.value if isinstance(arg.value, str) else None


def _call_has_secret_default(node: ast.Call) -> bool:
    if len(node.args) > 1:
        return not _expr_is_empty_default(node.args[1])
    for keyword in node.keywords:
        if keyword.arg == "default":
            return not _expr_is_empty_default(keyword.value)
    return False


def _expr_is_empty_default(node: ast.expr) -> bool:
    if isinstance(node, ast.Constant):
        return node.value in {None, ""}
    if isinstance(node, ast.Call):
        if len(node.args) > 1:
            return _expr_is_empty_default(node.args[1])
        return any(
            keyword.arg == "default"
            and keyword.value is not None
            and _expr_is_empty_default(keyword.value)
            for keyword in node.keywords
        )
    return False


def _constant_slice(node: ast.expr) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _assignment_bodies(tree: ast.AST) -> list[list[ast.AST]]:
    bodies: list[list[ast.AST]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef):
            bodies.append(list(node.body))
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            defaults = [*(node.args.defaults), *(node.args.kw_defaults)]
            bodies.extend([[default] for default in defaults if isinstance(default, ast.expr)])
    return bodies


def _module_constant_assignment(node: ast.AST) -> tuple[str | None, str | bytes | None]:
    target: ast.Name | None
    value: ast.expr | None
    if isinstance(node, ast.Assign) and len(node.targets) == 1:
        target = node.targets[0] if isinstance(node.targets[0], ast.Name) else None
        value = node.value
    elif isinstance(node, ast.AnnAssign):
        target = node.target if isinstance(node.target, ast.Name) else None
        value = node.value
    elif isinstance(node, ast.expr):
        target = ast.Name(id="parameter_default")
        value = node
    else:
        return None, None
    if target is None or value is None:
        return None, None
    if not isinstance(value, ast.Constant):
        literal = _static_secret_literal(value)
        return (target.id, literal) if literal is not None else (None, None)
    if isinstance(value.value, str | bytes):
        return target.id, value.value
    return None, None


def _static_secret_literal(node: ast.expr) -> str | bytes | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str | bytes):
        return node.value
    if (
        isinstance(node, ast.BinOp)
        and isinstance(node.op, ast.Mult)
        and isinstance(node.left, ast.Constant)
        and isinstance(node.left.value, str | bytes)
        and isinstance(node.right, ast.Constant)
        and isinstance(node.right.value, int)
    ):
        return node.left.value * node.right.value
    return None


def _compose_service_env(path: Path) -> dict[str, set[str]]:
    """Small YAML env-map reader for this compose file's services section."""
    env_by_service: dict[str, set[str]] = {}
    current_service: str | None = None
    in_services = False
    in_environment = False
    environment_indent = 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent == 0:
            in_services = stripped == "services:"
            current_service = None
            in_environment = False
            continue
        if not in_services:
            continue
        if indent == 2 and stripped.endswith(":"):
            current_service = stripped[:-1]
            env_by_service.setdefault(current_service, set())
            in_environment = False
            continue
        if current_service is None:
            continue
        if indent == 4 and stripped == "environment:":
            in_environment = True
            environment_indent = indent
            continue
        if in_environment and indent <= environment_indent:
            in_environment = False
        if not in_environment or indent < 6 or ":" not in stripped:
            continue
        key, _value = stripped.split(":", 1)
        if key != "<<":
            env_by_service[current_service].add(key.strip("'\""))
    return env_by_service


def _is_secret_env_name(name: str) -> bool:
    if name.endswith(("_URL", "_URI", "_HOST", "_HOSTNAME", "_ID", "_KID")):
        return name in {"DATABASE_URL", "LOOPIT_STORE_DSN"}
    return bool(COMPOSE_SECRET_ENV_NAME.search(name))
