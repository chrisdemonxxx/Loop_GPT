import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Spinner, StatusPill, Toast } from '@loopit/ui-kit';
import '@loopit/ui-kit/styles.css';
import {
  canUseAdmin,
  demoQuotas,
  destructiveActionLabel,
  isOperatorToken,
  listAudit,
  listIncidents,
  performIncidentAction,
  requiresConfirmation,
  type Incident,
  type Role,
} from './api';
import type { AuditEvent } from '@loop-it/contracts';

type PendingAction = { action: string; title: string; message: string; run: () => Promise<void> };

export default function App() {
  const [token, setToken] = useState(() => window.localStorage.getItem('loopit.admin.token') ?? '');
  const [role, setRole] = useState<Role | null>(() => (window.localStorage.getItem('loopit.admin.role') as Role | null) ?? 'admin');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const roleAllowed = canUseAdmin(role);
  const operatorAllowed = isOperatorToken(token);
  const adminAllowed = roleAllowed && operatorAllowed;

  useEffect(() => {
    if (token) window.localStorage.setItem('loopit.admin.token', token);
    if (role) window.localStorage.setItem('loopit.admin.role', role);
  }, [token, role]);

  async function refresh() {
    if (!token || !adminAllowed) return;
    setBusy(true);
    setError(null);
    try {
      const [nextIncidents, nextAudit] = await Promise.all([listIncidents(token), listAudit(token)]);
      setIncidents(nextIncidents);
      setAudit(nextAudit);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, [token, adminAllowed]);

  const incidentColumns = useMemo(() => [
    { key: 'tier', header: 'Tier', render: (row: Incident) => <StatusPill status={row.tier} /> },
    { key: 'tenant', header: 'Tenant', render: (row: Incident) => <code>{row.tenant_id}</code> },
    { key: 'taxon', header: 'Taxon', render: (row: Incident) => row.taxon },
    { key: 'state', header: 'State', render: (row: Incident) => <Badge tone={row.state === 'open' ? 'warning' : 'neutral'}>{row.state}</Badge> },
    { key: 'score', header: 'Score', render: (row: Incident) => row.score.toString(), align: 'right' as const },
    { key: 'action', header: 'Action', render: (row: Incident) => <Button variant={row.tier === 'T3' ? 'danger' : 'secondary'} onClick={() => queueIncidentAction(row)}>{destructiveActionLabel(row.action)}</Button> },
  ], []);

  function queueIncidentAction(row: Incident) {
    const label = destructiveActionLabel(row.action);
    setPending({
      action: row.action,
      title: label,
      message: `${label} for ${row.tenant_id}${row.lease_id ? ` / ${row.lease_id}` : ''}?`,
      run: async () => {
        await performIncidentAction(token, row);
        setToast(`${label} submitted for ${row.incident_id}`);
        await refresh();
      },
    });
  }

  function queueAction(action: string, message: string) {
    if (!requiresConfirmation(action)) return;
    setPending({
      action,
      title: destructiveActionLabel(action),
      message,
      run: async () => { setToast(`${destructiveActionLabel(action)} submitted`); },
    });
  }

  if (!roleAllowed) {
    return <main className="admin-shell"><Card title="Admin role required"><EmptyState title="Forbidden">This console is available only to owner/admin roles.</EmptyState></Card></main>;
  }

  return (
    <main className="admin-shell">
      <header className="admin-hero">
        <div><h1>Loop-it Admin</h1><p>Abuse response, quotas, kill switches, and audit.</p></div>
        <div className="login-box">
          <input aria-label="Platform identity token" placeholder="Paste platform operator token" value={token} onChange={(event) => setToken(event.target.value)} />
          <select aria-label="Role" value={role ?? 'admin'} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="owner">owner</option><option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option>
          </select>
          <Button onClick={() => void refresh()} disabled={!token || !adminAllowed || busy}>{busy ? <Spinner label="Refreshing" /> : 'Refresh'}</Button>
        </div>
      </header>
      {!operatorAllowed && <Toast tone="danger" message="Paste an operator token minted with scripts/mint_operator_token.py. Customer login tokens are rejected." onDismiss={() => undefined} />}
      {error && <Toast tone="danger" message={error} onDismiss={() => setError(null)} />}
      {toast && <Toast tone="success" message={toast} onDismiss={() => setToast(null)} />}

      <Card title="Abuse queue">
        <DataTable rows={incidents} columns={incidentColumns} getRowKey={(row) => row.incident_id} empty={<EmptyState title="No incidents">Infrastructure-abuse queue is clear.</EmptyState>} />
      </Card>

      <section className="grid">
        <Card title="Tenant quotas and overrides">
          <DataTable rows={demoQuotas} getRowKey={(row) => row.tenant_id} columns={[
            { key: 'tenant', header: 'Tenant', render: (row) => <code>{row.tenant_id}</code> },
            { key: 'credits', header: 'Credits', render: (row) => row.balance_credits },
            { key: 'rate', header: 'Rate limit', render: (row) => row.rate_limit.toString() },
            { key: 'state', header: 'State', render: (row) => <StatusPill status={row.suspended ? 'suspended' : 'ok'} /> },
            { key: 'override', header: 'Override', render: (row) => <Button variant="secondary" onClick={() => queueAction('quota_override', `Review quota override for ${row.tenant_id}? Current rate ${row.rate_limit}.`)}>Override</Button> },
          ]} />
        </Card>
        <Card title="Kill-switch panel">
          <div className="switches">
            <Button variant="danger" onClick={() => queueAction('kill_sandbox', 'Kill the selected sandbox lease?')}>Kill sandbox</Button>
            <Button variant="danger" onClick={() => queueAction('suspend_tenant', 'Suspend tenant access?')}>Suspend tenant</Button>
            <Button variant="danger" onClick={() => queueAction('global_pause', 'Pause all automated abuse enforcement globally?')}>Global pause</Button>
          </div>
        </Card>
      </section>

      <Card title="Audit log">
        <DataTable rows={audit.slice(0, 50)} getRowKey={(row) => row.event_id} columns={[
          { key: 'time', header: 'Time', render: (row) => row.occurred_at },
          { key: 'type', header: 'Type', render: (row) => row.type },
          { key: 'tenant', header: 'Tenant', render: (row) => row.tenant_id },
          { key: 'outcome', header: 'Outcome', render: (row) => row.outcome ?? '—' },
        ]} empty={<EmptyState title="No audit records">Refresh after authenticating.</EmptyState>} />
      </Card>

      <ConfirmDialog open={pending !== null} destructive={pending ? requiresConfirmation(pending.action) : false} title={pending?.title ?? ''} message={pending?.message ?? ''} confirmLabel="Confirm" onCancel={() => setPending(null)} onConfirm={() => { const action = pending; setPending(null); if (action) void action.run(); }} />
    </main>
  );
}
