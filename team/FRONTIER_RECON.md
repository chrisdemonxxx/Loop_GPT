# FRONTIER RECON — external ground truth for P2 (owner: research-scout)

Time: 2026-09-27. Repo HEAD at write time: `ae30ded`, tree clean.
Method: read the code first (`frontend/app/**`), then the ledger (`docs/PROGRESS.md`,
`AUDIT_REPORT.md` §8/§10, `docs/GAP_REGISTER.md`), then fetch the frontier claim from a primary
source. **Every line below carries its source and a confidence.** Anything I could not fetch from a
primary page is marked `UNVERIFIED` or `secondary`.

Source hashes read this pass:
`AUDIT_REPORT.md` sha256 `ae1160b6a10df...c80fc`; `docs/PROGRESS.md` sha256 `d161587461b5e...ee42`.

---

## §0 — Corrections to the brief before anything is built (read these first)

**0.1 — The audit's §8 "missing" list is stale; four items it still lists are in the code.**
`AUDIT_REPORT.md:829` lists "Fix error + Building state" as missing, but `Fix error` is a live
button at `frontend/app/components/chat/ArtifactsPanel.tsx:293` (error bridge
`ArtifactViewers.tsx:105-108`, tests `__tests__/ArtifactsPanel.test.tsx:68-81`). Likewise
audit `:813` "full-screen artifact view + device-size toggle" — both ship:
`ArtifactsPanel.tsx:219` (fullscreen) and `:307` + `ArtifactViewers.tsx:119` (`DEVICE_WIDTH`).
Audit `:828` "PDF + spreadsheet in-panel viewer" → `ArtifactViewers.tsx:23` (SheetJS) and
`PdfView`. **Confidence: high** (read the files). → P2 must not re-propose these.

**0.2 — `AUDIT_REPORT.md` §8 numbering ≠ `docs/PROGRESS.md` "§8-N" numbering. They disagree.**
Audit `:821` item 15 is "Floating Scroll-to-bottom button"; PROGRESS:398 titles
"Sidebar group (audit §8-13..16)" and calls §8-15 "Per-chat Share". Audit `:823` item 17 is
list virtualization, but PROGRESS:532 calls **§8-33** virtualization. Audit `:839` item 33 is
"Visual revoke UX". The tails agree (34 extraction, 35 theme, 39 queue, 40 connector chip, 47
docs) — the middle does not. **A "§8-N shipped" line cannot be cross-checked between the two
documents.** Confidence: high (both files read). → P2 cites `PROGRESS.md` commits, not audit
numbers, or we re-number the audit once.

**0.3 — ChatGPT *retired* Canvas (2026-05-28); do not build a Canvas clone.** The release note
text: "canvas will no longer be available in GPT-5.5 Instant or GPT-5.5 Thinking. Writing and
coding functionality is now supported directly in chat responses through writing blocks and code
blocks." Source: `https://help.openai.com/en/articles/6825453-chatgpt-release-notes` (retrieved
via search index; direct fetch returned 403 from the keyless extractor). Corroborated by three
secondaries, incl. `https://cloudspress.com/openai-launches-new-canvas-chatgpt-interface-tailored-to-writing-and-coding-projects`.
**Confidence: medium-high** (primary text quoted from the release-notes index page; primary page
itself not byte-verified this pass — see §4). → Loop GPT's in-thread artifacts panel is
*current*, not behind; the parity target moved to in-thread document blocks + a Library.

---

## §1 — Patterns the frontier ships that Loop GPT does not (ranked by felt experience)

Format: pattern | what the frontier does (source) | Loop GPT today (path) | gap | cost | rank.

1. **Long-conversation table of contents.** ChatGPT: "Conversations longer than five responses
   can now include a table of contents, so you can scan sections and jump to the part you need."
   Source: `help.openai.com/en/articles/6825453-chatgpt-release-notes` (Jun 2026 entry).
   Confidence: high on the quote, primary page not byte-fetched. Loop GPT: **absent** —
   `grep -riE 'table of contents|outline|toc' app --include=*.tsx` → no product match
   (`frontend/app`). Gap: a scroll-spy rail for long threads. Cost **M**. Rank **1** — this is
   the "fast and snappy" felt win on a 50-turn chat, and we already virtualize
   (`MessageList.tsx:6` `useVirtualizer`), so the anchor data exists.
2. **A Library / saved-document home.** ChatGPT: "You can save your document to the Library, so
   you can find, reuse, or edit documents later." Same source. Loop GPT: artifacts are
   conversation-scoped only (`ArtifactsPanel.tsx`); no cross-chat document index. Gap: a
   `/library` view over existing artifact rows. Cost **M**. Rank **2**. **Needs a contract?**
   No new table if `File`/artifact rows already carry owner+name — `arch-lead` to confirm.
3. **Composer "Output" chooser (design / doc / deck).** Claude: "Ask for a design, deck, or doc
   in any conversation, select 'Output' in the message box and choose one, or pick a template
   in the **Artifacts** tab." Source:
   `https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them`
   (primary, fetched). Loop GPT: composer has a web-search + thinking toggle
   (`Composer.tsx:25-29,72`) and a connector chip row (`Composer.tsx:255`, audit §8-40); no
   output-kind selector. Gap: a third composer toggle that seeds the run's output type. Cost
   **S**. Rank **3** — cheapest visible parity, reuses the existing toggle plumbing.
4. **Reasoning *effort* levels, not just on/off.** Claude: Low / Medium / High / Extra high,
   with xhigh "designed for long-running coding and agentic tasks". Source:
   `https://support.anthropic.com/en/articles/10574485-using-extended-thinking` (primary,
   fetched). Loop GPT: a binary `thinking` toggle (`Composer.tsx:28-29`). Gap: an effort
   selector mapped to backend tiers. Cost **M**. Rank **4**. **Needs a contract?** Yes — the
   stream input must carry effort, not a boolean; `arch-lead` sign-off.
5. **Visible research trace with a "Thoughts" view.** Grok exposes Think/DeepSearch as composer
   toggles with a "Thoughts" panel of the intermediate steps and a hard 10-step search cap.
   Source: `https://suprmind.ai/hub/grok/features` (**secondary**; xAI's own docs are thin —
   `docs.x.ai` carries no feature page for these) and `https://deepwiki.com/xai-org/grok-prompts/5.3-deepsearch-and-think-modes`.
   Confidence: medium. Loop GPT: `deepResearch.ts` 5-phase fleet (GAP_REGISTER GAP-017,
   **Partial**); stream resume ships (`PROGRESS.md:491`). Gap: a step budget surfaced in the UI.
   Cost **S**. Rank **5**.
6. **In-chat email send.** ChatGPT (Jun 2026): "connected Gmail or Outlook accounts can be used
   to draft and send email from the same conversation." Source:
   `https://vmts.com.hk/en/insights/openai-chatgpt-app-workflow-updates-2026-en/` (**secondary**),
   consistent with the release-notes index. Loop GPT: Gmail/Outlook connectors exist
   (GAP-013); send-as-a-tool is not asserted anywhere I read. Gap: `send_email` tool. Cost
   **S-M**. Rank **6**. Confidence on our side: medium (connector adapter read not done).

## §2 — Table stakes hygiene still open (nobody ships without it)

7. **Offline detection + banner.** Audit `:811` lists it; the only trace in code is the string
   `app/lib/i18n.tsx:46` ("You are offline…") — **no `navigator.onLine` / event listener**
   (`grep -rniE 'navigator.onLine|Offline' app --include=*.tsx` → only the settings copy and
   the i18n string). Cost **S**. Confidence: high.
8. **iOS keyboard-aware composer** (`visualViewport.resize`). Audit `:824`. `grep -rn
   'visualViewport' app` → **no match**. Cost **S**. Confidence: high. Rank above most §1
   items *for mobile users* — the composer can be covered by the keyboard today.
9. **44 px touch targets.** Audit `:825` says many controls are 28-32 px. Not re-measured this
   pass — `UNVERIFIED` at HEAD.
10. **WCAG AA contrast + full axe gate.** The axe run covers `critical` only
    (`frontend/tests/e2e/app.spec.ts:10-13`, per the P1 kickoff). Frontier hygiene = the AA
    rule set. Cost **S**. Confidence: high (file cited by the kickoff; not re-read).

## §3 — First-load trade (the budget these must fit in)

Anchor from `team/PERF_BASELINE.md`: `/chat` first-load is 505 kB JS, with mermaid
~2.5 MB raw / ~692 kB gzip loaded **unconditionally**. Ranks 1-6 above add DOM + small state,
not bundles — with one exception: a TOC rail needs no library (anchors + IntersectionObserver).
Anything that pulls a markdown/TOC dependency must name what it evicts. Live `/chat/` currently
serves **18** unique chunk names (my probe: `curl -s https://loop-gpt.cyou/chat/ | grep -oE
'_next/static/chunks/[A-Za-z0-9_./-]+\.js' | sort -u | wc -l` → `18`), matching
`team/P1_FINDINGS.md` F1 — so the deploy gap is unchanged as of this pass.

## §4 — UNVERIFIED this pass (do not quote as fact)

- OpenAI release-notes **page bytes**: `web_extract` on
  `help.openai.com/en/articles/6825453-chatgpt-release-notes` → `Keyless Firecrawl extract
  failed: 403`. All OpenAI claims here come from the search index's rendering of that URL.
- Claude **"Publish and share artifacts"** article (`support.claude.com/en/articles/9547008`) →
  same 403; the artifact-share behaviour is confirmed only by the fetched `9487310` page.
- Grok tier/feature matrix (`suprmind.ai`) is third-party and self-labels tier limits "Volatile".
- `docs.x.ai` carries no primary page for DeepSearch/Think mechanics that I found — the 10-step
  cap and the "Thoughts" toggle are **secondary-sourced**.
- The 44 px touch-target count and the AA contrast failures are audit-era claims, not re-measured
  at HEAD.

## §5 — Hand-off

- `ui-visual`: ranks 1, 3, 5 are buildable with no contract; 4 needs `arch-lead` first.
- `arch-lead`: one decision needed — effort levels on the stream contract (§1.4) and whether
  Library (§1.2) can read existing artifact rows.
- `boss-bot`: §0.2 is a doc-hygiene fix worth one commit — re-number `AUDIT_REPORT.md` §8 or
  add a mapping table, so "§8-N shipped" is checkable.
