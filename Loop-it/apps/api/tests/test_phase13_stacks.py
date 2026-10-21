"""Phase 1.3: vite-react / react-postgres stacks and scaffolding."""

from __future__ import annotations

from loopit_api.stacks import (
    REACT_POSTGRES_STACK,
    REACT_STACK,
    STACKS,
    VITE_REACT_STACK,
    guidance_for,
    infer_stack_from_files,
    scaffold_for,
    uses_sandbox_runtime,
)


def test_sandbox_stacks_are_registered() -> None:
    assert VITE_REACT_STACK in STACKS
    assert REACT_POSTGRES_STACK in STACKS
    assert uses_sandbox_runtime(VITE_REACT_STACK)
    assert uses_sandbox_runtime(REACT_POSTGRES_STACK)
    assert not uses_sandbox_runtime(REACT_STACK)


def test_vite_react_scaffold_copies_template() -> None:
    files = scaffold_for(VITE_REACT_STACK)
    assert "package.json" in files
    assert "vite.config.ts" in files
    assert "src/App.tsx" in files
    assert "src/components/ui/button.tsx" in files
    assert "jsx" in guidance_for(VITE_REACT_STACK).lower() or "JSX" in guidance_for(VITE_REACT_STACK)


def test_react_postgres_scaffold_copies_template() -> None:
    files = scaffold_for(REACT_POSTGRES_STACK)
    assert "package.json" in files
    assert "src/server/app.ts" in files
    assert "src/client/App.tsx" in files
    assert "migrations/0001_bootstrap.sql" in files


def test_infer_stack_from_on_disk_files() -> None:
    assert (
        infer_stack_from_files({"index.html", "main.js", "App.js", "styles.css"})
        == REACT_STACK
    )
    assert (
        infer_stack_from_files({"package.json", "vite.config.ts", "src/main.tsx"})
        == VITE_REACT_STACK
    )
    assert (
        infer_stack_from_files(
            {
                "package.json",
                "vite.config.ts",
                "src/server/index.ts",
                "migrations/0001_bootstrap.sql",
            }
        )
        == REACT_POSTGRES_STACK
    )
