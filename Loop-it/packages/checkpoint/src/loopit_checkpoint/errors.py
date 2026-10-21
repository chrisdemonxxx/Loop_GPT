"""Checkpoint failures.

Every one of these is a refusal, not a warning. A checkpoint subsystem that
degrades gracefully under inconsistency silently hands a user a half-restored
project, so all of these fail the operation.
"""

from __future__ import annotations


class CheckpointError(Exception):
    """Base class for checkpoint failures."""


class CheckpointNotFound(CheckpointError):
    """The requested checkpoint does not exist."""


class CrossTenantAccess(CheckpointError):
    """A tenant tried to reach another tenant's checkpoint.

    Raised rather than returning empty, so the attempt is loud. Silently
    returning "not found" would hide an active isolation probe in the noise of
    ordinary misses.
    """


class ImmutabilityViolation(CheckpointError):
    """Something tried to modify a checkpoint after it was written."""


class PruneRefused(CheckpointError):
    """The checkpoint is still referenced and must not be collected.

    Pruning a checkpoint that an open run forked from destroys the base that run
    is diffing against, which loses work with no way to recover it.
    """


class InconsistentSnapshot(CheckpointError):
    """Filesystem and database snapshots do not belong to the same moment."""
