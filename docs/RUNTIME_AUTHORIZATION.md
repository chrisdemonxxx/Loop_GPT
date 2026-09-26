# Workspace-bound agent execution (through foundation 03h)

> **Historical checkpoint record (audit §8-47):** the authorization model this
> document describes is still live (workspace-bound stream routes, no dev
> bypass), but newer fields and flows have been added since — branch anchoring
> (`regenerateOf`/`parentMessageId`, §8-22), durable replay runs (§8-30),
> per-run capability toggles (§8-25/26). Current state lives in
> `docs/PROGRESS.md` + `docs/GAP_REGISTER.md`; treat this as the 03h snapshot.


## Supported scope

Streaming routes at both `/api/agent/:conversationId/stream` and
`/api/conversations/:conversationId/stream` require a real database-backed
workspace and owner/editor membership. Conversation user ownership is still
required: membership alone does not grant another person's chat. There is no
in-memory/development bypass for this executor.

New optional request fields:

```json
{
  "content": "Calculate 6 * 7",
  "mode": "agent",
  "workspaceId": "<workspace-id>",
  "toolNames": ["calculator"]
}
```

- A new conversation uses the requested workspace or the account's personal
  workspace. Permission is checked before creation.
- Existing workspace-bound conversations cannot be moved by this request.
- A legacy unbound conversation can be assigned only to its owner's personal
  workspace. Assignment is conditional/transactional; concurrent changes return
  409. This is lazy assignment, not a bulk migration.
- `chat` has no tools, even when built-in skill triggers match.
- `agent` defaults to seven reviewed built-ins plus explicitly selected connections;
  an explicit `toolNames` array narrows it.
  An empty array enables none. Unsupported names return 400 before execution.
- `research` defaults to web_search/web_fetch and requires both permissions.
- Lower-level `runAgent` treats omitted `toolNames` as no tools.
- Credit-check exceptions return 503 rather than proceeding. This is not a
  reservation/ledger implementation; existing metering gaps remain.

### Opt-in read-only connections

Both stream aliases accept `connectionIds`, an array of at most eight distinct
connection UUIDs (default `[]`). Connections require `mode: "agent"`; chat and
research reject nonempty selections. Saved/enabled connections are not implicitly
available to a run. Obtain tool names/schemas from
`GET /api/workspaces/:workspaceId/connections/:connectionId/tools`.

```json
{
  "content": "Find the roadmap",
  "mode": "agent",
  "workspaceId": "<workspace-id>",
  "connectionIds": ["<connection-UUID>"]
}
```

Omit `toolNames` to use selected connections plus built-ins, or supply an explicit
array containing only the discovered names you want. Connection tool names without
matching `connectionIds` are rejected. Foreign, missing, disabled and unsupported
connections fail before creating/binding a conversation. Selection reads metadata
only; dispatch decrypts only the captured workspace/connection/version after live
owner/editor checks. Access/version is rechecked after DNS before the socket opens
and after the response before returning projected results. See `docs/WORKSPACES.md`
for limits and rotation/revocation semantics.

### Hosted model selection (03e)

Both streaming aliases and both `/completions` aliases now accept only hosted
Loop model selection. Omit `provider` (recommended), or send `"huggingface"` for
backward compatibility. Other providers are rejected with HTTP 400 and code
`HOSTED_MODEL_REQUIRED`. The presence of `apiKey`, `api_key`, `baseUrl`, `baseURL`,
`base_url`, `models` or `selectionMode` is rejected, including empty/null values.
This intentionally removes bring-your-own-provider/local-server behavior from
these HTTP endpoints; a future BYO integration needs separate credential/egress
policy, not a fallback to process credentials.

An optional `model` is a nonblank string of at most 200 characters. The existing
catalog alias mapping selects an operator-configured target; unrecognized strings
fall back to standard, and are never sent upstream as a model or URL. Omission
selects standard. `DEFAULT_PROVIDER`/`DEFAULT_MODEL` no longer choose the target
for these routes. `HF_ENDPOINT_URL`, `HF_MODEL`, and the corresponding large-tier
settings remain trusted operator configuration. Selection is resolved before
credit checks, attachments, conversation writes, SSE headers or SDK construction.

CLI `/completions` accepts 1-200 message objects with recognized roles, up to 128
tool definitions, and an actual boolean `stream` (default true). This is envelope
validation, not full upstream message/tool-schema validation. The relay forwards
model tool calls to the CLI; it does not execute them server-side. SDK construction
and request failures before SSE starts return generic HTTP 502. A midstream failure
emits a generic error event, without a successful `[DONE]`. Successful SSE framing
is unchanged. Disconnects abort the upstream SDK call; normal/error exit also
cleans up its abort controller. Streaming headers begin only after upstream setup,
so startup failures remain ordinary HTTP errors rather than partial SSE responses.

The 03e change was a request-selection boundary, not a complete SDK transport
policy. Checkpoint 03g adds root validation and per-request credential/redirect
controls; 03h adds pinned DNS, per-request byte/deadline budgets and v1 disconnect
cancellation. See `docs/MODEL_HTTP.md` for remaining transport limits.
The legacy message path was migrated in 03f below. Checkpoint 03i migrates independent
provider/media transports and administrator discovery under `PROVIDER_MEDIA_HTTP.md`;
administrator settings remain process-wide. No backend-wide SSRF protection or
provider compatibility is claimed. Existing CLI metering gaps remain release gates.

### Legacy message migration and global selection retirement (03f)

`POST /api/conversations/:conversationId/messages` now uses the same hosted-only
selection gate. It inspects raw JSON before schema validation, so unknown URL/key
fields cannot be silently stripped before rejection. Selection is request-local:
no import, read or mutation of the shared multi-model router or interaction-mode
dispatcher remains in this route. The eager global OpenAI client, alternate
provider fallback and canned unconfigured-provider answers have been removed.

Hosted chat and vision retain the existing response envelope (`userMessage`,
`assistantMessage`, `conversationId`, `toolUsed`), conversation ownership and
private attachment checks. Chat uses up to 20 recent history entries, filtered
to user/assistant roles. `content` is capped at 100,000 characters. Chat response
metadata no longer lists selected upstream providers/models. Each model call has
its own abort signal; disconnects cancel it. SDK failures or an empty model answer
return generic 502, without an alternate provider call or raw exception output.
The already-saved user message may remain on failure/disconnect; this is not an
atomic conversational transaction or an idempotent retry API.

Legacy `interactionMode` supports only omission or `"ask"`. Planning, agentic,
automation, and any `schedule` field return 400 `LEGACY_MODE_RETIRED`. Explicit or
auto-detected `mcp`/`gpt-creation` tools return 400 `LEGACY_TOOL_RETIRED`. No planned
capability is declared complete by retiring its old handler: use workspace-bound
streaming for current agent/research runs; durable automation and packaged MCP
still require implementation. These are intentional compatibility breaks.

At 03f image generation retained its existing transport and private-artifact
storage. Checkpoint 03i adds the isolated sidecar policy and forwards legacy-message
disconnect cancellation; it does not add workspace revocation or billing here.
The raw hosted-selection gate rejects provider overrides for image requests too.
Missing vision attachments and unsupported modes/tools fail before conversation
creation. Legacy owner-only and no-database fallback semantics remain unchanged;
workspace revocation and metering across this route are still release gates.

`/api/models/selection` and every subpath/verb now require authentication and
return 410 `GLOBAL_MODEL_SELECTION_RETIRED`, with `Cache-Control: no-store`. There
is no implicit development bypass or shared model state response. The public
`GET /api/models/catalog` remains available. The old singleton implementation files
were not erased, but neither message nor model-selection HTTP routes use them.
Administrator-only provider settings remain separate from request model selection.

## Authority is separate from model output

`authorizeRunContext` is an internal server issuer. After verifying conversation,
workspace and membership, it records a grant in a private WeakMap keyed by the
returned context. The grant captures identity, cancellation signal and reviewed
definitions/handlers. Request JSON cannot manufacture it. Copying, spreading or
serializing a context does not copy its grant. `restrictRunContext` only narrows.

`runAgent` and `ToolRegistry.execute` use the grant, not the mutable discovery
registry, and recheck database access before model turns and tool dispatch.
Replacing a global registration cannot retarget a captured handler. Native and
inline JSON tool calls share the execution gate, including calls naming
registered-but-unselected tools. Denials never execute handlers and are not
counted in successful `toolsUsed`.

AJV 8.20.0 validates captured schemas without type coercion. Undeclared top-level
properties are rejected unless a reviewed schema explicitly permits them.
Invalid/null/falsy arguments are not replaced with `{}`. Temporary compiled
schemas are removed after validation instead of retained indefinitely. Caught
registry errors do not reflect raw provider exceptions.

Research retains dedicated search/fetch helpers. It checks both permissions
before planning, rechecks before each search/fetch, and checks access before
verification/synthesis. Authorization failures escape its network-failure
fallback blocks rather than being treated as unavailable sources.
Checkpoint 03i also forwards cancellation into planning and verification model
calls; aborted calls do not silently fall back and continue to synthesis.

These are process-local grants, not sandboxes or durable job tokens. Server
implementation code remains trusted. Future workers must reissue grants from
verified persisted identity. Revocation cannot retract already-issued requests;
not all existing provider helpers cancel in-flight work.

## Retired global configuration

At both agent mounts, authenticated requests under `mcp-servers`, `connectors`,
`skills`, `custom-tools`, and `plugins` return **410 GLOBAL_CONFIGURATION_RETIRED**
for all verbs/subpaths. Old handlers were removed. Startup no longer activates
global extensions. `create_skill` and `create_custom_tool` are not registered or
granted. Compiled skill instructions may be used, but filesystem/global skill
settings are not read by the streaming route. Existing files were neither erased
nor imported. Restart existing processes to apply the new bootstrap.

`/api/agent/tools` lists reviewed built-ins only. `/api/settings` is explicitly
administrator-only, including development, because it changes process-wide
provider configuration. These are breaking changes for old settings screens and
arbitrary-extension clients. No frontend migration is claimed.

## Remaining release gates

- Only Notion/GitLab search adapters are executable with explicit selection.
  Other WorkspaceConnection types remain configuration-only. Connection tokens
  are not provided to built-ins. Live provider compatibility, remaining adapters,
  OAuth lifecycle, write approvals and pagination remain unimplemented/unverified.
- Checkpoints 03c/03g-03i cover reviewed web, SDK and independent provider/media
  transports under separate policies. Live provider qualification, deployment
  egress rules and aggregate resource budgets remain pending.
- Legacy message/media/file endpoints retain user-ownership semantics. Full
  workspace lifecycle/revocation across those paths is pending.
- `/completions` relays model calls for the local CLI rather than executing tools
  server-side. Its metering integration remains pending despite hosted selection
  and guarded model transport.
- Organization invitations, private evaluated skills, packaged MCP, durable
  execution, sandboxing, reservations and UI/mobile work remain.

Evidence: `docs/validation/foundation-03b.md`, `docs/validation/foundation-03d.md`,
`docs/validation/foundation-03e.md`, `docs/validation/foundation-03f.md` and
`docs/validation/foundation-03g.md`, `docs/validation/foundation-03h.md` and
`docs/validation/foundation-03i.md`. This work does not declare
the whole backend ready for public onboarding.
