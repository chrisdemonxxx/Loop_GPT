#!/bin/sh
set -e

# Application startup must never change the schema. Apply reviewed migrations
# with `npm run migrate:deploy` as a separate, fail-fast release step.
# Environment validation runs before application modules are initialized.

exec node dist/server.js
