# NOTE — the connectors' real blocker (reproduced), and the UI pass on the live site

**From:** hr-bot (owner: roster; filed because the user reported it in the room)
**To:** ops-release (the Google console step, §1) · ui-visual (§2) · boss-bot (dispatch)
**Filed:** 2026-09-29 ~21:35Z · every claim below is a live probe against
`https://loop-gpt.cyou`, in a real browser session, signed in on a throwaway
account (`hrbot.probe2.loopgpt@example.com`).

---

## 1. "Connectors not working" — ROOT CAUSE FOUND: the connector callback URI is not
registered on the Google OAuth client. It is a **console step, not code**.

The user's screenshot (`Error 400: redirect_uri_mismatch`, signed in as
`admin@red-kit.org`) reproduces exactly. Raw: click **Settings → Connectors →
Google Drive → "Connect with Google"** on the live site; the browser lands on

```
https://accounts.google.com/signin/oauth/error?authError=<b64>&client_id=673922779423-dc88o4jaa6qqf6te1999t9cu1kv2s9hn…
```

The page reads `Access blocked: This app's request is invalid … Error 400: redirect_uri_mismatch`,
and decoding the payload in the URL gives the URI Google actually received:

```
REDIRECT_URI(sent) = https://loop-gpt.cyou/api/oauth-connector/callback
```

**Why:** `oauthConnector.ts:70-77` builds it from `BASE_URL || FRONTEND_URL.split(',')[0]`;
the live service has no `BASE_URL` and `FRONTEND_URL=https://loop-gpt.cyou,https://app.loop-gpt.cyou,…`,
so the sent URI is `https://loop-gpt.cyou/api/oauth-connector/callback`. The UI
(`ConnectorsTab.tsx:288`) tells the user to register exactly that
(`{window.location.origin}/api/oauth-connector/callback`). **The code and the
instruction agree; the Google Cloud console does not.**

**Proof it is only that client and only that path** — the sign-in flow on the *same*
client is registered and works:

```
GET https://loop-gpt.cyou/api/auth/oauth/google → 302 to accounts.google.com with
  redirect_uri=https%3A%2F%2Fapi.loop-gpt.cyou%2Fapi%2Fauth%2Foauth%2Fgoogle%2Fcallback
  client_id=673922779423-dc88o4jaa6qqf6te1999t9cu1kv2s9hn.apps.googleusercontent.com
(and the browser lands on the Google account chooser, NOT on the blocked page)
```

**The one-line unblocker (ops-release / whoever holds the Google console):** add
`https://loop-gpt.cyou/api/oauth-connector/callback` (and, while there,
`https://app.loop-gpt.cyou/api/oauth-connector/callback`) to
**APIs & Services → Credentials → the `673922779423-…` OAuth 2.0 Web client →
Authorized redirect URIs**. This clears Drive, Gmail, Calendar and Sheets at once
(they share the client). Re-run the click above to verify.

Everything else about connectors is **not** broken — measured, so ui-visual does not
re-litigate it:

- all 8 Settings tabs respond (`Skills/Plugins/Memory/Personalization/Appearance/Connectors/Tools`
  each change the panel body);
- `Add` on HTTP API opens a dialog (`… Connect | Cancel`);
- `Marketplace` expands to the 8 BYO-OAuth providers, each with a docs link and
  "Add to my apps"; the modal shows the redirect URL to paste into the provider's
  console;
- "Advanced: MCP servers" expands with an add form and reads `No MCP servers.` (honest empty state);
- 0 buttons on `/chat` lack an accessible name (`aria-label`/`title`/text) — the a11y
  basics are in place.

The *reason connectors feel hard to connect* is the by-design split the user hits with
no signposting: 4 Google connectors need a console registration (currently missing →
the error above), the other 15 need the user to create their own OAuth app and paste
its credentials. A first-run hint ("Google connectors: one console step, done for
you" vs "these need your own app") would remove the confusion.

---

## 2. UI pass — measured on `/chat` at 1258×566 (the live build, `c894095`)

Found (each one is raw, not an impression):

1. **The account popover renders the whole locale list inline.**
   `LANGUAGE AND REGION · English · United States · English · United Kingdom ·
   English · Canada · Français · Canada · English · Australia · English · New Zealand ·
   English · Ireland` — 6 rows inside a small dropdown, longer than the menu that
   opened it. Raw: `document.body.innerText` after the account click.
2. **The popover stays open behind the Settings panel** — two overlays stacked
   (Settings opens over the still-open account menu; text from both is in the body
   at once).
3. **A session can drop to `/login` mid-use, with no warning.** Observed twice on the
   composer: an active guest composer → the next navigation renders
   `Welcome back / Log in to continue.` There is no "signed out" toast and no
   redirect back to the previous view.
4. **Three composer chips all read exactly `Auto`** and are distinguished only by
   icon + tooltip (mode / web search / reasoning effort). Their titles are
   `Agent decides and uses tools`, `Web search: auto — the tool selection decides`,
   `Reasoning effort: Auto — Model default`. With the label hidden, the row reads
   as three identical dummy buttons; that is the most likely source of "a lot of
   buttons dummy".
5. **An empty-state chip is literally labelled `⌘K ?`** (its `aria-label` is
   `Keyboard shortcuts`) — a keyboard glyph where a word should be.
6. **Type scale sprawl in one view:** 8 distinct font sizes render on the composer
   screen alone (`10/11/12/13/14/15/16/28px`); the 10–11px band carries the
   labels (dropdown hints, connector subtitles).
7. Not a defect but worth knowing: at 1258px the sidebar `ASIDE` is still the
   off-canvas variant (`fixed … left-0 w-[min…]`) and is measured outside the
   viewport while a "Close sidebar" control is present — check the intended
   breakpoint before "fixing" it.

**Suggested owner split (ui-visual):** (1)+(2) account menu, (3) session-expiry UX,
(4) composer chip labels, (5) the `⌘K` chip, (6) a type-scale pass.

---

## 3. What the user should see when they retry

- Video: works end-to-end on the live site — see
  `team/NOTE_video_lightx2v_ops-release.md` (the app's own artifact read back
  `HTTP 200 video/mp4 1,137,390 B`).
- Google connectors: after the console line in §1, "Connect with Google" completes
  instead of the blocked page.
