#!/bin/sh
exec temporal server start-dev \
  --ip 0.0.0.0 \
  --ui-ip 0.0.0.0 \
  --port 7233 \
  --ui-port 8233 \
  --db-filename /var/lib/temporal/temporal.db
