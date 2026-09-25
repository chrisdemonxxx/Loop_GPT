# Operator task: browser-agent credentials & tokens collection (2026-09-26)

One-off prompt for an in-browser AI agent. Context: Loop GPT production
(https://loop-gpt.cyou) is mid production-readiness work; the operator needs
tokens and keys collected from an already-logged-in browser session.
Not committed secrets — instructions only.

---

## THE PROMPT (copy everything below this line into the browser agent)

You are an autonomous browser agent acting for the operator of **Loop GPT**, a
production web app at `https://loop-gpt.cyou`. Your job is to collect seven
specific values from web pages and present them in one copy-paste block at the
end. You do NOT need to understand the product. Follow the tasks in order —
do Task A first, because the values it collects expire.

**Already true, do not change it:** this browser is already logged into Gmail
(inbox of `chrisdemonxxx@gmail.com`) and into Railway (`railway.com`).
**You must create new accounts on exactly two sites: Sentry and PostHog.**
Do not sign up anywhere else. Do not touch Stripe.

---

### TASK A — Gmail: extract two tokens (do this FIRST; tokens expire in ~1 hour)

There are two recently delivered emails in the Gmail inbox, both sent to the
address `chrisdemonxxx+loopgpt-e2e@gmail.com` (Gmail delivers those to this
inbox) from `noreply@loop-gpt.cyou`:

1. An email with subject **"Verify your email"**.
2. An email with subject **"Reset your password to chrisdemonxxx+loopgpt-e2e@gmail.com"**.

Steps:
- Open Gmail. Search `from:noreply@loop-gpt.cyou` (or search `loop-gpt`).
- Open the **"Verify your email"** email. It contains a button/link pointing at
  `https://loop-gpt.cyou/verify/?token=...`.
- **DO NOT click the link.** Right-click / copy the link address (or inspect
  the button href). Extract the full URL. The `token` query parameter is a long
  hexadecimal string. Record it as `VERIFY_TOKEN`.
- Open the **"Reset your password"** email. Its button/link points at
  `https://loop-gpt.cyou/reset/?token=...`.
- **DO NOT click it, and DO NOT complete any reset form.** Copy the link
  address. Extract the `token` query parameter. Record it as `RESET_TOKEN`.
- If either email has not arrived, wait up to 5 minutes and refresh (they were
  confirmed delivered by the email provider already). Do not mark anything
  "clicked" or "verified" in any UI.

Sanity checks: both tokens are long hex strings (roughly 40–64 hex chars).
If a URL uses `&` after the token (other params), take only the `token=` value.

---

### TASK B — Railway: confirm the backups toggle and copy DATABASE_URL

You are already logged into Railway at `railway.com`.

**B1 — Daily backups confirmation:**
- Open the Railway project **`loop-gpt-owned-staging-20260917`**, environment
  **production** (it is the only project with this name; the services are
  `web`, `backend`, `postgres`, `searxng`, `cf-tunnel`).
- Click the **postgres** service. Open its **Volumes** section (may be under
  Settings → Volumes; the volume is named `candidate-postgres-data`).
- Look for a **Backups** section on the volume.
  - If Backups shows **ON** with a **Daily** schedule: record
    `BACKUPS_CONFIRMATION=ON, Daily` (note the exact schedule + any retention
    shown).
  - If it is OFF: **toggle it ON and select Daily**, save, then record
    `BACKUPS_CONFIRMATION=ON, Daily (agent enabled it)`.
- Optionally note whether the `backend` service's volume
  (`candidate-private-store`) has backups too. Report as
  `PRIVATE_STORE_BACKUPS=<on/off/unknown>`. Do not change it.

**B2 — DATABASE_URL:**
- On the same **postgres** service, open the **Variables** tab.
- Find the variable named `DATABASE_URL`. Its value may be hidden — use the
  reveal/show control to display it. Copy the ENTIRE value exactly. It starts
  with `postgres://` or `postgresql://` and contains a host, username,
  password, and database name. Record it as `DATABASE_URL`.
- Do NOT edit, delete, or "raw-editor" anything in Railway. This is read-only
  except the backups toggle in B1 (only if it was OFF).

---

### TASK C — Sentry: sign up and create TWO projects (new account)

Sentry is error tracking. We need two DSNs (they look like
`https://something@oXXXX.ingest.sentry.io/NNN`).

1. Go to `https://sentry.io` → **Sign up**.
2. Choose **Continue with Google** and use the already-logged-in Google
   account (`chrisdemonxxx@gmail.com`). If asked for a verification email,
   the inbox you already have access to will receive it — open it and confirm
   through the link if required.
3. If asked to create an **organization**, name it `Loop GPT`. Region: choose
   the default. Plan: **Free/Developer** (do not start a paid trial unless it
   is the only option; if a card is demanded, STOP and note it).
4. Create project #1:
   - Platform: **Node.js**. Name: `loop-gpt-backend`. Create.
   - Sentry shows a **DSN** in the setup instructions. Copy it.
     (If you missed it: Settings → Projects → loop-gpt-backend → Client Keys
     (DSN).) Record as `SENTRY_DSN_BACKEND`.
   - Do NOT install any SDK, do NOT run any command it suggests. You already
     have what you need.
5. Create project #2:
   - From Projects → **Create Project**. Platform: **Next.js** (if not
     offered, choose **JavaScript**). Name: `loop-gpt-web`.
   - Copy its DSN the same way. Record as `SENTRY_DSN_WEB`.

If Sentry shows CAPTCHA or bot checks, pause and ask the operator to solve
them, then continue.

---

### TASK D — PostHog: sign up and copy the project API key (new account)

PostHog is product analytics. We need one API key (starts with `phc_`).

1. Go to `https://posthog.com` → **Get started** (sign up).
2. Choose **Continue with Google** using the same Google account. Confirm any
   verification email from the Gmail inbox if asked.
3. Organization name: `Loop GPT`. Project name: `loop-gpt`.
4. The onboarding asks what you're integrating with — choose **JavaScript**
   (or skip the questionnaire). Do NOT install anything; you only need the key.
5. Copy the **Project API key** (from the onboarding snippet or
   Settings → Project → API key). It starts with `phc_`.
   Record as `POSTHOG_KEY`.
6. Note the ingestion **host** used in their code snippet — it appears as
   `https://us.i.posthog.com` (US) or `https://eu.i.posthog.com` (EU).
   Record as `POSTHOG_HOST`. If unclear, record
   `POSTHOG_HOST=https://us.i.posthog.com` (the default when signup region is
   US).

---

### RULES (read before acting)

1. **Never click the `/verify/` or `/reset/` links in Gmail.** They are
   one-time action tokens; another automation will consume them via API.
   Clicking would ruin the evidence trail.
2. **Never modify anything in Railway** except turning the volume backups
   toggle ON (Daily) if it is OFF. Do not deploy, restage, or edit variables.
3. **Never post/email these values anywhere** (no pastebin, no chat apps, no
   "share" buttons). Display them only in your final answer to the operator.
4. **Do not sign up for any site other than Sentry and PostHog.** In
   particular: no Stripe, no UptimeRobot, no Resend.
5. If you hit a CAPTCHA, 2FA prompt, consent screen, or payment wall: pause,
   tell the operator exactly what is blocking, resume after they resolve it.
6. If a value fails its sanity check below, re-derive it rather than guessing.
   If you truly cannot get one, record it as `NOT_FOUND: <reason>`.

Sanity checks:
- `VERIFY_TOKEN`, `RESET_TOKEN`: long hex strings from the two email links.
- `DATABASE_URL`: starts `postgres://` or `postgresql://`, contains `@` and
  `:5432`.
- `SENTRY_DSN_BACKEND`, `SENTRY_DSN_WEB`: start `https://`, contain `@`, end
  with a numeric project id.
- `POSTHOG_KEY`: starts `phc_`.
- `POSTHOG_HOST`: starts `https://`.

---

### FINAL OUTPUT (exact format, single fenced block, nothing else after it)

```
VERIFY_TOKEN=<hex token from the /verify/ link>
RESET_TOKEN=<hex token from the /reset/ link>
DATABASE_URL=<full postgres connection string>
BACKUPS_CONFIRMATION=<ON, Daily | OFF (could not change) | details>
PRIVATE_STORE_BACKUPS=<on|off|unknown>
SENTRY_DSN_BACKEND=<Node.js project DSN>
SENTRY_DSN_WEB=<Next.js/JS project DSN>
POSTHOG_KEY=<phc_...>
POSTHOG_HOST=<https://us.i.posthog.com or eu>
SENTRY_ACCOUNT_EMAIL=<the email the Sentry account uses>
POSTHOG_ACCOUNT_EMAIL=<the email the PostHog account uses>
```

After the block, add one line per anomaly you encountered (nothing found,
unexpected screens, toggles you changed). Then stop.
