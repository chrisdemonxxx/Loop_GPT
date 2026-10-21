# Subprocessors Register

This register requires operator/legal review before publication and is not legal advice.

Populate it with the actual vendors used by a deployment before taking customer data.

| Category | Purpose | Data categories | Region | Replacement/self-host option |
| --- | --- | --- | --- | --- |
| Model endpoint | Code-generation completions through router | Prompts, tool observations, generated code snippets | Operator-selected | Self-hosted vLLM/SGLang |
| Sandbox provider | Isolated app builds and verification | Generated code, test output, sandbox telemetry | Operator-selected | Self-hosted Firecracker |
| Object storage | Checkpoints, exports, WORM audit mirror | Code, artifacts, audit backups | Operator-selected | S3-compatible storage |
| Payments | Checkout, invoices, subscription state | Billing/contact records, plan metadata | Processor-selected | Manual invoicing for self-host |
| Telemetry | Traces, metrics, logs | Service telemetry, run IDs, error categories | Operator-selected | Grafana stack |
| Email/support | Account, support, security intake | Contact details and support content | Operator-selected | Self-hosted mail/helpdesk |

Self-hosted/VPC operators should replace hosted services with their chosen model endpoint, sandbox provider,
object storage, telemetry, email, and payment processors.
