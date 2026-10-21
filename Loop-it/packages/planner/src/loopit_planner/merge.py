"""Merge-gate conflict detection over immutable checkpoints."""

from __future__ import annotations

from dataclasses import dataclass

from loopit_checkpoint import Checkpoint


@dataclass(frozen=True, slots=True)
class ChangeDigest:
    path: str
    before: str | None
    after: str | None


@dataclass(frozen=True, slots=True)
class Conflict:
    path: str
    left_after: str | None
    right_after: str | None


@dataclass(frozen=True, slots=True)
class MergeDecision:
    winner_node_id: str
    loser_node_ids: tuple[str, ...]
    conflicts: tuple[Conflict, ...]


def changed_digests(ancestor: Checkpoint, checkpoint: Checkpoint) -> dict[str, ChangeDigest]:
    """Return path → before/after digest changes relative to a common ancestor."""
    paths = set(ancestor.files) | set(checkpoint.files)
    changes: dict[str, ChangeDigest] = {}
    for path in sorted(paths):
        before = ancestor.files.get(path)
        after = checkpoint.files.get(path)
        if before != after:
            changes[path] = ChangeDigest(path, before, after)
    return changes


def detect_conflicts(
    ancestor: Checkpoint,
    left: Checkpoint,
    right: Checkpoint,
) -> tuple[Conflict, ...]:
    """Detect conflicting writes without attempting a blind three-way merge."""
    left_changes = changed_digests(ancestor, left)
    right_changes = changed_digests(ancestor, right)
    conflicts: list[Conflict] = []
    for path in sorted(set(left_changes) & set(right_changes)):
        left_after = left_changes[path].after
        right_after = right_changes[path].after
        if left_after != right_after:
            conflicts.append(Conflict(path, left_after, right_after))
    return tuple(conflicts)


def choose_winner(
    candidates: tuple[str, ...],
    *,
    ranks: dict[str, int],
) -> str:
    """Deterministic winner rule: lower topological rank, then lower node id."""
    if not candidates:
        raise ValueError("cannot choose a winner from no candidates")
    return min(candidates, key=lambda node_id: (ranks.get(node_id, 10_000), node_id))
