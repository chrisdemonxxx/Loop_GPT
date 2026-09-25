# Loop GPT mobile (Expo)

Native Store and Direct editions of Loop GPT for Android and iOS, talking to
the same hardened backend as the web product UI.

## Security posture
- The JWT lives **only in module memory** — never AsyncStorage or device
  storage. App restarts require sign-in (same posture as the web client).
- Streaming chat uses the verified contract: `POST /api/agent/:id/stream`
  with `{ content, mode }` only (no BYOK fields).
- Edition separation: `store` vs `direct` variants select app identity and
  naming only — policy/entitlement/data separation is server-authoritative.

## Flavors
| Variant | Bundle id | Name | Builds |
|---|---|---|---|
| `store` | `com.loopgpt.app` | Loop GPT | Android AAB (Play), iOS App Store |
| `direct` | `com.loopgpt.direct` | Loop GPT Direct | Android APK (sideload), iOS device build |

## Development
```sh
cd mobile
npm install
EXPO_PUBLIC_API_URL=https://<your-deployment> npm start
```

## EAS builds (needs your Expo/EAS account + signing credentials)
```sh
npx eas build -p android --profile android-store   # Play AAB
npx eas build -p android --profile android-direct  # Direct APK
npx eas build -p ios --profile ios-store           # App Store
npx eas build -p ios --profile ios-direct          # Direct device build
```

Signing (Android keystore upload key, Apple certificates/profiles) is an
operator step; EAS manages credentials when you provide the dev accounts.

## Follow-up milestones (documented, not built)
- Rich markdown rendering + artifact viewer parity with the web UI
- Attachments (private-files contract with image pickers)
- Push notifications, biometric lock, deep links
- Accessibility labels audit + dynamic type testing
