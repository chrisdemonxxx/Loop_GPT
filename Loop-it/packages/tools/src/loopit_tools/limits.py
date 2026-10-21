"""Per-tool output and runtime limits."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ToolLimits:
    """Caps applied by concrete tool handlers before observations reach the loop."""

    read_file_bytes: int = 64_000
    search_file_bytes: int = 1_000_000
    search_results: int = 50
    shell_timeout_seconds: int = 300
    shell_output_bytes: int = 64_000
    browser_timeout_seconds: float = 30.0

    def __post_init__(self) -> None:
        for name in (
            "read_file_bytes",
            "search_file_bytes",
            "search_results",
            "shell_timeout_seconds",
            "shell_output_bytes",
        ):
            value = getattr(self, name)
            if value <= 0:
                raise ValueError(f"{name} must be positive")
        if self.browser_timeout_seconds <= 0:
            raise ValueError("browser_timeout_seconds must be positive")


def clip_bytes(text: str, limit: int) -> tuple[str, bool]:
    """Clip UTF-8 text by encoded byte length without splitting a code point."""
    data = text.encode("utf-8")
    if len(data) <= limit:
        return text, False
    return data[:limit].decode("utf-8", errors="ignore"), True
