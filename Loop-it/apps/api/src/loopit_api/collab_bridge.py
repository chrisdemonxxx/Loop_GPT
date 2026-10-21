"""Project collaboration: presence + shared chat (Phase 3.9).

Workspace roles already gate project access. This sidecar holds ephemeral
presence heartbeats and durable shared chat messages under ``.collab/``.
Offline-friendly: no websocket fan-out — clients poll.
"""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


PRESENCE_TTL_SECONDS = 45


@dataclass
class PresencePeer:
    actor_id: str
    display_name: str
    role: str = "editor"
    last_seen_at: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "actor_id": self.actor_id,
            "display_name": self.display_name,
            "role": self.role,
            "last_seen_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.last_seen_at)),
        }


@dataclass
class ChatMessage:
    message_id: str
    actor_id: str
    display_name: str
    text: str
    created_at: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CollabState:
    project_id: str
    presence: dict[str, PresencePeer] = field(default_factory=dict)
    messages: list[ChatMessage] = field(default_factory=list)

    def as_dict(self, *, now: float | None = None) -> dict[str, Any]:
        clock = now if now is not None else time.time()
        live = [
            peer.as_dict()
            for peer in self.presence.values()
            if clock - peer.last_seen_at <= PRESENCE_TTL_SECONDS
        ]
        return {
            "project_id": self.project_id,
            "presence": live,
            "online_count": len(live),
            "messages": [m.as_dict() for m in self.messages[-200:]],
        }


class CollabStore:
    def __init__(self, projects_root: Path) -> None:
        self._root = projects_root
        self._states: dict[str, CollabState] = {}
        self._load()

    def _dir(self) -> Path:
        path = self._root / ".collab"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _path(self, project_id: str) -> Path:
        return self._dir() / f"{project_id}.json"

    def _load(self) -> None:
        for path in self._dir().glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                project_id = str(data["project_id"])
                presence: dict[str, PresencePeer] = {}
                for raw in data.get("presence") or []:
                    actor_id = str(raw.get("actor_id") or "")
                    if not actor_id:
                        continue
                    presence[actor_id] = PresencePeer(
                        actor_id=actor_id,
                        display_name=str(raw.get("display_name") or actor_id),
                        role=str(raw.get("role") or "editor"),
                        last_seen_at=float(raw.get("last_seen_epoch") or 0),
                    )
                messages = [
                    ChatMessage(
                        message_id=str(item.get("message_id") or secrets.token_hex(6)),
                        actor_id=str(item.get("actor_id") or "unknown"),
                        display_name=str(item.get("display_name") or "Member"),
                        text=str(item.get("text") or ""),
                        created_at=str(item.get("created_at") or ""),
                    )
                    for item in (data.get("messages") or [])
                    if item.get("text")
                ]
                self._states[project_id] = CollabState(
                    project_id=project_id, presence=presence, messages=messages
                )
            except Exception:
                continue

    def _save(self, state: CollabState) -> None:
        self._states[state.project_id] = state
        payload = {
            "project_id": state.project_id,
            "presence": [
                {
                    "actor_id": p.actor_id,
                    "display_name": p.display_name,
                    "role": p.role,
                    "last_seen_epoch": p.last_seen_at,
                }
                for p in state.presence.values()
            ],
            "messages": [m.as_dict() for m in state.messages[-200:]],
        }
        self._path(state.project_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _state(self, project_id: str) -> CollabState:
        return self._states.get(project_id) or CollabState(project_id=project_id)

    def heartbeat(
        self,
        project_id: str,
        *,
        actor_id: str,
        display_name: str,
        role: str = "editor",
    ) -> dict[str, Any]:
        state = self._state(project_id)
        state.presence[actor_id] = PresencePeer(
            actor_id=actor_id,
            display_name=display_name or actor_id,
            role=role,
            last_seen_at=time.time(),
        )
        self._save(state)
        return state.as_dict()

    def get(self, project_id: str) -> dict[str, Any]:
        return self._state(project_id).as_dict()

    def post_message(
        self,
        project_id: str,
        *,
        actor_id: str,
        display_name: str,
        text: str,
    ) -> dict[str, Any]:
        cleaned = (text or "").strip()
        if not cleaned:
            raise ValueError("message text is required")
        if len(cleaned) > 4000:
            raise ValueError("message too long")
        state = self._state(project_id)
        msg = ChatMessage(
            message_id=f"msg_{secrets.token_hex(6)}",
            actor_id=actor_id,
            display_name=display_name or actor_id,
            text=cleaned,
            created_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        state.messages.append(msg)
        # Refresh presence for the poster.
        state.presence[actor_id] = PresencePeer(
            actor_id=actor_id,
            display_name=display_name or actor_id,
            role=state.presence.get(actor_id, PresencePeer(actor_id, display_name)).role,
            last_seen_at=time.time(),
        )
        self._save(state)
        return state.as_dict()
