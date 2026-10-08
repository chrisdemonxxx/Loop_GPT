import Link from 'next/link'

/** Hosted origin when the nested console is deployed. Empty keeps the local
 *  Vite dev server (pnpm --filter @loopit/admin dev). */
const configured = process.env.NEXT_PUBLIC_LOOPIT_ADMIN_URL?.trim()
const adminUrl = (configured || 'http://127.0.0.1:5174').replace(/\/$/, '')

export default function LoopitAdminEntryPage() {
  return (
    <div className="min-h-screen px-5 py-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <Link href="/admin" className="text-sm text-slate-400 hover:text-slate-200">← Admin portal</Link>
      </div>
      <h1 className="text-xl font-semibold text-slate-100 mb-2">Loop-it ops console</h1>
      <p className="text-sm text-slate-400 leading-relaxed mb-4">
        Abuse incidents, tenant quotas, kill switches, and the audit log still run in{' '}
        <code className="text-slate-300">Loop-it/apps/admin</code>. Open that app until those panels
        are ported onto this portal.
      </p>
      <a
        href={adminUrl}
        className="inline-flex text-xs px-3 py-1.5 rounded-lg border text-violet-300 border-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20"
      >
        Open Loop-it admin
      </a>
      <p className="text-xs text-slate-500 mt-4 leading-relaxed">
        Local dev listens on port 5174 (<code>pnpm --filter @loopit/admin dev</code> from{' '}
        <code>Loop-it</code>). Set <code>NEXT_PUBLIC_LOOPIT_ADMIN_URL</code> when building the web
        app if the console has another origin. The remaining port is described in{' '}
        <code>deploy/loopit/README.md</code>.
      </p>
    </div>
  )
}
