import type { AuditEvent } from '@loop-it/contracts';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type IncidentTier = 'T0' | 'T1' | 'T2' | 'T3';
export type IncidentState = 'open' | 'dismissed' | 'resolved';

export interface Incident {
  incident_id: string;
  tenant_id: string;
  project_id?: string | null;
  sandbox_id?: string | null;
  lease_id?: string | null;
  taxon: string;
  tier: IncidentTier;
  state: IncidentState;
  score: number;
  action: string;
  dry_run: boolean;
  signal_ids: string[];
  created_at: string;
  updated_at: string;
  detail: Record<string, unknown>;
}

export interface TenantQuota {
  tenant_id: string;
  balance_credits: string;
  rate_limit: number;
  suspended: boolean;
}

export interface AdminConfig {
  apiBaseUrl: string;
  operatorAudience: string;
  operatorIssuer: string;
}

declare global {
  interface Window {
    __LOOPIT_ADMIN_API_BASE_URL__?: string;
    __LOOPIT_OPERATOR_IDENTITY_AUDIENCE__?: string;
    __LOOPIT_OPERATOR_IDENTITY_ISSUER__?: string;
  }
}

export function getConfig(): AdminConfig {
  const runtime = window.__LOOPIT_ADMIN_API_BASE_URL__?.trim();
  const buildTime = import.meta.env.VITE_LOOPIT_API_BASE_URL?.trim() as string | undefined;
  return {
    apiBaseUrl: (runtime || buildTime || '/api').replace(/\/$/, ''),
    operatorAudience:
      window.__LOOPIT_OPERATOR_IDENTITY_AUDIENCE__?.trim() ||
      (import.meta.env.VITE_LOOPIT_OPERATOR_IDENTITY_AUDIENCE?.trim() as string | undefined) ||
      'loopit-platform-operator',
    operatorIssuer:
      window.__LOOPIT_OPERATOR_IDENTITY_ISSUER__?.trim() ||
      (import.meta.env.VITE_LOOPIT_OPERATOR_IDENTITY_ISSUER?.trim() as string | undefined) ||
      'loopit-operator',
  };
}

export function canUseAdmin(role: Role | null): boolean {
  return role === 'owner' || role === 'admin';
}

export function isOperatorToken(token: string, config: AdminConfig = getConfig()): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payloadPart = parts[1];
  if (!payloadPart) return false;
  try {
    const payload = JSON.parse(base64UrlDecode(payloadPart)) as {
      aud?: unknown;
      iss?: unknown;
      scopes?: unknown;
    };
    return (
      payload.aud === config.operatorAudience &&
      payload.iss === config.operatorIssuer &&
      Array.isArray(payload.scopes) &&
      payload.scopes.includes('platform:operate')
    );
  } catch {
    return false;
  }
}

function base64UrlDecode(value: string): string {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  return atob(base64);
}

export function destructiveActionLabel(action: string): string {
  const labels: Record<string, string> = {
    kill_sandbox: 'Kill sandbox',
    suspend_tenant: 'Suspend tenant',
    global_pause: 'Pause all automation',
    quota_override: 'Override tenant quota',
    dismiss: 'Dismiss incident',
    allowlist: 'Allowlist false positive',
  };
  return labels[action] ?? action;
}

export function requiresConfirmation(action: string): boolean {
  return [
    'kill_sandbox',
    'suspend_tenant',
    'global_pause',
    'quota_override',
    'dismiss',
    'allowlist',
  ].includes(action);
}

export async function apiFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getConfig().apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export async function listIncidents(token: string): Promise<Incident[]> {
  const body = await apiFetch<{ incidents: Incident[] }>('/v1/incidents', token);
  return body.incidents;
}

export async function listAudit(token: string): Promise<AuditEvent[]> {
  const body = await apiFetch<{ events: AuditEvent[] }>('/v1/audit', token);
  return body.events;
}

export async function performIncidentAction(token: string, incident: Incident): Promise<void> {
  const reason = `admin console action for ${incident.incident_id}`;
  if (incident.action === 'kill_sandbox' && incident.lease_id) {
    await apiFetch('/v1/sandboxes/kill', token, {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: incident.tenant_id,
        lease_id: incident.lease_id,
        reason,
        confirmed: true,
      }),
    });
    return;
  }
  if (incident.action === 'suspend_tenant') {
    await apiFetch(`/v1/tenants/${encodeURIComponent(incident.tenant_id)}/suspend`, token, {
      method: 'POST',
      body: JSON.stringify({ reason, confirmed: true }),
    });
    return;
  }
  await apiFetch(`/v1/incidents/${encodeURIComponent(incident.incident_id)}/dismiss`, token, {
    method: 'POST',
    body: JSON.stringify({ reason, confirmed: true }),
  });
}

export const demoQuotas: TenantQuota[] = [
  { tenant_id: 'tenant-acme', balance_credits: '182.50', rate_limit: 100, suspended: false },
  { tenant_id: 'tenant-lab', balance_credits: '3.00', rate_limit: 12, suspended: true },
];
