"""Turn one line from a person into a complete build brief.

The user writes "just build this". The engine does the rest: this module asks
the planner-class model — through the same router seam the loop itself uses —
for a product-style title, a one-line summary, an expanded implementation
brief, and a complexity class that sizes the run's iteration budget. The loop
then runs on the expanded brief and stops itself when verification passes.

This is *prompt elasticity*: the effort a run deserves is derived from what
was asked, not chosen by the person asking. A landing page gets a quick
budget; a multi-page app with settings and permissions earns a deep one.

The model is never allowed to fail the run. Anything unexpected — a timeout, a
malformed answer, a router hiccup — falls back to the user's own words with a
standard budget, because someone who typed ten words still wants their build.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator
from loopit_agent_core.model import Message

LOGGER = logging.getLogger(__name__)

#: Complexity the brief model picks; each maps to an iteration budget below.
COMPLEXITIES = ("quick", "standard", "deep", "max")

#: Elastic effort: what the derived complexity is worth in loop iterations.
#: quick — a single screen or a small change. standard — a page or two with
#: real behaviour. deep — a multi-page app with state. max — everything above
#: plus settings, permissions, or an admin surface.
#:
#: The iteration axis prices RECOVERY, not work: turns whose tool executed
#: (reads, patches, verification reflection) are refunded by the loop, so
#: these numbers are "turns spent getting nowhere", not "turns total". A
#: standard build used to die at turn 14 with the app half-assembled when
#: every turn counted — now it finishes, and only a genuinely stuck build
#: (tool failures, rejected calls, truncations) ever touches the cap.
BUDGET_BY_COMPLEXITY: dict[str, int] = {
    "quick": 8,
    "standard": 14,
    "deep": 24,
    "max": 40,
}

#: The budget a run gets when no brief could be produced.
FALLBACK_BUDGET = 14

#: Answer shape. Constrained decoding on the router keeps this valid by
#: construction; validation here is the second layer for clients that fence
#: or freehand the JSON anyway.
BRIEF_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "summary", "expanded_prompt", "complexity"],
    "properties": {
        "title": {
            "type": "string",
            "minLength": 2,
            "maxLength": 64,
            "description": (
                "Product-style name for what is being built, "
                "e.g. 'Customer Intake Form'."
            ),
        },
        "summary": {
            "type": "string",
            "minLength": 2,
            "maxLength": 200,
            "description": "One plain-language sentence describing the result for the build board.",
        },
        "expanded_prompt": {
            "type": "string",
            "minLength": 2,
            "maxLength": 8000,
            "description": (
                "The implementation brief the builder agent will execute. It must "
                "contain ONLY what the user requested — no invented features, pages, "
                "integrations, or 'nice touches'. Structure and make concrete the "
                "user's explicit requirements; do not expand scope."
            ),
        },
        "complexity": {
            "type": "string",
            "enum": list(COMPLEXITIES),
            "description": "Effort class sizing the run's iteration budget.",
        },
    },
}

_BRIEF_VALIDATOR = Draft202012Validator(BRIEF_SCHEMA)

_BRIEF_SYSTEM = "\n".join(
    [
        "You turn a short app request into a build brief for an autonomous web-app builder.",
        "",
        "STRICT SCOPE RULE (binding): the builder must implement exactly what the user",
        "requests — no more, no less. Your job is to RESTATE and STRUCTURE the request,",
        "not to expand it. Do NOT invent features, pages, sections, fields, navigation,",
        "empty states, styling systems, integrations, sample data, settings, admin surfaces,",
        "or 'nice touches' the user did not explicitly ask for. Do NOT fabricate backends,",
        "auth flows, databases, or APIs that the request does not mention.",
        "",
        "Given the user's request (and, when present, the files already in the",
        "project), respond with a JSON object:",
        "- title: a concise product-style name (no quotes, no prefix like 'Build' or 'App for');",
        "- summary: one sentence a non-technical person would write about the result;",
        "- expanded_prompt: the builder's brief. Include ONLY the user's explicit requirements,",
        "  organized concretely. If the user left something truly ambiguous, make the smallest",
        "  reasonable interpretation and state it as an assumption. Do not add scope. Do not include code.",
        "- complexity: quick (one simple screen), standard (a page or two with real",
        "  behaviour), deep (multi-page app with state), max (deep plus settings,",
        "  permissions, or an admin surface). Pick the SMALLEST class that comfortably fits",
        "  the request; never oversize.",
        "",
        "For an edit to an existing project, the expanded_prompt states ONLY the change",
        "the user asked for and how it fits what is already there. Do not refactor or",
        "redesign unrelated parts.",
        "Write for a product surface: no markdown, no tool names, no file paths in title",
        "or summary. expanded_prompt may use short bullet points.",
    ]
)

_EDIT_CONTEXT = "\n".join(
    [
        "The request targets an existing project. Current files:",
        "{listing}",
        "",
        "Treat it as an edit: keep what already works, and make the requested",
        "change fit the project's structure.",
    ]
)


@dataclass(frozen=True, slots=True)
class Brief:
    """Everything the run needs that the user did not type."""

    title: str
    summary: str
    expanded_prompt: str
    complexity: str
    budget: int


def fallback_brief(prompt: str) -> Brief:
    """The user's own words, cleaned up, with a standard budget.

    Used when the brief model is unavailable (offline mode, a router failure,
    a malformed answer). The title strips the "just build this" scaffolding
    people write so the board still reads like a product list.
    """
    cleaned = _clean_title(prompt)
    return Brief(
        title=cleaned[:64] if cleaned else "New build",
        summary=prompt.strip()[:200] or "A build in progress.",
        expanded_prompt=prompt,
        complexity="standard",
        budget=FALLBACK_BUDGET,
    )


def expand_brief(
    model: Any,
    prompt: str,
    *,
    existing_files: Sequence[str] | None = None,
) -> Brief:
    """Ask the planner-class model for the full brief, or fall back.

    ``model`` is the run's own router client, so the brief's tokens and
    credits land on the run's ledger. Any failure returns the fallback brief
    rather than raising: the expansion is an enhancement, never a gate.
    """
    try:
        user = prompt.strip()
        if existing_files:
            user += "\n\n" + _EDIT_CONTEXT.format(
                listing="\n".join(f"- {path}" for path in existing_files[:80])
            )
        response = model.complete(
            [Message("system", _BRIEF_SYSTEM), Message("user", user)],
            difficulty="planning",
            response_schema=BRIEF_SCHEMA,
        )
        parsed = _parse_json_object(response.content)
        _BRIEF_VALIDATOR.validate(parsed)
        complexity = str(parsed["complexity"])
        return Brief(
            title=_clean_title(str(parsed["title"]))[:64] or fallback_brief(prompt).title,
            summary=str(parsed["summary"]).strip()[:200],
            expanded_prompt=str(parsed["expanded_prompt"]).strip(),
            complexity=complexity,
            budget=BUDGET_BY_COMPLEXITY[complexity],
        )
    except Exception:
        LOGGER.warning("brief expansion fell back to the raw prompt", exc_info=True)
        return fallback_brief(prompt)


def _parse_json_object(content: str) -> Mapping[str, Any]:
    """Parse the model's answer, tolerating markdown code fences."""
    text = (content or "").strip()
    if not text:
        raise ValueError("empty brief response")
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("brief response was not a JSON object")
    return parsed


#: Requests that mean "build" but read as filler when the title shows them.
_FILLER = re.compile(
    r"^\s*(?:please\s+)?(?:just\s+)?(?:can you\s+|could you\s+|i want\s+|i need\s+|"
    r"make me\s+|build me\s+|create me\s+|build\s+|make\s+|create\s+|design\s+)+",
    re.IGNORECASE,
)
_TRAILING = re.compile(r"\s*[.!]+$")


def _clean_title(text: str) -> str:
    """First clause of the request, without the 'please just build me' prefix."""
    stripped = text.strip()
    if not stripped:
        return ""
    first_clause = re.split(r"[.!?\n]", stripped, maxsplit=1)[0]
    cleaned = _FILLER.sub("", first_clause, count=1)
    cleaned = _TRAILING.sub("", cleaned).strip()
    # Collapse to title-ish capitalisation: first letter up, rest untouched.
    return cleaned[:1].upper() + cleaned[1:] if cleaned else ""


__all__ = [
    "BRIEF_SCHEMA",
    "BUDGET_BY_COMPLEXITY",
    "COMPLEXITIES",
    "Brief",
    "expand_brief",
    "fallback_brief",
]
