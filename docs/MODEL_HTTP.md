# Model SDK destination, DNS and response controls (through 03i)

`agent/llmClient.ts::createClient` now uses `services/modelTransport.ts` through
the OpenAI SDK's custom-fetch option. This covers its callers in agent/research,
CLI completions, legacy chat/vision and `/v1/chat/completions`. Checkpoint 03i also
routes compatible `aiProviders.ts` chat methods through this factory. Independent
Anthropic/discovery/embedding/media requests use a separate bounded buffered
transport; see `PROVIDER_MEDIA_HTTP.md`, not the SDK budgets below.

## Configuration

- HF clients may use only the normalized `/v1` roots configured by the operator in
  `HF_ENDPOINT_URL` and optional `HF_LARGE_ENDPOINT_URL`. Both configured roots
  are validated; an invalid large-root setting also prevents standard HF clients.
- Fixed internal provider clients retain only their compiled origins/paths:
  OpenAI, Groq, Together, NVIDIA, xAI and Perplexity. A supplied custom root must
  equal that fixed root. This does not expose provider switching in HTTP routes.
- Local/Ollama, unknown providers and arbitrary custom roots are rejected by
  this client factory. Private infrastructure needs a separate reviewed transport.
- Roots must be absolute HTTPS with standard ports, no userinfo, whitespace,
  controls, backslashes, queries, fragments, percent escapes or dot segments.
  The existing public-URL syntax check also rejects nonpublic IP literals and
  known local/internal hostnames. Each request also validates and pins fresh DNS
  results as described below.
- Credentials must be 1-8,000 printable non-whitespace ASCII characters. Missing
  keys fail rather than using a default `sk-no-key` placeholder. An explicit empty
  or malformed key never falls back to the server key.
- `OPENAI_BASE_URL` is not inherited. Ambient OpenAI organization/project headers
  are explicitly disabled. Each client captures its destination and credential;
  changing those mutable SDK fields cannot retarget the guarded fetch.

These checks run at client construction, not process startup. Operator URLs and
keys remain trusted configuration; validation is not proof of provider ownership
or a working credential. Existing deployments with HTTP/private/custom roots,
query-based authentication or unsigned endpoints require configuration changes.

## Request/response rules

- Only `POST <captured-root>/chat/completions` with JSON string bodies is permitted.
  Absolute SDK URL escapes, another path/origin, query parameters, or a different
  authorization value fail before calling fetch. This is a chat-only factory.
- Headers permit the captured Authorization, JSON Content-Type, matching optional
  Content-Length, Accept, User-Agent and SDK `x-stainless-*` metadata. Other routing,
  tenant, cookie or proxy headers are rejected.
- Each request gets a dedicated non-keepalive HTTPS agent, replacing SDK-supplied
  agents, with `rejectUnauthorized: true` and empty proxy environment configuration.
  Certificate checks are not disabled. Agents are destroyed on failure or after
  the node-fetch response stream ends/closes/errors.
- Fetch uses `redirect: manual`, `follow: 0`. All non-2xx responses, including
  same-origin redirects, are discarded and become generic transport errors.
  Unexpected response URLs/redirect flags are rejected too. No Location follow-up
  or raw provider error body is passed to the SDK. Normal clients use zero retries.
- The SDK still handles JSON and SSE/native tool-call parsing. The transport now
  declares `node-fetch` 2.7.0 and its 2.6.13 types directly rather than importing a
  private OpenAI shim. Those versions already existed transitively. A narrow type
  adapter bridges the SDK's default web-fetch declarations to its tested Node
  runtime; no browser/global-fetch transport fallback is used. Upgrade only with
  the real-SDK/mocked-transport tests passing.
- `/v1/chat/completions` now catches client-construction errors inside its handler
  and returns a generic 502 before opening SSE. Its error path no longer logs or
  returns raw upstream exceptions.

## Pinned DNS and whole-response lifecycle (03h)

Every request uses the shared `resolvePublicAddress` helper. All DNS answers must
be valid public addresses: empty, private, mixed public/private and mismatched
address-family answers fail before fetch. One accepted address (IPv4 preferred)
is installed in the dedicated HTTPS agent's lookup callback. Host/TLS SNI and
certificate hostname remain the original hostname. Both Node lookup callback
forms return only the pinned address. No keepalive socket is reused, and subsequent
requests resolve/check again. Late DNS results after cancellation cannot dispatch.

| Budget | Default | Maximum |
| --- | --- | --- |
| JSON request bytes | 32 MiB | 32 MiB |
| Response payload bytes | 8 MiB | 8 MiB |
| Normalized headers, each direction | 16 KiB | 16 KiB |
| DNS-through-body-consumption deadline | 300,000 ms | 600,000 ms |

The model factory passes `HF_REQUEST_TIMEOUT_MS` through the existing agent config
to the whole-response timer; the resulting value must be a positive integer within
the ceiling. Trusted helper callers can lower byte budgets. Request JSON is already
serialized before the transport checks it, so this is not a strict process-memory
allocation cap. Response header budgets are checked after the HTTP parser, which
also has Node's own header limits.

Requests force `Accept-Encoding: identity` and disable node-fetch decompression.
Gzip/deflate/Brotli or other non-identity response encodings fail closed. Providers
must honor identity encoding; compressed provider compatibility is not claimed.
Because no decompression occurs, encoded and decoded payload budgets coincide
(TCP/TLS framing is not included). Declared Content-Length is validated before
reading; incremental counting and EOF-length checks cover streaming/undeclared
lengths. A backpressured Transform exposes bounded bytes to the SDK instead of
buffering the entire response in the transport.

One timer remains active across DNS, fetch headers and body consumption, including
an unconsumed response. Abort, timeout, byte overflow, source error or premature
close destroys the source/bounded streams and agent. Late responses from a fetch
delegate that ignored cancellation are discarded. Successful EOF or caller stream
closure clears the timer/listeners and closes upstream resources. An incomplete
SSE turn fails rather than becoming a successful final answer. Already-delivered
partial deltas cannot be retracted.

`/v1/chat/completions` now forwards disconnect cancellation in streaming and JSON
modes and does not emit a late completed result after observing cancellation.
This does not implement reservation or partial-usage settlement; billing on failed
or partially delivered requests remains release work.

## Remaining boundaries

This is not a complete model egress sandbox. OS DNS itself cannot be cancelled;
the request stops waiting and cannot use its late result. Synchronous JSON/SSE
parsing CPU cannot be preempted by the timer. Aggregate concurrency, whole-agent-run
budgets, deployment egress rules and special public-address deny rules remain
necessary. Limits apply per upstream request, not to an entire multi-turn run.

Trusted server code can bypass a factory or replace a fetch implementation; this
is not an isolation boundary against arbitrary server-side code execution. Success
payloads are model content, not a general-purpose credential/DLP filter. Checkpoint
03i migrates the reviewed independent clients, embeddings, media helpers and admin
discovery under their own policy. Research planning and verification now propagate
their run cancellation signal through `completeOnce` without fallback. No live
TLS/provider compatibility or backend-wide egress isolation is claimed.

Evidence: `docs/validation/foundation-03g.md` and `docs/validation/foundation-03h.md`.
Independent-provider and cancellation follow-up: `docs/validation/foundation-03i.md`.
