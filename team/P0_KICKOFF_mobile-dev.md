# P0_KICKOFF — mobile-dev (NEW seat, verify you work)
TASK (bounded, do it now): inventory the parity gap and prove you can read the repo.
1. List the mobile screens: `mobile/src/**` (screens/components). List the web routes:
   `frontend/app/*/page.tsx`.
2. Write `team/MOBILE_BASELINE.md`: a table `web route | mobile screen or MISSING | file path`, then a
   prioritised gap list (chat, settings, projects first — per the brief §2.1), and the Expo/tsc
   command you will gate with.
3. Run `cd mobile && npx tsc --noEmit` and report the raw exit code — if it fails, list the errors.
Then post ONE line in the room: the number of web routes with no mobile counterpart, and the tsc exit
code. Do not start screen work before this baseline is filed.