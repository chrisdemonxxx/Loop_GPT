#!/usr/bin/env node
/**
 * `build-storybook` shim.
 *
 * Storybook 8 merged the classic `build-storybook` binary into the single
 * `storybook` CLI (`storybook build`); the `storybook` package no longer
 * ships a `build-storybook` bin. The blueprint's gate is literally
 * `npx build-storybook`, so this one-line wrapper re-exposes that name by
 * delegating to the real CLI. It is wired through package.json's `bin`
 * field, so a plain `npm install` links `node_modules/.bin/build-storybook`
 * to it — reproducible on a fresh checkout.
 */
import { spawnSync } from 'node:child_process'

const result = spawnSync('storybook', ['build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
})

process.exit(result.status ?? 1)
