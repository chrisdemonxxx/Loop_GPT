from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any, Literal

Verdict = Literal["ship", "no_ship"]


class ComparisonRefusal(RuntimeError):
    """The benchmark cannot honestly produce a ship/no-ship verdict."""


@dataclass(frozen=True, slots=True)
class CapabilityDelta:
    tier: str
    capability: str
    base_pass_at_1: float
    modified_pass_at_1: float

    @property
    def delta(self) -> float:
        return self.modified_pass_at_1 - self.base_pass_at_1

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["delta"] = round(self.delta, 4)
        return payload


@dataclass(frozen=True, slots=True)
class ModelComparison:
    base_model_id: str
    modified_model_id: str
    deltas: Sequence[CapabilityDelta]
    tolerance: float

    @property
    def regressions(self) -> tuple[CapabilityDelta, ...]:
        return tuple(delta for delta in self.deltas if delta.delta < -self.tolerance)

    @property
    def verdict(self) -> Verdict:
        return "no_ship" if self.regressions else "ship"

    def to_dict(self) -> dict[str, Any]:
        return {
            "base_model_id": self.base_model_id,
            "modified_model_id": self.modified_model_id,
            "tolerance": self.tolerance,
            "verdict": self.verdict,
            "deltas": [delta.to_dict() for delta in self.deltas],
            "regressions": [delta.to_dict() for delta in self.regressions],
            "rule": "ship only if no coding/reasoning pass@1 delta regresses beyond tolerance",
        }

    def to_text(self) -> str:
        lines = [
            f"{self.modified_model_id} vs {self.base_model_id}: {self.verdict}",
            "ship rule: no significant coding/reasoning regression per tier",
        ]
        for delta in self.deltas:
            lines.append(
                f"  {delta.tier}/{delta.capability}: "
                f"{delta.base_pass_at_1:.1%} -> {delta.modified_pass_at_1:.1%} "
                f"({delta.delta:+.1%})"
            )
        return "\n".join(lines)


def compare_model_reports(
    *,
    base_payload: Mapping[str, Any],
    modified_payload: Mapping[str, Any],
    tolerance: float = 0.0,
) -> ModelComparison:
    base_model_id = _require_real_run(base_payload, "base")
    modified_model_id = _require_real_run(modified_payload, "modified")
    base_scores = _capability_scores(base_payload, "base")
    modified_scores = _capability_scores(modified_payload, "modified")

    missing = sorted(set(base_scores) ^ set(modified_scores))
    if missing:
        raise ComparisonRefusal(
            "base and modified reports do not cover the same tier/capability cells: "
            + ", ".join(f"{tier}/{capability}" for tier, capability in missing)
        )
    deltas = tuple(
        CapabilityDelta(
            tier=tier,
            capability=capability,
            base_pass_at_1=base_scores[(tier, capability)],
            modified_pass_at_1=modified_scores[(tier, capability)],
        )
        for tier, capability in sorted(base_scores)
    )
    if not deltas:
        raise ComparisonRefusal("no comparable coding/reasoning eval cells were measured")
    return ModelComparison(
        base_model_id=base_model_id,
        modified_model_id=modified_model_id,
        deltas=deltas,
        tolerance=tolerance,
    )


def _require_real_run(payload: Mapping[str, Any], label: str) -> str:
    run = payload.get("run")
    if not isinstance(run, Mapping) or run.get("executor") != "real":
        raise ComparisonRefusal(
            f"{label} report is not marked as a real eval run; refusing to produce a verdict"
        )
    model_id = run.get("model_id")
    if not isinstance(model_id, str) or not model_id:
        raise ComparisonRefusal(f"{label} report is missing run.model_id")
    if int(payload.get("total_tasks") or 0) <= 0:
        raise ComparisonRefusal(f"{label} report contains no measured tasks")
    return model_id


def _capability_scores(payload: Mapping[str, Any], label: str) -> dict[tuple[str, str], float]:
    raw = payload.get("capabilities")
    if not isinstance(raw, list):
        raise ComparisonRefusal(f"{label} report lacks capability summaries")
    scores: dict[tuple[str, str], float] = {}
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        capability = item.get("capability")
        tier = item.get("tier")
        if capability not in {"coding", "reasoning"} or not isinstance(tier, str):
            continue
        if int(item.get("total") or 0) <= 0:
            raise ComparisonRefusal(f"{label} report has an empty {tier}/{capability} cell")
        scores[(tier, capability)] = float(item.get("pass_at_1") or 0.0)
    return scores
