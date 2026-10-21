# Single-node Temporal dev frontend for staging.
# The image entrypoint is the temporal CLI. gRPC stays on 7233 for the
# private network. Railway's HTTP health check uses PORT (8233), the UI.
FROM temporalio/temporal:latest
EXPOSE 7233 8233
CMD ["server", "start-dev", "--ip", "0.0.0.0", "--port", "7233", "--ui-port", "8233", "--db-filename", "/var/lib/temporal/temporal.db"]
