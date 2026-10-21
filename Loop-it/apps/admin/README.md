# Loop-it Admin

Internal ops console for abuse incidents, tenant quotas, kill switches, and audit review.

The app requires platform authentication and is intended for owner/admin roles only. It reads the API base URL from runtime configuration (`window.__LOOPIT_ADMIN_API_BASE_URL__`) or `VITE_LOOPIT_API_BASE_URL`; it never hardcodes localhost. Every destructive action uses an explicit confirm dialog before calling the API (I7).

```powershell
pnpm --filter @loopit/admin dev
pnpm --filter @loopit/admin test
```
