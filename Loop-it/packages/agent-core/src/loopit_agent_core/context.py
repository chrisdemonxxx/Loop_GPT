"""Context window management (Doc 04 §4, P1-9/P1-10).

Context is the scarcest resource in the loop and the one most often wasted.
Three rules govern how this module spends it.

**The stable prefix comes first, byte for byte.** Providers cache on an exact
prefix match, and a cache hit is roughly an order of magnitude cheaper than a
miss. Putting anything variable — a timestamp, a retrieved file, an iteration
counter — ahead of the system prompt invalidates the cache on every single
call, which is a large recurring bill for no benefit.

**Condense the middle, never the ends.** The opening turns carry the task and
its constraints; the closing turns carry the current failure. The middle is
where superseded attempts accumulate, and that is what gets summarised.

**Condensation is for the prompt only.** The full transcript is retained for
audit and replay (I10). A summarised history that overwrote the original would
destroy the record precisely for the long, expensive runs that most need
explaining afterwards.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from .budget import BudgetExceeded
from .model import Difficulty, Message, ModelClient, ModelResponse

#: Characters per token. A rough English/code average, used for budgeting only.
#:
#: Deliberately an estimate: the real count is tokeniser-specific and differs
#: per model, and the router may switch models mid-run. Budgeting on an estimate
#: that is stable across models beats budgeting on an exact number that is only
#: correct for whichever model happened to be picked.
CHARS_PER_TOKEN = 4

#: Fraction of the window at which condensation triggers.
#:
#: Condensing at the ceiling is too late: the condensation call itself needs
#: room, and so does the response that follows it.
DEFAULT_CONDENSE_AT = 0.7

#: Turns kept verbatim at each end of the transcript.
DEFAULT_HEAD_TURNS = 2
DEFAULT_TAIL_TURNS = 6


def estimate_tokens(text: str) -> int:
    """Approximate the token cost of ``text``."""
    return (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def estimate_messages(messages: Sequence[Message]) -> int:
    """Approximate the token cost of a transcript."""
    return sum(estimate_tokens(m.content) for m in messages)


#: Summarises a run of superseded turns. Backed by a cheap model in production.
Condenser = Callable[[Sequence[Message]], str]

#: Called when a condenser spends model tokens, so the owning loop can charge
#: the same budget and audit stream as ordinary inference.
CondensationRecorder = Callable[[ModelResponse], None]

#: Called when the summarisation model is unavailable and compaction falls back
#: to the deterministic structural summary.
CondensationDegradationRecorder = Callable[[Exception], None]


def default_condenser(messages: Sequence[Message]) -> str:
    """A deterministic, model-free fallback summary.

    Records what happened structurally rather than inventing prose about it.
    A condenser that guesses at intent can assert something the run never did,
    and the agent has no way to tell that apart from a real observation.
    """
    by_role: dict[str, int] = {}
    for message in messages:
        by_role[message.role] = by_role.get(message.role, 0) + 1
    counts = ", ".join(f"{count} {role}" for role, count in sorted(by_role.items()))
    return (
        f"[{len(messages)} earlier turns condensed: {counts}. "
        "These attempts did not reach a verified state; their detail was dropped to "
        "make room. Re-read files rather than relying on memory of them.]"
    )


MODEL_CONDENSER_SYSTEM_PROMPT = (
    "You compact an autonomous coding agent transcript. Summarise only durable "
    "state: the user's objective and constraints if they appear, files changed, "
    "commands already run, verification failures, rejected approaches, and the "
    "next useful lead. Omit bulk file contents and stale command output. Do not "
    "invent facts."
)


def render_condensation_input(messages: Sequence[Message]) -> str:
    """Render superseded turns for a summariser without giving them authority.

    The condenser needs enough raw evidence to preserve the run's memory, but
    those turns include tool output and attacker-influenced application text.
    Labelling every entry as transcript data keeps the summariser doing clerical
    compression instead of following an old page's instructions.
    """

    rendered: list[str] = []
    for index, message in enumerate(messages, start=1):
        rendered.append(f"Turn {index} ({message.role}, DATA only):\n{message.content}")
    return "\n\n---\n\n".join(rendered)


@dataclass(slots=True)
class ModelBackedCondenser:
    """Summarise superseded transcript turns through the router's cheap tier.

    The deterministic condenser remains available because tests should not
    become inference tests by accident. Production loops need the opposite
    tradeoff: dropping the middle structurally is cheap, but it erases the
    record of failed approaches and makes a long build repeat itself. Routing
    this call as ``trivial`` lets the router choose the small summarisation
    model while keeping credentials and model choice out of the agent harness.
    """

    model: ModelClient
    difficulty: Difficulty = "trivial"
    on_response: CondensationRecorder | None = None
    on_degraded: CondensationDegradationRecorder | None = None
    last_degraded: bool = field(default=False, init=False)

    def __call__(self, messages: Sequence[Message]) -> str:
        self.last_degraded = False
        try:
            response = self.model.complete(
                [
                    Message("system", MODEL_CONDENSER_SYSTEM_PROMPT),
                    Message("user", render_condensation_input(messages)),
                ],
                difficulty=self.difficulty,
                response_schema=None,
            )
        except BudgetExceeded:
            raise
        except Exception as exc:
            self.last_degraded = True
            if self.on_degraded is not None:
                self.on_degraded(exc)
            return default_condenser(messages)
        if self.on_response is not None:
            self.on_response(response)
        summary = response.content.strip()
        if not summary:
            return default_condenser(messages)
        return (
            "[Earlier turns condensed for context budget. Durable run memory follows; "
            "re-read source files before relying on omitted details.]\n"
            f"{summary}"
        )


@dataclass(frozen=True, slots=True)
class _PromptEntry:
    message: Message
    degraded_source: tuple[Message, ...] = ()

    @property
    def condensation_source(self) -> tuple[Message, ...]:
        return self.degraded_source or (self.message,)


@dataclass(frozen=True, slots=True)
class StablePrefix:
    """The byte-stable head of every prompt in a run.

    Frozen because a mutable prefix is a prefix that will eventually be mutated,
    and the cost of that shows up as a quietly doubled inference bill rather
    than as a failure.
    """

    system_prompt: str
    tool_catalogue: str = ""
    conventions: str = ""

    def render(self) -> str:
        parts = [self.system_prompt]
        if self.tool_catalogue:
            parts.append(f"Available tools: {self.tool_catalogue}")
        if self.conventions:
            parts.append(self.conventions)
        return "\n\n".join(parts)

    def as_message(self) -> Message:
        return Message("system", self.render())

    @property
    def tokens(self) -> int:
        return estimate_tokens(self.render())


@dataclass(slots=True)
class ContextWindow:
    """Assembles prompts and condenses history when the budget gets tight.

    Args:
        prefix: the stable head. Emitted first, unchanged, on every call.
        max_tokens: the model's usable context.
        condense_at: fraction of ``max_tokens`` that triggers condensation.
        head_turns / tail_turns: how much of each end survives verbatim.
        condenser: summarises the middle.
    """

    prefix: StablePrefix
    max_tokens: int = 128_000
    condense_at: float = DEFAULT_CONDENSE_AT
    head_turns: int = DEFAULT_HEAD_TURNS
    tail_turns: int = DEFAULT_TAIL_TURNS
    condenser: Condenser = default_condenser
    _history: list[Message] = field(default_factory=list, init=False, repr=False)
    _prompt_history: list[_PromptEntry] = field(default_factory=list, init=False, repr=False)
    condensations: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        if not 0 < self.condense_at < 1:
            raise ValueError("condense_at must be a fraction strictly between 0 and 1")
        if self.head_turns < 0 or self.tail_turns < 1:
            raise ValueError("head_turns must be >= 0 and tail_turns >= 1")
        if self.prefix.tokens >= self.max_tokens * self.condense_at:
            raise ValueError(
                "the stable prefix alone exceeds the condensation threshold; no amount of "
                "history trimming can recover a window this small"
            )

    # --- History --------------------------------------------------------------

    def append(self, message: Message) -> None:
        self._history.append(message)
        self._prompt_history.append(_PromptEntry(message))

    def extend(self, messages: Sequence[Message]) -> None:
        self._history.extend(messages)
        self._prompt_history.extend(_PromptEntry(message) for message in messages)

    @property
    def history(self) -> tuple[Message, ...]:
        """The full, uncondensed transcript. This is what the audit log keeps."""
        return tuple(self._history)

    @property
    def threshold(self) -> int:
        return int(self.max_tokens * self.condense_at)

    def estimated_tokens(self) -> int:
        return self.prefix.tokens + estimate_messages(
            [entry.message for entry in self._prompt_history]
        )

    @property
    def needs_condensation(self) -> bool:
        return self.estimated_tokens() > self.threshold

    # --- Prompt assembly ------------------------------------------------------

    def build(self) -> list[Message]:
        """Render the prompt: stable prefix first, then history, condensed if needed."""
        messages = [self.prefix.as_message()]

        if not self.needs_condensation:
            messages.extend(entry.message for entry in self._prompt_history)
            return messages

        keep_head = self._prompt_history[: self.head_turns]
        keep_tail = self._prompt_history[-self.tail_turns :] if self.tail_turns else []
        middle_entries = self._prompt_history[
            self.head_turns : len(self._prompt_history) - len(keep_tail)
        ]

        if not middle_entries:
            # Nothing left to drop; the ends alone are over budget. Emitting
            # them anyway is right — silently discarding the current failure to
            # respect an estimate would break the loop for no safety gain.
            messages.extend(entry.message for entry in self._prompt_history)
            return messages

        middle = [message for entry in middle_entries for message in entry.condensation_source]
        summary = Message("system", self.condenser(middle))
        degraded = bool(getattr(self.condenser, "last_degraded", False))
        summary_entry = _PromptEntry(summary, tuple(middle) if degraded else ())
        self._prompt_history = [*keep_head, summary_entry, *keep_tail]
        self.condensations += 1
        messages.extend(entry.message for entry in self._prompt_history)
        return messages
