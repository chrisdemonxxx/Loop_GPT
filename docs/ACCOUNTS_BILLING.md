# Accounts, Billing, Vouchers & Admin Portal

Multi-user SaaS layer for Loop GPT: real auth (password + OAuth), credit
metering, redeemable vouchers (incl. T1 Gold team tier), transactional email,
and an admin backend portal with realtime stats.

Everything degrades gracefully without a database (local/dev runs as an
unlimited guest); the full system activates when `DATABASE_URL` (Postgres) is set.

## Plans & credit metering

| Plan | Message credits/day | Image credits/day | Notes |
|------|--------------------:|------------------:|-------|
| free | 30 | 5 | default on signup |
| pro  | 1,000 | 100 | paid individual |
| **gold (T1)** | **5,000** | **500** | team members — max usage, still capped |
| `unlimited` flag | ∞ | ∞ | internal/admins only |

- Credits reset on a rolling 24h window per user.
- Costs: chat/agent = 1, deep research = 3, image = 2 (image credits).
- Admins and `unlimited` users bypass all limits.
- Metering is applied in the streaming route: the turn is blocked up-front with
  `402 OUT_OF_CREDITS` when out of credits, and usage is recorded after the run
  (`UsageEvent` rows + lifetime counters), with token counts estimated (~4
  chars/token) since the endpoint doesn't return usage.

## Vouchers

Admins generate codes in the portal (or `POST /api/admin/vouchers`):

- **gold** — upgrades the user to the T1 Gold plan (capped-max) and refills to
  the gold daily allowance. Codes look like `GOLD-XXXXX-XXXXX`.
- **pro** — upgrades to Pro.
- **unlimited** — flips the true-unlimited flag (internal use).
- **credits** — one-off top-up of message/image credits.

Each voucher has `maxRedemptions` and one-redemption-per-user enforcement.
Users redeem in **Account → Redeem a voucher** (`POST /api/account/redeem`).

## OAuth sign-in (Google / GitHub / Apple)

Buttons appear on the login page only for providers whose credentials are set
(`GET /api/auth/providers` drives this). Flow:

1. `GET /api/auth/oauth/:provider` → redirects to the provider.
2. Provider redirects back to `/api/auth/oauth/:provider/callback` (Apple posts
   a form), which exchanges the code, upserts the user, issues a JWT, and
   redirects to `FRONTEND_URL/login?token=...`.
3. The login page consumes the token and routes to `/chat` (or `/admin`).

Set the credentials in env (`GOOGLE_*`, `GITHUB_*`, `APPLE_*`). Apple needs a
Services ID plus a Sign-in-with-Apple key (`.p8` contents in `APPLE_PRIVATE_KEY`,
newlines as `\n`). Set `OAUTH_CALLBACK_BASE` to the public backend URL in prod.

## Email (SMTP)

Transactional email via nodemailer, env-gated (`SMTP_HOST` etc.). No-op (logged)
when unset. Sends: welcome (signup / first OAuth), voucher-redeemed, and generic
alerts. Inbound mail: point an inbound provider (SES/Mailgun/Postmark route) at
`POST /api/mail/inbound` (guard with `MAIL_INBOUND_SECRET`); it logs and, if
`SUPPORT_EMAIL` is set, forwards a copy.

## Admin portal (`/admin`)

Admin-only (first registered user, or `ADMIN_EMAIL`, becomes admin). Realtime
via 5s polling. Surfaces:

- **Stats** — users (+24h), token totals & 24h, actions, revenue, plan mix.
- **Users** — search, tokens/credits/messages, one-click Gold / unlimited / admin.
- **Usage** — live cross-user activity feed.
- **Vouchers** — generate (default T1 Gold), list, activate/deactivate.
- **Payments** — recorded payments (`POST /api/admin/payments` to add manually).

### Key endpoints

```
GET   /api/account/me            profile + credits + usage
GET   /api/account/usage         own recent events
POST  /api/account/redeem        { code }
GET   /api/auth/providers        enabled OAuth providers
GET   /api/admin/stats           headline stats (admin)
GET   /api/admin/timeseries      hourly usage buckets (admin)
GET   /api/admin/users           paginated users (admin)
PATCH /api/admin/users/:id       role/plan/unlimited/credits (admin)
GET   /api/admin/usage           cross-user feed (admin)
GET   /api/admin/vouchers        list (admin)
POST  /api/admin/vouchers        create (admin)
PATCH /api/admin/vouchers/:id    toggle active (admin)
GET   /api/admin/payments        list (admin)
```
