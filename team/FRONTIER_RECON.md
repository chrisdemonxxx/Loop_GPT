# team/FRONTIER_RECON.md — external ground truth for P2 (owner: research-scout)

**This is the accepted-pattern list. `ui-visual` builds from §2 and nothing else.**
Ranked by user-visible experience first (the user's words: "fast and snappy", "reads more human").

**Pass 2 (2026-09-27, `research-scout`).** Pass 1 is `ef77e80`. This pass adds: a **prune table with
file:line** for the §8 items that already shipped (§0.2), the **live first-load measurement against
grok.com** (§3), the **mermaid-is-lazy** correction (§0.3), and a **correction to pass 1** (the iOS
composer already ships — §0.5). Ranks 1/3/4/6 from pass 1 are carried forward where re-verified.

Method: read the code first (`frontend/app/**`, `backend/src/**`), then the ledger (`docs/PROGRESS.md`,
`AUDIT_REPORT.md` §8/§10), then fetch the frontier claim from the vendor's own page. Every line carries a
source and a confidence. Unverifiable lines are marked `UNVERIFIED`.

---

## §0 — Corrections before anything is built (read these first)

**0.1 — `AUDIT_REPORT.md` §8 numbering ≠ `docs/PROGRESS.md` "§8-N" numbering. They disagree.**
Audit `:821` item 15 is "Floating scroll-to-bottom button"; PROGRESS:398 titles "Sidebar group (audit
§8-13..16)" and calls §8-15 "Per-chat Share". Audit `:823` item 17 is list virtualization, PROGRESS:532
calls **§8-33** virtualization. Tails agree (34 extraction, 35 theme, 39 queue, 40 connector chip, 47
docs); the middle does not. → **cite `PROGRESS.md` commits, not audit numbers.** Confidence: high.

**0.2 — §8 "missing" is stale: 19 of its 47 items are in the code. Do not rebuild these.**

| §8 # | item | shipped where (read today) |
|---|---|---|
| 9 | search across message **bodies** | `components/chat/Sidebar.tsx:42` + `backend/src/routes/conversations.ts:55` ("Search conversation MESSAGE BODIES") |
| 13 | star/pin + per-chat share | `Sidebar.tsx:66,334` |
| 14 | "Show more" on long user messages | `MessageBubble.tsx:121` |
| 15 | scroll-to-bottom button + scroll-fight guard | `MessageList.tsx:75,98,103,110,309` (`atBottom`, 160px threshold) |
| 16 | web-search toggle + thinking toggle | `chat/page.tsx:48` (`'auto'\|'on'\|'off'`), `Composer.tsx:330`, reasoning stream `MessageList.tsx:214` |
| 17 | list virtualization | `docs/PROGRESS.md` Phases 2/3/4 (21/21 SHAs resolve, `team/PHASES.md` §E1) |
| 18 | iOS keyboard-aware composer | `chat/hooks.ts:68` (`window.visualViewport`), `globals.css:223`, test `responsive.test.tsx:30` — **pass 1 listed this as open; it ships** |
| 19 | 44px touch targets | `__tests__/responsive.test.tsx:60` |
| 20 | math / LaTeX | `Markdown.tsx:7,12` (rehype-katex + css) |
| 21 | mermaid renderer | `ArtifactViewers.tsx:75` `await import('mermaid')`, rendered `ArtifactsPanel.tsx:274` |
| 22 | PDF + spreadsheet in-panel | `ArtifactViewers.tsx:10 PdfView`, `:24 SheetView` |
| 23 | "Fix error" + "Building…" | `ArtifactsPanel.tsx:293`, `:101 buildingKinds` |
| 24 | live website preview (sandbox) | `ArtifactsPanel.tsx:59,300` (`srcDoc` + `withErrorBridge` + device widths) |
| 26 | live stdout/stderr for execute_code | `TurnActivity.tsx:247,317` |
| 28 | progress checklist per sub-agent task | `TurnActivity.tsx:239` |
| 29 | stream auto-resume on disconnect | `app/lib/stream.ts:168` ("ended WITHOUT a terminal event") |
| 31 | per-message feedback modal | `MessageBubble.tsx:67,241-257` |
| 32 | tablet layout | `chat/page.tsx:461,471` (backdrop below tablet; sidebar persistent from 768px) |
| 36 | settings tabs | `components/settings/` — Appearance, Memory, Personalization, Plugins, Skills, Tools, Connectors |
| 37/38 | PIP + poster/buffering on video | `VideoPlayer.tsx:4,12` |
| 39/40 | message queue, connectors chip | `chat/hooks.ts:379 useMessageQueue`, `:429 useWorkspaceConnections` |
| 42/44/45 | branching arrows, hands-free voice, server TTS | `docs/PROGRESS.md` Phases 2/3/4; `hooks.ts:500`; `backend/src/routes/tts.ts` |

**0.3 — mermaid is NOT a first-load cost (corrects the P1 anchor).** No static `mermaid` import exists
(`grep -rn "from 'mermaid'"` → 0 hits); the only reference is the dynamic import at
`ArtifactViewers.tsx:75`. The served `/chat` first-load set contains **no** ~692 kB chunk (largest live
chunk = 346,410 B raw, §3). `team/PERF_BASELINE.md`'s "loaded unconditionally on every /chat
first-load" is therefore suspect. `perf-eng` owns the verdict; it is one grep to settle.

**0.4 — ChatGPT retired Canvas (2026-05-28) — do not build a Canvas clone.** "canvas will no longer be
available in GPT-5.5 Instant or GPT-5.5 Thinking. Writing and coding functionality is now supported
directly in chat responses through writing blocks and code blocks."
Source: `https://help.openai.com/en/articles/6825453-chatgpt-release-notes`. **Confidence: medium** —
the page was fetched live 2026-09-27 but only its head (Sept 2026) entries rendered this pass; the May
entry is carried from pass 1. → Loop GPT's in-thread artifacts panel is *current*; the parity target is
in-thread document blocks + a Library.

---

## §1 — Frontier-side evidence base (fetched live 2026-09-27)

| ref | source | status of the fetch |
|---|---|---|
| **G** | `https://grok.com/release-notes` | **HTTP 200, full text read** — xAI's dated product changelog |
| **A** | `https://support.claude.com/en/articles/12138966-release-notes` | **fetched, full text** — latest entry Sept 15, 2026 ("Updated this week") |
| **A2** | `https://support.claude.com/en/articles/11817273-…chat-search-and-memory…` | fetched, read |
| **A3** | `https://support.claude.com/en/articles/17153992-what-are-artifacts…` | fetched, read |
| **O** | `https://help.openai.com/en/articles/6825453-chatgpt-release-notes` | fetched once (head entries, Sept 10 2026); **now behind Cloudflare** — a real browser hits "Just a moment…" and later extracts return a 2.8 kB stub |
| **O2** | `https://help.openai.com/en/articles/11752874` (ChatGPT agent) | indexed, not byte-fetched → `secondary` |

---

## §2 — THE ACCEPTED-PATTERN LIST (ranked)

Format: `pattern | frontier behaviour (source) | Loop GPT today (path) | exact gap | cost | rank`.

### A. PARITY — the frontier has it, we don't

| rank | pattern | frontier (source) | Loop GPT today | gap | cost |
|---|---|---|---|---|---|
| **1** | **First-paint skeletons** | Grok's Library "load[s] progressively"; their polish rounds repeatedly fix placeholder/resize flicker (**G**, Aug 29, 2026) | `grep -rn "Skeleton" frontend/app` → **0**; only `LoadingShim` inside the artifacts panel | skeleton rows for the conversation list + first turn, on the shipped `primitives.tsx`. **+0 JS** | **S** |
| **2** | **Offline banner + queued sends** | Grok fixes composer/offline edge cases every round (**G**) | the string exists and is **never rendered**: `app/lib/i18n.tsx:46`; `navigator.onLine` → **0 hits** | render it on `offline`; the per-message queue (`hooks.ts:379`) already holds sends | **S** |
| **3** | **At-capacity run that self-resumes** | "When Grok is at capacity you see a wait card that resumes on its own instead of a failed response." (**G**, Aug 29, 2026) | `grep -rn "429\|Retry-After\|retryAfter" frontend/app/lib frontend/app/chat/hooks.ts` → **0** | a "waiting, will resume" turn state + auto-continuation. **Contract**: 429 + `Retry-After` or an SSE `retry` event → `arch-lead` first | **M** |
| **4** | **Long-thread table of contents** | "Conversations longer than five responses can now include a table of contents, so you can scan sections and jump to the part you need." (**O**, Jun 2026 entry; head-only fetch — see §4) | **absent** (`grep -rniE 'table of contents\|outline\|\btoc\b'` → CSS `outline` only); virtualization already ships (`MessageList.tsx:6 useVirtualizer`) so anchors exist | a scroll-spy rail; no new dependency (anchors + IntersectionObserver) | **M** |
| **5** | **Undo for destructive chat actions** | "Deleting a chat shows an undo toast so you can bring it back." (**G**, Aug 29, 2026) | `Sidebar.tsx:218` — `confirm('Delete this session?')`; a `useToast` already ships (`chat/page.tsx:96`) | delete without a modal; toast with **Undo** | **S** |
| **6** | **Composer "Output" chooser (design / doc / deck)** | "Ask for a design, deck, or doc in any conversation, select 'Output' in the message box…" (**A3**) | `Composer.tsx` has web-search + thinking toggles and a connector chip; **no** output-kind selector | a third composer toggle seeding the run's output type; reuses existing toggle plumbing | **S** |
| **7** | **Reasoning *effort* levels, not a boolean** | Low/Medium/High/Extra-high, xhigh "for long-running coding and agentic tasks" (Claude extended-thinking help; pass-1 source `support.anthropic.com/en/articles/10574485`) | binary `thinking` (`Composer.tsx:28-29`, `:330`) | effort selector mapped to backend tiers. **Contract**: stream input carries effort, not a bool | **M** |
| **8** | **Model + effort controls inside voice** | "ChatGPT Voice can now use GPT-5.6 or GPT-6 Astra… Choose your model and reasoning effort using the same controls as text chat." (**O**, Sept 10, 2026) | voice mode (`hooks.ts:500`) has no model/effort surface; text chat has them | expose the same controls in voice (or state that voice inherits — then it is copy) | **S–M** |
| **9** | **Agent browser, live view, take-over** | ChatGPT agent can drive a browser and hand control back (**O2**, `secondary`) | **absent**: `backend/src/agent/tools/` = 16 tools, **no browser tool**; `/screenshot` only captures the *user's* screen (`Composer.tsx:136`) | browser tool + live-view artifact + "take over". **Contract + new artifact kind** | **L** |
| **10** | **A file Library browsable beside the conversation** | "review supported file previews beside the conversation and follow citations back to the source… keep Box, Dropbox and SharePoint files open beside the conversation" (**O**, Sept 10, 2026) | artifacts are conversation-scoped (`ArtifactsPanel.tsx`); no cross-chat index, no citation UI | Library view + citations. **Contract**: file index + citation metadata | **L** |

### B. TABLE-STAKES HYGIENE (nobody ships without it)

| # | pattern | evidence | today | cost |
|---|---|---|---|---|
| B1 | Palette breadth — Cmd+K searches chats/media too | Grok: "search (Cmd+K) has Chats and Media tabs" (**G**, Aug 29, 2026) | `CommandPalette.tsx:39` filters command labels only; chats live in the sidebar search | M |
| B2 | Doc hygiene | §8-47 | SUPERSEDED/stale refs in `docs/` | S |
| B3 | Legacy `neon-*` class cleanup | §8-46 | present per §8 | S |
| B4 | Multi-file edit queue for artifacts | "leave edit requests in several files before submitting" (**A3**) | absent (single focused artifact) | M |
| B5 | Memory topics + sensitive-topic gate | "Everything Claude remembers is listed under Topics… health or beliefs stay out of memory unless you include sensitive topics" (**A**, Aug 25, 2026) | per-item edit/delete ships (`MemoryTab.tsx:36,62`); no topics, no gate | M |
| B6 | WCAG AA contrast, full axe rule set | axe gate covers `critical` only (`tests/e2e/app.spec.ts:10-13`) | `qa-verify` owns | S |

**Contracts needed before a new surface lands (`arch-lead`):** #3 (retry/resume contract), #7 (effort on
the stream input), #9 (browser tool + artifact kind), #10 (file index + citation metadata).
Ranks 1, 2, 5, 6, 8 need **no** contract — pure UI on shipped APIs.

---

## §3 — The "fast and snappy" budget, measured against the frontier (2026-09-27)

Measured identically for both: take the `<script src>` set of the served page, then fetch each file with
`Accept-Encoding: gzip, br` and sum the wire bytes.

```
grep -oE 'src="[^"]+\.js[^"]*"' page.html | sed 's/src="//;s/"$//' | sort -u
curl -s -H 'Accept-Encoding: gzip, br' -m 20 "$url" -o f.bin; wc -c < f.bin   # per file, summed
```

| surface | scripts | JS wire bytes (gzip) | HTML wire bytes |
|---|---|---|---|
| `https://loop-gpt.cyou/chat/` | **18** | **551,075 B (~538 kB)** | 5,314 B |
| `https://grok.com/` | **104** | **2,495,586 B (~2,437 kB)** | 98,433 B (identity — no `Content-Encoding`) |

`claude.ai/` and `chatgpt.com/` return **403 to curl** (3,195 B / 4,419 B HTML, 0 script `src`) → their
bundles are **not measurable this way**: `UNVERIFIED`, do not cite a number for them.
Caveat, stated plainly: `grok.com/` is the app shell and preloads later-route chunks, so 2,437 kB is an
**upper bound**, not grok's `/chat` cost. Usable conclusion: **our route budget has headroom; the felt
slowness is not first-load bundle size.** Trade rule for P2: ranks 1–2 add ~0 JS; #4 needs no library;
#9/#10 must be lazy (`await import(...)`), as mermaid already is.

**Revision drift — RESOLVED at source level (probe run 2026-09-27 22:20 EDT, supersedes the paragraph
this replaces).** Live `/chat` and a build of HEAD both reference **18** chunks with **8 names
differing**; the 10 shared names are byte-identical (`8272-9d6c91afc980c56e.js` = 346,410 B in both).
Chunk-name equality is therefore *not* a staleness test. The decisive test is a **source marker**:

```
git log -1 --format=%h -- frontend/            # → d110e56 (newest frontend commit, in HEAD)
git show --unified=0 d110e56 -- frontend/ | grep -oE '"[A-Za-z][A-Za-z ,:!?—-]{12,60}"'
                                                # → "Server read-aloud voice"   (new literal, post-P0)
curl all 18 live chunk srcs; grep -rl "Server read-aloud voice" lv/
                                                # → lv/page-b2100450a5471ec3.js   (PRESENT live)
```

The literal added by the **newest frontend commit** is served live, and the `page` chunk that carries
it is a build of HEAD's `/chat` page. **So live's web build is not stale: the 8-name diff is a
build-env/hash delta (minifier identifier renaming + `NEXT_PUBLIC_*` literals), not missing code.**
Same conclusion as `team/PHASES.md` §6 (`014e366`), reached by a different probe. Corollary: the
"deployed" acceptance line must be read back with a **served marker**, not with a chunk-name diff —
`GET /api/version` → `200` `{"revision":"3a43db8…"}` (verified live 22:17 EDT, `Cache-Control:
no-store`) covers the **API** half; the **static/nginx half has no served revision marker** (no
`revision`/`commit`/40-hex string in the served `/chat/` HTML).

---

## §4 — UNVERIFIED this pass (do not quote as fact)

- **OpenAI release-notes page bytes**: fetched once (head, Sept 2026). The browser hits Cloudflare
  ("Just a moment…"); later `web_extract` calls return a 2.8 kB stub. The **Canvas (May 2026)** and
  **table-of-contents (Jun 2026)** quotes are carried from pass 1 / the search index — `secondary`.
- `support.claude.com/en/articles/11146994` (**Library in ChatGPT**) → HTTP error; #10 rests on **O**.
- `help.openai.com/en/articles/11909943` → thin FAQ; the effort/model-in-voice quote rests on **O**.
- `docs.x.ai` carries no primary page for DeepSearch/Think mechanics (pass 1) — third-party only.
- Browser support for STT/TTS (AUDIT §10-11) is still `NEEDS CONFIRMATION`; not re-litigated.

## §5 — Hand-off

`ui-visual`: build §2 ranks 1, 2, 4, 5, 6, 8 first — none needs a contract. `arch-lead`: four
contracts (#3, #7, #9, #10). `perf-eng`: §0.3 (mermaid) and §3 (the budget) are yours. `ops-release`:
§3's 8-of-18 diff is the read-back gate. `boss-bot`: §0.1 is worth one commit — re-number
`AUDIT_REPORT.md` §8 or publish a mapping table.
