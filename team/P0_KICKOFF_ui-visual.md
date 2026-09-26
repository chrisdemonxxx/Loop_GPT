# P0_KICKOFF — ui-visual (P0 owner)
You own `frontend/` and you are the SINGLE owner of `frontend/app/chat/hooks.ts` and
`components/chat/Composer.tsx`. Four items are uncommitted and half-finished:
§8-40 connector chip, §8-44 hands-free voice mode, §8-45 server read-aloud engine, Appearance tab.
Finish them in the existing design system, then gate each with `npx tsc --noEmit` / `npm run lint` /
`npm test` / `npx playwright test` / `npm run build` in `frontend/`, then commit ONE commit per item
(§-number in the message). Evidence per item in `team/P0_UI_<n>.md`: files touched + gate output.
Do not start P2 work before P0 is committed and the tree is clean.