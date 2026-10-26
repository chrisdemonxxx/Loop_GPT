# Loop browser packages

Two codebases, three installable packages. They share one socket protocol and one JSON result shape.
Source of truth is `packages/browser-extension/src`, synchronized via `node packages/browser-extension/build.mjs`.

| Package | Folder | Install |
| --- | --- | --- |
| Chromium (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium, and an Octo profile) | `apps/extension` | Development: load this folder unpacked at `chrome://extensions`. Release: Chrome Web Store unlisted, or unpacked developer zip. Off-store CRX is not supported on Windows/macOS. |
| Firefox | `apps/extension-firefox` | Signed XPI via AMO (unlisted channel) with update_url, or temporary load in `about:debugging` → Load Temporary Add-on. |
| Tor Browser | `apps/extension-tor` | Built for Tor Browser (Firefox ESR 128). AMO unlisted signed XPI (or temporary unsigned with `xpinstall.signatures.required` false for dev). `.onion` pages are opened only on a device that paired as Tor Browser. |

Each device reports `manifest.version` on the pair socket. The device picker shows a version skew when that version does not match the API's expected package version.

### Safety & Permissions
- Risky actions (payments, checkout, password change, messages) require user confirmation via an in-window confirm bar.
- Cookie and auth headers (`Cookie`, `Authorization`, `Proxy-Authorization`, `Set-Cookie`) are redacted before anything leaves the machine.
- DevTools console and network logs are captured per action with strict buffer limits (50 console lines prioritizing errors, 40 network entries, 16 KB body payload cap).

### Captcha & Antidetect
- Captcha handling defaults to `wait` (pauses in visible window). When `captchaHandling` is `solver` and a BYOK solver key (2captcha / CapMonster / etc.) is connected, challenges are solved via the solver adapter. Solvers are strictly disabled for Tor Browser to prevent `.onion` leakage.
- Octo profiles are managed via Octo's Cloud API token and driven via the local Octo client (`127.0.0.1:58888`) CDP relay through a paired Chromium extension on the machine.
