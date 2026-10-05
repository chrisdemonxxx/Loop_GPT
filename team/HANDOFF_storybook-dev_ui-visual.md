# HAND-OFF — `storybook-dev` → `ui-visual` (the one line: `frontend/package.json` dev-deps)

**From:** `storybook-dev` (seat cut 2026-09-29) · **To:** `ui-visual` (owns every component `.tsx`)
**Filed:** 2026-09-29 · HEAD `092dcb0`, branch `release/owned-staging-20260917`.

## What changes in `frontend/package.json` (and nothing else)

The Storybook harness is blueprint **BP P0** (`team/NOTE_dispatch_blueprint_boss-bot.md` §2/§4; kickoff
`team/P6_KICKOFF_storybook-dev.md`). It needs these `devDependencies` added, and a `storybook`/`build-storybook`
script pair. This is the **only** line of overlap with `ui-visual`'s file.

```
storybook, @storybook/nextjs, @storybook/addon-essentials,
@storybook/addon-interactions, @storybook/test, @storybook/blocks   (all 8.6.x)
scripts: "storybook": "storybook dev -p 6006", "build-storybook": "storybook build"
```

## What is NOT touched

- Every component `.tsx` stays `ui-visual`'s. `storybook-dev` writes **new paths only**:
  `frontend/.storybook/**` and `frontend/app/components/**/*.stories.tsx` (co-located with the
  components — there is no `frontend/components/` tree on disk; tailwind `content` already covers
  `./app/**`). A story that exposes a component bug is filed back here as a row, never patched.
- No component import/export/JSX is modified. Story files import the components read-only.

## Read-back after the change (paste into the evidence note)

```
$ git diff --stat frontend/package.json
$ npm run build        # app build must still exit 0
```
