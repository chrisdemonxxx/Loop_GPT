"""Leased sandbox tool dispatch (Doc 02 §2, invariant I1).

The orchestrator is durable control-plane code, so it cannot execute generated
commands or even apply generated patches itself. This service is the narrow HTTP
bridge that proves a caller owns a live lease, checks the lease's tool surface,
and then forwards the instruction to the sandbox runtime bound to that lease.
"""

from .server import DispatchSettings, create_app, main
from .workspace import InMemoryWorkspaceFactory

__all__ = ["DispatchSettings", "InMemoryWorkspaceFactory", "create_app", "main"]
