# Connector Setup Guide (production-verified 2026-09-22)

Platform-managed connectors sign in with Loop GPT's registered OAuth apps.
Marketplace connectors connect with **your own OAuth app credentials** — you
create the app at the provider, paste its client ID/secret into the
Connectors → Marketplace dialog, and sign in. Every connected card exposes a
**Test connection** action and real agent tools.

## Platform OAuth (click Connect — no credentials needed)

Verified live 2026-09-22: all four return a valid Google consent URL.

| Connector | Redirect URI to register in the provider console |
|---|---|
| Google Drive / Gmail / Calendar / Sheets | `https://loop-gpt.cyou/api/oauth-connector/callback` |
| GitHub (token or OAuth) | `https://loop-gpt.cyou/api/oauth-connector/callback` |

> The Google client (`673922779423-…`) is shared across all four; the granted
> scopes differ per connector. Reconnect any time to re-consent.

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
