"""Static red-team checks on the sandbox base image (P1-3, P1-12).

The image cannot be built in CI on every PR — it is a multi-hundred-megabyte
artefact with a browser in it. But the properties that matter for security are
all visible in the Dockerfile text, and those are cheap to assert on every
commit.

This is deliberately a *negative* test suite. It does not check that the image
works; it checks that the specific mistakes that turn a sandbox image into a
credential leak or an escape aid have not been reintroduced.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.fast

IMAGE_DIR = Path(__file__).resolve().parents[2] / "sandbox" / "image"
DOCKERFILE = IMAGE_DIR / "Dockerfile"
PREWARM = IMAGE_DIR / "warmup" / "prewarm.sh"


@pytest.fixture(scope="module")
def dockerfile() -> str:
    assert DOCKERFILE.is_file(), f"missing sandbox image definition at {DOCKERFILE}"
    return DOCKERFILE.read_text(encoding="utf-8")


def _directives(text: str, keyword: str) -> list[str]:
    pattern = re.compile(rf"^\s*{keyword}\s+(.*)$", re.MULTILINE | re.IGNORECASE)
    return [match.group(1).strip() for match in pattern.finditer(text)]


def _instructions_only(text: str) -> str:
    """The Dockerfile with comment lines removed.

    Prose about what the image deliberately omits would otherwise trip the very
    checks that look for those omissions.
    """
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


# --- Provenance ---------------------------------------------------------------


def test_the_base_image_is_pinned_by_digest(dockerfile: str) -> None:
    """A mutable tag makes a 'reproducible' run change with no commit."""
    froms = _directives(dockerfile, "FROM")
    assert froms, "the image must declare a base"
    for line in froms:
        assert "@sha256:" in line, f"base image is not digest-pinned: {line}"


def test_globally_installed_toolchains_are_version_pinned(dockerfile: str) -> None:
    for tool in ("pnpm@", "playwright@", "uv=="):
        assert tool in dockerfile, f"{tool} must be installed at a pinned version"


# --- No credentials in layers -------------------------------------------------


SECRET_NAMES = re.compile(
    r"\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*)\b"
)


def test_no_secret_shaped_build_arguments(dockerfile: str) -> None:
    """Build args and env vars end up in image metadata, which is not private."""
    for line in _directives(dockerfile, "ARG") + _directives(dockerfile, "ENV"):
        name = line.split("=", 1)[0]
        assert not SECRET_NAMES.search(name.upper()), f"secret-shaped build variable: {line}"


def test_no_credential_files_are_copied_into_the_image(dockerfile: str) -> None:
    forbidden = (".npmrc", ".netrc", "id_rsa", ".aws", ".env", "credentials")
    for line in _directives(dockerfile, "COPY") + _directives(dockerfile, "ADD"):
        lowered = line.lower()
        for needle in forbidden:
            assert needle not in lowered, f"credential-bearing path copied into image: {line}"


# --- Least privilege ----------------------------------------------------------


def test_the_image_does_not_run_as_root(dockerfile: str) -> None:
    users = _directives(dockerfile, "USER")
    assert users, "the image must drop to an unprivileged user"
    assert users[-1].split()[0] not in {"root", "0"}, "final USER must not be root"


def test_no_privilege_escalation_tooling_is_installed(dockerfile: str) -> None:
    """sudo in a sandbox removes the inner of the two boundaries."""
    instructions = _instructions_only(dockerfile)
    for banned in (" sudo", "sudo ", "openssh-server", "sshd"):
        assert banned not in instructions, f"privilege/remote-access tooling present: {banned!r}"


def test_an_init_process_reaps_orphaned_dev_servers(dockerfile: str) -> None:
    """Without one, zombie dev servers exhaust the microVM's process cap."""
    assert "tini" in dockerfile


# --- Cold-start guarantees ----------------------------------------------------


def test_browsers_are_baked_in_rather_than_fetched_at_run_time(dockerfile: str) -> None:
    assert "playwright install" in dockerfile
    assert "PLAYWRIGHT_BROWSERS_PATH" in dockerfile


def test_package_caches_have_fixed_prewarmed_paths(dockerfile: str) -> None:
    for variable in ("npm_config_cache", "PNPM_HOME", "UV_CACHE_DIR", "PIP_CACHE_DIR"):
        assert variable in dockerfile, f"{variable} must be set so caches are found without config"


def test_the_prewarm_script_exists_and_fails_loudly() -> None:
    assert PREWARM.is_file(), f"missing cache warm-up script at {PREWARM}"
    body = PREWARM.read_text(encoding="utf-8")
    # A warm-up that swallows errors produces an image that looks warmed and
    # is not — the failure then shows up as a slow first run in production.
    assert "set -euo pipefail" in body
    assert "|| true" not in body, "warm-up steps must not silently ignore failures"


def test_the_warmup_directory_is_removed_from_the_final_image(dockerfile: str) -> None:
    assert "rm -rf /opt/warmup" in dockerfile
