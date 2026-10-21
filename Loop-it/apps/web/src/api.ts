/** Browser-facing API client for the Loop-it web app. */

export type RunStatus = 'running' | 'verified' | 'error' | string;
export type NodeStatus = 'pending' | 'running' | 'verifying' | 'blocked' | 'merged' | 'failed';

export interface TaskNodeView {
  id: string;
  kind?: string;
  goal: string;
  dag_parents: string[];
  fork_checkpoint_id?: string;
  expected_verification: string[];
  destructive: boolean;
  destructive_reason?: string;
  status?: NodeStatus;
}

export interface TaskDagView {
  plan_id: string;
  goal: string;
  base_checkpoint_id?: string;
  nodes: TaskNodeView[];
}

export interface ApprovalGate {
  gate_id: string;
  node_id?: string;
  action: string;
  reason: string;
  args?: Record<string, unknown>;
  args_hash?: string;
  expires_at?: string | null;
  destructive: boolean;
  irreversible?: boolean;
  status?: 'pending' | 'approved' | 'rejected';
}

export interface CheckpointView {
  checkpoint_id: string;
  parent_id: string | null;
  label?: string | null;
  created_at: string;
  verified: boolean;
  live?: boolean;
}

export interface RunCost {
  credits_spent?: number;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  iterations?: number;
  cost_per_successful_deploy?: number;
}

export interface RunSummary {
  run_id: string;
  project_id: string;
  prompt: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  iterations: number;
  summary: string;
  credits_spent: number;
  stack?: string;
  dag?: TaskDagView | null;
  task_dag?: TaskDagView | null;
  gates?: ApprovalGate[];
  gate?: ApprovalGate | null;
  checkpoints?: CheckpointView[];
  cost?: RunCost | null;
}

export interface RunDetail extends RunSummary {
  files: string[];
}

export interface AuditStreamEvent {
  kind: 'audit';
  type: string;
  outcome: string | null;
  occurred_at: string;
  detail: Record<string, unknown>;
}

export interface RunStreamEvent extends RunDetail { kind: 'run'; }
export interface DagStreamEvent { kind: 'dag'; dag: TaskDagView; }
export interface GateStreamEvent { kind: 'gate'; gate: ApprovalGate; }
export interface CheckpointsStreamEvent { kind: 'checkpoints'; checkpoints: CheckpointView[]; }
export interface CostStreamEvent { kind: 'cost'; cost: RunCost; }
export interface ErrorStreamEvent { kind: 'error'; message: string; }

export type StreamEvent = AuditStreamEvent | RunStreamEvent | DagStreamEvent | GateStreamEvent | CheckpointsStreamEvent | CostStreamEvent | ErrorStreamEvent;

export interface Health {
  status: string;
  offline: boolean;
  exec_enabled: boolean;
  projects_root: string;
  auth_required?: boolean;
  run_execution_mode?: string;
}

export interface CurrentUser {
  user_id: string;
  email: string | null;
  org_id: string;
  role: string;
  scopes: string[];
}

export interface OrgSummary { org_id: string; name: string; role: string; }
export interface AuthSession { accessToken: string; user: CurrentUser | null; orgs: OrgSummary[]; }
export interface AuthResponse {
  access_token: string;
  token_type: 'bearer';
  user?: { user_id: string; email: string | null };
  org?: { org_id: string; name: string };
  role?: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ErrorKind =
  | 'network'
  | 'run_failure'
  | 'quota'
  | 'payment'
  | 'sandbox'
  | 'model'
  | 'auth'
  | 'permission'
  | 'unavailable'
  | 'unknown';

export interface UserFacingError {
  kind: ErrorKind;
  title: string;
  message: string;
  action: string;
}

export const SESSION_STORAGE_KEY = 'loopit.identity.v1';

declare global { interface Window { __LOOPIT_API_BASE_URL__?: string; } }

export function getApiBaseUrl(): string {
  const runtime = window.__LOOPIT_API_BASE_URL__?.trim();
  return (runtime || '/api').replace(/\/$/, '');
}

export function loadSession(): AuthSession | null {
  const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    return typeof parsed.accessToken === 'string'
      ? { accessToken: parsed.accessToken, user: parsed.user ?? null, orgs: parsed.orgs ?? [] }
      : null;
  } catch {
    clearSession();
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void { window.sessionStorage.removeItem(SESSION_STORAGE_KEY); }

function authHeaders(token?: string): HeadersInit { return token ? { Authorization: `Bearer ${token}` } : {}; }

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body || `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      if (typeof parsed.detail === 'string') message = parsed.detail;
    } catch { /* keep raw body */ }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export function toUserFacingError(cause: unknown): UserFacingError {
  const status = cause instanceof ApiError ? cause.status : 0;
  const raw = cause instanceof Error ? cause.message : String(cause);
  const normalized = raw.toLowerCase();
  if (status === 401) return { kind: 'auth', title: 'Sign in again', message: 'Your session expired.', action: 'Sign in and retry the action.' };
  if (status === 403) return { kind: 'permission', title: 'Permission needed', message: 'Your role cannot perform this action.', action: 'Ask an org owner for access.' };
  if (status === 402 || normalized.includes('hard_quota')) return { kind: 'payment', title: 'Upgrade required', message: 'This org is out of included credits.', action: 'Review plans or add credits before starting another run.' };
  if (status === 429 || normalized.includes('quota') || normalized.includes('rate_limited')) return { kind: 'quota', title: 'Quota limit reached', message: 'A daily, token, sandbox, or egress limit stopped the request.', action: 'Wait for the window to reset or upgrade the plan.' };
  if (status === 503 && normalized.includes('temporal')) return { kind: 'unavailable', title: 'Run service unavailable', message: 'The durable run service is not reachable.', action: 'Check status, then retry when the operator has restored it.' };
  if (status === 503 && normalized.includes('sandbox')) return { kind: 'sandbox', title: 'Sandbox unavailable', message: 'No isolated build sandbox is available right now.', action: 'Retry shortly or contact support if it persists.' };
  if (status === 503 || normalized.includes('model')) return { kind: 'model', title: 'Model unavailable', message: 'The selected model endpoint could not accept the run.', action: 'Retry or choose a lower effort while operators check the router.' };
  if (status >= 500) return { kind: 'run_failure', title: 'Run failed safely', message: 'The platform hit an internal failure without exposing details.', action: 'Retry the run. If it repeats, share the run ID with support.' };
  if (raw === 'Failed to fetch' || normalized.includes('network') || normalized.includes('aborted')) return { kind: 'network', title: 'Connection interrupted', message: 'The browser lost contact with Loop-it.', action: 'Check your connection; live updates will retry automatically.' };
  return { kind: 'unknown', title: 'Action could not finish', message: 'Loop-it could not complete the request.', action: 'Review your input and try again.' };
}

export async function apiFetch<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(authHeaders(token))) headers.set(key, value);
  return json<T>(await fetch(`${getApiBaseUrl()}${path}`, { ...init, headers }));
}

export async function getHealth(token?: string): Promise<Health> { return apiFetch<Health>('/health', token); }
export async function register(input: { email: string; password: string; orgName: string; displayName?: string; aupAccepted?: boolean; }): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/auth/register', undefined, { method: 'POST', body: JSON.stringify({ email: input.email, password: input.password, org_name: input.orgName, display_name: input.displayName || null, aup_accepted: Boolean(input.aupAccepted) }) });
}
export async function login(input: { email: string; password: string; orgId: string; }): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/auth/login', undefined, { method: 'POST', body: JSON.stringify({ email: input.email, password: input.password, org_id: input.orgId }) });
}
export async function logout(token: string): Promise<void> { await apiFetch('/auth/logout', token, { method: 'POST' }); }
export async function getMe(token: string): Promise<CurrentUser> { return apiFetch<CurrentUser>('/auth/me', token); }
export async function getOrgs(token: string): Promise<OrgSummary[]> { return apiFetch<OrgSummary[]>('/auth/orgs', token); }
export async function getLegalAup(): Promise<{ version: string; text: string }> { return apiFetch('/legal/aup'); }
export async function getBillingBalance(token: string): Promise<{ balance: string; plan: string }> { return apiFetch('/billing/balance', token); }
export async function listRuns(token: string): Promise<RunSummary[]> { return apiFetch('/runs', token); }
export async function deployProject(token: string, projectId: string, checkpointId: string, reason: string): Promise<{ production_url: string; status: string }> {
  return apiFetch(`/projects/${encodeURIComponent(projectId)}/deploy`, token, { method: 'POST', body: JSON.stringify({ checkpoint_id: checkpointId, confirmed: true, reason }) });
}
export async function startRun(token: string, prompt: string, options: { projectId?: string | null; maxIterations?: number } = {}): Promise<RunSummary> {
  return apiFetch<RunSummary>('/runs', token, { method: 'POST', body: JSON.stringify({ prompt, project_id: options.projectId ?? null, max_iterations: options.maxIterations ?? 12 }) });
}

export function siteUrl(projectId: string, _token: string, path = 'index.html'): string {
  return `${getApiBaseUrl()}/projects/${projectId}/site/${path}`;
}
export async function createPreviewUrl(token: string, projectId: string, path = 'index.html'): Promise<string> {
  const body = await apiFetch<{ url: string }>(`/projects/${encodeURIComponent(projectId)}/preview`, token, { method: 'POST', body: JSON.stringify({ path }) });
  return body.url.startsWith('http') ? body.url : `${getApiBaseUrl().replace(/\/api$/, '')}${body.url}`;
}

export async function getRun(token: string, runId: string): Promise<RunDetail> { return apiFetch<RunDetail>(`/runs/${runId}`, token); }
export async function getFile(token: string, runId: string, path: string): Promise<string> {
  const body = await apiFetch<{ content: string }>(`/runs/${runId}/file?path=${encodeURIComponent(path)}`, token);
  return body.content;
}
export async function approveGate(token: string, runId: string, gateId: string, reason: string): Promise<void> {
  await apiFetch(`/runs/${runId}/gates/${encodeURIComponent(gateId)}/approve`, token, { method: 'POST', body: JSON.stringify({ reason }) });
}
export async function rejectGate(token: string, runId: string, gateId: string, reason: string): Promise<void> {
  await apiFetch(`/runs/${runId}/gates/${encodeURIComponent(gateId)}/reject`, token, { method: 'POST', body: JSON.stringify({ reason }) });
}
export async function rollbackCheckpoint(token: string, projectId: string, checkpointId: string): Promise<void> {
  await apiFetch(`/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/rollback`, token, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
}
export async function forkCheckpoint(token: string, projectId: string, checkpointId: string): Promise<{ project_id?: string }> {
  return apiFetch<{ project_id?: string }>(`/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/fork`, token, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
}

export async function streamRunEvents(token: string, runId: string, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const init: RequestInit = { headers: authHeaders(token) };
  if (signal) init.signal = signal;
  const response = await fetch(`${getApiBaseUrl()}/runs/${runId}/events`, init);
  if (!response.ok) throw new ApiError(response.status, await response.text());
  if (!response.body) throw new Error('streaming is not supported by this browser');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const parsed = parseSseChunk(chunk);
      if (parsed === 'end') return;
      if (parsed) onEvent(parsed);
    }
    if (done) break;
  }
}

function parseSseChunk(chunk: string): StreamEvent | 'end' | null {
  const lines = chunk.split(/\r?\n/);
  if (lines.some((line) => line.trim() === 'event: end')) return 'end';
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  return data ? (JSON.parse(data) as StreamEvent) : null;
}
