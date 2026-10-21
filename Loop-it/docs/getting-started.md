# Getting started

Loop-it turns a product prompt into a generated app in an isolated sandbox. The fastest first run is:

1. Register an organization in `apps/web`.
2. Choose one of the starter prompts or describe one concrete app.
3. Click **Build it** and watch the run activity, task DAG, cost, files, and preview panes.
4. If Loop-it asks for approval, read the gate text and approve only if you intend the irreversible
   action (deploy, delete, spend, external write, or secret rotation).
5. Use checkpoints to roll back or fork a verified state.

Local verification remains development-only. Live launch still requires Docker/E2B isolation, live model
credentials, Stripe, Fly/deploy credentials, OIDC, TLS, and production database/object storage configured
by the operator.

## Good first prompts

- Build a customer intake form with an admin review table.
- Create a SaaS landing page with pricing cards and a waitlist form.
- Build a team task tracker with login, projects, and owner-only settings.

## What to expect

The control plane never executes generated code. Runs lease data-plane sandboxes, spend credits through
the router and scheduler quotas, emit audit events, verify changes, and expose authenticated previews.
