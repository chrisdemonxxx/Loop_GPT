# 07 — Operations Runbook (Day-2)

**Purpose:** The architecture and build are done; now the platform has to *stay up, stay solvent, and stay uncompromised* while running untrusted AI-generated code at scale. This is the on-call operator's book: concrete incident-response runbooks (sandbox-escape suspicion, GPU exhaustion, runaway costs, model-endpoint outage, abuse spike), warm-pool and capacity management, cost dashboards with **cost-per-successful-deploy** as the north star, on-call checklists, backup/restore and checkpoint recovery, and the upgrade/rollout procedure for both models and platform code. It operationalizes the economics-and-operations guidance of the research playbook (Section 7) under the master index `00-blueprint.md`, and depends on the planes (`01`), sandbox controls (`02`), serving layer (`03`), eval gate (`05`), and control plane (`06`).

> **Operating principle:** When in doubt, **contain the data plane, protect the control plane.** The control plane never runs generated code (`01-architecture-blueprint.md`); most incidents are contained by isolating or draining sandboxes without touching control-plane integrity. "Unrestricted" model choice never suspends isolation, egress control, or abuse response — those are the controls you lean on hardest during an incident.

---

### 1. Severity, roles, and the golden signals

#### 1.1 Severity ladder

| Sev | Meaning | Examples | Page? |
|---|---|---|---|
| **SEV-1** | Active compromise or full outage | Suspected sandbox escape; metadata-endpoint hit; control-plane down | Page immediately, wake people |
| **SEV-2** | Major degradation / financial risk | Model endpoint outage; runaway cost; GPU exhaustion blocking runs | Page on-call |
| **SEV-3** | Partial degradation | Elevated iteration counts; warm pool undersized; single-region latency | Business hours |
| **SEV-4** | Minor / cosmetic | Dashboard lag; non-blocking eval warning | Ticket |

#### 1.2 Roles during an incident

- **Incident Commander (IC):** owns decisions, declares sev, coordinates. Not hands-on-keyboard.
- **Operator:** executes runbook steps.
- **Scribe:** timestamps actions in the incident channel (feeds the post-mortem and the audit trail from `06`/`08`).
- **Comms:** status page + affected-tenant messaging (SEV-1/2).

#### 1.3 Golden signals to watch (always-on dashboards)

| Signal | Source | Alarm |
|---|---|---|
| Sandbox egress denials / anomalies | Egress firewall logs (`02`) | Spike, or any hit to `169.254.169.254` |
| GPU utilization & queue depth | Inference backends (`03`) | Util >85% sustained; queue depth rising |
| Cost per successful deploy | Billing + eval join (`05`,`06`) | >20% above 7-day baseline |
| Model endpoint health/latency | Router health checks (`03`) | Error rate >2%, p95 latency 2× baseline |
| Warm-pool availability | Scheduler | Pool draw-down faster than refill |
| Human-intervention rate | Eval/run telemetry (`05`) | Sudden rise (loop degraded) |

---

### 2. Incident runbooks

Each runbook: **detect → contain → diagnose → recover → post.** Run them top-to-bottom; containment before diagnosis.

#### 2.1 Sandbox escape suspicion (SEV-1)

**Detect:** egress firewall shows a hit to the cloud metadata endpoint (`169.254.169.254`) or an off-allowlist destination; unexpected syscalls/host-process anomalies; a sandbox reaching a control-plane endpoint it shouldn't.

**Contain (do this first, in order):**
1. **Freeze the suspect sandbox** — do not destroy yet; snapshot for forensics if the platform supports it, else preserve logs.
2. **Isolate at the network layer** — cut the sandbox's egress entirely (default-deny already blocks most; assert it).
3. **Quarantine the host** — drain the host of *other* tenants' sandboxes to fresh hosts; stop scheduling new sandboxes onto it.
4. **Rotate any credential that could conceivably have been exposed** — even though the sandbox holds no ambient creds (`02`,`06`), rotate model-router-adjacent and any build-step secrets used recently, out of caution.
5. **Assert the metadata block and egress allowlist are intact** fleet-wide (a config regression is the classic root cause).

**Diagnose:** review the audit log (`06`) and egress logs for what the sandbox attempted; determine if it was *attempted* vs. *successful* escape; check whether tenant isolation held (any cross-tenant access in logs?).

**Recover:** destroy the quarantined sandbox; rebuild the host from a known-good image if host integrity is in question; confirm no other tenant was touched before restoring scheduling.

**Post:** SEV-1 post-mortem; add a detection/regression test; if a control gap enabled it, gate the fix through the platform-change process (§7) and coordinate with `08-security-and-abuse-playbook.md`.

**Don't:** destroy evidence before snapshotting; assume "just one sandbox" without checking the host and neighbors; skip the fleet-wide metadata/egress assertion.

#### 2.2 GPU exhaustion (SEV-2)

**Detect:** GPU utilization pinned; inference queue depth climbing; run latency ballooning; new runs stalling at the model-call step.

**Contain:**
1. **Shed low-value load first:** pause the internal eval harness's non-gating nightly runs; deprioritize background/batch work.
2. **Enforce routing discipline:** confirm the router (`03`) isn't sending trivial edits to the largest model — misrouting is a common self-inflicted cause.
3. **Apply/verify per-tenant quota** so one tenant can't starve the fleet (`06` billing/quota).

**Diagnose:** is it demand (real traffic spike) or supply (an endpoint down, forcing pile-up on the rest)? Check §2.4 if an endpoint is unhealthy.

**Recover:** scale up GPU capacity / add endpoint replicas; if capacity is hard-capped, queue with backpressure and communicate elevated latency rather than dropping runs. Restore shed load once util normalizes.

**Don't:** disable prefix caching to "free memory" (you lose the KV-cache reuse that reduces load); let one tenant monopolize; silently drop in-flight runs.

#### 2.3 Runaway costs (SEV-2)

**Detect:** cost-per-successful-deploy dashboard >20% over baseline; token spend or GPU-hours spiking; a forgotten always-on endpoint.

**Contain:**
1. **Find the driver:** split cost by model, tenant, and run. The three usual culprits: (a) a forgotten running endpoint that never scaled to zero, (b) a routing regression sending everything to the big model, (c) a run stuck in a verify→fix loop past its cap.
2. **Kill the obvious waste:** pause idle endpoints (scale-to-zero); confirm iteration caps and oscillation detection are firing (`05`); enforce per-tenant/plan quota (`06`).
3. **Cap the bleed:** if a single tenant or run is responsible, apply an emergency quota/kill.

**Diagnose:** attribute spend to the root cause with the cost dashboard (§4). "Cost per token" is a distraction — anchor on cost per *successful deploy*.

**Recover:** fix routing policy / add scale-to-zero / tighten iteration caps; re-baseline once normal.

**Don't:** chase token price while ignoring iteration count — a cheap model that needs 9 iterations is more expensive than a pricey one that needs 2. **Don't** leave endpoints running "just in case."

#### 2.4 Model endpoint outage (SEV-2)

**Detect:** router health checks failing; error rate/latency past alarm; runs failing at the model-call step.

**Contain:**
1. **Fail over via the router** (`03`): route affected traffic to a healthy alternate model/endpoint. This is why the router-in-front and swappable-model design exists.
2. **Degrade gracefully:** if only the largest planner model is down, temporarily route planning to the next-best available and flag reduced quality rather than halting.
3. **Pause new runs** only if no viable alternate exists; queue with backpressure.

**Diagnose:** provider-side outage vs. our config (bad deploy, expired credential, quota). Check the recent rollout log (§7) — a model rollout is a prime suspect.

**Recover:** restore/replace the endpoint; if a rollout caused it, roll back per §7.3; drain the queue.

**Don't:** hard-fail runs when a healthy alternate exists; forget that a recent model rollout is the likeliest cause.

#### 2.5 Abuse spike (SEV-1/2)

**Detect:** egress anomalies (known mining-pool traffic, mass outbound scanning, spam/C2 shapes); sustained max-CPU crypto-miner-shaped workloads; a burst of sign-ups driving identical suspicious builds.

**Contain:**
1. **Auto-kill miner-shaped workloads** (sustained max CPU + known pool traffic) — this should already be automatic (`02`); assert it fired.
2. **Tighten egress** for implicated tenants/sandboxes to the minimal allowlist; block the abusive destinations fleet-wide.
3. **Rate-limit / suspend** the abusing tenant(s) via quota and platform auth (`06`).

**Diagnose:** distinguish **infrastructure abuse** (mining, scanning, C2, spam — always in scope to stop) from **model-content** questions (a policy matter for `10-governance-legal-policy.md`). Keep these separate: an uncensored model layer does not mean tolerating a malware host.

**Recover:** terminate abusive sandboxes; apply account action per the abuse-response process; file to `08-security-and-abuse-playbook.md`'s process for repeat patterns.

**Don't:** conflate model-content policy with infrastructure-abuse policy; let egress default-deny be the *only* line — active detection matters too.

---

### 3. Capacity and warm-pool management

Firecracker microVMs boot in **<125 ms** with **<5 MiB** memory overhead each, and a host can create **up to 150 microVMs/s** (verified official figures, Aug 17, 2026). Cold start is cheap but not free at scale, so keep a **warm pool**.

**Warm-pool policy:**

- **Size to demand, not to peak.** Default: warm pool = rolling p95 of concurrent new-sandbox starts over the last 15 min, floored at a small constant (e.g. 5) so the first user of a quiet period isn't cold.
- **Recycle ephemerally.** Sandboxes are cattle: a warm sandbox is a *clean* base image with no tenant state. On lease, it's bound to one tenant/run (`06`); on release, it's destroyed, never reused across tenants.
- **Refill continuously.** The scheduler tops the pool back to target as leases draw it down; alarm if draw-down outpaces refill (undersized pool → cold-start latency).
- **Cap the pool** so idle warm capacity doesn't itself become a cost leak; scale-to-zero the pool floor during sustained idle windows.

**Capacity decision rules:**

- Scale-to-zero everything idle — GPU endpoints *and* sandbox warm pools.
- GPU capacity: watch quota "like a hawk" in a managed-endpoints phase; a forgotten running endpoint is the classic surprise bill (ties to §2.3).
- Add inference replicas when GPU util is >85% sustained *and* prefix-cache hit rate is already healthy (add capacity, don't sacrifice caching).

---

### 4. Cost dashboards — cost-per-successful-deploy is the north star

**Track cost per successful deploy, not cost per token.** A cheap model that needs 9 iterations is more expensive than an expensive one that needs 2. This single metric aligns ops with the eval KPIs in `05-verification-and-evals.md`.

**Dashboards to maintain:**

| Dashboard | Metric | Breakdown | North-star tie |
|---|---|---|---|
| **Cost per successful deploy** | total compute + model $ ÷ successful deploys | by tier, model config, tenant | primary — the number that decides model/routing changes |
| Spend attribution | $ | by model, tenant, run | find runaway drivers (§2.3) |
| GPU-hours & idle | endpoint-hours, % idle | by endpoint | catch forgotten endpoints |
| Iteration count | mean verify→fix cycles | by tier | rising = cost rising even at flat token price (`05`) |
| Warm-pool efficiency | warm vs. used | over time | right-size the pool (§3) |

**Decision rules:**

- Evaluate any model/routing change on **cost per successful deploy at equal-or-better success rate** — never on token price alone (mirrors the model-selection method in `03` and the eval gate in `05`).
- Alarm cost-per-successful-deploy at +20% over 7-day baseline; open a SEV-2 if it doesn't self-correct within an hour.

---

### 5. On-call checklists

#### 5.1 Start-of-shift

- [ ] Golden-signal dashboards (§1.3) green; note any active SEV-3/4.
- [ ] Egress-denial log clean; **zero** metadata-endpoint hits.
- [ ] GPU util and queue depth nominal; no forgotten always-on endpoints.
- [ ] Cost-per-successful-deploy within baseline.
- [ ] Warm pool at target; refill keeping up.
- [ ] Any rollout in progress (§7) noted with its rollback handle.
- [ ] Recent eval-gate results green (`05`); no unacknowledged regressions.

#### 5.2 During any incident

- [ ] Declare severity; assign IC / Operator / Scribe / Comms.
- [ ] **Contain before diagnose** — isolate the data plane, protect the control plane.
- [ ] Scribe timestamps every action (feeds audit + post-mortem).
- [ ] Status page updated for SEV-1/2.
- [ ] Follow the matching §2 runbook top-to-bottom.

#### 5.3 End-of-incident

- [ ] Recovery verified against golden signals; re-baseline metrics.
- [ ] Shed/paused load restored.
- [ ] Post-mortem scheduled (mandatory for SEV-1/2); action items filed.
- [ ] If a platform/model change was implicated, route the fix through §7.

---

### 6. Backup, restore, and checkpoint recovery

Two distinct things: **control-plane durable state** (users, projects, billing, audit) and **project state** (CoW checkpoints, from `06`).

#### 6.1 Control-plane state

- **Back up** control-plane databases (auth, projects, billing, audit) on the standard managed cadence; audit log is append-only and additionally shipped to immutable storage.
- **Test restore** on a schedule — an untested backup is a hope, not a backup. Quarterly restore drill into an isolated environment; measure RTO.

#### 6.2 Project checkpoint recovery (runbook)

Checkpoints are immutable CoW snapshots of project files (+ DB snapshot where relevant), per `06-control-plane-and-deployment.md`.

1. **Identify** the target checkpoint (last labeled/milestone, or last verified-good — L0–L2 green per `05`).
2. **Verify** the checkpoint's CoW ref and DB snapshot ref are intact and consistent (files and schema from the same snapshot).
3. **Fork** a fresh working set from the checkpoint into a new sandbox (never restore into a live/suspect sandbox).
4. **Validate** by running the per-run verification loop (`05`) against the restored state before handing it back.
5. **Rebind** the project's current pointer to the restored working set once validated.

**Rules:** never prune a checkpoint referenced by an open Run; DB snapshot must be restored *with* its matching filesystem snapshot (consistency), never independently.

---

### 7. Upgrade / rollout procedure

Two rollout tracks — **models** and **platform code** — both gated by the eval harness (`05-verification-and-evals.md`). Nothing big-bangs into production.

#### 7.1 Common rules

- Every gated change (model, prompt, tool, sandbox image, verifier, router policy) passes the eval-harness regression gate **before** any traffic (`05` §5).
- Every rollout has a documented **rollback handle** recorded before it starts.
- Announce in the on-call channel; note it on the shift checklist (§5.1).

#### 7.2 Model rollout (runbook)

1. **Offline gate:** new model/serving-config passes the full eval suite (all tiers, N=3) with no threshold-breaching regression (`05`).
2. **Stage:** deploy the endpoint behind the router (`03`) with scale-to-zero; health-check green.
3. **Canary:** route a small % of real runs to the new model; watch live **success rate** and **cost-per-successful-deploy** vs. incumbent (§4, `05`).
4. **Promote or roll back:**
   - Promote by ramping the router weight if canary KPIs hold.
   - **Auto-rollback** (revert router weight to incumbent) if canary KPIs regress past threshold.
5. **Confirm** golden signals and cost dashboards post-promotion.

#### 7.3 Platform-code rollout (runbook)

1. **Eval gate green** on the PR (`05` §5) — merge blocked otherwise.
2. **Canary deploy** to a subset of control-plane instances / a canary region.
3. **Watch** golden signals (§1.3): egress denials, error rates, cost, human-intervention rate.
4. **Progressive rollout** if canary healthy; **rollback** to the prior release on regression.
5. **Sandbox base-image changes** are treated as gated platform changes: rebuild the image, pass the eval gate, roll out via warm-pool replacement (drain old-image warm sandboxes, refill with new).

#### 7.3.1 Rollback rules

- Rollback is always available and always tested; a rollout without a tested rollback does not ship.
- Prefer **automatic** rollback on threshold breach over manual judgment during an incident.
- After any rollback, open a post-mortem and re-gate the fix before re-attempting.

---

### 8. Operations checklist (master)

- [ ] Golden-signal dashboards live; metadata-endpoint hits alarm instantly.
- [ ] Every §2 runbook rehearsed; contain-before-diagnose is muscle memory.
- [ ] Warm pool sized to p95 demand, recycled ephemerally, capped, scale-to-zero when idle.
- [ ] Cost-per-successful-deploy is the north-star dashboard; alarms at +20%.
- [ ] Scale-to-zero enforced on GPU endpoints and warm pools; no forgotten endpoints.
- [ ] Control-plane backups + quarterly tested restores; audit log immutable.
- [ ] Checkpoint recovery restores files+DB snapshot consistently, validated by the verification loop.
- [ ] Model and platform rollouts pass the eval gate, canary first, auto-rollback on regression, rollback handle recorded.
- [ ] Infrastructure-abuse response is active and kept separate from model-content policy.

---

### 9. Cross-references

- `00-blueprint.md` — master index; research playbook Section 7 (economics and operations).
- `01-architecture-blueprint.md` — plane separation; contain-data-plane / protect-control-plane.
- `02-sandbox-and-isolation.md` — egress default-deny, metadata block, miner auto-kill, ephemerality.
- `03-model-layer-and-serving.md` — router, failover, scale-to-zero, prefix caching, model selection.
- `05-verification-and-evals.md` — eval gate, KPIs, cost-per-successful-deploy, iteration caps.
- `06-control-plane-and-deployment.md` — data model, checkpoints/forks, secrets, quota, audit log.
- `08-security-and-abuse-playbook.md` — abuse-response process; sandbox-escape forensics.
- `09-execution-roadmap.md` — when warm pools, dashboards, and rollout gating come online.
- `10-governance-legal-policy.md` — model-content vs. infrastructure-abuse policy boundary.
