# Connector Setup Guide (production-verified 2026-09-22)

Platform-managed connectors sign in with Loop GPT's registered OAuth apps.
Marketplace connectors connect with **your own OAuth app credentials** — you
create the app at the provider, paste its client ID/secret into the
Connectors → Marketplace dialog, and sign in. Every connected card exposes a
**Test connection** action and real agent tools.

## Platform OAuth (click Connect — no credentials needed)

**2026-10-05 fix:** platform connectors now ride the SIGN-IN flow's redirect
URI — the one registered in the provider console — instead of a dedicated
connector callback that had never been registered (every Google connector
connect died with `Error 400: redirect_uri_mismatch` before the consent
screen). Connector states are hex handles; login states are JWTs; the login
callback delegates connector states to the connector completion. Sign-in now
opens in a **centered popup** that posts the result back and closes itself.

| Connector | Redirect URI actually sent (== the sign-in flow's registered URI) |
|---|---|
| Google Drive / Gmail / Calendar / Sheets | `https://api.loop-gpt.cyou/api/auth/oauth/google/callback` |
| GitHub (token or OAuth) | `https://api.loop-gpt.cyou/api/auth/oauth/github/callback` |

> The Google client (`673922779423-…`) is shared across all four; the granted
> scopes differ per connector. Reconnect any time to re-consent. **If Google
> still shows `redirect_uri_mismatch`, the sign-in URI itself is missing from
> the Google Cloud client's authorized list — add the table row above (one
> registration now covers BOTH login and every Google connector).**

### Error 403: "has not completed the Google verification process"

Seen when the consent screen's **publishing status is Testing** and the
signed-in Google account is not an approved tester. The request passed the
redirect check — this is the consent screen's access list, not a code issue.

**Quick fix (still Testing mode):** OAuth consent screen → **Test users →
+ Add users** (e.g. `mundkhawaja1@gmail.com`) → Save. Effect is immediate.
Testing mode allows up to **100 test users**, and **refresh tokens expire
after 7 days** (weekly re-consent) — fine for trying it out today.

**The real fix — publish the app (no more manual user list):**

> **You do NOT have to add every user's email.** Move the consent screen's
> publishing status to **In production** (Audience page → **Publish app**).
> In production:
> - ANY user can connect — no manual list, no 403 tester gate.
> - The 7-day refresh-token expiry disappears (it is a Testing-mode rule).
> - Until verification completes, users see Google's **"unverified app"**
>   warning screen — they click **Advanced → Go to loop-gpt.cyou (unsafe)**
>   and continue. The app UI explains this step at the connect button.
> - Google caps an unverified app at **100 new users** total. Fine for a
>   beta; verification lifts it.

**Before publishing (console hygiene, 5 minutes):**
1. On the **OAuth consent screen** configuration, declare the exact scopes
   the app requests — a scope mismatch between the config and the request
   itself triggers the unverified screen.
   Our footprint: `gmail.readonly`, `gmail.send`, `drive.readonly`,
   `drive.file`, `calendar.events`, `calendar.readonly`, `spreadsheets`
   (+ GitHub `repo`, `read:user` — not Google-verified scopes).
2. Privacy policy URL: `https://loop-gpt.cyou/privacy` (live), homepage:
   `https://loop-gpt.cyou`, ToS: `https://loop-gpt.cyou/terms`.

**Full verification (removes the warning screen + the 100-user cap):**
1. Verify `loop-gpt.cyou` ownership in **Search Console** with an account
   that is a Project Owner of the OAuth project (Google blocks the request
   until this is done).
2. Submit verification from the consent screen (scope justifications).
3. Two of our scopes are **RESTRICTED** — `gmail.readonly` and
   `drive.readonly` (Gmail/Drive **read** access; every Gmail read scope is
   restricted; `gmail.send`, `drive.file`, `calendar.*`, `spreadsheets` are
   only sensitive). Restricted scopes require Google's full verification
   **plus a third-party security assessment (CASA)** — the costly, slow
   part. Options, in order of effort:
   - Accept CASA when the product goes public; or
   - Drop the restricted read scopes (Gmail becomes send-only via
     `gmail.send`; Drive becomes file-scoped via `drive.file`) — the app
     then uses only sensitive scopes and verification is CASA-free; or
   - If all users share one Google Workspace org, set the client's user
     type to **Internal** — no verification, no warning, no cap, but only
     org accounts can sign in (consumer @gmail.com accounts cannot).

Until the test user is added (or the app is published), the app handles the
rejection cleanly: Google redirects back with `error=access_denied`, the
popup reports it, and the Connectors UI shows *"The provider reported the
request was denied. Try again and approve the permissions."*

## Sign-in OAuth (login — separate from connectors)

| Provider | Redirect URI |
|---|---|
| Google sign-in | `https://api.loop-gpt.cyou/api/auth/oauth/google/callback` |
| GitHub sign-in | `https://api.loop-gpt.cyou/api/auth/oauth/github/callback` |

Verified live 2026-09-22: both initiation endpoints 302 to Google/GitHub with
signed state tokens. **One-time console step:** ensure the URIs above are in
the authorized redirect list of the Google Cloud OAuth client and the GitHub
App settings, then complete one consent per provider to finish verification.

## Marketplace (bring your own OAuth app)

All eight verified live 2026-09-22 (correct guidance + credential handling).
Create an app at the provider's console, add the redirect URI above, then
paste the client ID/secret into the Marketplace dialog.

| Provider | Developer console | Notes |
|---|---|---|
| **Figma** | figma.com/developers/api | Simplest smoke target. Scopes: `file_read`, `library_assets:read`, `project_reads`. |
| **Dropbox** | dropbox.com/developers/apps | Choose "Scoped access"; enable the Files APIs. |
| **Linear** | linear.app/settings/apps/new | Scopes `read`, `write`. App name visible to org members. |
| **Asana** | app.asana.com/0/my-apps | Create → OAuth 2 redirect URL as above. |
| **Zoom** | marketplace.zoom.us/develop/create | Choose "OAuth" app type, add scopes `meeting:read:list:admin`, `meeting:write:admin`, `user:read:admin`. |
| **Outlook** | Azure Portal → App registrations | **Entra specifics:** support "Accounts in any organizational directory and personal Microsoft accounts"; add the redirect URI as **Web** `https://loop-gpt.cyou/api/oauth-connector/callback`; under Certificates & secrets create a client secret; grant the Mail.Read / Mail.Send / Calendars.Read **delegated** scopes. `prompt=consent` is sent automatically. |
| **OneDrive** | Azure Portal (same app can serve both) | Add **delegated** `Files.Read`, `Files.ReadWrite.All`. Same Entra notes as Outlook. |
| **Salesforce** | Setup → App Manager → New Connected App | **Specifics:** set the Callback URL exactly as above; enable "Require Secret for Web Server Flow"; after creation click "Manage" → "Edit Policies" → relax IP restrictions (Relaxed IP ranges); OAuth scopes: full + refresh_token. Use a **Developer Edition** org for testing. The instance URL is captured automatically after consent. |

### What you get after connecting

- Live status on the card (connected account, last tested, Test / Disconnect).
- A generic authenticated `api_request` tool the agent can call (GET/POST any
  path on the provider's API base) — e.g. "list my Zoom meetings".
- Outlook/OneDrive use Microsoft Graph, so `/me/messages`, `/me/drive/recent`
  work out of the box.

## Key-based connectors (Notion, Slack, Stripe, GitLab, Jira, HubSpot, Sentry, Discord, Telegram, Airtable, Todoist, OpenWeather, SerpAPI)

Paste the API key — it is **validated against the provider before it is
saved** (a 401/403 rejects the key). Use Test connection any time to re-probe.
