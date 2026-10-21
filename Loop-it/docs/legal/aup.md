# Loop-it Acceptable Use Policy

**Version:** 2026-09-05  
**Applies to:** self-hosted and hosted Loop-it control planes operated for authorized organizations.

This AUP is the contract that lets an operator suspend infrastructure abusers without changing model-content policy (invariant I11). Model capability and infrastructure restraint are separate layers.

## A — Model use (permissive)

Loop-it offers an open model catalogue, including low-refusal weights, for authorized red-team, research, and software-building workloads. The model layer imposes no general content policy beyond the legal floors in section B. Users own the code they generate.

## B — Legal floors (hard, everywhere)

Prohibited regardless of model:

- Generating child sexual abuse material.
- Content whose creation is illegal in the operating jurisdiction.
- Direct facilitation of imminent physical harm where prohibited by law.

These are legal floors, not a general moderation regime.

## C — Infrastructure abuse (hard, non-negotiable)

Using Loop-it's compute, network, sandboxes, previews, or deploy targets for:

- cryptocurrency mining;
- port or vulnerability scanning of third parties;
- spam or bulk unsolicited messaging;
- command-and-control infrastructure;
- hosting phishing or credential-harvesting pages;
- denial-of-service;
- any use that violates a chosen third-party API's terms.

Sandbox egress is default-deny. Confirmation gates (I7) still apply to deploy, secrets, spend, and destructive shell.

## D — Enforcement

Signals are classified by `services/abuse-engine` (tiers T0–T3). Repeated or severe violation may suspend the tenant, kill sandboxes, and preserve audit evidence. Appeals go to the operator's designated abuse inbox.

## E — Downstream responsibility

Users are responsible for the apps they build and deploy and for laws that apply to *their* end users. The platform is responsible for what its own infrastructure does.

Accepting this policy is required to create a Loop-it organization when `LOOPIT_ENV=production` or `LOOPIT_REQUIRE_AUP=1`.
