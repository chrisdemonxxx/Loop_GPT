from __future__ import annotations

import re
from pathlib import Path

from loopit_policy import DEFAULT_RULE_SET


def _rego_set(name: str) -> set[str]:
    rego = Path(__file__).parents[1] / "rego" / "policy.rego"
    text = rego.read_text(encoding="utf-8")
    match = re.search(rf"{name}\s*:=\s*\{{(?P<body>.*?)\}}", text, re.S)
    assert match is not None
    return set(re.findall(r'"([^"]+)"', match.group("body")))


def test_rego_artifact_rule_ids_match_python_rule_set() -> None:
    assert _rego_set("action_rule_ids") == {rule.name for rule in DEFAULT_RULE_SET.action_rules}
    assert _rego_set("domain_category_ids") == {
        category.name for category in DEFAULT_RULE_SET.domain_categories
    }
    assert _rego_set("analyzer_rule_ids") == {rule.name for rule in DEFAULT_RULE_SET.analyzer_rules}
