import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "failure_text",
    Path(__file__).resolve().parents[1] / "src" / "loopit_orchestrator" / "failure_text.py",
)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
describe_failure = _MODULE.describe_failure


class _ActivityError(Exception):
    def __init__(self, cause: BaseException) -> None:
        super().__init__("Activity task failed")
        self.cause = cause


def test_failure_text_keeps_the_activity_cause() -> None:
    wrapped = _ActivityError(RuntimeError("scheduler refused the lease: volume unreadable"))
    text = describe_failure(wrapped)
    assert "Activity task failed" in text
    assert "volume unreadable" in text


def test_failure_text_uses_explicit_cause_chain() -> None:
    inner = RuntimeError("sandbox missing")
    outer = RuntimeError("lease failed")
    outer.__cause__ = inner
    text = describe_failure(outer)
    assert "lease failed" in text
    assert "sandbox missing" in text
