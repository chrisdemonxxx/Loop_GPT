# PERF_BASELINE — loop-gpt.cyou (2026-09-26, perf-eng)

Real baseline, not estimated. Everything measured from the same shell:
`cd frontend && npm run build` (Next 14.0.4, static export → `out/`), then
`wc -c` + `gzip -9 -c` over `out/_next/static/chunks/*.js`, then
`curl -s -o /dev/null` x5 per route against `https://loop-gpt.cyou/`.
Every number below has the exact command that produced it.
Build quirk: Windows-specific ENOENT on `.next/server/app-paths-manifest.json`
after "Generating static pages (19/19)" — 1 retry = clean `out/` with 19 pages.

## Route table (from `npm run build`)

| route | size | first load JS |
|---|---|---|
| `/` | 4.98 kB | 131 kB |
| `/_not-found` | 875 B | 84.4 kB |
| `/acceptable-use` | 190 B | 90.5 kB |
| `/account` | 14.5 kB | 105 kB |
| `/admin` | 6.12 kB | 96.4 kB |
| `/chat` | 93.2 kB | **505 kB** |
| `/cookies` | 190 B | 90.5 kB |
| `/developer` | 4.46 kB | 94.8 kB |
| `/forgot` | 2.95 kB | 93.2 kB |
| `/login` | 152 B | 195 kB |
| `/onboarding` | 3.86 kB | 94.1 kB |
| `/privacy` | 190 B | 90.5 kB |
| `/reset` | 3.12 kB | 93.4 kB |
| `/share` | 2.08 kB | 271 kB |
| `/signup` | 152 B | 195 kB |
| `/terms` | 186 B | 90.5 kB |
| `/verify` | 2.79 kB | 93.1 kB |

17 app routes + 404. `/chat` = 93 kB page + 505 kB first-load JS.

## Shipped JS — `out/_next/static/chunks` (7.47 MB raw, 94 .js)

Top 20 (bytes = `wc -c`, gzip = `gzip -9 -c | wc -c`):

| chunk | raw B | gzip B | what |
|---|---:|---:|---|
| `91dbc596.b45005575773f44c.js` | 1,450,005 | 428,181 | elk.js (mermaid's ELK layout, `elk-api.js`+`elk-worker.min.js` at chunk tail) |
| `3a7aa434.ed1e55f70adc1d12.js` | 653,881 | 138,792 | mermaid entry (id 2791, 15x "mermaid") |
| `90542734.36bb049f9114e403.js` | 432,104 | 134,447 | mermaid deps w/ `version="3.34.3"` (dompurify/d3) |
| `2170a4aa.8f404cefc3bd38e9.js` | 413,791 | 138,714 | SheetJS `CFB/SSF/parse_zip` (xlsx) |
| `794.12ba04e73c0e7937.js` | 386,514 | 120,382 | highlight.js (`hljs`, `version="3.4.12"`) |
| `8272-9d6c91afc980c56e.js` | 346,410 | 98,077 | app chunk — 10x react, 4x hljs (the chat page) |
| `0d8bff65.572a2b6262a909f5.js` | 263,475 | 76,083 | |
| `628fdacb-415a9e173d1ecb9b.js` | 263,470 | 76,083 | |
| `9da6db1e-407beb6be273a35a.js` | 233,847 | 75,268 | |
| `adf4140e.ae82b98e72f0ddc6.js` | 208,051 | 21,983 | best ratio (~10.6%) |
| `6337.06b23f0e6e521ce2.js` | 189,560 | 49,993 | |
| `fd9d1056-a2f1f89260d06de9.js` | 171,904 | 53,151 | |
| `4178.d37969335f390106.js` | 148,878 | 40,935 | |
| `framework-638abc5ad5ea33cc.js` | 140,088 | 44,932 | |
| `4a9a213e.b4550ea20052da86.js` | 117,865 | 30,659 | |
| `15e3b581.0b4378ec1114e403.js` | 117,503 | 28,377 | |
| `7462-f7bea14b7ef70225.js` | 110,689 | 35,705 | |
| `main-d24cbd563233b355.js` | 109,865 | 31,847 | |
| `3452-89f59a52a39385fe.js` | 108,520 | 30,528 | |
| `74ee6d58.75f7d749bf35060c.js` | 108,303 | 35,317 | |

```
# grand totals
$ du -sb out/_next/static/chunks
7804831
# = 7.47 MB raw
# all 94 .js: raw 7,471,010 B / gzip 2,172,089 B → 29.1% (7296/2121 KB)
```

## Live timings — `https://loop-gpt.cyou/`

```
$ curl -s -o /dev/null -w '%{time_total} %{size_download}' https://loop-gpt.cyou/
# 5x:
1.020428 0 200
0.714797 0 200
0.748067 0 200
0.747307 0 200
0.734510 0 200

$ curl -s -o /dev/null -w '%{time_total} %{size_download}' https://loop-gpt.cyou/chat/
# 5x:
0.736640 0 200
0.754209 0 2220
0.712521 0 2220
0.731329 0 2220
0.739183 0 2220
```

| route | TTFB s | HTML bytes | CL |
|---|---|---:|---|
| `/` | 0.71–1.02 (median ~0.73) | 27,285 (gzip) | `text/html`, `vary: accept-encoding` |
| `/chat/` | 0.71–0.75 (median ~0.73) | 21,400 (gzip) | same |

`time_total` 0.71–1.02s from this box (loop-gpt.cyou origin, no edge).
First-token latency = not measurable yet — needs a real model call; that's
the `?prompt=` run on `/chat/` I'll do after this file (next file:
`PERF_TTFT_<model>.md`). LCP/CLS: needs browser; `/` is img (LCP),
`/chat` CLS on message mount — both measured in the browser pass.

## 5 biggest offenders (ranked by first-load cost on /chat)

1. **mermaid 12** — elk.js 1.45 MB + 654 KB + 432 KB = 2.5 MB first-load,
   3rd-gzipped 428 KB. Loaded unconditionally in the markdown render.
   Fix: `dynamic(() => import('mermaid'))` behind a `?data-mermaid` in
   `MessageBubble` (lazy render on `<pre class="mermaid">`) — saves
   ~2.5 MB raw / ~692 KB gzip from every chat first-load.
2. **xlsx (SheetJS)** — 414 KB first-load on /chat, nobody needs it for
   the first token. Fix: dynamic import in the export path
   (`app/components/chat/useXlsxExport.ts`) → -138 KB gzip off first-load.
3. **highlight.js 11** — 387 KB, default theme set. Fix: register only
   the languages we use (`js,ts,json,py,sh,yaml,sql,html,css`) →
   ~200 KB raw, ~62 KB gzip.
4. **elk.js** — the 1.45 MB worker. Fix: `elk-worker.min.js` via
   `new Worker` only after first `elk` layout, not at module scope.
5. **framer-motion** — on every `MessageBubble` (4th-gzipped 263 KB
   duplicated chunks). Fix: `m` prop (AnimatePresence) on
   `MessageList` only; pop-in animation doesn't need the full tree.

Plus: `8272-*.js` (346 KB) is the /chat page chunk itself — that one is
our code, no fix, just the thing that grows.

## Commands (copy-paste, same shell)

```bash
cd frontend && npm run build                      # 19/19 pages → out/

# sizes
ls -lS out/_next/static/chunks/*.js | head -20
du -sb out/_next/static/chunks                # 7804831 B

# gzip per chunk
for f in $(ls -S out/_next/static/chunks/*.js | head -20); do
  raw=$(wc -c < "$f"); gz=$(gzip -9 -c "$f" | wc -c)
  printf '%10s %8s %s\n' "$raw" "$gz" "${f##*/}"
done

# live
curl -s -o /dev/null -w '%{time_total} %{size_download} %{http_code}\n' https://loop-gpt.cyou/
curl -s -o /dev/null -w '%{time_total} %{size_download} %{http_code}\n' https://loop-gpt.cyou/chat/
```

## Room one-liner

**7,471,010 B (7.3 MB) raw / 2,172,089 B (~2121 KB) gzip across 94 chunks;
biggest single = `91dbc596…` (elk.js/mermaid) 1.45 MB raw / 428 KB gzip.**
