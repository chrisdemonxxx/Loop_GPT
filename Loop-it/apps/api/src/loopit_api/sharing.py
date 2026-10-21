"""Project visibility and public remix (Phase 2.5).

Visibility is a sidecar under ``.sharing/`` so we do not touch provision /
ProjectStore schema. Remix forks the latest verified checkpoint and never
copies chat journals or secrets.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

Visibility = Literal["private", "link", "public_remix"]


@dataclass
class ShareRecord:
    project_id: str
    tenant_id: str
    visibility: Visibility
    share_id: str
    title: str = ""
    production_url: str | None = None
    checkpoint_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class SharingStore:
    def __init__(self, projects_root: Path) -> None:
        self._root = projects_root
        self._by_project: dict[str, ShareRecord] = {}
        self._by_share: dict[str, ShareRecord] = {}
        self._load()

    def _dir(self) -> Path:
        path = self._root / ".sharing"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _path(self, project_id: str) -> Path:
        return self._dir() / f"{project_id}.json"

    def _load(self) -> None:
        for path in self._dir().glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                record = ShareRecord(
                    project_id=str(data["project_id"]),
                    tenant_id=str(data["tenant_id"]),
                    visibility=data.get("visibility") or "private",  # type: ignore[arg-type]
                    share_id=str(data["share_id"]),
                    title=str(data.get("title") or ""),
                    production_url=data.get("production_url"),
                    checkpoint_id=data.get("checkpoint_id"),
                )
                self._by_project[record.project_id] = record
                self._by_share[record.share_id] = record
            except Exception:
                continue

    def _save(self, record: ShareRecord) -> None:
        self._by_project[record.project_id] = record
        self._by_share[record.share_id] = record
        self._path(record.project_id).write_text(
            json.dumps(asdict(record), indent=2), encoding="utf-8"
        )

    def get(self, project_id: str) -> ShareRecord | None:
        return self._by_project.get(project_id)

    def get_by_share_id(self, share_id: str) -> ShareRecord | None:
        return self._by_share.get(share_id)

    def set_visibility(
        self,
        *,
        project_id: str,
        tenant_id: str,
        visibility: Visibility,
        title: str = "",
        production_url: str | None = None,
        checkpoint_id: str | None = None,
    ) -> ShareRecord:
        if visibility not in {"private", "link", "public_remix"}:
            raise ValueError(f"invalid visibility: {visibility!r}")
        existing = self._by_project.get(project_id)
        share_id = existing.share_id if existing else f"share_{secrets.token_urlsafe(10)}"
        if existing and existing.share_id in self._by_share:
            # Keep share_id stable across visibility flips.
            pass
        record = ShareRecord(
            project_id=project_id,
            tenant_id=tenant_id,
            visibility=visibility,
            share_id=share_id,
            title=title or (existing.title if existing else ""),
            production_url=production_url
            if production_url is not None
            else (existing.production_url if existing else None),
            checkpoint_id=checkpoint_id
            if checkpoint_id is not None
            else (existing.checkpoint_id if existing else None),
        )
        self._save(record)
        return record

    def public_payload(self, share_id: str) -> dict[str, Any] | None:
        record = self._by_share.get(share_id)
        if record is None:
            return None
        if record.visibility == "private":
            return None
        return {
            "share_id": record.share_id,
            "project_id": record.project_id,
            "title": record.title or record.project_id,
            "visibility": record.visibility,
            "production_url": record.production_url,
            "checkpoint_id": record.checkpoint_id,
            "remix_allowed": record.visibility == "public_remix",
        }
