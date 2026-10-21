# loopit-mcp

Thin MCP server over Loop-it's FastAPI. LibreChat (and any MCP client) can start
runs, poll status, approve I7 gates, mint preview URLs, and list checkpoints.

The portal **never** holds model keys (I5). Callers send a Loop-it identity JWT
(`Authorization: Bearer`). Upstream Hugging Face / vLLM credentials stay on
`router-svc`.

## Tools

| Tool | API |
|---|---|
| `start_run` | `POST /api/runs` |
| `get_run` | `GET /api/runs/{id}` |
| `list_runs` | `GET /api/runs` |
| `list_gates` | `GET /api/runs/{id}/gates` |
| `approve_gate` / `reject_gate` | `POST .../gates/{id}/approve\|reject` |
| `list_checkpoints` | `GET /api/projects/{id}/checkpoints` |
| `create_preview` | `POST /api/projects/{id}/preview` |
| `git_export` | checkpoints + preview URL (remote push is `loopit-gitsync`) |

## Local

`POST /mcp` speaks MCP JSON-RPC (streamable HTTP, JSON responses).
`GET /healthz` is the compose probe.

```bash
docker compose up loopit-mcp
```

LibreChat overlay (optional, not in the default stack):

```bash
docker compose -f docker-compose.yml -f docker-compose.librechat.yml up
```

Paste a Loop-it login JWT into the portal MCP `LOOPIT_ACCESS_TOKEN` field and
into the Loop-it custom endpoint (router `http://router-svc:8001/v1`). That JWT
is not a model API key.
