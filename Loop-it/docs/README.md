# Loop-it docs

User-facing launch docs:

- [Getting started](getting-started.md)
- [Core concepts](core-concepts.md)
- [Troubleshooting and FAQ](troubleshooting.md)
- [Go-live checklist](go-live-checklist.md)
- [Privacy and data-handling summary](privacy-data-handling-summary.md)
- [Self-hosting](self-hosting.md)
- [Security and abuse playbook](08-security-and-abuse-playbook.md)

Build the lightweight static docs site with:

```bash
uv run python scripts/build_docs.py
```

The generated HTML lands in `docs/site/` and uses no third-party static-site dependency.
