# loopit-policy

`loopit-policy` is the pure-Python default policy engine for infrastructure-abuse
controls. It intentionally does **not** enforce model-content policy; invariant
I11 requires those enforcement paths to stay separate.

The default rule set lives in `loopit_policy.rules.DEFAULT_RULE_SET` as typed
dataclasses that can be serialized to JSON and exported to Rego later. The
`rego/` files are parity documentation artifacts; tests assert their structural
rule IDs match the Python rule set.

## Consumers

- `classify_action(...)` classifies proposed tool calls/shell commands by
  reversibility, destructiveness, and gate requirement. `LOOPIT_GATE_PRESET`
  selects `builder` (default: auto-approve relative `cat`/`tee` heredoc writes
  and `python file.py`) or `strict` (read-only/verify allowlist only). Deploy,
  egress, secrets, spend, and destructive shell still require human confirmation
  (I7). Unknown presets fail closed to `strict`.
- `EgressPolicy.evaluate(...)` mirrors the egress proxy semantics: default deny,
  category allowlists, deploy windows, and unconditional metadata/link-local
  denial.
- `evaluate_quota(...)` checks tenant limits before tokens, leases, egress, or
  credits are spent.
- `analyze_proposed_actions(...)` is the P3-8 pre-execution security pass.
- `classify_failure(...)` maps errors into the P3-9 orchestrator taxonomy.
