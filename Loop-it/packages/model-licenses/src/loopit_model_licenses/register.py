from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from importlib import resources
from pathlib import Path
from typing import Any


class LicenseRegisterError(ValueError):
    """A model is not legally servable, or the register is malformed."""


@dataclass(frozen=True, slots=True)
class LicenseEntry:
    model_id: str
    base_model: str
    derivative_lineage: tuple[str, ...]
    license_id: str
    license_url: str
    field_of_use_restrictions: tuple[str, ...]
    commercial_use: bool
    attribution_requirements: tuple[str, ...]
    redistribution_requirements: tuple[str, ...]
    last_verified: date
    verifier: str

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> LicenseEntry:
        required = {
            "model_id",
            "base_model",
            "license_id",
            "license_url",
            "commercial_use",
            "last_verified",
            "verifier",
        }
        missing = sorted(required - payload.keys())
        if missing:
            raise LicenseRegisterError(f"license entry is missing required keys: {missing}")
        try:
            verified = date.fromisoformat(str(payload["last_verified"]))
        except ValueError as exc:
            raise LicenseRegisterError(
                f"model {payload.get('model_id')!r} has invalid last_verified"
            ) from exc
        return cls(
            model_id=str(payload["model_id"]),
            base_model=str(payload["base_model"]),
            derivative_lineage=_strings(payload.get("derivative_lineage", ())),
            license_id=str(payload["license_id"]),
            license_url=str(payload["license_url"]),
            field_of_use_restrictions=_strings(payload.get("field_of_use_restrictions", ())),
            commercial_use=bool(payload["commercial_use"]),
            attribution_requirements=_strings(payload.get("attribution_requirements", ())),
            redistribution_requirements=_strings(payload.get("redistribution_requirements", ())),
            last_verified=verified,
            verifier=str(payload["verifier"]),
        )

    def assert_servable_commercially(self, *, today: date, max_age_days: int) -> None:
        if not self.commercial_use:
            raise LicenseRegisterError(
                f"model {self.model_id!r} is not approved for commercial serving"
            )
        age_days = (today - self.last_verified).days
        if age_days < 0:
            raise LicenseRegisterError(
                f"model {self.model_id!r} has a future license verification date"
            )
        if age_days > max_age_days:
            raise LicenseRegisterError(
                f"model {self.model_id!r} license verification is stale "
                f"({age_days} days old, max {max_age_days})"
            )


@dataclass(frozen=True, slots=True)
class ModelLicenseRegister:
    entries: Mapping[str, LicenseEntry]

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> ModelLicenseRegister:
        validate_register_payload(payload)
        entries = [LicenseEntry.from_dict(item) for item in payload["models"]]
        by_id: dict[str, LicenseEntry] = {}
        duplicates: list[str] = []
        for entry in entries:
            if entry.model_id in by_id:
                duplicates.append(entry.model_id)
            by_id[entry.model_id] = entry
        if duplicates:
            raise LicenseRegisterError(f"duplicate model license entries: {sorted(duplicates)}")
        return cls(entries=by_id)

    def assert_servable_commercially(
        self, model_id: str, *, today: date | None = None, max_age_days: int | None = None
    ) -> LicenseEntry:
        try:
            entry = self.entries[model_id]
        except KeyError:
            raise LicenseRegisterError(
                f"model {model_id!r} is not in the license register"
            ) from None
        entry.assert_servable_commercially(
            today=today or datetime.now(UTC).date(),
            max_age_days=max_age_days if max_age_days is not None else _configured_max_age_days(),
        )
        return entry


def validate_register_payload(payload: Mapping[str, Any]) -> None:
    if payload.get("schema_version") != 1:
        raise LicenseRegisterError("license register schema_version must be 1")
    models = payload.get("models")
    if not isinstance(models, list) or not models:
        raise LicenseRegisterError("license register must contain at least one model")
    for index, item in enumerate(models):
        if not isinstance(item, Mapping):
            raise LicenseRegisterError(f"models[{index}] must be an object")


def load_register(path: Path | str) -> ModelLicenseRegister:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise LicenseRegisterError("license register root must be an object")
    return ModelLicenseRegister.from_dict(payload)


def load_default_register() -> ModelLicenseRegister:
    data = resources.files("loopit_model_licenses.data").joinpath("models.json")
    payload = json.loads(data.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise LicenseRegisterError("default license register root must be an object")
    return ModelLicenseRegister.from_dict(payload)


def assert_servable_commercially(
    model_id: str,
    *,
    register: ModelLicenseRegister | None = None,
    today: date | None = None,
    max_age_days: int | None = None,
) -> LicenseEntry:
    return (register or load_default_register()).assert_servable_commercially(
        model_id, today=today, max_age_days=max_age_days
    )


def _strings(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, Sequence) and not isinstance(value, str):
        result = tuple(str(item) for item in value)
        if all(result):
            return result
    raise LicenseRegisterError("expected a non-empty string array")


def _configured_max_age_days() -> int:
    return int(os.environ.get("LOOPIT_MODEL_LICENSE_MAX_AGE_DAYS", "120"))
