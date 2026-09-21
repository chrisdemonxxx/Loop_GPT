---
title: Loop Search — SearXNG
emoji: 🔍
colorFrom: gray
colorTo: indigo
sdk: docker
pinned: false
app_port: 7860
---

# Loop Search

Private metasearch engine for Loop GPT. Provides web search results through a JSON API.
Access is restricted to the Loop GPT backend; no public web interface.

## Environment secrets

| Variable | Description |
|---|---|
| `SEARXNG_SECRET_KEY` | Required. Set in Space Secrets for API authentication. |
| `SEARXNG_BASE_URL` | Auto-set to `https://red-kit-loop-search.hf.space` |
