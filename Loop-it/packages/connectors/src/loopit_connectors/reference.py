from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from loopit_secrets import Lease

from .core import Capability, ConnectorCredential, ConnectorInvocation, ConnectorResult


@dataclass(frozen=True, slots=True)
class WebhookConnector:
    name: str = "webhook"
    description: str = "Posts JSON payloads to a project-owned HTTPS webhook."
    capabilities: frozenset[Capability] = frozenset({"external_write"})
    required_scopes: frozenset[str] = frozenset({"connector:webhook:write"})
    egress_domains: frozenset[str] = frozenset({"hooks.example.test"})
    credential_requirements: tuple[ConnectorCredential, ...] = (
        ConnectorCredential("WEBHOOK_TOKEN", frozenset({"post:event"})),
    )
    sent: list[dict[str, Any]] = field(default_factory=list, compare=False)

    def invoke(
        self, invocation: ConnectorInvocation, leases: Mapping[str, Lease]
    ) -> ConnectorResult:
        del leases
        self.sent.append({"operation": invocation.operation, "args": dict(invocation.args)})
        return ConnectorResult(
            True, "webhook queued", {"connector": self.name, "fake_network": True}
        )


@dataclass(frozen=True, slots=True)
class ObjectStorageConnector:
    name: str = "object_storage"
    description: str = "Reads and writes project-scoped objects in an S3-compatible bucket."
    capabilities: frozenset[Capability] = frozenset({"read", "external_write"})
    required_scopes: frozenset[str] = frozenset({"connector:object_storage:write"})
    egress_domains: frozenset[str] = frozenset({"objects.example.test"})
    credential_requirements: tuple[ConnectorCredential, ...] = (
        ConnectorCredential("OBJECT_STORAGE_TOKEN", frozenset({"objects:read", "objects:write"})),
    )
    objects: dict[str, str] = field(default_factory=dict, compare=False)

    def invoke(
        self, invocation: ConnectorInvocation, leases: Mapping[str, Lease]
    ) -> ConnectorResult:
        del leases
        key = str(invocation.args.get("key", "default.txt"))
        if invocation.operation == "read":
            return ConnectorResult(True, self.objects.get(key, ""), {"key": key})
        self.objects[key] = str(invocation.args.get("body", ""))
        return ConnectorResult(True, "object written", {"key": key})


@dataclass(frozen=True, slots=True)
class GitHubIssuesConnector:
    name: str = "github_issues"
    description: str = "Creates GitHub-issues-style records via a fake client in tests."
    capabilities: frozenset[Capability] = frozenset({"read", "external_write"})
    required_scopes: frozenset[str] = frozenset({"connector:github_issues:write"})
    egress_domains: frozenset[str] = frozenset({"api.github.com"})
    credential_requirements: tuple[ConnectorCredential, ...] = (
        ConnectorCredential("GITHUB_ISSUES_TOKEN", frozenset({"issues:read", "issues:write"})),
    )
    issues: list[dict[str, str]] = field(default_factory=list, compare=False)

    def invoke(
        self, invocation: ConnectorInvocation, leases: Mapping[str, Lease]
    ) -> ConnectorResult:
        del leases
        issue = {
            "title": str(invocation.args.get("title", "Untitled")),
            "body": str(invocation.args.get("body", "")),
        }
        self.issues.append(issue)
        return ConnectorResult(True, "issue recorded", {"number": len(self.issues)})
