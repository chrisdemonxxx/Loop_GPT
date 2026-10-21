# Loop-it Console (Capacitor)

This is the same `apps/web` console wrapped for iOS, Android, and PWA. It is not a second product.

```bash
pnpm --filter @loopit/web build
cd apps/console-mobile
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android
npx cap sync
```

Point the packaged WebView at the operator's Loop-it API with `window.__LOOPIT_API_BASE_URL__` (same as the web console). Store identity tokens in the Capacitor Preferences plugin later; v1 uses the existing sessionStorage path inside the WebView.

TestFlight / Play internal tracks are operator-owned. This package only provides the wrap.
