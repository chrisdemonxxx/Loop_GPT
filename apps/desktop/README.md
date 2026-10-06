# Loop GPT — Desktop Shell

Electron desktop shell for Loop GPT, built on the **sand-pattern architecture**
(reverse-engineered from the Grok Bot reference distribution): staged main-process
boot, a sandboxed preload bridge, and a custom `loop://` protocol that serves the
web app's static export *and* proxies the API — in-process nginx.

## Architecture

```
electron-main/
  main.cjs        staged boot loader — core stage must win the ready race
  main-core.cjs   pre-ready init: loop:// scheme registration (throws after
                  ready), window-state store, runtime config
  main-app.cjs    remainder: loop:// handler, shell window, lifecycle, IPC
electron-preload/
  preload.cjs    contextBridge (loopDesktop.*), sandbox-compatible
renderer/
  fallback.html   recovery page when the static export is missing
```

### The loop:// protocol (the nginx role)

The shell serves the **same static export the website runs** at `loop://app/`
and forwards `/api` + `/v1` to the backend. From the renderer's perspective
these are same-origin fetches — no CORS, no preflight, and response streams
pass through (SSE feeds work). The web app runs unmodified.

| Env var | Purpose | Default |
|---|---|---|
| `LOOP_API_URL` | backend origin the proxy forwards to | `https://loop-gpt.cyou` |
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
renderer-export` and is served by `loop://` via `process.resourcesPath`.

- **Icon**: regenerated from the brand SVG — `node scripts/build-icon.mjs`
  (writes `build/icon.ico`; the source of truth is `apps/web/public/icon.svg`).
- **Signing**: set `CSC_LINK` + `CSC_KEY_PASSWORD` in the environment and
  electron-builder signs automatically; otherwise artifacts are unsigned.

## Smoke gates

- `scripts/smoke.mjs` — repo mode: spawns Electron, asserts `SMOKE_OK`
  (page served via loop://) and `SMOKE_API_OK` (renderer `fetch('/api/version')`
  through the proxy → live backend). Exit-code contract: `0` pass, `3` API
  probe failure, timeout = boot failure.
- `scripts/smoke-packaged.mjs` — same contract against
  `release/win-unpacked/Loop GPT.exe` (verifies the packaged export path).

CI (`web-validation.yml`) runs the smoke headless via `xvfb-run` on Linux.
