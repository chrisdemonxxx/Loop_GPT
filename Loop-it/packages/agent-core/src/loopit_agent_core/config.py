"""Fail-closed configuration helpers for control-plane secrets."""

from __future__ import annotations

import re
import shlex
from collections.abc import Mapping
from urllib.parse import urlparse

PLACEHOLDER_SECRET_RE = re.compile(
    r"(?i)(?:change[-_]?me|replace[-_]?with|placeholder|"
    r"example\.(?:com|org|net)\b|\b(?:example|sample)[-_]?(?:secret|key|token|password|value)\b|"
    r"loopit_dev_password|insecure|notsecret|not[-_]a[-_]secret|"
    r"dev[-_].*(?:key|secret|token|password)|local-only|"
    r"^(?:secret|password|test|todo|xxx+|foo|bar)$)"
)


class SecretConfigurationError(RuntimeError):
    """A required secret was missing, weak, or a known placeholder."""


class UnsafeConfigurationError(RuntimeError):
    """A dangerous development-only configuration was enabled unsafely."""


def require_secret(env: Mapping[str, str], name: str, *, min_length: int = 32) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise SecretConfigurationError(f"{name} must be set")
    if len(value) < min_length:
        raise SecretConfigurationError(f"{name} must be at least {min_length} characters")
    if PLACEHOLDER_SECRET_RE.search(value):
        raise SecretConfigurationError(f"{name} must not use a placeholder value")
    return value


def is_placeholder_secret(value: str) -> bool:
    return bool(PLACEHOLDER_SECRET_RE.search(value))


def is_truthy(value: str | None) -> bool:
    return (value or "0").lower() in {"1", "true", "yes", "on"}


# Environment names that explicitly opt into non-production behavior. Missing,
# blank, or unrecognized LOOPIT_ENV values count as production markers so a
# deployment must deliberately declare itself local/dev before dangerous
# development-only bypasses are allowed.
NON_PRODUCTION_ENVIRONMENTS = frozenset({"dev", "development", "local"})


def has_production_marker(env: Mapping[str, str]) -> bool:
    environment = env.get("LOOPIT_ENV", "").strip().lower()
    if environment not in NON_PRODUCTION_ENVIRONMENTS:
        return True
    if _url_points_at_non_local_host(env.get("LOOPIT_PUBLIC_URL", "")):
        return True
    for name in ("LOOPIT_STORE_DSN", "LOOPIT_POSTGRES_DSN", "DATABASE_URL"):
        if _dsn_points_at_non_local_host(env.get(name, "")):
            return True
    return False


def _url_points_at_non_local_host(url: str) -> bool:
    return _dsn_points_at_non_local_host(url)


def _dsn_points_at_non_local_host(dsn: str) -> bool:
    if not dsn:
        return False
    host = _dsn_hostname(dsn)
    if not host:
        return True
    return host.lower() not in {"localhost", "127.0.0.1", "::1"}


def _dsn_hostname(dsn: str) -> str | None:
    parsed = urlparse(dsn)
    if parsed.hostname:
        return parsed.hostname
    return _libpq_keyword_value(dsn, "host")


def _libpq_keyword_value(dsn: str, key: str) -> str | None:
    try:
        tokens = shlex.split(dsn)
    except ValueError:
        return None
    key = key.lower()
    prefix = f"{key}="
    for index, token in enumerate(tokens):
        normalized = token.lower()
        if normalized.startswith(prefix):
            value = token[len(prefix) :].strip().strip("'\"")
            if value:
                return value
            if len(tokens) > index + 1:
                return tokens[index + 1].strip().strip("'\"") or None
        next_value = _next_token_value(tokens, index)
        if normalized == key and next_value:
            return next_value
    return None


def _next_token_value(tokens: list[str], index: int) -> str | None:
    if len(tokens) > index + 2 and tokens[index + 1] == "=":
        return tokens[index + 2].strip().strip("'\"") or None
    if len(tokens) > index + 1 and tokens[index + 1].startswith("="):
        return tokens[index + 1][1:].strip().strip("'\"") or None
    return None
