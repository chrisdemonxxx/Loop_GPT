# Loop GPT — Cloudflare tunnel connector (runs INSIDE Railway).
# The credential is supplied at runtime via TUNNEL_CREDS_B64; the ingress is
# this image's config.yml. Alpine is used so the entrypoint can materialize the
# credential file (the distroless cloudflared image has no shell).
FROM alpine:3.20

RUN apk add --no-cache ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/cloudflared \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
 && chmod +x /usr/local/bin/cloudflared \
 && cloudflared --version

COPY config.yml /etc/cloudflared/config.yml
COPY entrypoint.sh /usr/local/bin/tunnel-entrypoint.sh
RUN chmod +x /usr/local/bin/tunnel-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/tunnel-entrypoint.sh"]
