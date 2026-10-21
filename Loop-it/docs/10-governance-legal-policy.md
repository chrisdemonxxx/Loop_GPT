# 10 — Governance, Legal & Policy

**Purpose:** This doc defines how to run an open, model-unrestricted AI app-builder as a *responsible* platform — one that can offer an uncensored model layer while staying inside the law, its payment processors' and hosting providers' terms, and its own commitments to users. It operationalizes the governance idea from `00-blueprint.md`: **keep model-content policy and infrastructure-abuse policy strictly separate.** You can permit an uncensored *model* while still refusing to be a *malware host* — those are different layers with different controls. Conflating them is the mistake that either neuters your product or gets it taken offline. This doc owns policy, licensing, data handling, jurisdiction, and legal-request process; `08-security-and-abuse-playbook.md` owns the technical enforcement of the infrastructure-abuse side. The hard boundary from `00` holds: "unrestricted" is open model choice + code ownership + capability breadth — never the removal of isolation, tenant separation, egress control, or abuse detection.

---

### 1. The core governance idea: two policies, two layers

The single most important governance decision is to run **two independent policies** with two independent enforcement mechanisms. Do not merge them.

| | Model-content policy | Infrastructure-abuse policy |
|---|---|---|
| **Governs** | What the *model* is willing to generate/say. | What the *platform's compute + network* is allowed to do. |
| **Posture** | Open / uncensored by design (your differentiator). | Strict, non-negotiable (keeps you alive). |
| **Enforced by** | Model choice, jurisdiction limits, narrow legal carve-outs. | Sandbox isolation, egress control, abuse detection, takedown (`08`). |
| **Owner** | Governance + legal (this doc). | Trust & safety + platform security (`08`). |
| **Example** | The model may write a network scanner on request. | The platform will not *run* that scanner against the internet from its infra, and will kill + suspend if it does. |

**Decision rule:** an action is permitted only if it passes **both** policies independently. A permissive model does *not* relax the infrastructure policy, and a strict infrastructure policy does *not* require censoring the model. **Do this:** state this separation explicitly in your public docs and internal runbooks — it is what makes "open model layer" defensible to processors, providers, and regulators. **Don't do this:** try to make the model refuse your way out of an abuse problem; prompt injection and user-pasted code route around model refusals entirely, and infrastructure abuse (`08`) is where the real liability lives.

Narrow model-content limits are still legitimate and, in some jurisdictions, mandatory — e.g., CSAM and content illegal to generate everywhere you operate. These are **legal floors**, not a general content-moderation regime, and they are separate from the infrastructure controls.

#### Why the separation is load-bearing

Three concrete failure modes explain why merging the policies is fatal:

1. **The censorship spiral.** If you try to prevent infrastructure abuse by making the model refuse "bad" requests, you steadily widen refusals until the product is no different from a closed commercial builder — you have destroyed your only differentiator and *still* not stopped abuse.
2. **The refusal-bypass gap.** Model refusals do not stop abuse that arrives another way: a user pastes attacker code directly, a prompt-injection payload (`08` §3.4) hijacks the agent, or a poisoned dependency runs a postinstall script. None of these are gated by the model's willingness. Only infrastructure controls (egress deny, isolation, abuse detection) stop them.
3. **The liability mislocation.** Regulators, processors, and hosts care about what your *infrastructure does* (hosting phishing, emitting spam, mining), not primarily about what your model is willing to type. Putting your defensive effort in the wrong layer leaves the layer that actually creates liability under-defended.

The correct mental model: **the model is allowed to be maximally capable; the platform is not allowed to be maximally permissive with its own compute and network.** Capability lives in the model layer; restraint lives in the execution layer (`02`, `08`).

---

### 2. Acceptable-use policy (AUP) skeleton

Your AUP is the contract that lets you suspend abusers and satisfies processors/hosts that you run a responsible service. Structure it around the two-policy split.

**Section A — Model use (permissive).** The platform offers open-weight models, including low-refusal fine-tunes; the model layer imposes no general content policy beyond legal floors. Users own what they build (see §8).

**Section B — Legal floors (hard, everywhere).** Prohibited regardless of model: generating CSAM; content whose creation is illegal in operating jurisdictions; direct facilitation of imminent physical harm where prohibited by law.

**Section C — Infrastructure abuse (hard, non-negotiable).** Using the platform's compute or network for:
- cryptocurrency mining;
- port/vulnerability scanning of third parties;
- spam or bulk unsolicited messaging;
- command-and-control (C2) infrastructure;
- hosting phishing / credential-harvesting pages;
- denial-of-service, or any use that violates a chosen third-party API's terms.

**Section D — Enforcement.** Detection and automated response per `08` (tiers T0–T3); repeated or severe violation → suspension; evidence preservation; appeal path.

**Section E — Downstream responsibility.** Users are responsible for the apps they build and deploy and for compliance with laws applicable to *their* end users. The platform is responsible for what its own infrastructure does.

**Checklist for a shippable AUP:**
- [ ] Two-policy separation stated explicitly.
- [ ] Legal floors enumerated per jurisdiction.
- [ ] Infrastructure-abuse categories match `08`'s abuse taxonomy exactly.
- [ ] Enforcement tiers + appeal process defined.
- [ ] Cross-references processor/hosting AUP constraints (§4).
- [ ] Reviewed by counsel before launch, not after a suspension.

---

### 3. Per-model license tracking

Open weights are **not** uniformly permissive. Licensing is per-base-model and per-derivative, and it is on you to verify before commercial serving. Track every base model and every fine-tune/abliterated derivative you serve.

#### 3.1 Open-weight license classes

| Class | Examples of terms | What it typically permits | Watch-outs |
|---|---|---|---|
| **Permissive OSI-style** (Apache-2.0, MIT) | No field-of-use limits, commercial use allowed, attribution/notice. | Broad commercial serving, resale, modification. | Preserve notices; still verify the *specific* checkpoint. |
| **Open-weight with community/acceptable-use terms** | Custom licenses with acceptable-use clauses, sometimes scale thresholds. | Commercial use, often with AUP and attribution obligations. | Field-of-use restrictions; user-count/scale triggers; naming/branding rules. |
| **Research / non-commercial** (e.g., some CC-BY-NC checkpoints) | Non-commercial only. | Evaluation and internal research. | **Cannot serve commercially** — a common trap for abliterated community forks. |
| **Restrictive / custom** | Field-of-use carve-outs, resale limits, geographic limits. | Depends entirely on the text. | Read every clause; some forbid exactly what you want to do. |

Derivatives (abliterated / fine-tuned) generally inherit the base license's obligations **plus** anything the derivative adds — you must satisfy both.

#### 3.2 License-tracking process (runbook)

1. **Register** each model in a license ledger before it can be enabled in the router (`03-model-layer-and-serving.md`): base model, checkpoint hash, license class, license URL/text snapshot, commercial-use verdict, obligations (attribution, AUP, scale limits), verifier, date.
2. **Verify** commercial-use permission before enabling for paid serving. If non-commercial or unclear → research-only flag; not servable to customers.
3. **Wire the router** to refuse to route to any model not marked `commercial: verified` in production.
4. **Re-verify** on any new checkpoint or license change; the landscape moves monthly.
5. **Feed** the SAST dependency/license check (`08` §4) so generated apps' dependency licenses are also tracked.

**Do this:** treat "verify each model's license before commercial use" (from `00`/`03`) as a blocking gate in Phase 5 (`09`). **Don't do this:** assume an "open" or "uncensored" community fork is commercially usable — many are non-commercial or inherit restrictive base terms.

---

### 4. Payment-processor & hosting-provider ToS constraints

These bind you **regardless of your model policy.** A permissive model does not exempt you from Stripe's or your cloud provider's acceptable-use terms — and a suspension there ends the business overnight.

**Payment processors** typically prohibit or restrict: adult content, certain regulated goods, high-chargeback categories, and services that facilitate illegal activity. Your open-model stance is fine; hosting confirmed abuse (phishing, malware distribution) is exactly what gets a merchant account frozen.

**Hosting/cloud providers** have their own AUPs prohibiting mining, scanning, C2, spam, and DoS from their infrastructure — the same categories as your Section C. Because your platform's egress originates from *their* network, their AUP is effectively your infrastructure-abuse floor.

**Checklist (do this before launch, not after a suspension):**
- [ ] Read your payment processor's prohibited-business and AUP terms; map any that touch your categories.
- [ ] Read your hosting/cloud provider's AUP; confirm your `08` abuse controls cover everything they prohibit.
- [ ] Ensure your egress allowlist + abuse detection (`08`) demonstrably prevent the provider-prohibited activities.
- [ ] Keep an evidence trail (audit logs, abuse-response records) you can show a processor/provider trust team on request.
- [ ] Have a named contact/process for provider abuse-team correspondence.

**Decision rule:** where a processor/host term is stricter than your own AUP, the stricter term wins — align your AUP up to it.

#### Adult / mature content — a worked example of the two-policy split

Adult content is the case where the two-policy separation is most often mishandled, so treat it explicitly:

- **Model layer:** an open model may be *willing* to generate mature text/content. That is a model-content matter (§1), broadly legal to run.
- **Processor layer:** many payment processors restrict or prohibit adult-content businesses and impose higher-risk terms. If your *platform's paid offering* is characterized as an adult-content service, your merchant account is at risk — independent of your model policy.
- **Resolution:** the model's willingness and your *business categorization with processors* are different questions. Keep the model open; ensure your billed service and its marketing do not trip the processor's prohibited-business classification; enforce the legal floors (§1) regardless. If a jurisdiction or processor requires it, gate specific outputs — a narrow, documented carve-out, not a general content regime.

This same reasoning applies to any category a processor or host flags: separate "what the model can produce" from "what business we are and what our infrastructure hosts."

---

### 5. Data handling

User code and prompts are sensitive. Treat them as confidential customer data.

| Concern | Requirement |
|---|---|
| **Encryption** | Encryption at rest (project files, DB, secrets, logs) and in transit (TLS everywhere). Secrets in the control-plane secrets manager, never ambient in sandboxes (`08` §5). |
| **Tenant isolation** | Per-tenant separation end to end (`02`, `06`, `08`); no shared credentials; authenticated per-project preview URLs. |
| **Retention** | Publish retention windows: active project data retained while the project lives; deleted on user deletion within a stated window. Security/audit logs kept for a separate, forensics-appropriate window (`08` §6). |
| **Deletion** | Honor deletion requests: purge project files, DB, and derived artifacts within the stated window; document what remains (e.g., minimal billing records required by law). |
| **Training-use consent** | If you fine-tune on user traces (Phase 5, `09`), it **must be disclosed and consented** — opt-in, revocable, with a clear description of what is used. Default to *not* training on user data. |
| **Minimization** | Don't log raw secrets or full prompts that may contain secrets; redact at write time (`08` §6). |

**Do this:** make training-use opt-in and separable from using the product. **Don't do this:** quietly train on user code and prompts — it breaks the code-ownership promise (§8) and is a legal/PR landmine.

#### Data-classification map

Tag every data category so retention, encryption, and disclosure rules apply uniformly:

| Category | Sensitivity | Store | Default retention |
|---|---|---|---|
| User prompts & chat | High (may embed secrets/PII) | Control-plane, encrypted, redacted at log time | Project lifetime; purge on deletion |
| Generated code / project files | High (user-owned IP) | Control-plane CoW store, encrypted | Project lifetime; exportable then purged |
| Project secrets | Critical | Secrets manager only; never in sandbox ambient env | Until rotated/deleted |
| Sandbox execution logs | Medium | Append-only, redacted | Forensics window |
| Security/audit logs | Medium | Immutable/WORM (`08` §6) | Forensics + legal window (separate from user content) |
| Billing records | Low content, legally required | Billing system | As law requires (survives user deletion) |
| Fine-tuning traces (if opted in) | High | Isolated, consented dataset | Per consent; revocable |

**Decision rule:** deletion requests purge everything except the minimal legally-required billing records and any data under an active legal preservation order (§7) — and you document exactly what survives.

---

### 6. Jurisdiction considerations

- **Where you operate defines your legal floors.** The narrow model-content carve-outs (§1) and data-protection obligations (§5) vary by jurisdiction; enumerate your operating and target-user jurisdictions and set the floor to the strictest applicable.
- **Data residency & transfer:** know where project data is stored and processed; if you serve regulated regions, plan for residency and cross-border-transfer requirements.
- **Data-protection regimes:** honor access/deletion/portability rights where they apply (portability aligns naturally with the export guarantee in §8).
- **Model-content legality:** an uncensored model is broadly legal to run, but *specific generated content* can be illegal in specific places — the legal floors, not a general content policy, are what you enforce.
- **Decision rule:** when jurisdictions conflict, apply the strictest floor to the shared platform, or geo-fence the difference — never the loosest.

Re-check jurisdiction facts before commercial commitments; law and regulatory guidance move, and this doc's architecture is stable but the legal landscape is not.

---

### 7. Abuse-response & law-enforcement request handling

This is the policy/legal complement to the technical incident response in `08` §7.

**Abuse response (policy side):**
1. Confirmed AUP Section C violation → apply enforcement tier (`08` T0–T3); severe/repeat → suspend under the AUP.
2. Preserve evidence (immutable logs, snapshots) before teardown.
3. For a hosted-abuse target (phishing/malware host), take it down immediately under the AUP and notify the reporter/provider as appropriate.
4. Record the decision and rationale for audit and potential appeal.

**Law-enforcement (LE) request handling (runbook):**
1. **Route** all LE requests to a single named legal contact; front-line staff never respond ad hoc.
2. **Validate** the legal process (correct jurisdiction, valid legal instrument, correct scope). Push back on overbroad requests.
3. **Scope** disclosure to exactly what valid process compels; produce the minimum necessary from audit/data stores.
4. **Preserve** data on a valid preservation request without over-disclosing.
5. **Notify** the affected user where legally permitted (some orders prohibit notice).
6. **Log** every request and response for accountability; publish a transparency summary if you commit to one.
7. **Emergencies:** have a defined path for genuine imminent-harm requests, still validated by legal.

**Do this:** separate "we enforce our AUP" (fast, automated) from "we respond to legal process" (careful, lawyer-gated). **Don't do this:** hand over user data on an informal request without validated legal process.

---

### 8. User code ownership & export guarantees

Code ownership is one of the three pillars of "unrestricted" (`00`) and a genuine differentiator. Make it a hard, contractual guarantee — not a marketing line.

**Guarantees to publish and honor:**
- **The user owns the code they build.** No platform claim to their application code.
- **Full export, no lock-in.** One-click export to Git; the user can take the project and self-host it (`06-control-plane-and-deployment.md` Git sync). Export includes source, schema/migrations, and config — everything needed to run elsewhere.
- **Self-hostability.** The generated stack is one the user can run on their own infrastructure; deployment can target the user's own cloud with their credentials.
- **No hostage data.** On account closure, the user can export first; deletion (§5) happens after, on request.
- **Portability aligns with data-protection rights** (§6) — the export guarantee satisfies portability by design.

**Interaction with training-use (§5):** ownership means you do **not** get to train on their code by default. Any training use is opt-in and separately consented. **Do this:** ship export before you ship paid plans — it builds the trust the open positioning depends on. **Don't do this:** make export lossy or gated behind a higher tier; a partial export is lock-in with extra steps.

#### Export completeness checklist

An export is "lossless" only if a competent developer can run the project elsewhere with no platform dependency beyond documented third-party services:

- [ ] Full application source (frontend + backend).
- [ ] Database schema and migrations (not just a data dump).
- [ ] Seed/fixture data where the app depends on it.
- [ ] Environment/config templates (with secret *names*, never secret *values*).
- [ ] Dependency manifests with pinned versions.
- [ ] A README describing how to run and deploy off-platform.
- [ ] Git history where the user built with Git sync enabled (`06`).

---

### 9. Governance cadence & ownership (RACI)

Governance is not a launch task; it is an ongoing operating discipline. Assign clear ownership and a review cadence.

| Activity | Owner | Cadence |
|---|---|---|
| Model-license ledger review (§3) | Governance + ML | Per new model; quarterly full audit |
| AUP + legal-floor review (§1–2) | Legal | Semi-annual; on jurisdiction change |
| Processor/host ToS re-read (§4) | Legal + ops | Semi-annual; on provider term changes |
| Data retention/deletion audit (§5) | Security + legal | Quarterly |
| Jurisdiction/residency review (§6) | Legal | On market expansion |
| LE-request process rehearsal (§7) | Legal | Annual tabletop |
| Content-vs-abuse policy separation audit (§1) | Governance + trust & safety | Quarterly |

**Decision rule:** any change that would weaken the content-vs-abuse separation (§1), enable a non-`commercial: verified` model (§3), or reduce the export guarantee (§8) requires explicit sign-off from both legal and platform-security leads — these are the three commitments the open positioning rests on.

---

### 10. Governance checklist (launch gate)

- [ ] Model-content policy and infrastructure-abuse policy are separate, documented, and separately enforced.
- [ ] AUP published, counsel-reviewed, abuse categories aligned to `08`'s taxonomy.
- [ ] Legal floors (§1) enumerated per operating jurisdiction and enforced.
- [ ] Per-model license ledger populated; router refuses any model not `commercial: verified`.
- [ ] Payment-processor and hosting-provider AUPs reviewed; your controls cover their prohibitions; stricter term wins.
- [ ] Data handling: encryption at rest/in transit, retention/deletion windows published, training-use opt-in only.
- [ ] Jurisdiction/residency obligations mapped; strictest-floor rule applied.
- [ ] Abuse-response + LE-request runbooks in place and rehearsed (with `08` §7).
- [ ] User code ownership + full lossless export guaranteed and shipped.
- [ ] The whole set is consistent with `00-blueprint.md`'s hard boundary: open model layer, hardened execution layer — never one at the expense of the other.
