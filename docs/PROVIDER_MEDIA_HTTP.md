# Provider, embedding and media transport (03i)

**03j follow-up:** `ACCOUNTING.md` supersedes this checkpoint's billing and retry
notes. Reviewed synchronous paths reserve before dispatch; uncertain image POSTs
no longer retry automatically. Async-video creation and startup legacy-job
resumption are disabled until durable job-linked settlement exists. Transport
policies below still apply; whole-product production readiness is not claimed.

`backend/src/services/providerHttp.ts` provides a bounded buffered transport for
independent provider calls. It is separate from the streaming model SDK guard
(`MODEL_HTTP.md`) and web/connector transport (`PUBLIC_HTTP.md`). The isolated
sidecar entry point deliberately has a different destination policy.

## Public provider requests

- Absolute public HTTPS only, standard port, maximum URL length 8,192. Reject
  userinfo, fragments, whitespace/control characters and backslashes. Signed
  query URLs are supported; returned media links are still untrusted destinations.
- Fresh all-answer public DNS validation, one pinned address per request, original
  Host/SNI and certificate validation. Empty, mixed or private answers are rejected.
  No global/keepalive agent or ambient proxy fallback.
- GET, HEAD and POST only. Bodies are string or Buffer; string bodies must be JSON.
  Credentials are limited to Bearer Authorization and x-api-key with an explicit
  exact `allowedOrigins` match. Cookie, Host, proxy and framing overrides fail.
- Redirects are never followed, including same-origin redirects. Non-2xx bodies
  are discarded. `ProviderHttpError` exposes a generic message, a bounded internal
  code and optional status for explicitly implemented retry logic, not raw errors.
- Identity encoding only, no decompression. Invalid/conflicting Content-Length
  and Transfer-Encoding, premature closure and incremental overflow fail closed.
- DNS, connection, headers and complete body share one deadline. Cancellation,
  timeout and failure destroy requests, response streams and agents. Late DNS or
  response callbacks cannot reopen a cancelled request.
- Response bytes accumulate in at most 64 KiB blocks, bounding object overhead for
  tiny chunks. Final concatenation/JSON parsing can temporarily duplicate memory;
  this is not a strict process-memory or CPU limit.

| Limit | Default | Ceiling |
| --- | --- | --- |
| Request body | 32 MiB | 32 MiB |
| Response body | 8 MiB | 96 MiB |
| Headers in each direction | 16 KiB | 16 KiB |
| Whole-request deadline | 120 seconds | 30 minutes |

Callers apply narrower budgets. OS DNS itself and synchronous JSON processing
cannot be preempted; late results cannot dispatch. Limits exclude TCP/TLS framing.

## Isolated operator sidecar

`sidecarRequest` accepts only `/health`, `/api/generate`, `/api/analyze` and
`/api/vision-chat`, appended to operator `IMAGE_API_URL` (default
`http://localhost:8081`). A configured base path/port is preserved. Client-selected
URLs, URL credentials, queries, fragments, percent escapes and dot segments in
the base are not supported. Credential headers are prohibited.

HTTP sidecars must resolve solely to loopback, RFC1918 IPv4 or permitted private
IPv6 addresses. HTTPS additionally permits public addresses. Link-local/metadata,
mapped/special addresses and mixed prohibited answers are rejected. Resolution
is checked/pinned on every request with the same byte/deadline/redirect rules.
This is an explicit operator-owned service exception, not an internal-network
fetch API. Deployment egress rules must still restrict which sidecar is reachable.

## Migrated consumers and compatibility

- **Embeddings:** fixed HF inference destination and explicit credential origin;
  8 MiB response bound. Existing single/batch and mean-pooling formats retained.
  HTTP disconnects cancel the provider lifecycle.
- **v1 image generation:** operator endpoint, bounded raw/base64 response handling,
  16 MiB response cap, one 240-second deadline and 30-attempt budget across the
  entire batch. Only 502/503/504 provider responses are retried; aborts do not retry.
- **Independent chat clients:** compatible providers use guarded `createClient`
  via lazy import; Anthropic uses its fixed `/v1/messages` destination through
  `providerRequest`. Local/Ollama inference is disabled, not silently proxied.
- **Administrator discovery:** fixed provider destinations, bounded results and
  response sizes, no credential-insensitive model cache. GET discovery rejects
  query overrides; provider-specific POST accepts an optional key but no base URL
  override. A submitted key is never broadcast to every provider. Static catalog
  fallback is discovery only, not proof of successful inference or credentials.
  Process-wide provider configuration remains administrator-only, not a workspace
  credential store; storing a custom base does not bypass dispatch validation.
- **Agent image tool:** dedicated endpoint, fixed HF provider chain (`fal-ai`,
  `together`, `nscale`), then configured sidecar. Model identifiers are payload
  data, not arbitrary provider path segments. Returned image URLs are downloaded
  anonymously, even when same-origin. Reference image and strength zero retained.
- **Agent video tool:** raw/base64/URL and asynchronous polling supported. Status
  URLs must match the configured endpoint origin. Same-origin video result requests
  may use the provider credential; cross-origin CDN downloads are anonymous.
  Nested result links, polling and retries share bounded operation lifetimes.
- **Image API service:** health/generate/analyze/vision methods use only the sidecar
  paths; health and generation share the caller operation budget. Legacy message
  image generation now forwards its disconnect signal into that service.
- **Research:** nonstreaming planning/claim verification forward the run signal
  through `completeOnce`; cancellation escapes fallback logic and prevents synthesis.

Image responses are bounded at 16 MiB, video responses at 96 MiB; decoded stored
artifacts are bounded at 50 MiB and retain owner binding/private file URLs. Existing
file signature rules still apply; these are not full media decoding/AV scans.
Agent image/video credit-check exceptions now fail closed before provider calls.
This does not implement consistent billing for all routes.

## Persisted video jobs

New jobs capture the configured provider origin before starting the worker. Resume
rejects a captured-origin mismatch; status and result URLs are validated every time
they are used, including persisted values and retries. Historical records without
an origin still receive current endpoint/URL checks; no historical provenance is
invented. Status polls cannot send credentials to another origin.

Persisted `startedAt` anchors the remaining budget across restarts. A DB watcher
checks active status roughly every second and aborts requests/sleeps on cancellation
or lookup failure. Status writes are conditional on queued/processing so cancellation
or completion cannot be overwritten by a late worker. Completed jobs do not dispatch
again. Detached worker storage rejection is handled and logged generically.

The running-job set is **process-local**, not a distributed lease. Submission and
artifact creation are not transactional with job state; crashes/multiple replicas
can cause duplicate provider work or orphan artifacts. Cancellation cannot undo
already accepted provider work. Resumption still needs bounded worker concurrency,
job-linked reservations/settlement, leases and orphan cleanup before production.

## Verification and remaining gates

Evidence: `validation/foundation-03i.md`. Unit/provider fixtures mock external
DNS/network calls. Integration tests use real PostgreSQL/private artifact storage.
The production smoke uses actual Node HTTP against a temporary loopback sidecar
under `--network none`; it does not certify external DNS/TLS/provider compatibility.

No billing reservation ledger, webhook idempotency, partial-usage settlement,
workspace lifecycle across all legacy routes or distributed job execution is
implemented here. Legacy/API job-creation database errors and older persisted error
strings also need a broader response-normalization review. CLI completions, legacy
messages and JWT media creation still have inconsistent metering. Do not enable
public paid execution on the strength of these transport tests alone. Infrastructure
egress rules, resource quotas, key replacement, real provider qualification and
owned web/native client migration remain separate release gates.
