# loopit-auth

Self-hosted auth package for Loop-it's gateway.

It provides scrypt password registration/login, reset-token issuance events, account lockout, org membership roles, a typed RBAC matrix, HMAC-signed short-lived gateway identity tokens with `kid` rotation, an OIDC-ready provider protocol, and a `PreflightGuard` that rate-limits and checks quota ledger balance before sandbox or model spend.

Downstream services must verify gateway identity tokens with the configured issuer, audience, and key set, then trust only the returned claims. They must not accept caller-supplied tenant/user headers or re-read the auth database for authorization context.
