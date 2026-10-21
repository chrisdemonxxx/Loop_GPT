from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .models import Actor, Role

Action = Literal[
    "org:read",
    "org:manage",
    "team:manage",
    "project:read",
    "project:write",
    "run:start",
    "run:approve",
    "quota:read",
    "quota:manage",
]


@dataclass(frozen=True, slots=True)
class Resource:
    org_id: str
    owner_user_id: str | None = None
    project_id: str | None = None


_MATRIX: dict[Role, frozenset[Action]] = {
    "owner": frozenset(
        {
            "org:read",
            "org:manage",
            "team:manage",
            "project:read",
            "project:write",
            "run:start",
            "run:approve",
            "quota:read",
            "quota:manage",
        }
    ),
    "admin": frozenset(
        {
            "org:read",
            "team:manage",
            "project:read",
            "project:write",
            "run:start",
            "run:approve",
            "quota:read",
        }
    ),
    "member": frozenset({"org:read", "project:read", "project:write", "run:start", "quota:read"}),
    "viewer": frozenset({"org:read", "project:read", "quota:read"}),
}


def authorize(actor: Actor, action: Action, resource: Resource) -> bool:
    if actor.org_id != resource.org_id or actor.tenant_id != resource.org_id:
        return False
    if action not in _MATRIX[actor.role]:
        return False
    if action in {"project:write", "run:start"} and actor.role == "viewer":
        return False
    return True
