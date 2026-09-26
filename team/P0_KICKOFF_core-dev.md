# P0_KICKOFF — core-dev (backend)
TASK (bounded): confirm the §8-45 contract against the client. Read `backend/src/routes/tts.ts` and
the new `frontend/app/lib/voice.ts` engine path; verify (1) route path + method, (2) the auth
requirement, (3) the hard text cap, (4) the response shapes (`audio/*` bytes vs `{url}`), and (5)
what the client sends/parses. Write `team/P0_TTS_CONTRACT.md`: one line per contract point, raw
command (`grep -n`, `wc -c`) beside raw result, and any MISMATCH with `path:line`.
Do NOT edit `frontend/app/chat/hooks.ts` — hand any client change to `ui-visual`.
Then run `npm run build`, `npm test`, `npm run lint` in `backend/` and report the raw counts.