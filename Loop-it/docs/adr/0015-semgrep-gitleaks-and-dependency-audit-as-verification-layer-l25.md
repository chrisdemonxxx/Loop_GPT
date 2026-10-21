# ADR-0015: Semgrep, gitleaks, and dependency audit as verification layer L2.5

- **Status:** Accepted
- **Date:** 2026-08-23
- **Deciders:** Founding engineering
- **Handbook refs:** `docs/08-security-and-abuse-playbook.md` §4
- **Invariants touched:** I9

## Context

Threat class 3 is vulnerabilities in the generated app itself - SQL injection, missing row-level security, secrets embedded in client code. Safe-by-default templates prevent most of it, but generated code still needs an automated security pass before it can be shown as green or deployed.

## Decision

We will run Semgrep (with a ruleset targeting our one supported stack), gitleaks for secret detection, and package-manager dependency audits inside the sandbox as verification layer L2.5, positioned after tests and before deploy. Findings block the green state and feed back into the loop as observations.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Manual review | Thorough | Does not scale to agent output volume | Not viable |
| Commercial SAST | Deeper analysis | Cost per scan at our volume; sends generated code to a third party | Rejected on both cost and data handling |
| Rely on templates alone | Free | Templates cannot cover agent-authored logic | Necessary but not sufficient |

## Consequences

**Positive:** Generated apps ship with fewer injectable endpoints and no leaked secrets; findings become fix tasks automatically.

**Negative / accepted costs:** False positives can stall runs, so the ruleset needs curation; scans add time to every verification cycle.

## Revisit trigger

Revisit the ruleset every quarter and whenever the supported stack changes.
