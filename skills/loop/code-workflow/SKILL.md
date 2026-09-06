---
name: code-workflow
description: Write, run, and iterate on code in the execution sandbox. Use when the user asks to compute, test, plot, process data, build a script, verify logic, or any task where running the code is faster or safer than reasoning about it.
---

# Code Workflow

Run it, don't speculate. The sandbox executes JavaScript (Node) and Python 3 with stdout/stderr returned.

## Workflow

1. **Draft** — write a minimal runnable version first. Handle the main path only.
2. **Execute** — run it via `run_javascript` or `run_python`.
3. **Read the output** — actually read stdout/stderr. If it failed, fix and re-run. Iterate up to ~4 times before reporting a blocker.
4. **Present** — show the final code in a fenced block plus a one-line summary of the result. Offer the full file if the user wants to save it.

## Choosing the runtime

- **Python** for math, data, plots, scraping helpers, and anything with rich libraries
- **JavaScript (Node)** for JSON wrangling, API-shaped logic, quick string/file processing
- **Shell** for file listing, text pipelines, and quick system checks

## Conventions

- Print results with clear labels (`print("total:", total)`) — raw dumps are hard to read
- Seed data at the top of the snippet; keep snippets self-contained
- For files the user should keep, write them into the sandbox and mention the filename
- Check numeric answers by an independent method when it matters (e.g., verify a sum with two different loop styles)
- If a computation needs >30s, split it into stages across multiple runs

## Output presentation

- Code in ```python or ```javascript blocks
- Results as a short table or list, then one takeaway line
- Never present untested code as verified — if it ran, say so; if not, say "untested sketch"
