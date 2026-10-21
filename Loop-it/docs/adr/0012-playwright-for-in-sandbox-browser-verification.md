# ADR-0012: Playwright for in-sandbox browser verification

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/05-verification-and-evals.md`
- **Invariants touched:** I1, I8

## Context

Verification is the moat: the platforms that feel magical are the ones that actually run the app and click through it before showing the user. Browser verification must run inside the sandbox, against the same authenticated preview proxy path the user sees, so the verified path and the viewed path are identical.

## Decision

We will run Playwright inside the sandbox as verification layer L2, driving the app through the preview proxy, asserting critical flows and capturing console and network errors, which feed back into planning as the next observation.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Puppeteer | Mature | Chromium-focused; weaker tracing and multi-browser story | Playwright is the handbook default |
| Verify against a raw sandbox port | Simpler wiring | Diverges from the user-visible path; violates I8 | Rejected |
| Skip browser verification | Cheaper | This is exactly the shallow-verification risk R12 | Rejected |

## Consequences

**Positive:** Real failures ('button X threw 500', 'page Y blank') become the next planning input; the reflection loop turns plausible apps into working ones.

**Negative / accepted costs:** Browsers must be pre-baked into the sandbox image; browser runs are the most expensive verification layer, so cheap layers must gate them.

## Revisit trigger

Revisit only if a materially better in-sandbox browser automation tool emerges.
