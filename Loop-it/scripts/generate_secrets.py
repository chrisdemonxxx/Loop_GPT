from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path
from urllib.parse import quote

REPO_ROOT = Path(__file__).resolve().parents[1]


def token_urlsafe(length: int = 48) -> str:
    return secrets.token_urlsafe(length)


def generated_values() -> dict[str, str]:
    postgres_password = token_urlsafe(36)
    audit_role_password = token_urlsafe(36)
    database_url = (
        "postgresql://loopit:" + quote(postgres_password, safe="") + "@postgres:5432/loopit"
    )
    audit_url = (
        "postgresql://loopit_audit_writer:"
        + quote(audit_role_password, safe="")
        + "@postgres:5432/loopit"
    )
    return {
        "LOOPIT_ENV": "dev",
        "POSTGRES_PASSWORD": postgres_password,
        "DATABASE_URL": database_url,
        "LOOPIT_STORE_DSN": database_url,
        "LOOPIT_POSTGRES_DSN": database_url,
        "LOOPIT_AUDIT_DSN": audit_url,
        "LOOPIT_AUDIT_ROLE_PASSWORD": audit_role_password,
        "LOOPIT_AUDIT_EPHEMERAL": "0",
        "LOOPIT_PUBLIC_URL": "http://localhost:8080",
        "LOOPIT_REDIS_URL": "redis://redis:6379/0",
        "LOOPIT_OBJECT_STORAGE_ENDPOINT": "http://minio:9000",
        "LOOPIT_OBJECT_STORAGE_BUCKET": "loopit-local",
        "LOOPIT_MODEL_ENDPOINT": "https://router.huggingface.co",
        "LOOPIT_SANDBOX_PROVIDER": "docker",
        "LOOPIT_IDENTITY_SECRET": token_urlsafe(),
        "LOOPIT_OPERATOR_IDENTITY_SECRET": token_urlsafe(),
        "LOOPIT_PREVIEW_SIGNING_KEY": token_urlsafe(),
        "LOOPIT_LEASE_TOKEN_SECRET": token_urlsafe(),
        "LOOPIT_SERVICE_TOKEN": token_urlsafe(),
        "LOOPIT_MODEL_API_KEY": token_urlsafe(),
        "LOOPIT_SANDBOX_SIGNING_KEY": token_urlsafe(),
        "GRAFANA_ADMIN_PASSWORD": token_urlsafe(24),
    }


def render(template: Path) -> str:
    replacements = generated_values()
    lines: list[str] = []
    seen: set[str] = set()
    for raw in template.read_text(encoding="utf-8").splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            lines.append(raw)
            continue
        key, _value = raw.split("=", 1)
        seen.add(key)
        lines.append(f"{key}={replacements.get(key, _value)}")
    for key, value in replacements.items():
        if key not in seen:
            lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate a local Loop-it .env with strong secrets."
    )
    parser.add_argument("--template", default=str(REPO_ROOT / ".env.example"))
    parser.add_argument("--output", default=str(REPO_ROOT / ".env"))
    parser.add_argument("--force", action="store_true", help="overwrite an existing output file")
    args = parser.parse_args(argv)

    output = Path(args.output)
    if output.exists() and not args.force:
        print(f"{output} already exists; pass --force to replace it", file=sys.stderr)
        return 1
    output.write_text(render(Path(args.template)), encoding="utf-8")
    print(f"Wrote {output}")
    print("Run: docker compose --env-file .env up --build")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
