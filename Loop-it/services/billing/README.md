# loopit-billing

`loopit-billing` owns credits, metering, plan limits, and Stripe mirroring. The
append-only `packages/store` `quota_ledger` remains the billing source of truth;
Stripe only reflects paid plan state.

## Ledger model

Every mutation writes a `QuotaEntry` and an audit event (`billing.ledger.mutated`
or `billing.reservation.denied`) for invariant I10.

- `credit`: grants credits from plan changes, invoice payments, or manual ops.
- `debit`: charges inference tokens, sandbox-seconds, storage, always-on
  hosting seconds, custom-domain months, or domain registration pass-throughs.
- `reservation`: pre-spend hold made by `check_and_reserve`.
- `release` + `debit`: settlement releases the estimate and charges actual cost.

All public write paths require an idempotency key. Retrying the same meter event,
Stripe event, or settlement returns the original ledger effect instead of double
charging. Balance is monotonic over the append-only stream: credits/releases add,
reservations/debits/settlements subtract. Reconciliation scans the stream for
duplicate IDs and points where balance went negative.

## Price table

Defaults follow PLAN.md §9: inference cost is token volume times price, cached
prompt tokens are discounted, sandbox cost is seconds by sandbox size, always-on
hosting is charged per second because VPS slices remain allocated while idle,
and the north-star metric is:

```text
cost_per_successful_deploy = (inference_$ + sandbox_$ + backend_$) / successful_deploys
```

Override prices with `LOOPIT_BILLING_PRICE_TABLE_JSON`:

```json
{
  "default_input_per_1k": "0.0006",
  "default_output_per_1k": "0.0024",
  "model_input_per_1k": {"loopit/coder": "0.0006"},
  "model_output_per_1k": {"loopit/coder": "0.0024"},
  "sandbox_second_by_size": {"small": "0.000006", "medium": "0.000012", "large": "0.000024"},
  "hosting_second_by_size": {"small": "0.00000278", "medium": "0.00000556", "large": "0.00001112"},
  "storage_gb_month": "0.10",
  "custom_domain_month": "0.25",
  "domain_registration_margin_fraction": "0.15",
  "stripe_meter_price_ids": {
    "hosting_seconds": "price_hosting_meter",
    "custom_domain_months": "price_custom_domain_meter"
  }
}
```

Router events should send tokens in/out, cached prompt tokens, model, and
provider cost when already computed. Scheduler events should send lease
lifetimes as `sandbox_seconds` and sandbox `size`.

Deployer and domains services must reserve before side effects with
`POST /v1/billing/reservations` using `X-Loopit-Service-Token`; end-user
identity tokens are not accepted on that endpoint, and callers must not submit a
usage snapshot. Billing derives current usage from its own ledger. Send
`tenant_id` plus `quota_request.always_on_apps=1` before pinning a resident
always-on deployment, `quota_request.custom_domains=1` before attaching a custom
domain, and `quota_request.hosting_egress_bytes` before allowing hosted-app
egress. Free tenants have `max_always_on_apps=0`, but still get an
auto-subdomain preview with `max_hosting_egress_bytes_per_day=250_000_000` and
`hosting_idle_timeout_seconds=900`; deployer/app-proxy still need to implement
idle suspension, stop sending `hosting_seconds` while suspended, and show a
friendly upgrade page when billing returns
`hosting_egress_bytes_per_day quota exceeded`. Exhausting egress only blocks
traffic for the day; it must not delete project data. Meter runtime with
`kind=hosting_seconds`, attached custom domains with `kind=custom_domain_months`,
and purchased domains with `kind=domain_registration` plus the registrar
pass-through cost.

## Stripe setup

Set `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, and
`STRIPE_CANCEL_URL`. Map plan names to Stripe price IDs in deployment config
when constructing `Plan` definitions. The service lazily imports `stripe` only
when creating checkout sessions, so health checks and non-Stripe billing flows
run without Stripe configured.

Configure Stripe to POST `/stripe/webhook`. The endpoint is unauthenticated but
requires Stripe signature verification and handles:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Webhook payloads are never trusted without a valid `Stripe-Signature`; card data
and secrets must not be logged.

`stripe_meter_price_ids` wires recurring hosting/domain meters to Stripe price
IDs for deployment config. Purchased domains are intentionally not a fixed
Stripe price: `domain_registration` is priced from the registrar cost plus the
configured margin in the credit ledger. A future registrar checkout flow should
create a one-off Stripe line item from that computed amount rather than reuse a
subscription meter.

Domain purchase callers must reserve credits before contacting the registrar and
reuse one stable purchase idempotency key for the reservation, registrar call,
and `domain_registration` meter write. If a retry happens after the registrar
succeeds, the caller must reconcile the existing purchase before attempting a new
registrar call; billing's reservation and meter writes are idempotent under that
key, but billing cannot make an external registrar side effect idempotent by
itself.
