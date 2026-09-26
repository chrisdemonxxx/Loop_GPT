# MOBILE_BASELINE — screen map + parity gap (P0 kickoff)

Owner: mobile-dev. Filed before any screen work starts.
Web = `frontend/app/*/page.tsx` (Next 14, 16 routes). Mobile = `mobile/src/screens/*.tsx` (Expo 52, state router in `App.tsx`, no nav lib).

## Screen map — web route → mobile screen

| # | Web route | Mobile screen | Mobile file |
|---|-----------|---------------|-------------|
| 1 | `/chat` | `Chat` | `mobile/src/screens/Chat.tsx` |
| 2 | `/` (landing → chat shell) | `ChatList` | `mobile/src/screens/ChatList.tsx` |
| 3 | `/login` (+ `/signup`, `/forgot`, `/reset`, `/verify`) | `Login` | `mobile/src/screens/Login.tsx` |
| 4 | `/account` | `Settings` (tabs: memory/style/skills/connectors) | `mobile/src/screens/Settings.tsx` |
| 5 | `/developer` | `Projects` | `mobile/src/screens/Projects.tsx` |
| 6 | `/admin` | **MISSING** | — |
| 7 | `/onboarding` | **MISSING** | — |
| 8 | `/share` | **MISSING** | — |
| 9 | `/privacy` | **MISSING** (renders web HTML) | — |
| 10 | `/terms` | **MISSING** | — |
| 11 | `/acceptable-use` | **MISSING** | — |
| 12 | `/cookies` | **MISSING** | — |

Landing `/` is `ChatList` in the app shell (post-auth screen 2 handles the authed flow; unauthed `ChatList` isn't a public landing page on mobile — Login is).

**11 of 16 web routes have no mobile counterpart.** Functional (P0): 6 — admin, onboarding, share, + 3 legal pages (privacy/terms/acceptable-use, which are web-HTML and can ship as a WebView later).

## Priorised gap list (chat → settings → projects, per brief §2.1)

| P | Screen | Route | Notes |
|---|--------|-------|--------|
| P0 | Chat | `/chat` | 36 KB web (assistant message cards, version rows, retry-before, stop). Mobile is 7.7 KB — missing version history UI + retry-before row. |
| P0 | Settings | `/account` | 8.9 KB mobile vs 14.6 KB web. Missing MFA (web has start/confirm/disable), billing/upgrade, redeem-code. Mobile tabs: memory, style, skills, connectors. |
| P0 | Projects | `/developer` | 5.4 KB mobile vs 8.6 KB web. |
| P1 | Admin | `/admin` | 16.9 KB. No mobile admin — gate to a later pass. |
| P1 | Onboarding | `/onboarding` | 4.8 KB. First-run wizard. |
| P2 | Share | `/share` | 3.5 KB. |
| P2 | Legal x3 | `/privacy` `/terms` `/acceptable-use` | 10–11 KB each, plain prose pages → WebView. |
| P2 | Cookies | `/cookies` | 5.1 KB. |

## Gate commands

```bash
cd mobile && npx tsc --noEmit     # = "typecheck" script, TS 5.6.3, strict + noEmit
npx expo start                    # expo 52.0.49, RN 0.76.5
```

Baseline run (this seat):
```
$ cd mobile && npx tsc --noEmit
Version 5.6.3
EXIT=0
```
Full suite, 0 errors, exit 0 (strict mode, `**/*.ts(x)`).

## Routing

State router in `mobile/App.tsx` (50 lines): `list | chat | settings | projects`, `+login` as shell gate. `listKey` remount refreshes the list. Swap for `@react-navigation/native-stack` when admin lands (it needs a stack for overlay back-swipe + params).

## Byte sizes (this commit)

```
 5319 frontend/app/acceptable-use/page.tsx
14601 frontend/app/account/page.tsx
16976 frontend/app/admin/page.tsx
36055 frontend/app/chat/page.tsx
 5085 frontend/app/cookies/page.tsx
 8597 frontend/app/developer/page.tsx
 3063 frontend/app/forgot/page.tsx
   127 frontend/app/login/page.tsx
 4795 frontend/app/onboarding/page.tsx
10472 frontend/app/privacy/page.tsx
 4093 frontend/app/reset/page.tsx
 3472 frontend/app/share/page.tsx
   129 frontend/app/signup/page.tsx
10943 frontend/app/terms/page.tsx
 2452 frontend/app/verify/page.tsx
 7704 mobile/src/screens/Chat.tsx
 3517 mobile/src/screens/ChatList.tsx
 4262 mobile/src/screens/Login.tsx
 5375 mobile/src/screens/Projects.tsx
 8924 mobile/src/screens/Settings.tsx
```
