from __future__ import annotations

import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_model_licenses.py"
SPEC = importlib.util.spec_from_file_location("check_model_licenses", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
main = MODULE.main


def _register(path: Path, *, commercial: bool = True, last_verified: str = "2026-09-01") -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "models": [
                    {
                        "model_id": "model",
                        "base_model": "base",
                        "derivative_lineage": [],
                        "license_id": "apache-2.0",
                        "license_url": "https://www.apache.org/licenses/LICENSE-2.0",
                        "field_of_use_restrictions": [],
                        "commercial_use": commercial,
                        "attribution_requirements": [],
                        "redistribution_requirements": [],
                        "last_verified": last_verified,
                        "verifier": "legal",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_license_script_returns_zero_for_current_commercial_entry(tmp_path: Path) -> None:
    path = tmp_path / "models.json"
    _register(path)
    assert main(["--register", str(path), "--today", "2026-09-03"]) == 0


def test_license_script_returns_nonzero_for_stale_or_noncommercial_entry(tmp_path: Path) -> None:
    path = tmp_path / "models.json"
    _register(path, commercial=False)
    assert main(["--register", str(path), "--today", "2026-09-03"]) == 1

    _register(path, commercial=True, last_verified="2026-01-01")
    assert main(["--register", str(path), "--today", "2026-09-03"]) == 1
