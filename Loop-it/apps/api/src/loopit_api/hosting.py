"""Build-mode hosting glue: green checkpoint → HostingProvider → public URL.

Default offline path uses :class:`StaticObjectHostingProvider` (local object
root under ``.hosted/``). Set ``LOOPIT_DEPLOYER_PROVIDER=fly`` plus Fly tokens
for Machines; set ``LOOPIT_DOMAINS_URL`` + ``LOOPIT_SERVICE_TOKEN`` for opaque
``*.loop-apps`` hostnames from the domains service.

Phase 2.7: first publish ensures a separate prod database and applies
migrations before promoting the release.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from loopit_checkpoint import Checkpoint, CheckpointStore
from loopit_deployer import (
    FakeHostingProvider,
    FlyHostingProvider,
    HostingProvider,
    RuntimeAttachment,
    StaticObjectHostingProvider,
)
from loopit_gitsync import materialize_checkpoint_tree
from loopit_provision import (
    InMemoryStorageProvisioner,
    ProvisionedDatabase,
    project_database_names,
)

LOGGER = logging.getLogger("loopit.api.hosting")


@dataclass(frozen=True, slots=True)
class HostedPublish:
    """Result of a hosting-aware publish (alongside Phase 0 signed site URLs)."""

    production_url: str
    provider: str
    provider_release_id: str | None
    hostname: str | None
    hosted_release_id: str | None
    #: Phase 2.7 — prod DB created / migrated at publish (may be empty offline).
    prod_database: dict[str, Any] | None = None


def hosted_root(projects_root: Path) -> Path:
    return projects_root / ".hosted"


def opaque_label_for(project_id: str) -> str:
    return f"p-{hashlib.sha256(project_id.encode()).hexdigest()[:10]}"


def allocate_opaque_hostname(
    project_id: str,
    *,
    domains_url: str | None = None,
    service_token: str | None = None,
    base_domain: str | None = None,
) -> tuple[str, str | None]:
    """Return ``(label, absolute_https_url_or_none)``.

    Tries the domains service when configured; otherwise synthesises a stable
    local opaque label (no DNS).
    """
    label = opaque_label_for(project_id)
    base = (base_domain or os.environ.get("LOOPIT_APPS_BASE_DOMAIN") or "").strip()
    url = domains_url or os.environ.get("LOOPIT_DOMAINS_URL")
    token = service_token or os.environ.get("LOOPIT_SERVICE_TOKEN")
    if url and token:
        try:
            import httpx

            response = httpx.post(
                urljoin(url.rstrip("/") + "/", f"internal/projects/{project_id}/subdomain"),
                headers={"Authorization": f"Bearer {token}"},
                json={},
                timeout=10,
            )
            if response.status_code < 400:
                data = response.json()
                allocated = str(data.get("label") or data.get("hostname") or label)
                if "." in allocated:
                    host = allocated
                    label = allocated.split(".", 1)[0]
                else:
                    label = allocated
                    host = f"{label}.{base}" if base else label
                if base or host.count(".") >= 1:
                    return label, f"https://{host}" if not host.startswith("http") else host
        except Exception:
            LOGGER.warning("domains allocate failed for %s; using local opaque label", project_id)
    if base:
        return label, f"https://{label}.{base}"
    return label, None


def _placeholder_runtime(
    tenant_id: str,
    project_id: str,
    production_url: str | None,
    *,
    environment: str = "prod",
    applied_migrations: tuple[str, ...] = (),
    verified_tables: tuple[str, ...] = (),
) -> RuntimeAttachment:
    names = project_database_names(tenant_id, project_id, environment=environment)
    database = ProvisionedDatabase(
        tenant_id=tenant_id,
        project_id=project_id,
        names=names,
        applied_migrations=applied_migrations,
        verified_tables=verified_tables,
    )
    storage = InMemoryStorageProvisioner(
        bucket=os.environ.get("LOOPIT_STORAGE_BUCKET", "loopit-generated-apps")
    ).provision_bucket(tenant_id, project_id)
    return RuntimeAttachment(database=database, storage=storage, production_url=production_url)


def hosting_provider_from_env(
    projects_root: Path,
    *,
    stack: str = "react",
) -> tuple[HostingProvider, str]:
    """Pick a provider. Returns ``(provider, provider_name)``."""
    name = (os.environ.get("LOOPIT_DEPLOYER_PROVIDER") or "static").strip().lower()
    fly_token = os.environ.get("LOOPIT_FLY_API_TOKEN", "").strip()
    if name == "fly" and fly_token:
        org = os.environ.get("LOOPIT_FLY_ORG", "personal").strip() or "personal"
        domain = os.environ.get("LOOPIT_DEPLOYER_PUBLIC_BASE_DOMAIN", "fly.dev").strip() or "fly.dev"
        image = os.environ.get("LOOPIT_FLY_IMAGE", "registry.fly.io/loopit-gen:latest")

        def image_for_tree(_tree: Any) -> str:
            return image

        return (
            FlyHostingProvider(
                fly_token,
                org_slug=org,
                image_for_tree=image_for_tree,
                public_base_domain=domain,
            ),
            "fly",
        )
    if name == "fake":
        return FakeHostingProvider(), "fake"
    # Static (default) — also used when fly credentials are missing.
    if name == "fly" and not fly_token:
        LOGGER.info("LOOPIT_DEPLOYER_PROVIDER=fly but LOOPIT_FLY_API_TOKEN unset; using static")
    base = os.environ.get("LOOPIT_APPS_BASE_DOMAIN", "").strip() or None
    # Full-stack stacks still get the static path offline; Fly is opted-in above.
    del stack
    return (
        StaticObjectHostingProvider(
            hosted_root(projects_root),
            public_base_domain=base,
            allocate_label=opaque_label_for,
        ),
        "static",
    )


def publish_via_hosting(
    *,
    checkpoint: Checkpoint,
    checkpoints: CheckpointStore,
    projects_root: Path,
    tenant_id: str,
    project_id: str,
    reason: str,
    actor_id: str,
    site_url: str,
    stack: str = "react",
    project_backend: Any | None = None,
) -> HostedPublish:
    """Stage + promote through the configured hosting provider.

    Always returns a ``production_url``. Prefer absolute opaque domains when
    available; otherwise keep the signed ``site_url`` so offline Open-app works.

    When ``project_backend`` is provided, Phase 2.7 ensures a separate prod
    database and applies migrations before the hosting promote step.
    """
    del reason, actor_id
    prod_meta: dict[str, Any] | None = None
    if project_backend is not None:
        from .project_backend import apply_migrations_at_publish

        try:
            prod_meta = apply_migrations_at_publish(
                project_backend,
                projects_root=projects_root,
                tenant_id=tenant_id,
                project_id=project_id,
            )
        except Exception as error:
            LOGGER.warning("prod database migrate at publish failed: %s", error)
            prod_meta = {"error": str(error)}

    label, absolute = allocate_opaque_hostname(project_id)
    provider, provider_name = hosting_provider_from_env(projects_root, stack=stack)
    applied = tuple(prod_meta.get("applied_migrations") or ()) if isinstance(prod_meta, dict) else ()
    verified = tuple(
        str(item.get("name"))
        for item in (prod_meta.get("tables") or [])
        if isinstance(item, dict) and item.get("name")
    ) if isinstance(prod_meta, dict) else ()
    runtime = _placeholder_runtime(
        tenant_id,
        project_id,
        absolute,
        environment="prod",
        applied_migrations=applied,
        verified_tables=verified,
    )
    tree = materialize_checkpoint_tree(checkpoint, checkpoints)
    release = provider.stage(
        project_id=project_id,
        checkpoint_id=checkpoint.checkpoint_id,
        tree=tree,
        runtime=runtime,
        env={},
    )
    provider.run_migrations(release)
    if not provider.health_check(release):
        provider.stop_candidate(release)
        raise RuntimeError("hosting health check failed")
    release_id = provider.promote(release)
    production_url = absolute or release.url
    # Offline static releases without a public domain keep the signed site link
    # as the clickable URL; hosting metadata still records the release id.
    if not absolute and provider_name == "static":
        production_url = site_url
    elif absolute:
        production_url = absolute
    else:
        production_url = release.url or site_url
    return HostedPublish(
        production_url=production_url,
        provider=provider_name,
        provider_release_id=release_id,
        hostname=release.hostname or (f"{label}.{os.environ['LOOPIT_APPS_BASE_DOMAIN']}" if os.environ.get("LOOPIT_APPS_BASE_DOMAIN") else label),
        hosted_release_id=release.release_id if provider_name == "static" else None,
        prod_database=prod_meta,
    )


def rollback_via_hosting(
    *,
    projects_root: Path,
    project_id: str,
    checkpoint_id: str,
    stack: str = "react",
) -> str:
    provider, _name = hosting_provider_from_env(projects_root, stack=stack)
    return provider.rollback(project_id, checkpoint_id)


def read_hosted_file(projects_root: Path, release_id: str, relative: str) -> bytes | None:
    path = hosted_root(projects_root) / release_id / relative
    if not path.is_file():
        return None
    return path.read_bytes()
