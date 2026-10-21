"""Task-difficulty routing (Doc 03 §2, Doc 07 §4).

Models are configuration, never code. Nothing in the platform hard-codes "use
model X": the router owns the mapping from a difficulty class to a concrete
model, and the eval harness decides what that mapping should be. Any specific
model name is likely stale within a quarter — the *method* is what is durable.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

Difficulty = Literal["trivial", "implementation", "planning"]
DIFFICULTIES: tuple[Difficulty, ...] = ("trivial", "implementation", "planning")


class RoutingError(ValueError):
    """The routing policy is invalid and must not be loaded."""


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """One servable model.

    Attributes:
        name: the model identifier presented on the OpenAI-compatible surface.
        credential_ref: a *reference* into the secrets manager, resolved
            server-side at call time. Never the key itself (invariant I5).
        license_id: the base model's license, tracked per model so commercial
            serving can be verified before it happens (Doc 10 §3).
        credits_per_1k_input / credits_per_1k_output: pricing for attribution.
    """

    name: str
    #: Which serving engine hosts the weights. ``llamacpp`` is a llama.cpp
    #: server (the GGUF quant endpoints); ``tgi`` is deliberately not a
    #: member: it entered maintenance mode on 2025-12-11 and Hugging Face
    #: recommends vLLM or SGLang (Doc 03 §1).
    backend: Literal["vllm", "sglang", "managed", "llamacpp"]
    credential_ref: str
    license_id: str
    upstream_base_url: str | None = None
    # Wire id sent to a dedicated endpoint when it differs from ``name``
    # (vLLM on HF Endpoints often serves the weights as ``/repository``).
    served_model: str | None = None
    context_window: int = 8192
    capability_tags: tuple[str, ...] = ()
    difficulty_eligibility: tuple[Difficulty, ...] = DIFFICULTIES
    credits_per_1k_input: float = 0.0
    credits_per_1k_output: float = 0.0

    def __post_init__(self) -> None:
        if not self.name:
            raise RoutingError("model id must be non-empty")
        if not self.credential_ref:
            raise RoutingError(f"model {self.name!r} has no credential reference")
        if self.credential_ref.startswith(("sk-", "hf_", "ghp_")):
            raise RoutingError(
                f"model {self.name!r} appears to embed a literal API key; "
                "credential_ref must be a secrets-manager reference, not a secret"
            )
        if not self.license_id:
            raise RoutingError(
                f"model {self.name!r} has no tracked license; every served model's "
                "license is tracked and verified before commercial use (Doc 10 §3)"
            )
        if self.upstream_base_url is not None and not self.upstream_base_url.startswith(
            ("http://", "https://")
        ):
            raise RoutingError(f"model {self.name!r} has a non-http(s) upstream")
        if self.context_window <= 0:
            raise RoutingError(f"model {self.name!r} has no positive context window")
        if not self.difficulty_eligibility:
            raise RoutingError(f"model {self.name!r} is not eligible for any difficulty")
        unknown = set(self.difficulty_eligibility) - set(DIFFICULTIES)
        if unknown:
            raise RoutingError(f"model {self.name!r} has unknown difficulties: {sorted(unknown)}")

    def credits_for(self, input_tokens: int, output_tokens: int, cached: int = 0) -> float:
        """Cost in credits.

        Prompt tokens served from the prefix cache are not charged: the harness
        prefix is long and stable, so the cache hit fraction is a real discount.
        """
        billable_input = max(0, input_tokens - cached)
        return (
            billable_input / 1000 * self.credits_per_1k_input
            + output_tokens / 1000 * self.credits_per_1k_output
        )

    @property
    def id(self) -> str:
        return self.name

    @property
    def wire_model(self) -> str:
        """Model id placed on the OpenAI ``model`` field for this upstream."""
        return self.served_model or self.name

    def to_public_dict(self) -> dict[str, object]:
        return {
            "id": self.name,
            "backend": self.backend,
            "upstream_base_url": self.upstream_base_url,
            "context_window": self.context_window,
            "pricing": {
                "credits_per_1k_input": self.credits_per_1k_input,
                "credits_per_1k_output": self.credits_per_1k_output,
            },
            "capability_tags": list(self.capability_tags),
            "difficulty_eligibility": list(self.difficulty_eligibility),
            "license_id": self.license_id,
        }


@dataclass(frozen=True, slots=True)
class RoutingPolicy:
    """Maps a difficulty class to an ordered list of candidate models.

    The first candidate is preferred; the rest are fallbacks in the *same class*,
    so a fallback never silently downgrades a planning call to a trivial model.
    """

    routes: Mapping[Difficulty, Sequence[ModelSpec]]

    def __post_init__(self) -> None:
        missing = [d for d in DIFFICULTIES if not self.routes.get(d)]
        if missing:
            raise RoutingError(f"routing policy has no candidates for: {', '.join(missing)}")
        for difficulty, specs in self.routes.items():
            if difficulty not in DIFFICULTIES:
                raise RoutingError(f"unknown difficulty {difficulty!r}")
            for spec in specs:
                if difficulty not in spec.difficulty_eligibility:
                    raise RoutingError(
                        f"model {spec.name!r} is not eligible for difficulty {difficulty!r}"
                    )

    def candidates(self, difficulty: Difficulty) -> tuple[ModelSpec, ...]:
        """Ordered candidates for ``difficulty``: preferred first, then fallbacks."""
        route = self.routes.get(difficulty)
        if not route:
            raise RoutingError(f"no route configured for difficulty {difficulty!r}")
        return tuple(route)

    def licenses(self) -> dict[str, str]:
        """Model name → license id, for the compliance register (Doc 10 §3)."""
        return {spec.name: spec.license_id for specs in self.routes.values() for spec in specs}

    @property
    def catalog(self) -> ModelCatalog:
        return ModelCatalog({spec.name: spec for specs in self.routes.values() for spec in specs})

    def to_selection_dict(self) -> dict[str, list[str]]:
        return {
            difficulty: [spec.name for spec in self.candidates(difficulty)]
            for difficulty in DIFFICULTIES
        }


@dataclass(frozen=True, slots=True)
class ModelCatalog:
    """Server-owned model catalog; clients may pick ids, never endpoints or keys."""

    models: Mapping[str, ModelSpec]

    def __post_init__(self) -> None:
        if not self.models:
            raise RoutingError("model catalog is empty")

    def get(self, model_id: str) -> ModelSpec:
        try:
            return self.models[model_id]
        except KeyError:
            raise RoutingError(f"unknown model {model_id!r}") from None

    def policy_from_ids(self, routes: Mapping[Difficulty, Sequence[str]]) -> RoutingPolicy:
        return RoutingPolicy(
            {
                difficulty: tuple(self.get(model_id) for model_id in model_ids)
                for difficulty, model_ids in routes.items()
            }
        )

    def public_models(self) -> list[dict[str, object]]:
        return [self.models[model_id].to_public_dict() for model_id in sorted(self.models)]


@dataclass(frozen=True, slots=True)
class SelectionScope:
    org_id: str
    project_id: str | None = None


class InMemoryModelSelectionStore:
    """Per-org/per-project routing policy overrides.

    Production persists this beside org/project settings; the shape is already
    server-side and RBAC-gated, so clients cannot smuggle endpoints or secrets.
    """

    def __init__(self) -> None:
        self._policies: dict[tuple[str, str | None], RoutingPolicy] = {}

    def put(self, scope: SelectionScope, policy: RoutingPolicy) -> None:
        self._policies[(scope.org_id, scope.project_id)] = policy

    def get(self, scope: SelectionScope) -> RoutingPolicy | None:
        return self._policies.get((scope.org_id, scope.project_id))

    def resolve(self, scope: SelectionScope, default: RoutingPolicy) -> RoutingPolicy:
        if scope.project_id is not None:
            project = self.get(scope)
            if project is not None:
                return project
        return self.get(SelectionScope(scope.org_id)) or default


def default_policy(upstream_base_url: str | None = None) -> RoutingPolicy:
    """A development policy.

    Deliberately points at placeholder names: production routing is loaded from
    configuration and decided by the eval harness, not by this function. Re-run
    the harness whenever a notable model release lands rather than editing a
    list here.
    """
    small = ModelSpec(
        name="loopit/small",
        backend="vllm",
        credential_ref="secrets://models/small",
        license_id="apache-2.0",
        upstream_base_url=upstream_base_url,
        context_window=32768,
        capability_tags=("cheap", "fast", "coding"),
        difficulty_eligibility=("trivial",),
        credits_per_1k_input=0.0001,
        credits_per_1k_output=0.0004,
    )
    coder = ModelSpec(
        name="loopit/coder",
        backend="vllm",
        credential_ref="secrets://models/coder",
        license_id="apache-2.0",
        upstream_base_url=upstream_base_url,
        context_window=65536,
        capability_tags=("coding", "tools"),
        difficulty_eligibility=("trivial", "implementation"),
        credits_per_1k_input=0.0006,
        credits_per_1k_output=0.0024,
    )
    planner = ModelSpec(
        name="loopit/planner",
        backend="vllm",
        credential_ref="secrets://models/planner",
        license_id="apache-2.0",
        upstream_base_url=upstream_base_url,
        context_window=131072,
        capability_tags=("coding", "reasoning", "planning"),
        difficulty_eligibility=("implementation", "planning"),
        credits_per_1k_input=0.0020,
        credits_per_1k_output=0.0080,
    )
    return RoutingPolicy(
        routes={
            "trivial": (small, coder),
            "implementation": (coder, planner),
            "planning": (planner,),
        }
    )


def huggingface_router_policy(
    credential_ref: str = "secrets://models/hf-router", upstream_base_url: str | None = None
) -> RoutingPolicy:
    """A live policy targeting the Hugging Face Inference Router.

    Every model here was verified callable on 2026-09-05, and the prices are the
    provider's own published per-million rates read from ``GET /v1/models`` (one
    credit == one US dollar). Hugging Face passes provider pricing through
    without markup, so these are real costs rather than estimates.

    Pins prefer providers that advertise both tool calling and json_schema
    structured output, because the planner and the tool-call envelope both
    depend on constrained decoding. ``Qwen/Qwen3.8-27B-FP8`` is deliberately
    absent: the Router returns 404 for that id (dedicated vLLM/SGLang only).

    **Providers are pinned deliberately.** Left unpinned, the router picks a
    provider for you and may change it at any time, which means the retention
    terms governing a prompt can change without a deploy. Since prompts here
    contain customer source code, the provider is part of the compliance
    surface, so it is named in the model id using the router's documented
    ``model:provider`` syntax. A bogus provider is rejected with HTTP 400 rather
    than silently ignored, so this pin is enforced by the remote end, not merely
    requested.

    Fallbacks stay on the same weights and move only to a different provider:
    a provider outage should not silently change which model answered.

    This is not a recommendation to run production on shared infrastructure —
    see ``infra/runbooks/deploy-model-endpoints-hf.md`` for the dedicated
    deployment. It exists so the loop can be exercised end to end today.
    """
    small = ModelSpec(
        name="zai-org/GLM-5.3-Flash:baseten",
        backend="managed",
        credential_ref=credential_ref,
        license_id="mit",
        upstream_base_url=upstream_base_url,
        context_window=1048576,
        capability_tags=("cheap", "fast", "coding", "tools"),
        difficulty_eligibility=("trivial",),
        credits_per_1k_input=0.00015,
        credits_per_1k_output=0.00050,
    )
    small_alt = ModelSpec(
        name="zai-org/GLM-5.3-Flash:fireworks-ai",
        backend="managed",
        credential_ref=credential_ref,
        license_id="mit",
        upstream_base_url=upstream_base_url,
        context_window=1048576,
        capability_tags=("cheap", "fast", "coding", "tools"),
        difficulty_eligibility=("trivial",),
        # Router omits fireworks-ai unit prices; charge the published Baseten
        # pass-through for the same weights rather than under-billing at $0.
        credits_per_1k_input=0.00015,
        credits_per_1k_output=0.00050,
    )
    coder = ModelSpec(
        name="Qwen/Qwen3.8-27B:deepinfra",
        backend="managed",
        credential_ref=credential_ref,
        license_id="apache-2.0",
        upstream_base_url=upstream_base_url,
        context_window=262144,
        capability_tags=("coding", "tools"),
        difficulty_eligibility=("implementation",),
        credits_per_1k_input=0.00040,
        credits_per_1k_output=0.00300,
    )
    coder_alt = ModelSpec(
        name="Qwen/Qwen3.8-27B:ovhcloud",
        backend="managed",
        credential_ref=credential_ref,
        license_id="apache-2.0",
        upstream_base_url=upstream_base_url,
        context_window=262144,
        capability_tags=("coding", "tools"),
        difficulty_eligibility=("implementation",),
        # Router lists ovhcloud at $0/$0; keep deepinfra's published rate so a
        # failover does not silently zero the ledger.
        credits_per_1k_input=0.00040,
        credits_per_1k_output=0.00300,
    )
    planner = ModelSpec(
        name="zai-org/GLM-5.3:baseten",
        backend="managed",
        credential_ref=credential_ref,
        license_id="glm-5.3",
        upstream_base_url=upstream_base_url,
        context_window=1048576,
        capability_tags=("reasoning", "planning", "coding", "tools"),
        difficulty_eligibility=("planning",),
        credits_per_1k_input=0.00140,
        credits_per_1k_output=0.00440,
    )
    planner_alt = ModelSpec(
        name="zai-org/GLM-5.3:fireworks-ai",
        backend="managed",
        credential_ref=credential_ref,
        license_id="glm-5.3",
        upstream_base_url=upstream_base_url,
        context_window=1048576,
        capability_tags=("reasoning", "planning", "coding", "tools"),
        difficulty_eligibility=("planning",),
        credits_per_1k_input=0.00140,
        credits_per_1k_output=0.00440,
    )
    return RoutingPolicy(
        routes={
            "trivial": (small, small_alt),
            "implementation": (coder, coder_alt),
            "planning": (planner, planner_alt),
        }
    )


# Dedicated abliterated Hugging Face Inference Endpoints, verified live
# 2026-10-10 (the 2026-09-05 endpoint set was retired; these are the same
# endpoints the Loop-GPT chat deployment already serves production traffic
# from, so they are billed and warmed by the same operator account).
DEFAULT_GLM_FLASH_ENDPOINT = "https://6ac6f9bf904ec5f3ba7f4e6e.endpoints.huggingface.cloud"
DEFAULT_QWEN38_ENDPOINT = "https://6ac9858de4d5812f4c1a9f75.endpoints.huggingface.cloud"
DEFAULT_GLM53_ENDPOINT = "https://6abc4c0daa7378123428663f.endpoints.huggingface.cloud"


def huggingface_unrestricted_policy(
    credential_ref: str = "secrets://models/hf-router",
    upstream_base_url: str | None = None,
    *,
    flash_base_url: str | None = None,
    coder_base_url: str | None = None,
    planner_base_url: str | None = None,
    vision_base_url: str | None = None,
    flash_model: str | None = None,
    coder_model: str | None = None,
    planner_model: str | None = None,
    vision_model: str | None = None,
) -> RoutingPolicy:
    """Dedicated abliterated endpoints for fully unrestricted agency work.

    Every model here carries the abliterated / refusal-removed tag on the
    Hub, because the aligned catalogue refuses whole classes of legitimate
    builds (a phishing toolkit was refused outright on 2026-10-10). Difficulty
    mapping: Flash for trivial, DeepSeek-V4.1-Flash for implementation, full
    GLM-5.3 (cybersecurity-tuned, refusal-removed) for planning. Each spec
    points at its own Hugging Face Inference Endpoint rather than the public
    Router (which 429s and serves the aligned weights).

    ``served_model`` is the wire id each endpoint actually answers to — the
    Flash GGUF endpoint is a llama.cpp server that accepts the repo name, the
    vLLM endpoints answer the repo id (``root: /repository``). ``name`` stays
    the catalogue / license id.
    """
    del upstream_base_url
    flash_url = flash_base_url or DEFAULT_GLM_FLASH_ENDPOINT
    coder_url = coder_base_url or DEFAULT_QWEN38_ENDPOINT
    planner_url = planner_base_url or DEFAULT_GLM53_ENDPOINT
    small = ModelSpec(
        name="huihui-ai/Huihui-GLM-5.3-Flash-abliterated-GGUF",
        backend="llamacpp",
        credential_ref=credential_ref,
        license_id="mit",
        upstream_base_url=flash_url,
        served_model=flash_model or "huihui-ai/Huihui-GLM-5.3-Flash-abliterated-GGUF",
        context_window=262144,
        capability_tags=("cheap", "fast", "coding", "tools", "uncensored"),
        difficulty_eligibility=("trivial",),
        credits_per_1k_input=0.00015,
        credits_per_1k_output=0.00050,
    )
    coder = ModelSpec(
        name="s-zaizen/DeepSeek-V4.1-Flash-Abliterated",
        backend="vllm",
        credential_ref=credential_ref,
        license_id="apache-2.0",
        upstream_base_url=coder_url,
        served_model=coder_model or "s-zaizen/DeepSeek-V4.1-Flash-Abliterated",
        context_window=131072,
        capability_tags=("coding", "tools", "uncensored"),
        difficulty_eligibility=("implementation",),
        credits_per_1k_input=0.00040,
        credits_per_1k_output=0.00300,
    )
    planner = ModelSpec(
        name="dealignai/GLM-5.3-CYBERSECURITY-FP8",
        backend="vllm",
        credential_ref=credential_ref,
        license_id="mit",
        upstream_base_url=planner_url,
        served_model=planner_model or "dealignai/GLM-5.3-CYBERSECURITY-FP8",
        context_window=262144,
        capability_tags=("reasoning", "planning", "coding", "tools", "uncensored"),
        difficulty_eligibility=("planning",),
        credits_per_1k_input=0.00140,
        credits_per_1k_output=0.00440,
    )
    routes: dict[str, tuple[ModelSpec, ...]] = {
        "trivial": (small,),
        "implementation": (coder,),
        "planning": (planner,),
    }
    # Optional VL endpoint for Build image attachments (LOOPIT_VISION_*).
    vision_url = (vision_base_url or "").strip()
    if vision_url:
        vision = ModelSpec(
            name=vision_model or "loopit/vision",
            backend="vllm",
            credential_ref=credential_ref,
            license_id="apache-2.0",
            upstream_base_url=vision_url,
            served_model=vision_model or "loopit/vision",
            context_window=131072,
            capability_tags=("vision", "coding", "tools", "uncensored"),
            difficulty_eligibility=("implementation", "planning"),
            credits_per_1k_input=0.00100,
            credits_per_1k_output=0.00400,
        )
        # Prefer vision for implementation when configured (image-to-UI runs).
        routes["implementation"] = (vision, coder)
        routes["vision"] = (vision, coder)
    return RoutingPolicy(routes=routes)
