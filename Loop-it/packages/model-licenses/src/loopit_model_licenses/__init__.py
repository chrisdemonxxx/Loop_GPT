"""Per-model license register and fail-closed commercial serving gate."""

from .register import (
    LicenseEntry,
    LicenseRegisterError,
    ModelLicenseRegister,
    assert_servable_commercially,
    load_default_register,
    load_register,
    validate_register_payload,
)

__all__ = [
    "LicenseEntry",
    "LicenseRegisterError",
    "ModelLicenseRegister",
    "assert_servable_commercially",
    "load_default_register",
    "load_register",
    "validate_register_payload",
]
