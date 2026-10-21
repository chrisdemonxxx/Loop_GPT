"""Integrations for generated apps (Phase 3.7).

Stripe, email (Resend), and AI-in-app via the Loop router. Keys prefer the
Loop-GPT connector catalog / project secrets when present; otherwise the UI
shows an offline stub. Enabling a connector here only records the binding —
it never echoes secret values.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

ConnectorKind = Literal["stripe", "resend", "ai_router"]

CATALOG: list[dict[str, Any]] = [
    {
        "kind": "stripe",
        "label": "Stripe",
        "description": "Payments for the generated app. Prefer Loop-GPT Connectors → Stripe, or a project secret STRIPE_SECRET_KEY.",
        "secret_names": ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"],
        "catalog_type": "stripe",
    },
    {
        "kind": "resend",
        "label": "Email (Resend)",
        "description": "Transactional email. Prefer project secret RESEND_API_KEY (platform Resend is used for Loop-GPT mail).",
        "secret_names": ["RESEND_API_KEY"],
        "catalog_type": None,
    },
    {
        "kind": "ai_router",
        "label": "AI in-app",
        "description": "Call the Loop model router from the generated app. Prefer secret LOOP_AI_ROUTER_KEY.",
        "secret_names": ["LOOP_AI_ROUTER_KEY", "LOOPIT_ROUTER_TOKEN"],
        "catalog_type": None,
    },
]


@dataclass
class ConnectorBinding:
    kind: ConnectorKind
    enabled: bool = False
    status: str = "stub"  # stub | configured | missing
    source: str = "offline"  # offline | secret | catalog
    updated_at: str | None = None
    note: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class ConnectorsStore:
    def __init__(self, projects_root: Path) -> None:
        self._root = projects_root
        self._by_project: dict[str, dict[str, ConnectorBinding]] = {}
        self._load()

    def _dir(self) -> Path:
        path = self._root / ".connectors"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _path(self, project_id: str) -> Path:
        return self._dir() / f"{project_id}.json"

    def _load(self) -> None:
        for path in self._dir().glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                project_id = str(data["project_id"])
                bindings: dict[str, ConnectorBinding] = {}
                for raw in data.get("bindings") or []:
                    kind = str(raw.get("kind") or "")
                    if kind not in {"stripe", "resend", "ai_router"}:
                        continue
                    bindings[kind] = ConnectorBinding(
                        kind=kind,  # type: ignore[arg-type]
                        enabled=bool(raw.get("enabled")),
                        status=str(raw.get("status") or "stub"),
                        source=str(raw.get("source") or "offline"),
                        updated_at=raw.get("updated_at"),
                        note=raw.get("note"),
                    )
                self._by_project[project_id] = bindings
            except Exception:
                continue

    def _save(self, project_id: str, bindings: dict[str, ConnectorBinding]) -> None:
        self._by_project[project_id] = bindings
        payload = {
            "project_id": project_id,
            "bindings": [b.as_dict() for b in bindings.values()],
        }
        self._path(project_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def list_for_project(
        self,
        project_id: str,
        *,
        secret_names: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        known = secret_names or set()
        stored = self._by_project.get(project_id) or {}
        rows: list[dict[str, Any]] = []
        for entry in CATALOG:
            kind = entry["kind"]
            binding = stored.get(kind) or ConnectorBinding(kind=kind)  # type: ignore[arg-type]
            secret_hit = any(name in known for name in entry["secret_names"])
            if secret_hit:
                binding.status = "configured"
                binding.source = "secret"
                binding.note = "Project secret present"
            elif binding.enabled and binding.status == "stub":
                binding.note = binding.note or "Enabled offline (stub — add a secret or connector key)"
            elif not binding.enabled:
                binding.status = "missing" if not secret_hit else binding.status
                binding.note = binding.note or "Not connected"
            meta = {**entry, **binding.as_dict()}
            rows.append(meta)
        return rows

    def set_enabled(
        self,
        project_id: str,
        kind: ConnectorKind,
        enabled: bool,
        *,
        secret_names: set[str] | None = None,
    ) -> dict[str, Any]:
        if kind not in {"stripe", "resend", "ai_router"}:
            raise ValueError(f"unknown connector kind: {kind}")
        bindings = dict(self._by_project.get(project_id) or {})
        binding = bindings.get(kind) or ConnectorBinding(kind=kind)
        binding.enabled = enabled
        binding.updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        known = secret_names or set()
        catalog_entry = next(e for e in CATALOG if e["kind"] == kind)
        if any(name in known for name in catalog_entry["secret_names"]):
            binding.status = "configured"
            binding.source = "secret"
            binding.note = "Project secret present"
        elif enabled:
            binding.status = "stub"
            binding.source = "offline"
            binding.note = "Enabled offline (stub — add a secret or connector key)"
        else:
            binding.status = "missing"
            binding.source = "offline"
            binding.note = "Not connected"
        bindings[kind] = binding
        self._save(project_id, bindings)
        return next(
            row
            for row in self.list_for_project(project_id, secret_names=known)
            if row["kind"] == kind
        )
