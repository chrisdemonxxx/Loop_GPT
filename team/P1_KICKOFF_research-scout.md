# P1 KICKOFF — research-scout (owner: frontier-pattern recon)

**Deliverable: `team/FRONTIER_RECON.md`.** It is the **only** source of work for P2 — `ui-visual`
builds from your accepted-pattern list and nothing else.

Input, in order: `AUDIT_REPORT.md` §8 (missing-vs-frontier) and §10 (open questions),
`docs/GAP_REGISTER.md`, then `docs/PROGRESS.md` for what already shipped (do not re-propose shipped work —
21/21 SHAs in `team/PHASES.md` §E1 resolve).

For each pattern Claude / ChatGPT / Grok has that §8 still lists as missing:
`pattern | what the frontier product does (observed, with the URL or the app version/date you observed it) |
what Loop GPT has today (file path, or "absent") | the exact gap | build cost (S/M/L) | rank`.

Rules:
- **Cite, don't vibe.** A URL per claim. If it is a product behaviour you observed rather than read, say so
  and give the date and the surface (desktop web / mobile web).
- Rank by **user-visible experience first** — the user's words are "fast and snappy" and "reads more
  human". A pattern that does not change the felt experience ranks below one that does.
- Mark the ones that need a **new backend contract** separately: `arch-lead` must sign a contract before
  `ui-visual` lands any new surface.
- Separate "parity" (the frontier has it, we don't) from "table stakes hygiene" (nobody ships without it).

Two anchors already measured so you don't re-derive them: `/chat` first-load is **505 kB** JS with
mermaid at ~2.5 MB raw / ~692 kB gzip loaded unconditionally (`team/PERF_BASELINE.md`), and the axe gate
only covers `critical` (`frontend/tests/e2e/app.spec.ts:10-13`). Anything you propose that makes the
first-load heavier must name the trade.

Blocked? One line: what, and the unblocker.
