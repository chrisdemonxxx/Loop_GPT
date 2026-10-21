"""Background-build pending reviews and notifications (Phase 2.9).

Approved plans can run detached. When a background build finishes it does
**not** stay on the main checkpoint line: a pending review holds the new
checkpoint plus file diffs, a notification is recorded, and applying the
review promotes that checkpoint (files + pointer) after the user inspects
the diff.
"""

from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("loopit.api.reviews")


@dataclass
class ReviewStore:
    """Process-local store with durable JSON under ``.reviews/`` / ``.notifications/``."""

    projects_root: Path
    #: tenant_id → list of notification dicts (newest last).
    notifications: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: review_id → review dict.
    reviews: dict[str, dict[str, Any]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self._load()

    def _reviews_dir(self) -> Path:
        return self.projects_root / ".reviews"

    def _notifications_dir(self) -> Path:
        return self.projects_root / ".notifications"

    def _load(self) -> None:
        reviews_dir = self._reviews_dir()
        if reviews_dir.is_dir():
            for path in reviews_dir.glob("*.json"):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(data, dict) and data.get("review_id"):
                    self.reviews[str(data["review_id"])] = data
        notes_dir = self._notifications_dir()
        if notes_dir.is_dir():
            for path in notes_dir.glob("*.json"):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(data, dict):
                    continue
                tenant = str(data.get("tenant_id") or "")
                items = data.get("items")
                if tenant and isinstance(items, list):
                    self.notifications[tenant] = [item for item in items if isinstance(item, dict)]

    def _persist_review(self, review: dict[str, Any]) -> None:
        path = self._reviews_dir() / f"{review['review_id']}.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(review, indent=2), encoding="utf-8")
        except OSError:
            LOGGER.warning("could not persist review %s", review.get("review_id"))

    def _persist_notifications(self, tenant_id: str) -> None:
        path = self._notifications_dir() / f"{tenant_id.replace('/', '_')}.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(
                    {"tenant_id": tenant_id, "items": self.notifications.get(tenant_id, [])},
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError:
            LOGGER.warning("could not persist notifications for %s", tenant_id)

    def create_pending_review(
        self,
        *,
        tenant_id: str,
        project_id: str,
        run_id: str,
        checkpoint_id: str,
        base_checkpoint_id: str | None,
        file_changes: list[dict[str, Any]],
        summary: str = "",
        title: str = "",
    ) -> dict[str, Any]:
        review_id = f"rev_{secrets.token_hex(6)}"
        review = {
            "review_id": review_id,
            "tenant_id": tenant_id,
            "project_id": project_id,
            "run_id": run_id,
            "checkpoint_id": checkpoint_id,
            "base_checkpoint_id": base_checkpoint_id,
            "status": "pending",
            "summary": summary,
            "title": title or "Background build ready",
            "file_changes": file_changes,
            "created_at": datetime.now(UTC).isoformat(),
        }
        self.reviews[review_id] = review
        self._persist_review(review)
        self.notify(
            tenant_id=tenant_id,
            kind="background_build_ready",
            title=review["title"],
            body=summary or "A background build finished. Review and apply changes.",
            project_id=project_id,
            run_id=run_id,
            review_id=review_id,
        )
        return review

    def notify(
        self,
        *,
        tenant_id: str,
        kind: str,
        title: str,
        body: str,
        project_id: str | None = None,
        run_id: str | None = None,
        review_id: str | None = None,
    ) -> dict[str, Any]:
        note = {
            "notification_id": f"ntf_{secrets.token_hex(6)}",
            "tenant_id": tenant_id,
            "kind": kind,
            "title": title,
            "body": body,
            "project_id": project_id,
            "run_id": run_id,
            "review_id": review_id,
            "read": False,
            "created_at": datetime.now(UTC).isoformat(),
        }
        self.notifications.setdefault(tenant_id, []).append(note)
        # Cap per tenant so the offline file stays small.
        if len(self.notifications[tenant_id]) > 200:
            self.notifications[tenant_id] = self.notifications[tenant_id][-200:]
        self._persist_notifications(tenant_id)
        return note

    def list_notifications(
        self, tenant_id: str, *, unread_only: bool = False
    ) -> list[dict[str, Any]]:
        items = list(self.notifications.get(tenant_id) or [])
        if unread_only:
            items = [item for item in items if not item.get("read")]
        return list(reversed(items))

    def unread_count(self, tenant_id: str) -> int:
        return sum(1 for item in self.notifications.get(tenant_id) or [] if not item.get("read"))

    def mark_read(self, tenant_id: str, notification_id: str | None = None) -> int:
        """Mark one (or all) notifications read. Returns how many flipped."""
        flipped = 0
        for item in self.notifications.get(tenant_id) or []:
            if notification_id and item.get("notification_id") != notification_id:
                continue
            if not item.get("read"):
                item["read"] = True
                flipped += 1
        if flipped:
            self._persist_notifications(tenant_id)
        return flipped

    def list_reviews(
        self, tenant_id: str, *, project_id: str | None = None, status: str | None = "pending"
    ) -> list[dict[str, Any]]:
        items = [
            review
            for review in self.reviews.values()
            if review.get("tenant_id") == tenant_id
            and (project_id is None or review.get("project_id") == project_id)
            and (status is None or review.get("status") == status)
        ]
        items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return items

    def get_review(self, review_id: str, *, tenant_id: str) -> dict[str, Any] | None:
        review = self.reviews.get(review_id)
        if review is None or review.get("tenant_id") != tenant_id:
            return None
        return review

    def mark_applied(self, review_id: str, *, tenant_id: str) -> dict[str, Any] | None:
        review = self.get_review(review_id, tenant_id=tenant_id)
        if review is None:
            return None
        if review.get("status") == "applied":
            return review
        updated = {
            **review,
            "status": "applied",
            "applied_at": datetime.now(UTC).isoformat(),
        }
        self.reviews[review_id] = updated
        self._persist_review(updated)
        self.notify(
            tenant_id=tenant_id,
            kind="background_build_applied",
            title="Changes applied",
            body=f"Applied background build for project {updated.get('project_id')}.",
            project_id=str(updated.get("project_id") or ""),
            run_id=str(updated.get("run_id") or "") or None,
            review_id=review_id,
        )
        return updated

    def mark_dismissed(self, review_id: str, *, tenant_id: str) -> dict[str, Any] | None:
        review = self.get_review(review_id, tenant_id=tenant_id)
        if review is None:
            return None
        updated = {
            **review,
            "status": "dismissed",
            "dismissed_at": datetime.now(UTC).isoformat(),
        }
        self.reviews[review_id] = updated
        self._persist_review(updated)
        return updated


def diff_checkpoint_files(
    *,
    base_files: dict[str, bytes],
    head_files: dict[str, bytes],
) -> list[dict[str, Any]]:
    """Build structured file_change rows (1.12 shape) between two manifests."""
    changes: list[dict[str, Any]] = []
    all_paths = sorted(set(base_files) | set(head_files))
    for path in all_paths:
        before = base_files.get(path)
        after = head_files.get(path)
        if before == after:
            continue
        if before is None:
            op = "create"
            old_text = ""
            new_text = _decode(after or b"")
        elif after is None:
            op = "delete"
            old_text = _decode(before)
            new_text = ""
        else:
            op = "modify"
            old_text = _decode(before)
            new_text = _decode(after)
        unified = _unified_diff(path, old_text, new_text)
        additions = sum(
            1 for line in unified.splitlines() if line.startswith("+") and not line.startswith("+++")
        )
        deletions = sum(
            1 for line in unified.splitlines() if line.startswith("-") and not line.startswith("---")
        )
        changes.append(
            {
                "path": path,
                "op": op,
                "diff": unified,
                "additions": additions,
                "deletions": deletions,
            }
        )
    return changes


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return f"<<binary {len(raw)} bytes>>"


def _unified_diff(path: str, old: str, new: str) -> str:
    import difflib

    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            n=3,
        )
    )
