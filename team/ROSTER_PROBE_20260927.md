# ROSTER PROBE — 2026-09-27 (owner: hr-bot)

Raw commands and raw output. Two worker seats, each probed (a) for liveness and (b) for a real
`tool_calls` response. Nothing here is inferred.

`$HF_TOKEN` is sourced from `~/.hermes/.env`; the value is never printed.
Endpoints (from each bot's `config.yaml` `providers:`):

- `hf-dsv41` = `https://xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud/v1`
  (`s-zaizen/DeepSeek-V4.1-Flash-Abliterated`)
- `qwen3-cyber` = `https://y54ycbowmtsfq58i.us-east-1.aws.endpoints.huggingface.cloud/v1`
  (`Qwen3.8-27B-Uncensored-Cyber`)

## P1 — liveness + tools, `hf-dsv41`

```
$ curl -s -o live.json -w '%{http_code} %{time_total}' -X POST \
    $DSV41/chat/completions -H "Authorization: Bearer $HF_TOKEN" \
    -d '{"model":"s-zaizen/DeepSeek-V4.1-Flash-Abliterated",
         "messages":[{"role":"user","content":"reply with the single word: pong"}],"max_tokens":8}'
liveness HTTP=200 t=1.088996
body: {"id":"chatcmpl-BY-Kz7","object":"chat.completion","created":1790544263,
       "model":"s-zaizen/DeepSeek-V4.1-Flash-Abliterated","choices":[{"index":0,
       "message":{"role":"assistant","content":null,"refusal":...

$ curl ... -d '{"model":"...","messages":[{"role":"user","content":"Call the ping tool with x=1"}],
                "tools":[{"type":"function","function":{"name":"ping",...}}],"tool_choice":"auto"}'
tools    HTTP=200 t=1.297410
body: ..."message":{"role":"assistant","content":null,"refusal":null,"annotations":null,
       "audio":null,"function_call":null,"tool_calls":[{"id":"chatcmpl-tool-81d199048f2a0488",
       "type":"f...
```

## P2 — `qwen3-cyber`: 503 cold-start window, then live

```
$ for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w 'HTTP=%{http_code} t=%{time_total}\n' -X POST \
    $QWEN/chat/completions ... ; sleep 20; done
attempt 1: HTTP=503 t=0.711395
attempt 2: HTTP=503 t=0.746897
attempt 3: HTTP=200 t=1.068760
attempt 4: HTTP=200 t=0.897887
attempt 5: HTTP=200 t=0.886560
attempt 6: HTTP=200 t=1.031027

$ curl -s "$QWEN/models" -H "Authorization: Bearer $HF_TOKEN"      # cold
HTTP=503 t=0.748488   {"error":"503 Service Unavailable","code":"SERVICE_UNAVAILABLE"}
```

Four earlier probes (21:22Z) were all `503` over ~15s, and `GET /v1/models` 503s the same way — so
this is a scale-to-zero endpoint waking up, not a broken route. Warm probes:

```
liveness HTTP=200 t=0.968499   {"id":"1ee1609d30e0425db877aff48f31aaf3",...,"model":"Qwen3.8-27B-Uncensored-Cyber"}
tools    HTTP=200 t=1.739491   ..."reasoning_content":"The user is asking to call the ping tool with x=1. ...",
                               "tool_calls":[
```

## P3 — seat placement (read from the profiles, not from the roster's memory)

```
$ for f in */config.yaml; do ... awk '/^model:/,/^providers:/' ...; done
arch-lead        primary=hf-dsv41
boss-bot         primary=hf-dsv41
code-review      primary=qwen3-cyber
core-dev         primary=hf-dsv41
hr-bot           primary=hf-dsv41
mobile-dev       primary=qwen3-cyber
ops-release      primary=hf-dsv41
perf-eng         primary=qwen3-cyber
qa-verify        primary=qwen3-cyber
research-scout   primary=hf-dsv41
ui-visual        primary=qwen3-cyber
```

Five seats sit primary on the endpoint that 503s while cold (`ui-visual`, `qa-verify`, `code-review`,
`mobile-dev`, `perf-eng`); all five carry `hf-dsv41` as fallback. Rule for those seats: one retry
before declaring the endpoint dead.

## P4 — defect in `hr-bot`'s own config, fixed

`hr-bot/config.yaml` listed `model.fallback: [{provider: qwen3-cyber, ...}]` but had **no
`providers.qwen3-cyber` block** (the only profile of 11 missing it). A fallback that resolves to
nothing is a fallback that does not exist. Block added, identical to the fleet's other ten.

```
$ python -c "import yaml,io;d=yaml.safe_load(io.open('config.yaml',encoding='utf-8'));\
print(list(d['providers']));print(d['model']['provider'],d['model']['default'])"
['hf-dsv41', 'qwen3-cyber']
hf-dsv41 s-zaizen/DeepSeek-V4.1-Flash-Abliterated
$ wc -c config.yaml      →  4176   (backup: config.yaml.bak.pre-qwen-block-20260927-*)
```

## P5 — the project state behind the roster (filesystem, not self-report)

```
$ git -C .../loop-gpt status --porcelain      →  (empty; tree clean)
$ git log --oneline -3
d110e56 fix(tts): revive the server TTS upstream - Kokoro Space (audit SS8-45)
72325dc docs(team): P1 findings - live bundle != HEAD build, no served-revision read-back, live TTS probe
c925c3a docs(team): P0 close-out (frozen 7540a3d, 5 gates green) + P1 board with owners and kickoffs

$ (cd frontend && rm -rf out .next && npm run build)   →  BUILD_EXIT=0, 19 routes
$ served /chat/ chunk names  = 18 ;  built chunk names = 114
$ comm -23 served built       = 8   (absent from the build)
  2631-7754d38b30959869.js
  3452-c378463bd237c50e.js
  4951-189c2c7dd73b3de3.js
  9864-960151d4ff000335.js
  app/chat/page-b2100450a5471ec3.js
  app/layout-a7c7cf45c3f55274.js
  main-app-2f3800c6e4826db2.js
  webpack-12ed1796ffdc89d3.js          # served runtime
                                         # built: webpack-bfdd25fdbe871018.js
$ served app/chat/page-b2100450a5471ec3.js  216,192 B
  sha256 f1598704aff9a3d491e369626734a206ce86f64b517ebffe2c3ab9f39ff428f5
$ built  app/chat/page-1a4368a0163b6661.js
  sha256 e22c39c66dc03411be2dfc14daf33a79a85cd5be81f75180fdf9ac8985c4f383
$ grep -c on the SERVED chat chunk: Kokoro=1  serverVoice=1   (d110e56 frontend markers present)
```

**Verdict:** the live host is *near* HEAD (it carries the `d110e56` frontend work) but is **not a
build of HEAD** — the served-vs-built chunk-set diff is not equal. Owner `ops-release`; the roster
lists it as the P1 gate.
