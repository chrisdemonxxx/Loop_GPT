# Loop-it stack template: `vite-react`

Frontend-only scaffold: **React 18 + TypeScript + Vite + Tailwind**, with a
minimal shadcn-style `Button`. No Express, no Postgres — use `react-postgres`
when the app needs a backend or database.

```powershell
cd stack-templates/vite-react
npm install
npm run dev        # Vite on :5173
npm run typecheck
npm run test
```

Only `VITE_`-prefixed env vars reach the browser (`vite.config.ts`).
