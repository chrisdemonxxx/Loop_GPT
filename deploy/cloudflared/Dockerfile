# Loop GPT — Cloudflare tunnel connector (runs INSIDE Railway)
# NOTE: cloudflared official image is distroless (no shell) — this recipe is
# deliberately shell-less. Inject the credentials file read-only at runtime;
# never put tunnel credentials in the repository or image build context.
FROM cloudflare/cloudflared:latest

COPY config.yml /etc/cloudflared/config.yml

ENTRYPOINT ["cloudflared", "tunnel", "--cred-file", "/etc/cloudflared/tunnel-creds.json", "--config", "/etc/cloudflared/config.yml", "--loglevel", "info", "--retries", "10", "run", "bc0a90c0-e120-44ba-99ea-15a6d138619b"]
