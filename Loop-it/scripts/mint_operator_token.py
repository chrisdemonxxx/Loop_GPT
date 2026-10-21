from __future__ import annotations

import argparse
import sys

from loopit_auth import OperatorTokenIssuer, OperatorTokenSettings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mint a short-lived Loop-it operator token.")
    parser.add_argument("--subject", required=True, help="Operator identity recorded in audit logs")
    parser.add_argument("--ttl-seconds", type=int, default=None, help="Override token TTL")
    args = parser.parse_args(argv)

    issuer = OperatorTokenIssuer(OperatorTokenSettings.from_env())
    print(issuer.mint(subject=args.subject, ttl_seconds=args.ttl_seconds))
    return 0


if __name__ == "__main__":
    sys.exit(main())
