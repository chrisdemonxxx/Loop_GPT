"""Two-stage code retrieval (Doc 04 §4, P1-9).

Naive retrieval dumps whole files into the prompt and runs out of window on any
repository worth building. Two-stage retrieval separates *locating* from
*reading*:

1. **Locate (coarse, cheap).** Search returns paths and symbol names with a
   line of context — enough to decide relevance, nowhere near enough to edit
   against. Hundreds of candidates fit here.
2. **Read (focused, expensive).** Only the spans that survived stage one are
   read in full.

The split matters because the two stages have different failure modes. Locating
too narrowly loses the file that mattered; reading too broadly burns the window
on files that turned out to be irrelevant. Keeping them separate lets stage one
stay generous and stage two stay strict.

Everything retrieved is repository content, which is untrusted input (I3).
:func:`render_reads` fences it accordingly — a README that says "ignore prior
instructions" is a file, not an instruction.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from .context import estimate_tokens
from .observation import untrusted

#: Stage-one caps. Generous, because a hit that never surfaces cannot be read.
DEFAULT_MAX_HITS = 200

#: Stage-two caps. Strict, because this is what actually costs window.
DEFAULT_MAX_READS = 12
DEFAULT_READ_BUDGET_TOKENS = 12_000


@dataclass(frozen=True, slots=True)
class Hit:
    """A stage-one candidate: where something is, not what it says."""

    path: str
    line: int
    symbol: str = ""
    preview: str = ""
    score: float = 0.0

    def __post_init__(self) -> None:
        if self.line < 1:
            raise ValueError("line numbers are 1-based")

    def summary(self) -> str:
        label = f"{self.path}:{self.line}"
        if self.symbol:
            label = f"{label} {self.symbol}"
        return f"{label} — {self.preview}" if self.preview else label


@dataclass(frozen=True, slots=True)
class Span:
    """A focused read request: a file and a line range."""

    path: str
    start: int = 1
    end: int | None = None

    def __post_init__(self) -> None:
        if self.start < 1:
            raise ValueError("line numbers are 1-based")
        if self.end is not None and self.end < self.start:
            raise ValueError("span end precedes its start")


@dataclass(frozen=True, slots=True)
class ReadResult:
    """Stage-two content. Untrusted until fenced."""

    span: Span
    content: str

    @property
    def tokens(self) -> int:
        return estimate_tokens(self.content)


@runtime_checkable
class Index(Protocol):
    """The repository-side half of retrieval.

    A Protocol so the loop never imports a concrete index. Whether locating is
    ripgrep, an LSP, or embeddings is a deployment choice, and the loop should
    not need changing when it moves.
    """

    def locate(self, query: str, *, limit: int) -> Sequence[Hit]:
        """Coarse search. Returns positions and previews, not file bodies."""
        ...

    def read(self, span: Span) -> ReadResult:
        """Focused read of one span."""
        ...


@dataclass(frozen=True, slots=True)
class Retrieval:
    """The outcome of one two-stage retrieval, with what was dropped and why."""

    query: str
    hits: tuple[Hit, ...]
    reads: tuple[ReadResult, ...]
    skipped: tuple[str, ...] = ()

    @property
    def tokens(self) -> int:
        return sum(read.tokens for read in self.reads)


def select_spans(
    hits: Sequence[Hit],
    *,
    max_reads: int = DEFAULT_MAX_READS,
    context_lines: int = 40,
) -> tuple[Span, ...]:
    """Turn stage-one hits into stage-two spans, best first, one span per file.

    Collapsing to one span per file is deliberate: several hits in the same
    file are usually the same region, and reading it twice pays for it twice.
    """
    if max_reads < 1:
        raise ValueError("max_reads must be at least 1")
    if context_lines < 1:
        raise ValueError("context_lines must be at least 1")

    ordered = sorted(hits, key=lambda hit: (-hit.score, hit.path, hit.line))
    spans: list[Span] = []
    seen: set[str] = set()
    for hit in ordered:
        if hit.path in seen:
            continue
        seen.add(hit.path)
        start = max(1, hit.line - context_lines // 2)
        spans.append(Span(hit.path, start, start + context_lines))
        if len(spans) == max_reads:
            break
    return tuple(spans)


def retrieve(
    index: Index,
    query: str,
    *,
    max_hits: int = DEFAULT_MAX_HITS,
    max_reads: int = DEFAULT_MAX_READS,
    budget_tokens: int = DEFAULT_READ_BUDGET_TOKENS,
    context_lines: int = 40,
) -> Retrieval:
    """Run locate-then-read under a token budget.

    Reads stop at the budget rather than truncating the last file. A half-read
    function looks complete to the model and is edited against as though it
    were; an explicit "not read" entry does not.
    """
    if budget_tokens < 1:
        raise ValueError("budget_tokens must be at least 1")

    hits = tuple(index.locate(query, limit=max_hits))
    reads: list[ReadResult] = []
    skipped: list[str] = []
    spent = 0

    for span in select_spans(hits, max_reads=max_reads, context_lines=context_lines):
        result = index.read(span)
        if spent + result.tokens > budget_tokens:
            skipped.append(f"{span.path}:{span.start} (read budget exhausted)")
            continue
        spent += result.tokens
        reads.append(result)

    return Retrieval(query=query, hits=hits, reads=tuple(reads), skipped=tuple(skipped))


def render_hits(hits: Sequence[Hit], *, limit: int = 40) -> str:
    """Render stage-one results for a planning prompt."""
    if not hits:
        return "No matches."
    shown = list(hits)[:limit]
    lines = [hit.summary() for hit in shown]
    if len(hits) > len(shown):
        lines.append(f"... and {len(hits) - len(shown)} further matches (narrow the query)")
    return untrusted("\n".join(lines), source="repository search results")


def render_reads(retrieval: Retrieval) -> str:
    """Render stage-two content, fenced as untrusted repository input."""
    if not retrieval.reads:
        body = "No file content was read."
    else:
        blocks = []
        for read in retrieval.reads:
            end = read.span.end if read.span.end is not None else "EOF"
            blocks.append(f"--- {read.span.path} lines {read.span.start}-{end} ---\n{read.content}")
        body = "\n\n".join(blocks)
    if retrieval.skipped:
        body += "\n\nNot read: " + "; ".join(retrieval.skipped)
    return untrusted(body, source="repository files")
