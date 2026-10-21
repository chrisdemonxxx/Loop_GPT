"""Typed refusals keep API errors coarse while tests assert exact controls."""

from __future__ import annotations


class DomainError(RuntimeError):
    """Base class for safe, expected domain-service refusals."""


class AuthorizationDenied(DomainError):
    """The actor cannot mutate this tenant's domains."""


class InvalidDomain(DomainError):
    """A hostname is malformed or platform-owned."""


class ReservedName(DomainError):
    """A requested subdomain label is reserved for platform use or abuse prevention."""


class DomainConflict(DomainError):
    """A hostname is already active for another tenant or project."""


class VerificationFailed(DomainError):
    """The ownership challenge is missing, mismatched, or expired."""


class CertificateUnavailable(DomainError):
    """A host cannot be served because certificate state is unsafe."""
