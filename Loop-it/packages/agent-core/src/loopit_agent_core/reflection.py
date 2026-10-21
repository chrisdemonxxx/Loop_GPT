"""Turning failed verification into the next thought (Doc 04 §8, P1-8).

The reflection loop is the single mechanism that separates an agent producing
plausible code from one producing working code. A failed typecheck, a red test,
a 500 from the browser — none of these are errors to swallow and retry blindly.
Each is an *observation*, and it goes back into the transcript in the tool's own
words so the next iteration reasons about the actual defect.

The counterweight is thrashing. An agent that re-reads the same error and
re-applies the same non-fix will do so until the budget is gone, and it will
look busy the entire time. :class:`FailureTracker` watches for a repeating
failure signature and stops the loop while there is still budget left to
re-plan with — a stall detected at iteration four is recoverable, one detected
at the budget ceiling is just an expensive failure.
"""

from __future__ import annotations

import hashlib
import re
from collections import deque
from dataclasses import dataclass

#: Consecutive identical failures before the loop is declared stuck.
#:
#: Two is too eager — a genuine second attempt often produces the same error for
#: a different reason. Beyond three, the agent is paying full price per
#: iteration to learn nothing.
DEFAULT_REPEAT_LIMIT = 3

#: Volatile fragments stripped before comparing two failures.
#:
#: Without this, a timestamp, a temp path or a duration makes every failure look
#: novel, and thrash detection never fires — which is the failure mode that
#: actually costs money.
_VOLATILE = (
    re.compile(
        r"\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?",
        re.IGNORECASE,
    ),
    re.compile(r"\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|minutes)\b"),
    re.compile(r"0x[0-9a-fA-F]{4,}"),
    re.compile(r"/tmp/[\w./-]+"),  # noqa: S108 - matching temp paths, not creating one
    re.compile(r"\b[a-f0-9]{12,}\b"),
)


@dataclass(frozen=True, slots=True)
class VerificationVerdict:
    """What a verification hook reports back to the loop.

    Attributes:
        verified: whether the task's verification is green.
        summary: the completion summary, when verified.
        observation: the failure text fed back as the next input. Absent means
            "not verified, and nothing useful to say" — the loop then continues
            without polluting the transcript with an empty turn.
    """

    verified: bool
    summary: str = ""
    observation: str | None = None

    @classmethod
    def green(cls, summary: str) -> VerificationVerdict:
        return cls(verified=True, summary=summary)

    @classmethod
    def red(cls, observation: str) -> VerificationVerdict:
        return cls(verified=False, observation=observation)


def failure_signature(text: str) -> str:
    """A stable fingerprint for a failure, ignoring volatile detail."""
    normalised = text.strip().lower()
    for pattern in _VOLATILE:
        normalised = pattern.sub("<v>", normalised)
    normalised = re.sub(r"\s+", " ", normalised)
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:16]


class FailureTracker:
    """Detects an agent re-running into the same wall.

    Only *consecutive* repeats count. An agent that fails, fixes one thing,
    fails differently, then hits the first error again is making progress in a
    messy way; that is not thrashing, and stopping it would be wrong.
    """

    def __init__(self, repeat_limit: int = DEFAULT_REPEAT_LIMIT) -> None:
        if repeat_limit < 2:
            raise ValueError("repeat_limit must be at least 2; a single failure is not a pattern")
        self._limit = repeat_limit
        self._recent: deque[str] = deque(maxlen=repeat_limit)

    def record(self, observation: str) -> bool:
        """Record a failure. Returns True once it has repeated to the limit."""
        self._recent.append(failure_signature(observation))
        return self.is_stuck

    def reset(self) -> None:
        """Clear history after any progress."""
        self._recent.clear()

    @property
    def is_stuck(self) -> bool:
        return len(self._recent) == self._limit and len(set(self._recent)) == 1

    @property
    def repeat_count(self) -> int:
        if not self._recent:
            return 0
        latest = self._recent[-1]
        count = 0
        for signature in reversed(self._recent):
            if signature != latest:
                break
            count += 1
        return count


def stall_message(repeat_count: int) -> str:
    """The summary written when the loop is stopped for thrashing."""
    return (
        f"stopped: the same verification failure recurred {repeat_count} times without "
        "progress. Re-plan rather than retrying; the current approach is not converging."
    )
