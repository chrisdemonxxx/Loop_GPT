# Loop GPT — SearXNG metasearch Space
# Deploy as a Docker SDK Space in the red-kit HF org.
FROM searxng/searxng:latest
COPY settings.yml /etc/searxng/settings.yml
ENV SEARXNG_BASE_URL https://red-kit-loop-search.hf.space
# Override port for HF Spaces dynamic PORT assignment.
RUN sed -i "s/port: 8080/port: \${SEARXNG_PORT:-8888}/" /etc/searxng/settings.yml
COPY entrypoint.sh /usr/local/bin/loop-search-entrypoint.sh
RUN chmod +x /usr/local/bin/loop-search-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/loop-search-entrypoint.sh"]
