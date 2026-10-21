"""Static checks for Docker Compose entrypoints and health probes.

This catches broken control-plane launches in environments where Docker is not
available by proving every built service points at existing source and every
declared compose dependency resolves to another service.
"""

from __future__ import annotations

import re
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"

SERVICE_RE = re.compile(r"^  (?P<name>[a-zA-Z0-9_-]+):\s*$")
DOCKERFILE_RE = re.compile(r"\bdockerfile:\s*(?P<path>[^#\s]+)")
PYTHON_MODULE_RE = re.compile(
    r"python(?:3)?[\"']?(?:\s*,\s*|\s+)[\"']?-m[\"']?(?:\s*,\s*|\s+)"
    r"[\"']?(?P<module>[A-Za-z_][A-Za-z0-9_.]*)"
)
LOCAL_HTTP_PATH_RE = re.compile(r"http://127\.0\.0\.1:[^/\"']+(?P<path>/[A-Za-z0-9_./-]+)")
IMAGE_RE = re.compile(r"^\s+image:\s+(?P<image>\S+)\s*(?:#.*)?$")
PINNED_DIGEST_RE = re.compile(r"@sha256:[0-9a-f]{64}(?:\s|$)")


@dataclass(frozen=True, slots=True)
class ServiceBlock:
    name: str
    lines: tuple[str, ...]

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


def _compose_services() -> dict[str, ServiceBlock]:
    lines = COMPOSE.read_text(encoding="utf-8").splitlines()
    services: dict[str, ServiceBlock] = {}
    in_services = False
    current_name: str | None = None
    current_lines: list[str] = []
    for line in lines:
        if line == "services:":
            in_services = True
            continue
        if in_services and line and not line.startswith(" "):
            break
        if not in_services:
            continue
        match = SERVICE_RE.match(line)
        if match:
            if current_name is not None:
                services[current_name] = ServiceBlock(current_name, tuple(current_lines))
            current_name = match.group("name")
            current_lines = [line]
            continue
        if current_name is not None:
            current_lines.append(line)
    if current_name is not None:
        services[current_name] = ServiceBlock(current_name, tuple(current_lines))
    return services


def _source_roots() -> tuple[Path, ...]:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    paths = data["tool"]["pytest"]["ini_options"]["pythonpath"]
    return tuple(ROOT / Path(path) for path in paths)


def _module_exists(module: str, source_roots: tuple[Path, ...]) -> bool:
    relative = Path(*module.split("."))
    for source_root in source_roots:
        if (source_root / relative).with_suffix(".py").is_file():
            return True
        package = source_root / relative
        if (package / "__main__.py").is_file() or (package / "__init__.py").is_file():
            return True
    return False


def _module_package_dir(module: str, source_roots: tuple[Path, ...]) -> Path | None:
    package_name = module.split(".", maxsplit=1)[0]
    for source_root in source_roots:
        package = source_root / package_name
        if package.is_dir():
            return package
    return None


def _dockerfile(service: ServiceBlock) -> Path | None:
    match = DOCKERFILE_RE.search(service.text)
    if match is None:
        return None
    raw = match.group("path").strip("\"'")
    return ROOT / Path(raw)


def _command_module(service: ServiceBlock, dockerfile: Path | None) -> str | None:
    texts = [service.text]
    if dockerfile is not None and dockerfile.exists():
        texts.append(dockerfile.read_text(encoding="utf-8"))
    for text in texts:
        match = PYTHON_MODULE_RE.search(text)
        if match is not None:
            return match.group("module")
    return None


def _depends_on(service: ServiceBlock) -> set[str]:
    dependencies: set[str] = set()
    in_depends = False
    for line in service.lines:
        if line.startswith("    depends_on:"):
            in_depends = True
            continue
        if in_depends and line and len(line) - len(line.lstrip(" ")) <= 4:
            break
        if not in_depends:
            continue
        mapping = re.match(r"^      (?P<name>[a-zA-Z0-9_-]+):\s*$", line)
        sequence = re.match(r"^      -\s+(?P<name>[a-zA-Z0-9_-]+)\s*$", line)
        if mapping is not None:
            dependencies.add(mapping.group("name"))
        elif sequence is not None:
            dependencies.add(sequence.group("name"))
    return dependencies


def _http_paths(text: str) -> set[str]:
    return {match.group("path") for match in LOCAL_HTTP_PATH_RE.finditer(text)}


def _has_healthcheck_handlers(
    service: ServiceBlock,
    dockerfile: Path | None,
    module: str | None,
    source_roots: tuple[Path, ...],
) -> bool:
    if "healthcheck:" not in service.text:
        return True
    paths = _http_paths(service.text)
    if dockerfile is not None and dockerfile.exists():
        paths |= _http_paths(dockerfile.read_text(encoding="utf-8"))
    if not paths:
        return True
    if dockerfile is not None:
        nginx_template = dockerfile.parent / "nginx.conf.template"
        if nginx_template.is_file():
            nginx = nginx_template.read_text(encoding="utf-8")
            if all(path in nginx for path in paths):
                return True
    if module is None:
        return False
    package = _module_package_dir(module, source_roots)
    if package is None:
        return False
    seen: set[str] = set()
    for path in package.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        seen.update(health_path for health_path in paths if health_path in text)
    return seen == paths


# app-proxy is intentionally internet-facing: it is the production app edge.
PUBLIC_EDGE_SERVICES = frozenset({"api", "web", "preview-proxy", "app-proxy"})
# Short-form entry: - "8000:8000" / - '8000:8000' / - 8000:8000
PORT_SHORT_RE = re.compile(r"""^\s*-\s*(?P<q>['"]?)(?P<mapping>[^'"#]+?)(?P=q)\s*(?:#.*)?$""")
# Long-form entry: - target: 8000 / published: 8000 / host_ip: 127.0.0.1
PORT_LONG_KEY_RE = re.compile(
    r"^\s*-?\s*(?P<key>target|published|host_ip|protocol|mode):\s*(?P<value>\S+)"
)


def _published_ports(service: ServiceBlock) -> list[str]:
    """Return every published port mapping, normalised to a 'host_ip:...' string.

    Unparseable entries are returned as the sentinel '<unparsed>' so callers fail
    closed rather than silently skipping a syntax this parser does not understand.
    """
    mappings: list[str] = []
    long_form: dict[str, str] = {}
    in_ports = False

    def flush() -> None:
        if long_form:
            host_ip = long_form.get("host_ip", "")
            published = long_form.get("published", "")
            target = long_form.get("target", "")
            mappings.append(
                f"{host_ip}:{published}:{target}" if host_ip else f"{published}:{target}"
            )
            long_form.clear()

    for line in service.text.splitlines():
        stripped = line.strip()
        if stripped.startswith("ports:"):
            in_ports = True
            continue
        if not in_ports:
            continue
        if not stripped or stripped.startswith("#"):
            continue
        if not stripped.startswith("-") and not PORT_LONG_KEY_RE.match(line):
            flush()
            in_ports = False
            continue
        long_match = PORT_LONG_KEY_RE.match(line)
        if long_match is not None:
            key = long_match.group("key")
            if key in long_form:
                flush()
            long_form[key] = long_match.group("value").strip("'\"")
            continue
        short_match = PORT_SHORT_RE.match(line)
        if short_match is None:
            mappings.append("<unparsed>")
            continue
        mappings.append(short_match.group("mapping").strip())
    flush()
    return mappings


def _image_digest_errors(service: ServiceBlock) -> list[str]:
    errors: list[str] = []
    for line in service.lines:
        match = IMAGE_RE.match(line)
        if match is None:
            continue
        image = match.group("image").strip("\"'")
        if PINNED_DIGEST_RE.search(image) is None:
            errors.append(f"{service.name}: image {image!r} must be pinned with @sha256:<digest>")
    return errors


def validate() -> list[str]:
    services = _compose_services()
    source_roots = _source_roots()
    errors: list[str] = []
    if "secrets-broker" in services:
        errors.append("docker-compose.yml must not expose secrets-broker as a network service")

    for service in services.values():
        errors.extend(_image_digest_errors(service))

        for mapping in _published_ports(service):
            if service.name in PUBLIC_EDGE_SERVICES:
                continue
            if not mapping.startswith("127.0.0.1:"):
                errors.append(
                    f"{service.name}: internal port mapping {mapping!r} must bind 127.0.0.1; "
                    "only public edge services may publish on all interfaces"
                )

        dockerfile = _dockerfile(service)
        if dockerfile is not None and not dockerfile.is_file():
            errors.append(f"{service.name}: Dockerfile does not exist: {dockerfile}")

        module = _command_module(service, dockerfile)
        if dockerfile is not None and module is None and service.name not in {"admin", "web"}:
            errors.append(
                f"{service.name}: no python -m module found in compose command or Dockerfile"
            )
        if module is not None and not _module_exists(module, source_roots):
            errors.append(f"{service.name}: python module does not exist: {module}")

        for dependency in _depends_on(service):
            if dependency not in services:
                errors.append(f"{service.name}: depends_on unknown service {dependency!r}")

        if not _has_healthcheck_handlers(service, dockerfile, module, source_roots):
            paths = ", ".join(sorted(_http_paths(service.text)))
            errors.append(
                f"{service.name}: compose health probe(s) {paths} have no matching source handler"
            )

    return errors


def main() -> int:
    errors = validate()
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("docker-compose service entrypoints and healthchecks are statically valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
