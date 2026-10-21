package loopit.policy

# Documentation/parity artifact. The Python dataclass rule set is authoritative
# until an OPA runtime is introduced.

action_rule_ids := {
  "recursive-delete",
  "force-push",
  "external-git-push",
  "drop-or-truncate-sql",
  "migration",
  "deploy-or-promote",
  "secret-operation",
  "spend",
  "external-http-write",
  "package-publish",
}

domain_category_ids := {
  "package_registries",
  "deploy_targets",
  "model_router",
  "app_apis",
}

analyzer_rule_ids := {
  "chmod-777",
  "curl-pipe-shell",
  "base64-exec",
  "disable-rls",
}
