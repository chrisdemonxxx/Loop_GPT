import { AppPage } from '../../components/AppPage'
import { btnSecondary } from '@loop/ui'

/** Hosted origin when the nested console is deployed. Empty keeps the local
 *  Vite dev server (pnpm --filter @loopit/admin dev). */
const configured = process.env.NEXT_PUBLIC_LOOPIT_ADMIN_URL?.trim()
const adminUrl = (configured || 'http://127.0.0.1:5174').replace(/\/$/, '')

export default function LoopitAdminEntryPage() {
  return (
    <AppPage
      title="Loop-IT ops console"
      description={(
        <>
          Abuse incidents, tenant quotas, kill switches, and the audit log still run in{' '}
          <code className="text-[var(--ink-secondary)]">Loop-it/apps/admin</code>. Open that app until those panels
          are ported onto this portal.
        </>
      )}
      back={{ href: '/admin', label: 'Admin portal' }}
      actions={<a href={adminUrl} className={`${btnSecondary} px-3 py-1.5 text-ui-xs`}>Open Loop-IT admin</a>}
    >
      <p className="text-ui-xs text-[var(--ink-muted)] mt-4 leading-relaxed">
        Local dev listens on port 5174 (<code>pnpm --filter @loopit/admin dev</code> from{' '}
        <code>Loop-it</code>). Set <code>NEXT_PUBLIC_LOOPIT_ADMIN_URL</code> when building the web
        app if the console has another origin. The remaining port is described in{' '}
        <code>deploy/loopit/README.md</code>.
      </p>
    </AppPage>
  )
}
