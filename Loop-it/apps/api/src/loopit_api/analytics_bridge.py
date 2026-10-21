"""Published-app analytics (Phase 3.8).

Page views are counted when a published (deploy-lease) HTML document is served.
The plan references app-proxy ``billing.py`` counters; that edge service is not
in this stack, so we keep a durable sidecar under ``.analytics/`` and increment
from the site serve path. Live edge meters can replace the store later.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class AnalyticsSnapshot:
    project_id: str
    page_views: int = 0
    html_views: int = 0
    last_view_at: str | None = None
    by_path: dict[str, int] = field(default_factory=dict)
    source: str = "sidecar"  # sidecar | edge_stub

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class AnalyticsStore:
    def __init__(self, projects_root: Path) -> None:
        self._root = projects_root
        self._cache: dict[str, AnalyticsSnapshot] = {}
        self._load()

    def _dir(self) -> Path:
        path = self._root / ".analytics"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _path(self, project_id: str) -> Path:
        return self._dir() / f"{project_id}.json"

    def _load(self) -> None:
        for path in self._dir().glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                snap = AnalyticsSnapshot(
                    project_id=str(data["project_id"]),
                    page_views=int(data.get("page_views") or 0),
                    html_views=int(data.get("html_views") or 0),
                    last_view_at=data.get("last_view_at"),
                    by_path={str(k): int(v) for k, v in (data.get("by_path") or {}).items()},
                    source=str(data.get("source") or "sidecar"),
                )
                self._cache[snap.project_id] = snap
            except Exception:
                continue

    def _save(self, snap: AnalyticsSnapshot) -> None:
        self._cache[snap.project_id] = snap
        self._path(snap.project_id).write_text(
            json.dumps(asdict(snap), indent=2), encoding="utf-8"
        )

    def get(self, project_id: str) -> AnalyticsSnapshot:
        return self._cache.get(project_id) or AnalyticsSnapshot(project_id=project_id)

    def record_view(self, project_id: str, path: str | None = None, *, html: bool = False) -> AnalyticsSnapshot:
        snap = self.get(project_id)
        snap.page_views += 1
        if html:
            snap.html_views += 1
        key = (path or "index.html").lstrip("/") or "index.html"
        snap.by_path[key] = int(snap.by_path.get(key) or 0) + 1
        snap.last_view_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._save(snap)
        return snap

    def seed_offline(self, project_id: str, page_views: int = 0) -> AnalyticsSnapshot:
        """Dev/test helper — set counts without a live edge."""
        snap = self.get(project_id)
        snap.page_views = max(0, int(page_views))
        snap.html_views = max(snap.html_views, snap.page_views)
        snap.source = "edge_stub"
        snap.last_view_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._save(snap)
        return snap
