"""Allowlisted destination categories.

Allowlist by *domain category* through a logging proxy rather than by raw IP:
registries sit behind rotating CDN addresses, and request-level logs are what
make abuse forensics possible (Doc 02 §5).
"""

from __future__ import annotations

from types import MappingProxyType

# Official registry endpoints only. Mirroring/caching these cuts egress volume
# and build time; the allowlist is read-only in intent (publishing happens from
# the control plane, never from a sandbox).
DEFAULT_REGISTRY_DOMAINS: frozenset[str] = frozenset(
    {
        # JavaScript
        "registry.npmjs.org",
        "registry.yarnpkg.com",
        # Python
        "pypi.org",
        "files.pythonhosted.org",
        # Rust
        "crates.io",
        "static.crates.io",
        # Go
        "proxy.golang.org",
        "sum.golang.org",
        # Distro
        "deb.debian.org",
        "security.debian.org",
        "archive.ubuntu.com",
        "ports.ubuntu.com",
        # Container base images used by the sandbox toolchain
        "registry-1.docker.io",
        "auth.docker.io",
        "production.cloudflare.docker.com",
        # Playwright browser downloads (pre-baked, but pinned for rebuilds)
        "playwright.azureedge.net",
        "cdn.playwright.dev",
    }
)

# Deploy targets open only during an explicit deploy step, never during a build.
DEFAULT_DEPLOY_DOMAINS: frozenset[str] = frozenset(
    {
        "github.com",
        "api.github.com",
        "gitlab.com",
        "api.vercel.com",
        "api.fly.io",
        "backboard.railway.app",
        "api.cloudflare.com",
    }
)

CATEGORY_DOMAINS: MappingProxyType[str, frozenset[str]] = MappingProxyType(
    {
        "package_registries": DEFAULT_REGISTRY_DOMAINS,
        "deploy_targets": DEFAULT_DEPLOY_DOMAINS,
        # 'model_router' and 'app_apis' are resolved per-lease: the router host
        # comes from the lease, and app APIs are per-project opt-in.
        "model_router": frozenset(),
        "app_apis": frozenset(),
    }
)
