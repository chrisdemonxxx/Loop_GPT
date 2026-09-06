---
name: web-research
description: Research any topic with live web search and page reads. Use when the user asks about current events, prices, releases, comparisons, "latest", "today", or anything needing fresh sources, or when verifying claims that could have changed.
---

# Web Research

Use search first, read second, synthesize third. Cite everything.

## Workflow

1. **Search** — issue focused queries. For broad topics, split into 2–4 narrow queries instead of one giant one.
2. **Read** — fetch the 2–3 most promising sources fully with `fetch_url`. Prefer primary sources (official docs, filings, vendor pages) over aggregators.
3. **Cross-check** — a claim from one source needs a second source before you state it as fact. If sources conflict, say so and show both.
4. **Synthesize** — answer with the key findings first, then detail. End with sources.

## Output format

- Lead with the direct answer (1–3 sentences)
- Then a "Details" section with the substance
- Close with a "Sources" list: `[Title](URL)` for each source actually read
- Include dates when facts are time-sensitive ("as of the Sep 2026 release notes…")

## Rules

- Never invent a URL. If you didn't fetch it, don't cite it.
- If search returns nothing solid, say what you searched and what's uncertain rather than guessing.
- For numbers (prices, stats, dates), quote the source's exact figure and date.
