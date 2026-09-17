# Legacy spike credential remediation

The complete release-tree scan found a literal backend API key in `librechat.yaml`.
It has been replaced with `${LOOP_API_KEY}`. Inject a replacement through the
hosting secret manager before using this revised legacy configuration. No running
LibreChat service was updated and no stored backend key was revoked by this edit.

Treat the former literal as exposed through repository/image history. Coordinate
revocation or rotation with its backend owner and affected consumers; deleting it
from the current file does not invalidate old copies. Its current validity was not
tested, and its value is not included in release reports.

This legacy shared-key configuration is not the new owned staging topology and
does not establish per-user tenancy. It is not covered by owned-staging acceptance.
