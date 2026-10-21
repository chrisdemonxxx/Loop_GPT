"""Repository-wide pytest configuration."""

from __future__ import annotations

import base64
import os

_TEST_SECRETS = {
    "POSTGRES_PASSWORD": "pytest-postgres-password-with-32-chars",
    "LOOPIT_IDENTITY_SECRET": "pytest-identity-secret-with-at-least-thirty-two-bytes",
    "LOOPIT_OPERATOR_IDENTITY_SECRET": "pytest-operator-secret-with-at-least-thirty-two-bytes",
    "LOOPIT_PREVIEW_SIGNING_KEY": "pytest-preview-secret-with-at-least-thirty-two-bytes",
    "LOOPIT_LEASE_TOKEN_SECRET": "pytest-lease-secret-with-at-least-thirty-two-bytes",
    "LOOPIT_SERVICE_TOKEN": "pytest-service-token-with-at-least-thirty-two-bytes",
    "LOOPIT_MODEL_API_KEY": "pytest-model-api-key-with-at-least-thirty-two-bytes",
    "LOOPIT_SECRETS_ROOT_KEY": base64.b64encode(b"x" * 32).decode("ascii"),
}

for _name, _value in _TEST_SECRETS.items():
    os.environ.setdefault(_name, _value)
