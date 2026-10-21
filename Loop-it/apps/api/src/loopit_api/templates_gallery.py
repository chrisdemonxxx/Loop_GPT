"""Curated Build templates from ``stack-templates/recipes`` (Phase 2.6)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Extra gallery entries that are not (yet) full recipe DAGs — landing / CRUD
# style starters that remix into a scaffold + prompt seed.
_CURATED: tuple[dict[str, Any], ...] = (
    {
        "id": "landing-page",
        "title": "Landing page",
        "description": "Marketing landing with hero, pricing cards, and waitlist form.",
        "stack": "react",
        "prompt_seed": (
            "Build a polished landing page with a hero, three pricing cards, "
            "and a waitlist email form. Keep it as a no-build React/htm site."
        ),
        "tags": ["marketing", "static"],
        "source": "curated",
    },
    {
        "id": "crud-dashboard",
        "title": "CRUD dashboard",
        "description": "Admin table with create/edit/delete and simple filters.",
        "stack": "react",
        "prompt_seed": (
            "Build an admin CRUD dashboard with a data table, create/edit modal, "
            "delete confirm, and client-side search."
        ),
        "tags": ["admin", "crud"],
        "source": "curated",
    },
)


def recipes_dir() -> Path:
    """Resolve ``Loop-it/stack-templates/recipes`` from this package location."""
    here = Path(__file__).resolve()
    # .../Loop-it/apps/api/src/loopit_api/templates_gallery.py → Loop-it/
    candidates = [
        here.parents[4] / "stack-templates" / "recipes",
        Path.cwd() / "stack-templates" / "recipes",
        Path.cwd() / "Loop-it" / "stack-templates" / "recipes",
    ]
    for path in candidates:
        if path.is_dir():
            return path
    return candidates[0]


def _title_from_id(recipe_id: str) -> str:
    return recipe_id.replace("-", " ").replace("_", " ").title()


def load_templates() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = [dict(item) for item in _CURATED]
    directory = recipes_dir()
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            recipe_id = str(data.get("id") or path.stem)
            items.append(
                {
                    "id": recipe_id,
                    "title": _title_from_id(recipe_id),
                    "description": str(data.get("prompt_seed") or "")[:180],
                    "stack": str(data.get("stack") or "react"),
                    "prompt_seed": str(data.get("prompt_seed") or ""),
                    "expected_dag": data.get("expected_dag"),
                    "verification": data.get("verification"),
                    "tags": ["recipe", str(data.get("stack") or "react")],
                    "source": "recipe",
                }
            )
    # Stable order: curated first, then recipes by id.
    return items


def get_template(template_id: str) -> dict[str, Any] | None:
    for item in load_templates():
        if item["id"] == template_id:
            return item
    return None
