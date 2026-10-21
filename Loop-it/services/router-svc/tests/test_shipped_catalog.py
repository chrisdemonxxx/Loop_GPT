"""Shipped Hugging Face catalogues: aligned Router + dedicated abliterated.

Drives the real policy constructors in ``loopit_router.routing``, the compose
default that boots ``router-svc``, and the license register the router consults
before spend. ``Qwen/Qwen3.8-27B-FP8`` stays off the Router policy: the
Inference Router does not serve it. The unrestricted policy runs the
2026-10-10 abliterated endpoint set: GLM-5.3-Flash GGUF on llama.cpp,
DeepSeek-V4.1-Flash-Abliterated and GLM-5.3-CYBERSECURITY on vLLM.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from loopit_model_licenses import load_default_register
from loopit_router import OpenAICompatibleUpstream, huggingface_router_policy
from loopit_router.routing import huggingface_unrestricted_policy

REPO_ROOT = Path(__file__).resolve().parents[3]


def _repos(policy: object) -> set[str]:
    names = [spec.name for specs in policy.routes.values() for spec in specs]
    return {name.split(":")[0] for name in names}


def test_huggingface_router_policy_dispatches_glm53_flash_qwen38_glm53() -> None:
    policy = huggingface_router_policy()
    trivial = [spec.name for spec in policy.candidates("trivial")]
    implementation = [spec.name for spec in policy.candidates("implementation")]
    planning = [spec.name for spec in policy.candidates("planning")]
    assert trivial[0] == "zai-org/GLM-5.3-Flash:baseten"
    assert trivial[1] == "zai-org/GLM-5.3-Flash:fireworks-ai"
    assert implementation[0] == "Qwen/Qwen3.8-27B:deepinfra"
    assert implementation[1] == "Qwen/Qwen3.8-27B:ovhcloud"
    assert planning[0] == "zai-org/GLM-5.3:baseten"
    assert planning[1] == "zai-org/GLM-5.3:fireworks-ai"


def test_huggingface_unrestricted_policy_uses_dedicated_abliterated_endpoints() -> None:
    policy = huggingface_unrestricted_policy()
    trivial = policy.candidates("trivial")[0]
    implementation = policy.candidates("implementation")[0]
    planning = policy.candidates("planning")[0]
    assert trivial.name == "huihui-ai/Huihui-GLM-5.3-Flash-abliterated-GGUF"
    assert trivial.backend == "llamacpp"
    # llama.cpp serves GGUF quants under the repo id, not the vLLM /repository alias.
    assert trivial.served_model == "huihui-ai/Huihui-GLM-5.3-Flash-abliterated-GGUF"
    assert trivial.upstream_base_url and "endpoints.huggingface.cloud" in trivial.upstream_base_url
    assert implementation.name == "s-zaizen/DeepSeek-V4.1-Flash-Abliterated"
    assert implementation.wire_model == "s-zaizen/DeepSeek-V4.1-Flash-Abliterated"
    assert planning.name == "dealignai/GLM-5.3-CYBERSECURITY-FP8"
    assert planning.license_id == "mit"
    assert "hermes" not in trivial.name.lower()


def test_qwen38_fp8_is_not_on_the_router_policy() -> None:
    shipped = _repos(huggingface_router_policy()) | _repos(huggingface_unrestricted_policy())
    assert "Qwen/Qwen3.8-27B-FP8" not in shipped
    assert "Qwen/Qwen3.8-27B" in _repos(huggingface_router_policy())


def test_router_policy_ids_are_in_the_license_register() -> None:
    register = load_default_register()
    for policy in (huggingface_router_policy(), huggingface_unrestricted_policy()):
        for spec in (model for specs in policy.routes.values() for model in specs):
            entry = register.assert_servable_commercially(
                spec.name, today=date(2026, 10, 10), max_age_days=120
            )
            assert entry.license_id == spec.license_id


def test_compose_default_router_policy_is_huggingface_unrestricted() -> None:
    compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "LOOPIT_ROUTER_POLICY: ${LOOPIT_ROUTER_POLICY:-huggingface-unrestricted}" in compose


def test_router_exports_openai_compatible_upstream_not_a_litellm_wrapper() -> None:
    assert OpenAICompatibleUpstream.__module__ == "loopit_router.openai_upstream"
    pyproject = (REPO_ROOT / "services" / "router-svc" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    assert "litellm" not in pyproject.lower()
