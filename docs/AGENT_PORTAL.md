# Loop GPT — Agentic Chat Portal

Loop GPT is a Claude.ai / Manus-class agentic chat portal: a real tool-using
agent with streaming, deep research, native vision, image generation, document
generation, and an extensibility layer (MCP servers, connectors, skills,
plugins). The primary model is served by a **Hugging Face Inference Endpoint**.

## Architecture

```
frontend/ (Next.js 14)          backend/ (Express + TypeScript)
  app/page.tsx  chat UI            src/routes/agent.ts      SSE stream + management API
  app/lib/stream.ts SSE client     src/agent/
  app/components/SettingsPanel       agentRuntime.ts        tool-calling loop (native + ReAct)
                                     llmClient.ts           OpenAI-compatible streaming client
                                     toolRegistry.ts        tool registry
                                     streaming.ts           SSE helpers
                                     tools/                 web_search, web_fetch, calculator,
                                                            get_current_time, generate_image,
                                                            create_document
                                     research/deepResearch.ts  plan→search→read→cite
                                     mcp/                   MCP client + registry
                                     connectors/            connector framework (+ GitHub)
                                     skills/                Anthropic-style skills (+ 2 builtin)
                                     plugins/               plugin loader (+ example)
                                     configStore.ts         file-backed settings (data/*.json)
                                     artifacts.ts           generated files → /uploads/artifacts
```

The model call goes through the OpenAI SDK pointed at the HF endpoint
(`HF_ENDPOINT_URL/v1`, `llama.cpp`), so tool-calling, streaming, and multimodal
`image_url` content all work with one client. Tool-calling is attempted
natively; if the endpoint was not started with `--jinja`, the runtime
auto-falls back to an inline-JSON (ReAct) protocol.

## Configuration

Copy `backend/env.example` → `backend/.env` and set:

| Var | Purpose |
| --- | --- |
| `HF_ENDPOINT_URL` | Your dedicated endpoint URL (root or `…/v1`). |
| `HF_TOKEN` | HF access token for the endpoint. **Keep secret; rotate if shared.** |
| `HF_MODEL` | Model name sent in requests (llama.cpp ignores it; `tgi` is fine). |
| `HF_IMAGE_MODEL` | Text-to-image model on HF Providers (default `FLUX.1-schnell`). |
| `DEFAULT_PROVIDER` | `huggingface` to make the endpoint the default. |
| `TAVILY_API_KEY` | Optional; better web search. Falls back to DuckDuckGo. |
| `DATABASE_URL` | Optional Postgres. Without it, an in-memory store is used. |

> **Security:** secrets live only in env/secrets, never in the repo. `.env` is
> gitignored. Configured connector secrets are stored server-side and never
> returned to the browser.

## Running

Local (two processes):

```bash
# backend
cd backend && npm install && npm run dev      # http://localhost:3001
# frontend
cd frontend && npm install && npm run dev     # http://localhost:3000
```

Full stack with Docker:

```bash
# set HF_ENDPOINT_URL / HF_TOKEN in a .env next to docker-compose.yml
docker compose up --build
```

## Modes

- **Agent** — full tool use (web, images, documents, MCP, connectors, plugins).
- **Chat** — fast, no tools (unless an active skill recommends one).
- **Deep Research** — plans queries, searches, reads sources, and writes a cited
  report, streaming each step.

## Extending

- **MCP servers** — Settings → MCP. Add an HTTP (Streamable) or stdio server;
  its tools are namespaced `mcp__<id>__<tool>` and become callable by the agent.
- **Connectors** — Settings → Connectors. Ships a GitHub reference connector
  (token-based). Add a `ConnectorType` in `connectors/connectorRegistry.ts`.
- **Skills** — Settings → Skills. Built-ins live in `skills/builtin.ts`. Add a
  user skill by dropping `backend/skills/<id>/SKILL.md` with frontmatter
  (`name`, `description`, `triggers`, `tools`).
- **Plugins** — Settings → Plugins. Built-ins in `plugins/pluginLoader.ts`; drop
  `backend/plugins/<id>/index.js` exporting a `Plugin` to add third-party ones.
- **Tools** — implement a `ToolDefinition` and register it in `agent/index.ts`.

## API (selected)

- `POST /api/conversations/:id/stream` — SSE agent run. Body:
  `{ content, imagePath?, mode, provider?, model?, apiKey? }`. Events:
  `status`, `warming`, `delta`, `tool_call`, `tool_result`, `artifact`,
  `final`, `error`, `done`.
- `GET /api/agent/tools` · `GET/POST/DELETE /api/agent/mcp-servers` ·
  `GET/POST/DELETE /api/agent/connectors` · `GET/POST /api/agent/skills/:id` ·
  `GET/POST /api/agent/plugins/:id`.

## Verifying

```bash
cd backend && npm test          # unit tests (tools, runtime, registry)
npm run build                   # type-check + compile
```

End-to-end: start the backend with `HF_ENDPOINT_URL`/`HF_TOKEN`, open the
frontend, and try: “What's the latest on <topic>?” (Deep Research),
“Generate an image of a fox in snow”, “Make a PDF report about X”, or upload an
image and ask about it (native vision).

## Roadmap / not yet built

- Background/async task queue for long jobs (BullMQ + Redis) — currently long
  runs stream synchronously within the request.
- Persisting MCP/connector/skill config in Postgres (currently file-backed).
- OAuth connectors (the framework supports token connectors today).
