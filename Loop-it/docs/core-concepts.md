# Core concepts

## Runs

A run is one bounded attempt to turn a prompt into a working app or app change. Every run has iteration,
token, wall-clock, and credit limits (I12).

## Checkpoints

Checkpoints are immutable states of the generated project. A green checkpoint can be rolled back to or
forked after explicit confirmation.

## Gates

Confirmation gates enforce I7. Deploys, deletes, paid spend, external writes, and secret rotation pause
until a human explicitly approves. Prompt injection cannot bypass a capability that is structurally gated.

## Sandboxes

Generated code runs only in data-plane sandboxes (I1). Sandboxes receive no ambient credentials (I2),
use default-deny egress through the proxy (I3), and block cloud metadata endpoints fail-closed (I4).

## Verification

Verification runs cheap checks first, then browser and security layers when available. The Phase 1 live
exit gate refuses to report success unless real sandbox and model infrastructure are configured.

## Data ownership and export

Users own generated code. Git sync and export are the no-lock-in path: checkpoints align to commits, and
exports include code, migrations, seed data, and metadata needed to rebuild elsewhere.
