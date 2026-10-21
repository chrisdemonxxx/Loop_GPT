# Troubleshooting

## Run fails immediately

Check the web error action. `payment_required` or `hard_quota` means the org is out of credits before any
new spend starts. `rate_limited` means a daily, token, sandbox, or egress limit was hit.

## Live stream disconnects

The web app retries run streams with backoff. If it keeps failing, refresh and open the run again. Operators
should check `/api/health`, the API logs, and the orchestrator or local run mode.

## Sandbox unavailable

Do not bypass sandbox isolation. Verify provider credentials, warm-pool capacity, network policy, and
metadata-block tests before retrying live customer traffic.

## Model unavailable

Verify router credentials and upstream health. Do not put model keys in the browser or sandbox.

## Preview does not load

Previews must go through the authenticated preview proxy. Raw sandbox ports should never be exposed.

## FAQ

### Does unrestricted mean unsafe?

No. It means open model choice and user code ownership. Sandbox isolation, egress control, abuse controls,
and confirmation gates remain mandatory.

### Can I self-host?

Yes. Start with [`self-hosting.md`](self-hosting.md), then run the go-live checklist.

### Is live infrastructure proven in this environment?

No. The code paths are built, but Docker/E2B, live model endpoints, Stripe, Fly deploy, OIDC, and TLS require
operator credentials and a first real deployment.
