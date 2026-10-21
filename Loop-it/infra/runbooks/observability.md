# Runbook: observability with OpenTelemetry and Grafana

**Owner:** platform / observability
**Applies to:** P4-12, P4-13, PLAN §1 and §9
**Last verified:** 2026-09-03

Loop-it emits OpenTelemetry traces, metrics, and JSON logs through `packages/telemetry`. Services remain no-op when no OTLP endpoint is configured, so local development does not require Grafana Cloud or a collector.

---

## 0. Local stack

Start the local collector, Prometheus, and Grafana alongside the app:

```bash
docker compose up otel-collector prometheus grafana
```

Local endpoints:

| Component | URL |
| --- | --- |
| OTLP HTTP | `http://localhost:4318` |
| OTLP gRPC | `http://localhost:4317` |
| Prometheus | `http://localhost:9090` |
| Grafana | `http://localhost:3000` |

Set services to export locally with:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=router-svc
```

Dashboards are provisioned from `infra/grafana/dashboards`: golden signals, agent-run funnel, and cost. The cost dashboard puts `cost_per_successful_deploy` first because PLAN §9 makes it the north-star metric.

---

## 1. Grafana Cloud free tier

Create a Grafana Cloud stack, then create an access policy token with Metrics, Logs, and Traces write scopes. Grafana shows the exact OTLP endpoint and Basic auth value; copy them into service environment variables:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-REGION.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64-instance-id-api-token>
OTEL_SERVICE_NAME=api
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

Use `OTEL_TRACES_SAMPLER_ARG=1.0` for staging and `0.01`-`0.1` for production until volume is known. Keep high-cardinality or sensitive data out of attributes; the telemetry package only emits tenant-safe IDs and scrubs credentials, tokens, and email addresses.

---

## 2. Alerts

Start with low-noise alerts:

1. **Availability:** 5xx rate greater than 2% for 10 minutes by service.
2. **Latency:** p95 request duration above the service SLO for 15 minutes.
3. **Saturation:** scheduler active leases or queue depth above 80% for 10 minutes.
4. **Sandbox cold starts:** p95 cold-start latency above the expected provider boot time.
5. **Cost:** `cost_per_successful_deploy` above the weekly budget target, and token spend spikes per tenant.
6. **Audit mirror:** WORM verification result is not OK, or any missing audit IDs are detected.

---

## 3. Pull a per-run trace

Every run-level span carries:

- `loopit.tenant_id`
- `loopit.project_id`
- `loopit.run_id`
- `loopit.task_id` when available

In Grafana Cloud, open **Explore → Tempo**, then search:

```text
{resource.service.name="router-svc" && span.loopit.run_id="run_..."}
```

Open the root `loopit.run` trace to replay the path through agent step spans, model-call spans, tool-call spans, sandbox lease spans, and verification-layer spans. Cross-check audit rows by matching `trace_id` once service adoption propagates incoming trace IDs to `AuditEvent.trace_id`.

---

## 4. WORM audit mirror checks

Production should mirror the existing append-only `AuditStore` to object storage after append. Development can use `LocalObjectStore`; tests use `FakeObjectStore`:

```python
mirror = AuditWormMirror(LocalObjectStore(".loopit-audit-worm"))
mirror.mirror_tenant(audit_store, tenant_id="tenant_...")
result = verify_audit_mirror(audit_store, mirror_store, tenant_id="tenant_...")
assert result.ok
```

A failed result means either the database hash chain is invalid, an expected object is missing, or a mirrored object was changed outside the write-once API. Treat all three as incident-grade because I10 depends on audit continuity.
