# Loop GPT — SearXNG metasearch Space
# Deploy as a Docker SDK Space in the redkits HF org.
# Requires: HF_TOKEN set in the Space's Secrets for the app to call the
# SearXNG API without public access (or set SEARXNG_SECRET in the Space).
# The Space's internal URL becomes the webSearch tool's endpoint.
FROM searxng/searxng:latest
EXPOSE 8080
ENV SEARXNG_BASE_URL https://loop-search.redkits.hf.space
# Disable public registration; only the Loop GPT backend should call it.
ENV SEARXNG_REDIS_URL ""
# See settings.yml for engine config, rate limits and the JSON output format.
COPY settings.yml /etc/searxng/settings.yml
