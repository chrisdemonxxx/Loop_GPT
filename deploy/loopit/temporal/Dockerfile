# Single-node Temporal dev frontend for staging.
# Railway's start command is a single token (/start.sh) so the CLI arguments
# are not collapsed into one unknown command. gRPC stays on 7233. The UI
# listens on 8233, which is the Railway health-check port.
FROM temporalio/temporal:latest
COPY --chmod=755 start.sh /start.sh
EXPOSE 7233 8233
ENTRYPOINT ["/start.sh"]
