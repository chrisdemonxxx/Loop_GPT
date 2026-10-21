from scripts.check_compose_services import (
    PUBLIC_EDGE_SERVICES,
    ServiceBlock,
    _compose_services,
    _image_digest_errors,
    _published_ports,
    validate,
)


def test_compose_entrypoints_dependencies_and_healthchecks_are_static_valid() -> None:
    assert validate() == []


def _ports(text: str) -> list[str]:
    return _published_ports(ServiceBlock(name="temporal", lines=tuple(text.splitlines())))


def _is_public(mapping: str) -> bool:
    return not mapping.startswith("127.0.0.1:")


EXPOSED_SYNTAXES = {
    "single_quoted": "    ports:\n      - '7233:7233'\n",
    "unquoted": "    ports:\n      - 7233:7233\n",
    "double_quoted": '    ports:\n      - "7233:7233"\n',
    "bare_port": "    ports:\n      - 7233\n",
    "long_form": "    ports:\n      - target: 7233\n        published: 7233\n",
}

LOOPBACK_SYNTAXES = {
    "single_quoted": "    ports:\n      - '127.0.0.1:7233:7233'\n",
    "double_quoted": '    ports:\n      - "127.0.0.1:7233:7233"\n',
    "long_form": (
        "    ports:\n      - target: 7233\n        published: 7233\n        host_ip: 127.0.0.1\n"
    ),
}


def test_all_exposed_port_syntaxes_are_detected() -> None:
    """Every compose port syntax must be parsed, so none can silently re-expose a service."""
    for name, text in EXPOSED_SYNTAXES.items():
        mappings = _ports(text)
        assert mappings, f"{name}: port entry was skipped entirely"
        assert any(_is_public(m) for m in mappings), f"{name}: exposure not detected"


def test_loopback_port_syntaxes_are_accepted() -> None:
    for name, text in LOOPBACK_SYNTAXES.items():
        mappings = _ports(text)
        assert mappings, f"{name}: port entry was skipped entirely"
        assert not any(_is_public(m) for m in mappings), f"{name}: false positive"


def test_unparseable_port_entry_fails_closed() -> None:
    """An entry this parser does not understand must be treated as exposed, not skipped."""
    mappings = _ports("    ports:\n      - [7233, 7233]\n")
    assert mappings, "unparseable port entry was skipped entirely"
    assert any(_is_public(m) for m in mappings)


def test_only_intended_edge_services_are_public() -> None:
    # Exact-set assertion is deliberate: adding an internet-facing service must be a
    # conscious edit here, never an incidental side effect of a compose change.
    # app-proxy serves customer applications on their own hostnames, so it is public
    # by design; every other service must bind 127.0.0.1 and sit behind these.
    assert PUBLIC_EDGE_SERVICES == frozenset({"api", "web", "preview-proxy", "app-proxy"})


def test_workspace_dispatch_compose_supplies_checkpoint_store_dsn() -> None:
    service = _compose_services()["workspace-dispatch"]

    assert "LOOPIT_STORE_DSN: ${LOOPIT_STORE_DSN:?" in service.text


def test_docker_sandbox_services_share_socket_access() -> None:
    services = _compose_services()

    for name in ("scheduler", "workspace-dispatch"):
        service = services[name]
        assert "DOCKER_HOST: ${DOCKER_HOST:-unix:///var/run/docker.sock}" in service.text
        assert (
            "volumes: *docker-socket-volume" in service.text
            or "- /var/run/docker.sock:/var/run/docker.sock" in service.text
        )
        assert "group_add: *docker-socket-groups" in service.text


def test_compose_images_must_be_digest_pinned() -> None:
    service = ServiceBlock(
        name="temporal",
        lines=(
            "  temporal:",
            "    image: temporalio/server:1.25.2",
        ),
    )

    assert _image_digest_errors(service) == [
        "temporal: image 'temporalio/server:1.25.2' must be pinned with @sha256:<digest>"
    ]


def test_compose_digest_pinned_images_are_accepted() -> None:
    service = ServiceBlock(
        name="temporal",
        lines=(
            "  temporal:",
            "    image: temporalio/server:1.25.2@sha256:"
            "94dcdf51920fe894acff78694ad84e2ec3611ae5852f936fcccc1b67ce44dff0",
        ),
    )

    assert _image_digest_errors(service) == []
