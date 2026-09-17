# Public outbound HTTP policy (with checkpoint 03i cross-references)

`backend/src/services/publicHttp.ts` is the new transport for web_search,
web_fetch and their research consumers, and the two reviewed workspace search
connectors. It is not a transport for private infrastructure.

## Enforced behavior

- Only HTTP/HTTPS on their standard ports, without URL userinfo, raw whitespace,
  control characters or backslashes. URL length is capped at 8,192 characters.
- IPv4 excludes private, loopback, link-local, shared-address, documentation,
  benchmark, multicast and reserved ranges, plus known platform/metadata virtual
  addresses. IPv6 permits global-unicast space only, excluding selected special
  allocations, documentation and 6to4; IPv4-mapped, NAT64, ULA, link-local and
  multicast addresses are rejected. Local/internal names and known metadata
  names are blocked before DNS.
- All returned DNS addresses must pass. Mixed public/private answers fail closed.
  The socket lookup is pinned to one checked address, preferring IPv4 when both
  families are available. The original hostname remains in the request URL for
  Host, TLS SNI and default certificate validation.
- Each hop uses a dedicated non-keepalive agent, explicitly disabling environment
  proxy configuration on Node versions supporting it. Global agents/proxy defaults
  are not used. No fallback to the old unrestricted transport is allowed.
- Redirects are off by default. At most three may be explicitly enabled for
  anonymous GET requests with only Accept/Accept-Language/User-Agent headers.
  Credentials, custom headers and non-GET requests cannot follow redirects.
  Every hop is revalidated/re-resolved, including same-host redirects. HTTPS
  downgrade, private destinations and disallowed origins fail closed.
- Non-anonymous requests require HTTPS. Adapters may set an exact allowedOrigins
  array; no suffix or substring matching is performed.
- Caller overrides of Host, framing, proxy and hop-by-hop headers are rejected.
  Outgoing bodies are capped at 64 KiB and supplied headers at 16 KiB. Incoming
  headers are capped at 16 KiB using Node's parser option.
- One deadline covers DNS, connection, headers, all redirects and body reading.
  Default: 20 seconds; maximum configurable: 120 seconds. Abort listeners/timers
  are removed and agents/sockets destroyed on completion or failure.
- Trusted callers can provide `beforeConnect`, an asynchronous access recheck
  after DNS and before opening the socket, inside the same deadline. Rejection
  returns a generic transport error; a stalled/late callback cannot open a socket
  after cancellation. This hook is server code, not a request JSON option.
- Wire and decoded response bytes are independently limited. Default: 2 MiB;
  maximum configurable: 8 MiB. Identity, gzip, deflate and Brotli are supported.
  Unsupported encodings, excess content length, oversized streams and decompression
  expansion fail. Non-2xx error bodies and raw transport errors are not reflected.

## Web consumers

Page reading permits three anonymous public redirects, limits HTML to 1 MiB,
uses the final URL for DOM interpretation, and closes the DOM after extraction.
Scripts and external DOM resources are not enabled. Text output remains bounded.

Search uses fixed origins for Tavily, Brave, DuckDuckGo and Bing. API responses
are capped at 512 KiB; HTML at 1 MiB. API credentials are not forwarded to fallback
providers. An overall 30-second cancellation deadline covers the provider chain;
cancelled requests do not start another provider. Queries are capped at 2,000
characters and results at 10, with bounded titles/snippets and URL validation.
Research forwards its cancellation signal into these helpers.

## Limits and deployment requirements

This is application-layer filtering, not an egress firewall or a browser sandbox.
The range/metadata list must be maintained. Infrastructure using publicly routed
addresses internally needs additional deployment-specific network deny rules.
Corporate proxy-only environments and private/self-hosted endpoints are not
supported by this transport; do not bypass it to restore access.

Node's OS DNS lookup cannot itself be cancelled. A timed-out lookup may complete
later, but the request stops waiting and never opens a socket from that late
result. Network deadlines do not preempt synchronous HTML parsing or other CPU
work. Aggregate concurrency/quotas and isolated parsing remain later work.

Checkpoint 03i migrates `agent/httpClient.ts` and reviewed independent provider,
embedding and media calls to `providerHttp.ts`, with a separate fixed-path sidecar
entry point for private operator infrastructure. See `PROVIDER_MEDIA_HTTP.md` for
its stricter HTTPS/no-redirect/identity-only rules and different byte/time budgets.
This module's buffered web limits do not automatically apply to those consumers.
No application-layer transport is a claim of backend-wide SSRF isolation.

Checkpoint 03e rejects client provider/key/URL overrides at the agent streaming
and CLI-completion HTTP routes. Those routes now select hosted operator targets
only, but their SDK transport has not been replaced with this public transport.
Checkpoint 03f extends the selection gate to legacy messages and retires global
model selection. Neither checkpoint replaced the streaming SDK transport; the
later 03g-03i policies below supersede their deferred egress work.
See `docs/RUNTIME_AUTHORIZATION.md` for the exact scope and breaking changes.

Checkpoint 03g introduces a separate SDK fetch guard: exact chat endpoint and
credential checks, dedicated HTTPS agents and no redirects. It reuses URL syntax
checks, **not** this module's DNS pinning or byte/deadline enforcement. Model SDK
traffic must not be described as fully protected by `publicHttp`; the exact
coverage and remaining limits are in `docs/MODEL_HTTP.md`. Checkpoint 03h extends
that SDK guard with this module's shared public-address resolver, a pinned agent
lookup, identity-only payload caps and a DNS-through-consumption deadline. It is
still a separate streaming transport; the buffered publicRequest limits do not
automatically apply to unrelated provider/media clients.

The separate 03i provider transport reuses the shared public-address resolver, not
this module's redirect/decompression policy. Its sidecar resolver explicitly allows
selected private infrastructure; do not route web-tool URLs through that exception.

## Connector readiness review (code review, not live-provider certification)

Only Notion/GitLab now report `executionEnabled: true`, behind explicit workspace
selection. Do not reactivate the old `buildCatalogTools` factory: it interpolates raw URL components, restores encoded
slashes, uses default redirect behavior, clears its timeout before body reading,
and returns provider error bodies.

| Catalog group | Next requirement |
| --- | --- |
| Notion search; GitLab project search | Implemented/scoped and tested with mocked provider transport in 03d; live API compatibility still unverified |
| Slack channel listing; Todoist listing; Stripe/HubSpot reads | Dedicated adapters with bounded pagination and least-privilege scopes; separate read operations from writes |
| Airtable; Sentry | Immutable configured resource identifiers, path-segment validation and traversal rejection |
| OpenWeather; SerpAPI | Query credential redaction in success/error/telemetry paths; redirects disabled |
| Slack/Todoist/Discord/Telegram writes | Explicit write policy, previews/approval where appropriate, retry/idempotency behavior; Telegram also puts credentials in the path |
| Jira | Reviewed hostname/tenant policy and URL construction; arbitrary siteUrl interpolation is not acceptable |
| OAuth directory entries | Implement OAuth state/token lifecycle and scoped adapters before claiming availability |

Every enabled adapter must derive definitions from workspace-scoped metadata,
check the captured connection version and current membership before invoking,
keep credentials out of schemas/prompts/events, use fixed origins, and run both
isolation and HTTP construction tests. No connector API was called in 03c.

Evidence: `docs/validation/foundation-03c.md` and `docs/validation/foundation-03d.md`.
