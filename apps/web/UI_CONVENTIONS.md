# Loop GPT web UI conventions (UI uniformity pass)

Reference implementations: `app/build/page.tsx`, `app/build/[runId]/RunView.tsx`.
Shared primitives live in `packages/ui` (`@loop/ui`). Layout lives in `app/components/AppPage.tsx`.

## Layout shell — every standalone route uses `AppPage`

```tsx
import { AppPage } from '../components/AppPage'

<AppPage
  title="Developer"                      // h1 + document.title ("X - Loop GPT")
  description="Optional one-liner."
  back={{ href: '/chat', label: 'Chat' }} // optional
  width="default"                       // 'default' max-w-3xl | 'wide' max-w-6xl | 'fill' full-height app view
  meta={<Badge tone="accent">…</Badge>}  // optional row under description
  actions={<button className={btnPrimary}>…</button>} // optional top-right
>
  …page body…
</AppPage>
```

- `AppPage` renders the shared `AppBar` (brand, section nav with `aria-current`, theme toggle, Settings link) — delete any hand-rolled top bar / brand mark / theme toggle.
- Custom hero blocks: pass `header={<…/>}` instead of `title`.
- Full-height app views (Loop Bot): `width="fill"`; children manage their own min-h-0 flex layout.
- Never hand-set `document.title` in a migrated page — `AppPage` does it via `useDocumentTitle` (pass `documentTitle` when `title` is not a plain string).

## Type scale (tailwind `fontSize`, size-only)

`text-3xs` 10px · `text-2xs` 11px · `text-ui-xs` 12px · `text-ui-sm` 13px · `text-ui-base` 14px · `text-ui-md` 15px · page h1 stays `text-xl font-semibold` (PageHeader owns it). Replace `text-[10px]/[11px]/[12px]/[13px]/[14px]/[15px]` with the named classes. Larger ad-hoc sizes (`text-lg`, `text-2xl`) are allowed for hero/stat values.

## Color tokens (both themes) — never raw colors

| Use | Class |
|---|---|
| Page/panel background | `bg-[var(--bg-tint)]`, `bg-[var(--bg-panel)]`, `bg-[var(--bg-raised)]` |
| Hover fills | `hover:bg-[var(--bg-hover)]`, `bg-[var(--bg-hover-strong)]` |
| Borders | `border-[var(--border-subtle)]`, `border-[var(--border-strong)]`, dashed: same tokens + `border-dashed` |
| Text | `text-[var(--ink-primary)]` / `--ink-secondary` / `--ink-muted` |
| Accent | `text-[var(--accent-text)]`, `bg-[var(--accent-fill)]`, soft chip: `bg-[var(--accent-soft)] border-[var(--accent-soft-border)]` |
| Danger | `text-[var(--danger)]`, fill: `bg-[var(--danger-strong)]` hover `--danger-strong-hover`, soft: `bg-[var(--danger-soft)] border-[var(--danger-soft-border)]` |
| Success/warning | `text-[var(--success)]` / `text-[var(--warning)]`, dots via `<StatusDot>` |
| Code blocks | `bg-[var(--bg-code)] text-[var(--ink-primary)]` |

**Banned** (break light mode): `bg-white/[x]`, `border-white/[x]`, `divide-white/[x]`, `hover:bg-white/[x]`, `hover:text-white`, `bg-black/[x]`, `bg-[#08080a]`, `bg-[#141418]`, raw `text-slate-*`/`text-zinc-*` for primary text, `text-emerald-*`/`text-rose-*`/`text-violet-*`/`text-amber-*` (use success/danger/accent/warning tokens). `text-slate-100` may stay only as the page-root default `text-slate-200` that AppPage already sets.

## Primitives from `@loop/ui` — never hand-roll these

- Buttons: `btnPrimary` `btnSecondary` `btnGhost` `btnOutline` `btnDanger` `btnDangerOutline`
- Fields: `inputCls` `selectCls` `textareaCls` (all token-based), errors under fields: `<FieldError>`
- Surfaces: `cardCls` (interactive card), `panelCls` (static panel), `<Card title description badge active onClick actions>`, `<StatCard label value sub icon>`
- States: `<LoadingState label variant="inline|card|lines">`, `<ErrorState title message hint onRetry tone>` (role=alert), `<EmptyState icon title body action>`, `<Skeleton>`
- Bits: `<Badge tone="neutral|accent|green|amber|rose">`, `<Toggle on onChange label>`, `<StatusDot state>`, `<SearchInput value onChange placeholder resultCount>`, `<SectionHeader title count action>`
- Modals: `<Dialog open onClose title|ariaLabel align size role>` and `<ConfirmDialog open title body confirmLabel tone="danger" busy onConfirm onCancel>` — the ONE modal. `useFocusTrap` remains for non-dialog surfaces.

### Migrating an overlay → Dialog
Replace the hand-rolled `fixed inset-0 …` + `useFocusTrap` + Escape handling with `<Dialog>` (it owns scrim, focus trap, Escape stack, aria wiring). Keep the body content. Command-palette/lightbox: `align="top"`, `ariaLabel="…"` (no visible title), `role="dialog"`. Confirm flows: `<ConfirmDialog tone="danger">`, replace native `confirm()` calls.

## Naming (approved decision)

- User-facing: **Build** (never "Loop-IT" for users). Chat run card: "Build" + "Open build".
- **Loop-IT** only on internal admin/ops surfaces.
- **Loop Code** = the CLI/developer surface only; `/code` redirects to `/developer`.
- Per-route titles come from `AppPage` (`title` prop).

## Behavior rules

- Preserve existing behavior, props, keyboard shortcuts and `LOOPIT_ENABLED` gating.
- Don't edit `tokens.json` (generated capture). Extend `globals.css` only if a token is missing (rare — prefer existing tokens).
- Icons from `lucide-react` at 13–16px with `aria-hidden` when decorative.
- Buttons/links keep `aria-label`s; icon-only actions must have one.
