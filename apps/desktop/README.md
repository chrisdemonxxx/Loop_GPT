# Loop GPT — Desktop Shell

Electron desktop shell for Loop GPT, built on the **sand-pattern architecture**
(reverse-engineered from the Grok Bot reference distribution): staged main-process
boot, a sandboxed preload bridge, and a local HTTP gateway on `127.0.0.1` that
serves the web app's static export *and* proxies the API — in-process nginx.

## Architecture

```
electron-main/
  main.cjs        staged boot loader — core stage must win the ready race
  main-core.cjs   pre-ready init: runtime config, window-state store,
                  gateway descriptor (userData/gateway.json)
  main-app.cjs    remainder: local gateway, shell window, lifecycle, IPC
  gateway.cjs     http://127.0.0.1 gateway — static export + /api|/v1 proxy
                  (HTTP, SSE, and WebSocket upgrades for noVNC)
electron-preload/
  preload.cjs    contextBridge (loopDesktop.*), sandbox-compatible
renderer/
  fallback.html   recovery page when the static export is missing
```

### The local HTTP gateway (the nginx role)

The shell binds a Node `http` server on `127.0.0.1` (preferred port `47613`,
overridable with `LOOP_GATEWAY_PORT`) and loads the window at
`http://127.0.0.1:<port>/`. It serves the **same static export the website runs**
and forwards `/api` + `/v1` to the backend — including WebSocket upgrades
(notably `/api/bot/novnc/<sandboxId>/websockify` for the live bot screen).

From the renderer's perspective these are same-origin fetches and sockets —
no CORS, no preflight, response streams pass through (SSE feeds work), and
auth headers/cookies plus query strings are forwarded to the backend.

(Older builds used a custom `loop://` protocol; that approach delivered empty
request headers and broke authenticated calls. Session state is migrated
once from the legacy `loop://` origin into the gateway origin.)

| Env var | Purpose | Default |
|---|---|---|
| `LOOP_API_URL` | backend origin the proxy forwards to | `https://loop-gpt.cyou` |
| `LOOP_GATEWAY_PORT` | preferred local gateway port | `47613` |
| `LOOP_DEV_URL` | load the Next dev server instead of the export | — |

## Commands (run from the repo root)

```bash
npm run desktop            # launch the shell against apps/web/out
npm run desktop:web        # dev mode: load http://localhost:3000 (run
                           #   `next dev` in apps/web + the backend first)
npm run desktop:smoke      # CI gate: boot + /api proxy probe (SMOKE_OK)
npm run desktop:dist       # build web export → NSIS Setup.exe (release/)
```

Prerequisites: `npm run build -w apps/web` must have produced `apps/web/out`
(the smoke and dev commands check and tell you otherwise).

## Packaging

`electron-builder.yml` targets NSIS (same installer family as the reference
distribution). The static export rides along as `extraResources:
renderer-export` and is served by the local gateway via `process.resourcesPath`.

- **Icon**: regenerated from the brand SVG — `node scripts/build-icon.mjs`
  (writes `build/icon.ico`; the source of truth is `apps/web/public/icon.svg`).
- **Signing**: set `CSC_LINK` + `CSC_KEY_PASSWORD` in the environment and
  electron-builder signs automatically; otherwise artifacts are unsigned.

## Smoke gates

- `scripts/smoke.mjs` — repo mode: spawns Electron, asserts `SMOKE_OK`
  (page served via the local gateway) and `SMOKE_API_OK` (renderer
  `fetch('/api/version')` through the proxy → live backend). Exit-code
  contract: `0` pass, `3` API probe failure, timeout = boot failure.
- `scripts/smoke-packaged.mjs` — same contract against
  `release/win-unpacked/Loop GPT.exe` (verifies the packaged export path).

CI (`web-validation.yml`) runs the smoke headless via `xvfb-run` on Linux.
