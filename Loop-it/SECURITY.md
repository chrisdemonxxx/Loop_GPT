# Security disclosure policy

Loop-it welcomes responsible vulnerability reports. Send reports to the address published in
`security.txt` with enough detail to reproduce the issue, affected components, and any safe
proof-of-concept material.

We aim to acknowledge valid reports within 3 business days, keep report details confidential
while investigating, and coordinate disclosure timelines with reporters when user or tenant data
could be affected. Do not access, modify, or exfiltrate data that is not yours while testing.

## Scope

In scope: sandbox isolation, metadata/egress controls, cross-tenant access, preview URL authorization,
model-router credential handling, generated-app verification boundaries, billing/quota authorization, and
operator-token workflows.

Out of scope: denial-of-service tests without prior coordination, social engineering, physical attacks, and
accessing data that does not belong to you.

## Safe harbor

Good-faith testing that follows this policy, avoids data exfiltration, and stops after proving impact will
not be treated as abuse. If testing might affect availability or another tenant, ask first.
