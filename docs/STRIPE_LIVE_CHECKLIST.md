# Stripe — Dormant by Decision (Option B), and the Go-Live Checklist

**Decision (2026-09-22):** Loop GPT launches **free-only**. Stripe checkout is
**intentionally disabled** (`STRIPE_CHECKOUT_ENABLED=false`,
`STRIPE_FULFILLMENT_ENABLED=false` in the production environment). The checkout
ingress **fails closed** (`routes/billing.ts` returns 503 unless
`stripeEnabled()`), `GET /api/billing/config` reports `enabled:false`, and the
UI is honest about it:

- Landing page pricing says **"Free during launch"** — the Pro card shows a
  "Soon" price with a waitlist CTA, not a purchasable $15/mo plan.
- Account page hides the Upgrade button unless `billing.enabled && plans.pro`
  (already gated; shows a plain "See plans" link otherwise).

The plumbing is complete (`services/stripe.ts`, webhook with raw-body signature
verification at `POST /api/billing/webhook`, fulfillment via
`services/paymentFulfillment.ts`, `User.stripeCustomerId`/`stripeSubId`).
Going live is an environment change plus a test purchase — nothing to build.

## Go-Live Checklist (Option A, ~15 minutes)

1. Stripe Dashboard → create/reuse the **Pro** recurring price → copy `price_...`
   to `STRIPE_PRICE_PRO`. Optionally a Gold price → `STRIPE_PRICE_GOLD`.
2. Set environment variables on the Railway `backend` service (production):
   ```
   STRIPE_SECRET_KEY=sk_live_...            (sk_test_... while smoke-testing)
   STRIPE_WEBHOOK_SECRET=whsec_...           (from step 3)
   STRIPE_MODE=live                          (or "test" during the smoke test)
   STRIPE_PRICE_PRO=price_...
   STRIPE_PUBLISHABLE_KEY=pk_live_...        (only used when enabled)
   STRIPE_CHECKOUT_ENABLED=true
   STRIPE_FULFILLMENT_ENABLED=true
   ```
3. Stripe Dashboard → Developers → Webhooks → add endpoint
   `https://loop-gpt.cyou/api/billing/webhook` with events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed` — copy the signing
   secret into `STRIPE_WEBHOOK_SECRET`.
4. Redeploy backend (env change triggers it automatically).
5. Smoke test: sign in → Account → Upgrade → complete a **test-mode** purchase
   (or a 1-cent live price) → confirm:
   - the webhook arrives (`railway logs` shows the fulfillment line),
   - `User.plan` flips to `pro`, `stripeCustomerId`/`stripeSubId` populate,
   - credits reflect pro limits on the next request,
   - Account page shows the upgraded plan.
6. Flip `STRIPE_MODE=live` with live keys and run one low-value real charge.
7. Update the landing page pricing copy (restore purchasable plans) and this
   file.

## Rollback

Set `STRIPE_CHECKOUT_ENABLED=false` — checkout 503s, config reports disabled,
UI hides the Upgrade button automatically. No code changes needed.
