"""Live-gap seams: DispatchCommandRunner + egress proxy env helper."""

from __future__ import annotations

from loopit_api.dispatch_client import DispatchClient, DispatchCommandRunner, DispatchResult


class _FakeDispatch(DispatchClient):
    def __init__(self) -> None:
        super().__init__("http://dispatch.test/dispatch")
        self.calls: list[tuple[str, dict]] = []

    def execute(self, *, lease_id: str, lease_token: str, tool: str, args: dict):  # type: ignore[override]
        self.calls.append((tool, args))
        assert lease_id == "lease-1"
        assert lease_token == "tok"
        return DispatchResult(
            ok=True,
            output="ok\n",
            detail={"exit_code": 0, "stdout": "ok\n", "stderr": "", "duration_seconds": 0.05},
        )


def test_dispatch_command_runner_quotes_and_maps_output() -> None:
    client = _FakeDispatch()
    runner = DispatchCommandRunner(client, lease_id="lease-1", lease_token="tok")
    out = runner.run(("npm", "run", "typecheck"), timeout_seconds=30)
    assert out.exit_code == 0
    assert out.stdout == "ok\n"
    assert client.calls[0][0] == "run_shell"
    assert "typecheck" in client.calls[0][1]["command"]
    assert client.calls[0][1]["timeout_seconds"] == 30


def test_egress_proxy_envs_from_provider(monkeypatch) -> None:
    from loopit_scheduler.provider import _egress_proxy_envs

    monkeypatch.delenv("LOOPIT_EGRESS_PROXY_URL", raising=False)
    assert _egress_proxy_envs() == {}
    monkeypatch.setenv("LOOPIT_EGRESS_PROXY_URL", "http://egress-proxy:8002")
    envs = _egress_proxy_envs()
    assert envs["HTTP_PROXY"] == "http://egress-proxy:8002"
    assert envs["HTTPS_PROXY"] == "http://egress-proxy:8002"
    assert "localhost" in envs["NO_PROXY"]
