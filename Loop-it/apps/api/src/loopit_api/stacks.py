"""The stacks the preview can build, and the files a project starts from.

A generated app is only as good as the first file. Getting an import map
slightly wrong produces a blank page and no error anyone can read, and an agent
asked to write one from memory gets it slightly wrong often enough to matter.
So the entry point is not generated: it is a frozen, tested template, and the
agent's job starts at the components.

**Quick prototype (`react`).** No build step: React arrives as ES modules from
a CDN through an import map, and markup is written with `htm`. That is not a
toy: components, hooks, props, state and routing all work without npm.

**Sandbox stacks (`vite-react`, `react-postgres`).** Copied from
``stack-templates/``. JSX, TypeScript, Tailwind and npm are expected; the agent
runs inside a leased sandbox (``SANDBOX_SYSTEM_PROMPT``) with
``install_package`` / ``start_dev_server``. Offline local mode still scaffolds
the files; shell tools remain refused until orchestrator mode is on.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

#: Pinned, not floating. A project that renders today and not tomorrow because
#: a CDN moved a major version is indistinguishable, to whoever is looking at
#: it, from the agent having written something broken.
REACT_VERSION: Final = "18.3.1"
HTM_VERSION: Final = "3.1.1"
ROUTER_VERSION: Final = "6.26.2"

#: The origin the generated app is allowed to load code from.
MODULE_CDN: Final = "https://esm.sh"

_IMPORT_MAP = f"""{{
        "imports": {{
          "react": "{MODULE_CDN}/react@{REACT_VERSION}",
          "react/jsx-runtime": "{MODULE_CDN}/react@{REACT_VERSION}/jsx-runtime",
          "react-dom/client": "{MODULE_CDN}/react-dom@{REACT_VERSION}/client",
          "htm/react": "{MODULE_CDN}/htm@{HTM_VERSION}/react?deps=react@{REACT_VERSION}",
          "react-router-dom": "{MODULE_CDN}/react-router-dom@{ROUTER_VERSION}\
?deps=react@{REACT_VERSION},react-dom@{REACT_VERSION}"
        }}
      }}"""

_INDEX_HTML = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
    <link rel="stylesheet" href="styles.css" />
    <script type="importmap">
      {_IMPORT_MAP}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="main.js"></script>
  </body>
</html>
"""

_MAIN_JS = """import { createRoot } from "react-dom/client";
import { html } from "htm/react";
import { App } from "./App.js";

createRoot(document.getElementById("root")).render(html`<${App} />`);
"""

_APP_JS = """import { html } from "htm/react";
import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);

  return html`
    <main class="app">
      <h1>It works</h1>
      <p>Replace this component with the app that was asked for.</p>
      <button onClick=${() => setCount(count + 1)}>clicked ${count} times</button>
    </main>
  `;
}
"""

_STYLES_CSS = """:root {
  color-scheme: light dark;
  font-family:
    system-ui,
    -apple-system,
    Segoe UI,
    sans-serif;
}

body {
  margin: 0;
}

.app {
  max-width: 60rem;
  margin: 0 auto;
  padding: 2rem 1.25rem;
}
"""

#: What a fresh React (htm) project contains before the agent touches it.
REACT_SCAFFOLD: Final[dict[str, str]] = {
    "index.html": _INDEX_HTML,
    "main.js": _MAIN_JS,
    "App.js": _APP_JS,
    "styles.css": _STYLES_CSS,
}

STATIC_STACK: Final = "static"
REACT_STACK: Final = "react"
#: Quick frontend with Vite + JSX + Tailwind (sandbox / HMR).
VITE_REACT_STACK: Final = "vite-react"
#: Full stack: Vite client + Express + Postgres (sandbox / HMR).
REACT_POSTGRES_STACK: Final = "react-postgres"

STACKS: Final[frozenset[str]] = frozenset(
    {STATIC_STACK, REACT_STACK, VITE_REACT_STACK, REACT_POSTGRES_STACK}
)

#: Stacks that expect a leased sandbox (npm, dev server, real verify).
SANDBOX_STACKS: Final[frozenset[str]] = frozenset({VITE_REACT_STACK, REACT_POSTGRES_STACK})

_SKIP_TEMPLATE_NAMES: Final[frozenset[str]] = frozenset(
    {
        "node_modules",
        ".git",
        "dist",
        ".turbo",
        "__pycache__",
        ".DS_Store",
    }
)


def templates_root() -> Path:
    """Directory holding frozen stack templates.

    Override with ``LOOPIT_STACK_TEMPLATES`` when the api image does not sit
    next to ``stack-templates/`` in the Loop-it checkout.
    """
    env = (os.environ.get("LOOPIT_STACK_TEMPLATES") or "").strip()
    if env:
        return Path(env)
    # loopit_api → src → api → apps → Loop-it
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "stack-templates"
        if candidate.is_dir():
            return candidate
    return here.parents[4] / "stack-templates"


def uses_sandbox_runtime(stack: str) -> bool:
    """True when the stack expects shell / npm / HMR via a leased sandbox."""
    return stack in SANDBOX_STACKS


def _load_template_files(name: str) -> dict[str, str]:
    """Copy a stack-templates directory into a path → text map."""
    root = templates_root() / name
    if not root.is_dir():
        raise FileNotFoundError(f"stack template {name!r} not found under {templates_root()}")
    files: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(root).parts
        if any(part in _SKIP_TEMPLATE_NAMES for part in rel_parts):
            continue
        if path.name == "package-lock.json":
            # Lockfiles are large and environment-specific; npm install regenerates.
            continue
        try:
            files[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # Binary assets are rare in scaffolds; skip rather than corrupt.
            continue
    if not files:
        raise FileNotFoundError(f"stack template {name!r} is empty")
    return files


def scaffold_for(stack: str) -> dict[str, str]:
    """The files a new project of this stack starts with.

    A static site starts empty: there is nothing about a plain HTML page an
    agent gets wrong often enough to be worth freezing.
    """
    if stack == REACT_STACK:
        return dict(REACT_SCAFFOLD)
    if stack == VITE_REACT_STACK:
        return _load_template_files("vite-react")
    if stack == REACT_POSTGRES_STACK:
        return _load_template_files("react-postgres")
    return {}


REACT_GUIDANCE: Final = f"""\
This project is a React application (Quick prototype). It is already \
scaffolded and running: index.html, main.js, App.js and styles.css exist. \
Extend them.

There is no build step and no package manager. React arrives as ES modules \
through the import map already in index.html, and markup is written with `htm` \
tagged template literals, not JSX. JSX will not run here and produces a blank \
page.

Write markup like this:

    import {{ html }} from "htm/react";
    import {{ useState }} from "react";

    export function BookList({{ books }}) {{
      const [query, setQuery] = useState("");
      const shown = books.filter((b) => b.title.includes(query));
      return html`
        <section>
          <input value=${{query}} onInput=${{(e) => setQuery(e.target.value)}} />
          <ul>
            ${{shown.map((b) => html`<li key=${{b.title}}>${{b.title}}</li>`)}}
          </ul>
        </section>
      `;
    }}

The rules that differ from JSX, and are the only things that go wrong:

- A component tag is `<${{Name}} ... />`, interpolated, never `<Name ... />`.
- A component tag with children closes with `<//>`, not `</Name>`.
- Plain HTML tags are written normally: `<div>`, `</div>`.
- Use `class`, not `className`.
- `style` takes an object, never a string: `style=${{{{ background: color.bg }}}}` \
with camelCase keys. A string throws and mounts nothing. Prefer a CSS class.

Put each component in its own file under the project root and import it with a \
relative path ending in `.js` — `import {{ Header }} from "./Header.js"`. Native \
modules need the extension.

Keep each template shallow. A template holding a `.map` holding a ternary \
holding three more templates is where files get long, get cut off halfway, and \
render nothing. When markup nests more than about two levels, give the inner \
part its own component in its own file and interpolate that instead. Aim for \
files under 100 lines.

To add a library, add it to the import map in index.html as \
`{MODULE_CDN}/<package>@<version>?deps=react@{REACT_VERSION}` and pin the \
version. `react-router-dom` is already mapped; use `HashRouter`, because the \
preview serves files and has no server-side routing.

State lives in React. There is no backend and network calls are blocked, so \
seed data belongs in a module the app imports.

Write the CSS as you go, in the same turn as the markup. Every class you put on \
an element needs a rule in styles.css — structure with no stylesheet renders as \
black text on a white page, which is not a finished app.
"""

STATIC_GUIDANCE: Final = """\
This project is a plain static site: HTML, CSS and JavaScript, no framework and \
no build step. Split the work across files — index.html, styles.css, app.js and \
further pages — and link them with plain relative paths.
"""

VITE_REACT_GUIDANCE: Final = """\
This project is a Vite + React + TypeScript frontend (sandbox stack). The \
scaffold already includes index.html, src/main.tsx, src/App.tsx, Tailwind \
(via @tailwindcss/vite), and a minimal shadcn-style Button under \
src/components/ui/.

JSX and TypeScript are expected. Prefer `className` and Tailwind utility \
classes. Extend `src/components/ui/` rather than inventing one-off primitives.

There is a real package manager. After editing package.json, use \
install_package (or npm install via run_shell). Start the preview with \
start_dev_server (default `npm run dev` on port 5173), then read_logs if \
something fails.

Do not rewrite the Vite config's envPrefix — only VITE_ variables may reach \
the browser. Keep components under ~100 lines; split files instead of growing \
one giant App.tsx.

When you believe the work is finished, run typecheck / tests via the shell \
and re-read a representative file. The verify pipeline decides success.
"""

REACT_POSTGRES_GUIDANCE: Final = """\
This project is the full-stack react-postgres template: Vite React client, \
Express + TypeScript server, and PostgreSQL via the parameterised `db.ts` \
helper with RLS.

Preserve the template invariants:
- Every DB query goes through db.ts with (text, values[]) — never concatenated SQL.
- Identity uses withIdentity() so RLS sees the verified JWT claims.
- No secrets in client code (VITE_ prefix only).
- JWT signature verified on every request; helmet / CORS / rate limits stay on.

Frontend lives under src/client/; API under src/server/. Install with \
install_package / npm install. Typical local commands: `npm run migrate`, \
`npm run dev:server`, `npm run dev:client` (Vite :5173). Prefer start_dev_server \
for the client preview the user sees.

When finished, run typecheck and unit tests; the verify pipeline (and SAST) \
decide green.
"""


def guidance_for(stack: str) -> str:
    """The stack-specific half of the system prompt."""
    if stack == REACT_STACK:
        return REACT_GUIDANCE
    if stack == VITE_REACT_STACK:
        return VITE_REACT_GUIDANCE
    if stack == REACT_POSTGRES_STACK:
        return REACT_POSTGRES_GUIDANCE
    return STATIC_GUIDANCE


def infer_stack_from_files(files: set[str]) -> str:
    """Which stack an on-disk project was built on."""
    if "package.json" in files and "vite.config.ts" in files:
        if any(f.startswith("src/server/") for f in files) or "migrations/0001_bootstrap.sql" in files:
            return REACT_POSTGRES_STACK
        return VITE_REACT_STACK
    if {"index.html", "main.js"} <= files:
        return REACT_STACK
    return STATIC_STACK


__all__ = [
    "MODULE_CDN",
    "REACT_GUIDANCE",
    "REACT_POSTGRES_GUIDANCE",
    "REACT_POSTGRES_STACK",
    "REACT_SCAFFOLD",
    "REACT_STACK",
    "SANDBOX_STACKS",
    "STACKS",
    "STATIC_GUIDANCE",
    "STATIC_STACK",
    "VITE_REACT_GUIDANCE",
    "VITE_REACT_STACK",
    "guidance_for",
    "infer_stack_from_files",
    "scaffold_for",
    "templates_root",
    "uses_sandbox_runtime",
]
