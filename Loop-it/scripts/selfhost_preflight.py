from __future__ import annotations

import argparse
import os
import sys

from loopit_agent_core.config import has_production_marker, is_placeholder_secret, is_truthy

REQUIRED = (
    "LOOPIT_ENV",
    "LOOPIT_PUBLIC_URL",
    "LOOPIT_POSTGRES_DSN",
    "LOOPIT_TEMPORAL_ADDRESS",
    "LOOPIT_REDIS_URL",
    "LOOPIT_OBJECT_STORAGE_ENDPOINT",
    "LOOPIT_OBJECT_STORAGE_BUCKET",
    "LOOPIT_MODEL_ENDPOINT",
    "LOOPIT_SANDBOX_PROVIDER",
    "LOOPIT_AUDIT_DSN",
)
REQUIRED_SECRETS: dict[str, int] = {
    "POSTGRES_PASSWORD": 16,
    "LOOPIT_IDENTITY_SECRET": 32,
    "LOOPIT_OPERATOR_IDENTITY_SECRET": 32,
    "LOOPIT_PREVIEW_SIGNING_KEY": 32,
    "LOOPIT_LEASE_TOKEN_SECRET": 32,
    "LOOPIT_SERVICE_TOKEN": 32,
    "LOOPIT_MODEL_API_KEY": 32,
    "LOOPIT_SANDBOX_SIGNING_KEY": 32,
    "LOOPIT_AUDIT_ROLE_PASSWORD": 16,
    "GRAFANA_ADMIN_PASSWORD": 16,
}
REQUIRED_BASE64_32_BYTE_SECRETS: tuple[str, ...] = ()
OPTIONAL = (
    "LOOPIT_OIDC_ISSUER",
    "LOOPIT_OIDC_CLIENT_ID",
    "LOOPIT_AIRGAP_BUNDLE_PATH",
)


def check(env: dict[str, str]) -> tuple[list[str], list[str], list[str]]:
    required_names = tuple(
        dict.fromkeys((*REQUIRED, *REQUIRED_SECRETS, *REQUIRED_BASE64_32_BYTE_SECRETS))
    )
    missing = [name for name in required_names if not env.get(name)]
    invalid = [
        f"{name} must be at least {minimum} characters"
        for name, minimum in REQUIRED_SECRETS.items()
        if env.get(name) and len(env[name]) < minimum
    ]
    invalid.extend(
        f"{name} must not use a placeholder value"
        for name in (*REQUIRED_SECRETS, *REQUIRED_BASE64_32_BYTE_SECRETS)
        if env.get(name) and is_placeholder_secret(env[name])
    )
    if env.get("LOOPIT_ABUSE_DRY_RUN", "0").lower() in {"1", "true", "yes", "on"}:
        invalid.append("LOOPIT_ABUSE_DRY_RUN must be 0/false for production enforcement")
    if is_truthy(env.get("LOOPIT_DEV_SINGLE_TENANT")) and has_production_marker(env):
        invalid.append("LOOPIT_DEV_SINGLE_TENANT must be unset/0 for production auth")
    if is_truthy(env.get("LOOPIT_AUDIT_EPHEMERAL")):
        invalid.append("LOOPIT_AUDIT_EPHEMERAL must be unset/0 so edge audit records persist")
    provider = env.get("LOOPIT_SANDBOX_PROVIDER", "").strip().lower()
    if provider in {"memory", "inmemory", "in-memory"}:
        invalid.append("LOOPIT_SANDBOX_PROVIDER=memory is not a production isolation boundary")
    if provider == "e2b" and not env.get("LOOPIT_E2B_TEMPLATE_ID"):
        invalid.append("LOOPIT_E2B_TEMPLATE_ID is required when LOOPIT_SANDBOX_PROVIDER=e2b")
    if has_production_marker(env) and env.get("LOOPIT_REQUIRE_AUP", "1").strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }:
        invalid.append("LOOPIT_REQUIRE_AUP must be 1 in production so register accepts the AUP")
    audit_dsn = env.get("LOOPIT_AUDIT_DSN", "")
    if audit_dsn and is_placeholder_secret(audit_dsn):
        invalid.append("LOOPIT_AUDIT_DSN must not use a placeholder value")
    warnings = [name for name in OPTIONAL if not env.get(name)]
    return missing, warnings, invalid


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline self-host preflight for Loop-it.")
    parser.add_argument(
        "--env-file", help="Optional KEY=VALUE file to check instead of process env"
    )
    args = parser.parse_args(argv)
    env = dict(os.environ)
    if args.env_file:
        env.update(_read_env_file(args.env_file))
    missing, warnings, invalid = check(env)
    if missing:
        print("Missing required config:")
        for name in missing:
            print(f"- {name}")
    else:
        print("Required self-host config present.")
    if warnings:
        print("Optional config not set:")
        for name in warnings:
            print(f"- {name}")
    if invalid:
        print("Invalid required secrets:")
        for issue in invalid:
            print(f"- {issue}")
    return 1 if missing or invalid else 0


def _read_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


if __name__ == "__main__":
    sys.exit(main())
