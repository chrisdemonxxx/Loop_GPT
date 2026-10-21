# 02 — Sandbox and Isolation

**Purpose.** The sandbox is the part you cannot cut. This doc specifies the data-plane execution substrate that runs untrusted, agent-generated code: the isolation ladder with verified figures, the sandbox lifecycle (pool → lease → recycle), copy-on-write filesystem and checkpoints, egress control (default-deny + allowlist categories), metadata-endpoint blocking, resource caps and miner detection, the four threat classes, and structural prompt-injection mitigations mapped to the OWASP GenAI LLM Top 10 (2026). It is the concrete build-out of Layer 4 and the data-plane trust boundary from `01-architecture-blueprint.md`. Nothing here is optional for a public platform.

---

### 0. The framing that keeps you honest

"Unrestricted" means open model choice, code ownership, and capability breadth — never removal of isolation. The model layer (`03-model-layer-and-serving.md`) can be willing to write anything; **the sandbox still must not let that code touch your control plane or another tenant.** A platform that runs arbitrary AI-generated code with no isolation becomes a botnet, a crypto-miner host, and a data-exfiltration relay within hours of going public. Uncensored model, hardened execution. These are orthogonal and you build both.

**Do this:** treat every byte the agent generates or fetches as hostile. **Don't do this:** assume "our own agent wrote it, so it's safe" — prompt injection (Section 8) means the agent can be turned against you.

---

### 1. The isolation ladder

From weakest to strongest. Figures for Firecracker are **verified against official project figures as of Aug 17, 2026**.

| Option | Isolation strength | Cold start | Overhead | Best for |
|---|---|---|---|---|
| **Plain Docker** | Weakest — shared host kernel; a kernel exploit escapes to host | fast | low | **Not sufficient alone** for untrusted multi-tenant code |
| **gVisor** | Strong — userspace kernel intercepts syscalls; smaller kernel attack surface | low overhead | moderate | Good middle ground; some syscall-compat gaps |
| **Kata Containers** | Strong — a real VM per container, OCI-compatible | moderate | higher (full VM) | Container ergonomics with a VM boundary |
| **Firecracker microVMs** | Strong — minimal-device KVM VMs | **< 125 ms boot** | **< 5 MiB per microVM** | The gold standard for this workload |

**Verified Firecracker figures (official project, Aug 17, 2026):** boot **< 125 ms**, memory overhead **< 5 MiB per microVM**, creation rate **up to 150 microVMs/s per host**. These density and start-time numbers are why microVMs make ephemeral, per-fork sandboxing economically viable.

#### Decision rule

- **Untrusted multi-tenant execution → Firecracker microVMs** (or a Firecracker-based sandbox provider). This is the default.
- **Must ship this week on containers → wrap in gVisor** and treat it as explicitly temporary technical debt with a ticket to migrate.
- **Never** run tenant code in bare Docker sharing the host kernel. A single kernel CVE is a full host compromise.

The runtime choice matters, but the controls in Sections 3–7 matter *more*: a perfectly isolated VM with an open egress path and reachable metadata endpoint is still a disaster.

---

### 2. Sandbox lifecycle: pool → lease → recycle

Sandboxes are **cattle, not pets**. One project (or one fork) gets a fresh sandbox; it is destroyed after. Durable state lives in the CoW project filesystem (Section 4), not in a long-lived VM.

```
   ┌──────────┐  provision (warm)   ┌──────────┐  lease (per run/fork)  ┌──────────┐
   │  POOL    │────────────────────▶│  LEASED  │───────────────────────▶│ RUNNING  │
   │ (warm N) │                     │ (caps set)│                        │ (agent)  │
   └────▲─────┘                     └──────────┘                         └────┬─────┘
        │ refill to target                                                    │ done / timeout / kill
        │                                          ┌──────────┐               │
        └──────────────────────────────────────── │ RECYCLE  │◀──────────────┘
                              destroy microVM      └──────────┘
                              (never reuse dirty state)
```

#### Pool

- Maintain a **warm pool** sized to demand. Cold start even at ~125 ms adds up under concurrency, and dependency-warmed base images save far more than the boot itself.
- Warm images are pre-baked with the opinionated stack's toolchain (Node/Python, package caches, Playwright browsers) so the first build step isn't a cold `npm install`.
- Autoscale the pool from the sandbox scheduler (control plane, `01`), targeting a small buffer above observed concurrency. Scale-to-near-zero when idle (`07`).

#### Lease

- The scheduler assigns a warm sandbox to a Run/Task, sets **resource caps** (Section 6), mounts a **CoW view** of the project filesystem (Section 4), and applies the **egress policy** (Section 5).
- The lease carries a **TTL** and a least-privilege RPC channel back to the control plane. No platform, cloud, or tenant credentials are placed in the sandbox.

#### Recycle

- On completion, timeout, or kill-switch trip, **destroy the microVM**. Never return a used sandbox to the pool for another tenant — dirty state is a cross-tenant leak.
- Persist only the CoW filesystem delta as a Checkpoint if the state was green (Section 4).
- Refill the pool asynchronously to maintain the warm target.

**Do this:** one fresh sandbox per fork, destroyed after. **Don't do this:** reuse a warm sandbox across tenants or keep a "convenient" long-lived VM with project state in it.

---

### 3. No ambient credentials

The sandbox never holds your platform's cloud keys, DB admin creds, or other tenants' secrets. It reaches the model **only** through the control-plane router (`03`), which injects credentials server-side and enforces quota. A specific build secret is injected **just-in-time** only when a specific step genuinely needs it, and removed after (`06`).

- **Do this:** server-side credential injection at the router; per-step secret injection with immediate scope.
- **Don't do this:** mount a cloud service-account key, a shared registry token with write scope, or a `.env` full of every provider key into the sandbox.

This single discipline is what turns a hypothetical sandbox escape from "full account takeover" into "attacker got a throwaway VM with no keys and no egress."

---

### 4. Copy-on-write filesystem and checkpoints

CoW is the mechanism that makes forks, parallel task agents, and "undo the last hour" affordable (`01` data model; `04` parallel agents).

- **Project filesystem is CoW.** Each fork gets a copy-on-write view of a base checkpoint; only changed blocks consume space.
- **Checkpoints** are immutable snapshots of the CoW filesystem (and, where relevant, the project DB) taken on green states. They form a tree via `parent_id` (`01`), giving cheap rollback and branch points.
- **Parallel task agents** each run on their own CoW fork of the same checkpoint, then merge under a verification gate (`04`). No fork sees another fork's in-progress writes.

**Runbook — checkpoint & rollback:**
1. After verification passes (`05`), the orchestrator issues `snapshot(project_fs)` → new immutable Checkpoint C_n with `parent = C_{n-1}`.
2. To fork for a parallel task: `cow_view(C_n)` → new sandbox filesystem, zero-copy until first write.
3. To roll back: point the project's working ref at C_k; later checkpoints remain in the tree (nothing destroyed, undo is reversible).

Keep checkpoints in the data-plane storage layer, not on the sandbox VM itself — the VM is ephemeral.

---

### 5. Egress control — the single highest-leverage measure

Default-deny outbound network is the control most often skipped and the one that neutralizes most exfiltration, command-and-control, and abuse-as-a-service scenarios at once. It is worth more than the runtime choice.

#### Design: default-deny + categorized allowlist

Deny all outbound by default. Allow only what a build genuinely needs, by category, resolved through a **filtering egress proxy** (so you allowlist by domain/category, not raw IP, and can log every request for abuse forensics).

| Allowlist category | Examples of what it covers | Notes |
|---|---|---|
| **Package registries** | npm, PyPI, crates, Go proxy, distro mirrors | Read-only; pin to official mirrors. Mirror/cache them to cut egress and speed builds. |
| **Model endpoints (via control plane)** | The router's inference API only | Never a direct third-party model API from the sandbox. |
| **Explicitly chosen app APIs** | APIs the *build* legitimately integrates (e.g., a payments SDK's docs/test endpoint) | Per-project, opt-in, logged. |
| **Deploy/Git targets** | Only at explicit deploy time, with the app's own creds | Not open during general build. |

Everything else — arbitrary internet, other tenants' preview URLs, internal service ranges — is **denied**.

- **Do this:** default-deny, allowlist by category through a logging proxy, cache registries.
- **Don't do this:** "allow all outbound, we'll monitor it." Monitoring without blocking is how you find out about the botnet after the abuse report.

#### Metadata-endpoint blocking (non-negotiable)

Block the cloud metadata endpoint — `169.254.169.254` and all provider equivalents (including IMDSv2 hop-limit hardening, link-local ranges, and any provider-specific metadata hostnames). Unblocked, it is a direct route to your infrastructure's credentials and is the classic single misconfiguration that turns a sandbox escape into a full account takeover.

**Verify with a red-team check (`07`, `08`):** from inside a sandbox, `curl http://169.254.169.254/...` must fail closed. Make this a standing test in the eval/red-team suite.

---

### 6. Resource caps and miner detection

Per-run limits plus behavior-based kill switches keep one tenant from starving the host or running a mining farm on your GPUs/CPUs.

#### Caps (set at lease time)

| Resource | Default posture | Rationale |
|---|---|---|
| CPU | Hard quota per sandbox | Prevents host starvation; baseline for miner detection |
| Memory | Hard cap (+ OOM kill) | Firecracker overhead is < 5 MiB, so the cap is for the workload, not the VM |
| Disk | Quota on the CoW delta | Bounds runaway artifact/log growth |
| Wall-clock | TTL per run/step | No infinite loops holding a lease forever |
| Concurrency | Per-tenant sandbox count | Rate-limits abuse fan-out |

#### Miner / abuse detection

Terminate crypto-miner-shaped and scan-shaped workloads automatically:

- **Sustained max CPU** with no corresponding build/test progress → suspicious.
- **Known mining-pool traffic shapes / destinations** (caught at the egress proxy since default-deny already blocks them) → alert + kill.
- **Mass outbound connection fan-out** (port scanning, spam) → kill + flag tenant for abuse review (`08`).
- **GPU utilization from a sandbox that has no legitimate GPU task** → kill.

**Do this:** couple the CPU cap with a "no build progress + max CPU" heuristic and an egress-proxy denylist of mining pools. **Don't do this:** rely on CPU caps alone — a capped miner is still a miner, just a slower one; the egress + behavior signals are what actually stop abuse.

Every kill-switch event goes to the audit log for abuse response (`08`).

---

### 7. Four distinct threat classes

Keep these separate in your head; they have different owners and different mitigations.

| # | Threat class | What it is | Primary mitigation | Owned by |
|---|---|---|---|---|
| 1 | **Control-plane compromise** | Generated code reaching API/orchestrator/secrets | The entire plane separation (`01`) + no ambient creds + egress + metadata block | This doc + `01` |
| 2 | **Tenant escape** | One project reaching another's data/sandbox | Per-tenant isolation, no shared sandboxes for untrusted code, no shared creds, namespace + network policy | This doc + `08` |
| 3 | **App-level vulnerabilities** | Bugs in the *generated* app (SQLi, missing RLS, secrets in client) | SAST pass on output + safe-by-default templates (parameterized queries, RLS on by default) | `05`, `06`, `08` |
| 4 | **Infrastructure abuse** | Platform compute/network used for mining, scanning, spam, C2, phishing hosting | Default-deny egress + abuse detection/response (taxonomy in `08`) | `08` |

**Model misuse** — the model producing disallowed *content* — is deliberately **not** a threat class in this taxonomy: it is a policy/jurisdiction question owned by `10-governance-legal-policy.md`, completely separate from the four infrastructure threats above. The critical insight: model misuse is not solved by the sandbox, and threats 1–4 are not solved by model content policy. Conflating "the model will write anything" with "the platform will do anything" is the mistake that either neuters the product or gets it taken offline. Model openness lives in `03`/`10`; execution hardening lives here.

---

### 8. Prompt injection — an architectural threat, not a content-filter problem

A malicious webpage, README, dependency, or tool output that the agent reads can hijack it into running attacker instructions. You do not "filter" your way out of this; you constrain it structurally. This maps directly to the **OWASP GenAI LLM Top 10 — current release is the 2026 list** (verified against the OWASP GenAI project, Aug 17, 2026), where **Prompt Injection** and **Excessive Agency** are the key agentic risks.

#### Structural mitigations mapped to OWASP GenAI 2026

| OWASP GenAI 2026 risk | Structural mitigation (do this) | Anti-pattern (don't do this) |
|---|---|---|
| **Prompt Injection** | Treat *all* fetched/tool-returned content as untrusted **data**, never as instructions. Keep a hard boundary between the trusted system/task prompt and any retrieved content. | Concatenating a fetched README straight into the instruction context and letting it steer tool use. |
| **Excessive Agency** | Least-privilege tools; each tool does one narrow thing. Confirmation gates on destructive/irreversible actions (delete, deploy, spend, external write) — see `04`. | Giving the agent a broad "run anything" tool plus ambient credentials. |
| **Improper Output Handling** | Apply diffs through validators; never let tool output silently escalate permissions or rewrite the egress/allowlist policy. | Letting a build step edit its own sandbox's network policy. |
| **Supply-chain (deps)** | Install only through the allowlisted registry proxy; pin and, where possible, cache/mirror. SAST on generated code. | `curl | bash` from an arbitrary URL (blocked by default-deny anyway — keep it that way). |
| **Sensitive info disclosure** | No ambient credentials to leak (Section 3); default-deny egress means an injected exfil attempt has nowhere to send. | Secrets broadcast into the sandbox "for convenience." |

#### The load-bearing principle

**Never let tool output silently escalate permissions.** Injection can make the *model* want to do something dangerous; the platform's answer is that the dangerous thing requires a permission the sandbox structurally does not have (no egress to the exfil target, no credential to steal, no route to the control plane, and a human gate on anything destructive). The model's willingness is irrelevant when the capability is absent.

---

### 9. Isolation checklist (enforce from day one)

- [ ] Untrusted code runs in Firecracker microVMs (or gVisor as explicitly temporary), **never** bare Docker.
- [ ] One fresh sandbox per project/fork; destroyed on completion (pool → lease → recycle).
- [ ] No ambient platform/cloud/tenant credentials in any sandbox.
- [ ] Default-deny egress; allowlist by category (registries, router, chosen APIs, deploy) through a logging proxy.
- [ ] Metadata endpoint (`169.254.169.254` + provider equivalents) blocked and red-team-verified to fail closed.
- [ ] Registries mirrored/cached; no arbitrary internet.
- [ ] Resource caps (CPU/mem/disk/wall-clock/concurrency) set at lease time.
- [ ] Miner/scan detection: "max CPU + no build progress", mining-pool egress denylist, fan-out kill switch, unexpected-GPU kill.
- [ ] All fetched/tool content treated as untrusted data; system prompt boundary enforced.
- [ ] Least-privilege tools + confirmation gates on destructive/irreversible actions (`04`).
- [ ] CoW checkpoints on green states; rollback/fork reversible; state never lives only on the VM.
- [ ] Every kill-switch and gate decision written to the append-only audit log (`07`, `08`).

If a red-team pass can escape the sandbox, reach the metadata endpoint, or touch another tenant, none of the rest of the platform matters yet. Fix this first (`09` Phase 4 gate).
