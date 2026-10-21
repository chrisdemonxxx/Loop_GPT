# loopit-telemetry

OpenTelemetry, golden-signal metrics, structured JSON logging, and append-only audit WORM mirroring for Loop-it. It is safe-by-default: `configure_telemetry("service-name")` leaves providers as no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` or a test exporter is configured, and exporter startup failures are caught so services keep booting.

## One-line service adoption

```python
from loopit_telemetry import add_loopit_telemetry, configure_telemetry

configure_telemetry("router-svc")
add_loopit_telemetry(app, "router-svc")
```

Follow-up wiring locations:

- `apps/api/src/loopit_api/server.py`: after creating the FastAPI app.
- `services/router-svc/src/loopit_router/server.py`: in `create_app`, immediately after `app = FastAPI(...)`.
- `services/scheduler/src/loopit_scheduler/server.py`: in `create_app`, immediately after `app = FastAPI(...)`.
- `services/egress-proxy`, `services/preview-proxy`, `services/secrets-broker`, and `services/orchestrator`: same pattern at app construction.

## Grafana Cloud free tier

Set standard OTel environment variables in the service process:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-REGION.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64-instance-id-api-token>
OTEL_SERVICE_NAME=router-svc
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

Only tenant-safe correlation attributes are emitted: `loopit.tenant_id`, `loopit.project_id`, `loopit.run_id`, and `loopit.task_id`. Attribute and log scrubbers redact credential-shaped values and email addresses before export.

## Audit WORM mirror

`AuditWormMirror` consumes the existing `AuditStore` protocol and writes each `AuditRecord` once under a deterministic key. `verify_audit_mirror(...)` detects missing objects, modified objects, and hash-chain failures without adding mutation APIs to `packages/store`.
