from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OVERLAY = ROOT / "docker-compose.librechat.yml"
LIBRECHAT_YAML = ROOT / "deploy" / "librechat" / "librechat.yaml"

# Assignments, not mentions. Comments may name the vars they forbid (I5).
_KEY_ASSIGNMENT = re.compile(
    r"(?m)^\s*(?:-\s+)?(?:"
    r"LOOPIT_MODEL_API_KEY|HF_TOKEN|HUGGINGFACE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY"
    r")\s*:"
)
_UPSTREAM_URL = re.compile(r"router\.huggingface\.co|api\.openai\.com|api\.anthropic\.com")
_KEY_LITERAL = re.compile(r"\b(?:sk-|hf_)[A-Za-z0-9_-]{8,}")


def test_overlay_and_librechat_yaml_exist() -> None:
    assert OVERLAY.is_file()
    assert LIBRECHAT_YAML.is_file()


def test_portal_does_not_hold_model_keys() -> None:
    overlay = OVERLAY.read_text(encoding="utf-8")
    config = LIBRECHAT_YAML.read_text(encoding="utf-8")
    blob = overlay + "\n" + config
    assert _KEY_ASSIGNMENT.search(blob) is None
    assert _UPSTREAM_URL.search(blob) is None
    assert _KEY_LITERAL.search(blob) is None


def test_portal_points_at_loopit_router_and_mcp() -> None:
    config = LIBRECHAT_YAML.read_text(encoding="utf-8")
    overlay = OVERLAY.read_text(encoding="utf-8")
    assert "http://loopit-mcp:8010/mcp" in config
    assert "type: streamable-http" in config
    assert "http://router-svc:8001/v1" in config
    assert "LOOPIT_ACCESS_TOKEN" in config
    assert "ghcr.io/danny-avila/librechat:v0.8.7@sha256:" in overlay
    assert "mongo:7.0.14@sha256:" in overlay
    assert "127.0.0.1:" in overlay
