from __future__ import annotations

import json
from datetime import date
from importlib import resources

import pytest
from jsonschema import Draft202012Validator
from loopit_model_licenses import (
    LicenseRegisterError,
    ModelLicenseRegister,
    assert_servable_commercially,
    load_default_register,
)


def test_default_register_matches_schema() -> None:
    schema = json.loads(
        resources.files("loopit_model_licenses.data")
        .joinpath("models.schema.json")
        .read_text(encoding="utf-8")
    )
    payload = json.loads(
        resources.files("loopit_model_licenses.data")
        .joinpath("models.json")
        .read_text(encoding="utf-8")
    )

    Draft202012Validator.check_schema(schema)
    errors = list(Draft202012Validator(schema).iter_errors(payload))
    assert errors == []


def test_default_register_serves_registered_current_commercial_models() -> None:
    entry = assert_servable_commercially(
        "loopit/coder", register=load_default_register(), today=date(2026, 9, 3)
    )
    assert entry.commercial_use


def test_unregistered_model_fails_closed() -> None:
    with pytest.raises(LicenseRegisterError, match="not in the license register"):
        assert_servable_commercially(
            "attacker/model", register=load_default_register(), today=date(2026, 9, 3)
        )


def test_non_commercial_model_fails_closed() -> None:
    register = ModelLicenseRegister.from_dict(
        {
            "schema_version": 1,
            "models": [
                {
                    "model_id": "research-only",
                    "base_model": "base",
                    "derivative_lineage": [],
                    "license_id": "cc-by-nc-4.0",
                    "license_url": "https://creativecommons.org/licenses/by-nc/4.0/",
                    "field_of_use_restrictions": ["Non-commercial only."],
                    "commercial_use": False,
                    "attribution_requirements": [],
                    "redistribution_requirements": [],
                    "last_verified": "2026-09-01",
                    "verifier": "legal",
                }
            ],
        }
    )

    with pytest.raises(LicenseRegisterError, match="not approved"):
        register.assert_servable_commercially("research-only", today=date(2026, 9, 3))


def test_stale_verification_fails_closed() -> None:
    with pytest.raises(LicenseRegisterError, match="stale"):
        assert_servable_commercially(
            "loopit/coder",
            register=load_default_register(),
            today=date(2027, 2, 1),
            max_age_days=30,
        )
