from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from loopit_model_licenses import LicenseRegisterError, load_default_register, load_register


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate the per-model commercial license gate.")
    parser.add_argument("--register", type=Path, help="model license register JSON")
    parser.add_argument("--max-age-days", type=int, default=120)
    parser.add_argument("--today", type=date.fromisoformat, default=date.today())
    parser.add_argument("model_ids", nargs="*", help="optional subset to check")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        register = load_register(args.register) if args.register else load_default_register()
    except (OSError, ValueError, LicenseRegisterError) as exc:
        print(f"FAIL could not load model license register: {exc}", file=sys.stderr)
        return 1

    model_ids = tuple(args.model_ids) or tuple(sorted(register.entries))
    failures: list[str] = []
    for model_id in model_ids:
        try:
            entry = register.assert_servable_commercially(
                model_id, today=args.today, max_age_days=args.max_age_days
            )
        except LicenseRegisterError as exc:
            failures.append(str(exc))
            print(f"FAIL {model_id}: {exc}", file=sys.stderr)
            continue
        print(
            f"ok  {model_id}: {entry.license_id}, commercial, "
            f"verified {entry.last_verified.isoformat()} by {entry.verifier}"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
