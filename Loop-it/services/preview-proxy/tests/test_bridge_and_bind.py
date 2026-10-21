"""Phase 1.4–1.5 + 2.1: console/inspector bridge injection and dynamic route bind."""

from __future__ import annotations

from loopit_preview.bridge import (
    CONSOLE_BRIDGE_SCRIPT,
    INSPECTOR_BRIDGE_SCRIPT,
    inject_console_bridge,
    inject_preview_bridges,
)
from loopit_preview.routes import Backend, Route, RouteTable


def test_inject_console_bridge_into_head() -> None:
    html = "<!doctype html><html><head><title>x</title></head><body></body></html>"
    out = inject_console_bridge(html).decode("utf-8")
    assert "data-loopit-console-bridge" in out
    assert "postMessage" in out
    assert out.index("<head>") < out.index("data-loopit-console-bridge")


def test_inject_is_idempotent() -> None:
    html = f"<html><head>{CONSOLE_BRIDGE_SCRIPT}</head></html>"
    out = inject_console_bridge(html).decode("utf-8")
    assert out.count("data-loopit-console-bridge") == 1


def test_inject_preview_bridges_includes_inspector() -> None:
    html = "<!doctype html><html><head></head><body></body></html>"
    out = inject_preview_bridges(html).decode("utf-8")
    assert "data-loopit-console-bridge" in out
    assert "data-loopit-inspector-bridge" in out
    assert "inspect-mode" in out
    assert "data-loc" in out
    # Idempotent
    again = inject_preview_bridges(out).decode("utf-8")
    assert again.count("data-loopit-inspector-bridge") == 1
    assert INSPECTOR_BRIDGE_SCRIPT[:40] in again or "data-loopit-inspector-bridge" in again


def test_route_table_resolve_by_project() -> None:
    table = RouteTable()
    table.bind(
        Route(
            preview_host="abc.preview.loopit.dev",
            project_id="abc",
            tenant_id="t1",
            lease_id="lease-1",
            backend=Backend("10.0.0.1", 5173),
        )
    )
    route = table.resolve_project("abc", tenant_id="t1")
    assert route.backend.port == 5173
    assert "abc.preview.loopit.dev" in table
