import type { TaskKind } from '@loop/loopit-contracts'

import { ApiError } from './errors'
import { LOOPIT_API_BASE, createTokenStore, type TokenStore, type TokenStoreOptions } from './authToken'

export type RunStatus = 'running' | 'verified' | 'error' | string
export type NodeStatus = 'pending' | 'running' | 'verifying' | 'blocked' | 'merged' | 'failed'
export type RunMode = 'build' | 'chat' | 'plan'
export type FileChangeOp = 'create' | 'modify' | 'delete'

export interface FileChange {
  path: string
  op: FileChangeOp
  diff: string
  additions: number
  deletions: number
}

export type ProjectVisibility = 'private' | 'link' | 'public_remix'

export interface ProjectSummary {
  project_id: string
  name: string
  stack?: string
  current_checkpoint_id?: string | null
  created_at?: string | null
  updated_at?: string | null
  archived_at?: string | null
  run_count?: number
  knowledge?: string
  visibility?: ProjectVisibility
  share_id?: string | null
}

export interface GitSyncStatus {
  bound: boolean
  provider?: string
  mode?: string
  owner?: string
  name?: string
  clone_url?: string
  default_branch?: string
  last_commit_sha?: string | null
  last_checkpoint_id?: string | null
  auto_push?: boolean
}

export interface DomainClaim {
  claim_id: string
  hostname: string
  status: string
  challenge_name: string
  challenge_value: string
  expires_at: string
  project_id: string
  tls_status?: string | null
  challenge_type?: string
  cname_target?: string
}

export interface PublicShare {
  share_id: string
  project_id: string
  title: string
  visibility: ProjectVisibility
  production_url?: string | null
  checkpoint_id?: string | null
  remix_allowed: boolean
}

export interface BuildTemplate {
  id: string
  title: string
  description: string
  stack: string
  prompt_seed: string
  tags?: string[]
  source?: string
}

export interface ProjectDetail extends ProjectSummary {
  runs?: RunSummary[]
  files?: string[]
  checkpoints?: CheckpointView[]
}

export interface TaskNodeView {
  id: string
  kind?: TaskKind | string
  goal: string
  dag_parents: string[]
  fork_checkpoint_id?: string
  expected_verification: string[]
  destructive: boolean
  destructive_reason?: string
  status?: NodeStatus
}

export interface TaskDagView {
  plan_id: string
  goal: string
  base_checkpoint_id?: string
  nodes: TaskNodeView[]
}

export interface ApprovalGate {
  gate_id: string
  node_id?: string
  action: string
  reason: string
  args?: Record<string, unknown>
  args_hash?: string
  expires_at?: string | null
  destructive: boolean
  irreversible?: boolean
  status?: 'pending' | 'approved' | 'rejected'
}

export interface CheckpointView {
  checkpoint_id: string
  parent_id: string | null
  label?: string | null
  created_at: string
  verified: boolean
  live?: boolean
}

export interface RunCost {
  credits_spent?: number
  cost_usd?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  iterations?: number
  cost_per_successful_deploy?: number
}

export interface RunSummary {
  run_id: string
  project_id: string
  prompt: string
  /** Product-style name composed by the engine's brief; absent on legacy runs. */
  title?: string
  status: RunStatus
  started_at: string
  finished_at: string | null
  iterations: number
  summary: string
  credits_spent: number
  stack?: string
  tier?: RunTier
  mode?: RunMode
  background?: boolean
  base_checkpoint_id?: string | null
  pending_review_id?: string | null
  dag?: TaskDagView | null
  task_dag?: TaskDagView | null
  gates?: ApprovalGate[]
  gate?: ApprovalGate | null
  checkpoints?: CheckpointView[]
  cost?: RunCost | null
}

export interface RunDetail extends RunSummary {
  files: string[]
}

export interface AuditStreamEvent {
  kind: 'audit'
  type: string
  outcome: string | null
  occurred_at: string
  detail: Record<string, unknown>
}

export interface RunStreamEvent extends RunDetail { kind: 'run' }
export interface DagStreamEvent { kind: 'dag'; dag: TaskDagView }
export interface GateStreamEvent { kind: 'gate'; gate: ApprovalGate }
export interface CheckpointsStreamEvent { kind: 'checkpoints'; checkpoints: CheckpointView[] }
export interface CostStreamEvent { kind: 'cost'; cost: RunCost }
export interface ErrorStreamEvent { kind: 'error'; message: string; code?: string }
export interface ChatStreamEvent { kind: 'chat'; role: 'user' | 'assistant'; text: string }
export interface ChatChunkStreamEvent { kind: 'chat_chunk'; text: string }
export interface FileChangeStreamEvent extends FileChange { kind: 'file_change' }
export interface LogStreamEvent {
  kind: 'log'
  stream: 'stdout' | 'stderr' | string
  text: string
  tool?: string
}

export type StreamEvent =
  | AuditStreamEvent
  | RunStreamEvent
  | DagStreamEvent
  | GateStreamEvent
  | CheckpointsStreamEvent
  | CostStreamEvent
  | ChatStreamEvent
  | ChatChunkStreamEvent
  | FileChangeStreamEvent
  | LogStreamEvent
  | ErrorStreamEvent

export interface Health {
  status: string
  offline: boolean
  exec_enabled: boolean
  projects_root: string
  auth_required?: boolean
  run_execution_mode?: string
  local_gates?: boolean
  hosting_provider?: string
  apps_base_domain?: string | null
  domains_configured?: boolean
  domains_mode?: string
  gitsync_provider?: string
  fly_configured?: boolean
  provision_provider?: string
  background_builds?: boolean
  dev_prod_databases?: boolean
}

/** Phase 2.9 notification from a finished background build (or apply). */
export interface BuildNotification {
  notification_id: string
  kind: string
  title: string
  body: string
  project_id?: string | null
  run_id?: string | null
  review_id?: string | null
  read: boolean
  created_at: string
}

/** Pending Apply-changes review for a background build. */
export interface PendingReview {
  review_id: string
  project_id: string
  run_id: string
  checkpoint_id: string
  base_checkpoint_id?: string | null
  status: 'pending' | 'applied' | 'dismissed' | string
  title?: string
  summary?: string
  file_changes: FileChange[]
  created_at: string
  applied_at?: string
  dismissed_at?: string
}

export interface Me {
  user_id: string
  email: string | null
  org_id: string
  role: string
  scopes: string[]
}

/** Scope the engine requires on `/projects/<id>/exec`. Only admins are issued it. */
export const TERMINAL_SCOPE = 'build:terminal'

export interface LoopitClientOptions extends TokenStoreOptions {
  baseUrl?: string
}

export type RunTier = 'quick' | 'standard' | 'deep' | 'max'

/** Minted preview URL plus when the signed token expires (epoch ms). */
export interface PreviewUrl {
  url: string
  /** Absolute expiry time in ms. Defaults to now + 900s when the engine omits expires_at. */
  expiresAt: number
  /** static = signed site files; hmr = preview-proxy (Vite HMR). */
  mode?: 'static' | 'hmr'
}

export interface StreamRunOptions {
  signal?: AbortSignal
  /** Resume after this journal sequence number (`?after=`). Engine must honour it. */
  after?: number
}

/** Default signed-preview TTL when the engine does not return expires_at (seconds). */
export const PREVIEW_TTL_SECONDS = 900

export interface LoopitClient {
  getToken: TokenStore['getToken']
  clearToken: TokenStore['clear']
  getHealth: () => Promise<Health>
  getMe: () => Promise<Me>
  listRuns: () => Promise<RunSummary[]>
  getRun: (runId: string) => Promise<RunDetail>
  startRun: (prompt: string, options?: {
    projectId?: string | null
    maxIterations?: number
    tier?: RunTier
    mode?: RunMode
    attachmentUrls?: string[]
    background?: boolean
    /** Paired browser on the same user-scoped bridge Chat and Loop Bot use. */
    browser?: boolean
    browserDeviceId?: string
    browserGrantId?: string
  }) => Promise<RunSummary>
  listNotifications: (options?: { unreadOnly?: boolean }) => Promise<{ notifications: BuildNotification[]; unread_count: number }>
  markNotificationsRead: (notificationId?: string | null) => Promise<{ marked: number; unread_count: number }>
  listReviews: (options?: { projectId?: string; status?: string | null }) => Promise<PendingReview[]>
  getReview: (reviewId: string) => Promise<PendingReview>
  applyReview: (reviewId: string, reason?: string) => Promise<{ review: PendingReview; checkpoint?: CheckpointView }>
  dismissReview: (reviewId: string, reason?: string) => Promise<PendingReview>
  sendRunMessage: (runId: string, message: string) => Promise<{ queued: boolean }>
  cancelRun: (runId: string) => Promise<{ cancelled: boolean }>
  listProjects: (options?: { includeArchived?: boolean }) => Promise<ProjectSummary[]>
  getProject: (projectId: string) => Promise<ProjectDetail>
  renameProject: (projectId: string, name: string) => Promise<ProjectSummary>
  archiveProject: (projectId: string) => Promise<ProjectSummary>
  restoreProject: (projectId: string) => Promise<ProjectSummary>
  duplicateProject: (projectId: string) => Promise<{ project_id: string; name?: string }>
  putProjectKnowledge: (projectId: string, knowledge: string) => Promise<{ project_id: string; knowledge: string }>
  setProjectVisibility: (projectId: string, visibility: ProjectVisibility, title?: string) => Promise<{ share_id: string; visibility: ProjectVisibility }>
  getGitStatus: (projectId: string) => Promise<GitSyncStatus>
  bindGitRemote: (projectId: string, owner: string, name: string, options?: { create?: boolean; autoPush?: boolean; accessToken?: string }) => Promise<GitSyncStatus>
  unbindGitRemote: (projectId: string) => Promise<void>
  pushGitCheckpoint: (projectId: string, checkpointId: string, accessToken?: string) => Promise<{ commit_sha: string; branch: string }>
  pullGitWebhook: (projectId: string, payload: { files?: Record<string, string>; conflict?: boolean; after?: string; label?: string }) => Promise<{ checkpoint_id: string; backup_branch?: string | null }>
  listProjectDomains: (projectId: string) => Promise<DomainClaim[]>
  claimProjectDomain: (projectId: string, hostname: string) => Promise<DomainClaim>
  verifyProjectDomain: (projectId: string, hostname: string, seedTxt?: boolean) => Promise<DomainClaim>
  getPublicShare: (shareId: string) => Promise<PublicShare>
  remixPublicShare: (shareId: string) => Promise<{ project_id: string }>
  listTemplates: () => Promise<BuildTemplate[]>
  getTemplate: (templateId: string) => Promise<BuildTemplate>
  remixTemplate: (templateId: string) => Promise<{ project_id: string; run_id: string; prompt: string }>
  getCheckpointFile: (projectId: string, checkpointId: string, path: string) => Promise<string>
  execCommand: (projectId: string, command: string, timeoutSeconds?: number) => Promise<{ command: string; exit_code: number; stdout: string; stderr: string; duration_seconds: number; truncated: boolean }>
  deployProject: (projectId: string, checkpointId: string, reason: string, options?: { overrideSecurity?: boolean }) => Promise<{ production_url: string; status: string; deployment_id?: string }>
  /** Flip a deployment to unpublished so its public URL 404s. */
  unpublishProject: (projectId: string, deploymentId: string) => Promise<void>
  /** Flip an unpublished deployment back to live (same checkpoint blobs). */
  republishProject: (projectId: string, deploymentId: string) => Promise<{ production_url?: string; status: string; deployment_id?: string }>
  rollbackDeployment: (projectId: string, deploymentId: string) => Promise<{ production_url?: string; status: string; deployment_id?: string }>
  listDeployments: (projectId: string) => Promise<Array<{ deployment_id: string; status: string; production_url?: string; checkpoint_id?: string; created_at?: string; hosting_provider?: string }>>
  listProjectSecrets: (projectId: string, environment?: string) => Promise<Array<{ name: string; environment?: string; status?: string; reason?: string }>>
  putProjectSecret: (projectId: string, name: string, value: string, environment?: string) => Promise<void>
  deleteProjectSecret: (projectId: string, name: string, environment?: string) => Promise<void>
  getProjectDatabase: (projectId: string, environment?: 'dev' | 'prod' | string) => Promise<{
    tables: Array<{ name: string; schema?: string; rls?: boolean }>
    schema?: string
    storage_prefix?: string
    auth_ready?: boolean
    provider?: string
    environment?: string
    prod_ready?: boolean
    prod_schema?: string | null
  }>
  getProjectDatabaseTable: (projectId: string, table: string, environment?: 'dev' | 'prod' | string) => Promise<{ table: string; columns: string[]; rows: unknown[]; note?: string; environment?: string }>
  approveGate: (runId: string, gateId: string, reason: string) => Promise<void>
  rejectGate: (runId: string, gateId: string, reason: string) => Promise<void>
  rollbackCheckpoint: (projectId: string, checkpointId: string) => Promise<void>
  forkCheckpoint: (projectId: string, checkpointId: string) => Promise<{ project_id?: string }>
  createPreviewUrl: (projectId: string, path?: string) => Promise<PreviewUrl>
  /** Forward a preview iframe console/runtime error to the engine (Phase 1.5). */
  reportConsoleError: (projectId: string, payload: { level: string; text: string; href?: string }) => Promise<void>
  /** Phase 2.1 — deterministic visual edit or LLM prompt fallback. */
  applyVisualEdit: (projectId: string, body: VisualEditBody) => Promise<VisualEditResult>
  /** Phase 3.1 — Monaco / user edit via apply_patch + checkpoint. */
  applyProjectPatch: (projectId: string, body: ApplyPatchBody) => Promise<ApplyPatchResult>
  /** Phase 3.3 — social/SEO card fields from preview HTML. */
  getPreviewMeta: (projectId: string, path?: string) => Promise<PreviewMeta>
  /** Phase 3.2 — whether an interactive PTY websocket is available. */
  getPtyInfo: (projectId: string) => Promise<PtyInfo>
  /** Phase 1.1 / 3.2 — project sandbox lease (orchestrator). */
  getProjectLease: (projectId: string) => Promise<ProjectLeaseInfo>
  /** Phase 2.2 — Playwright / offline browser self-test. */
  startBrowserTest: (projectId: string, body?: BrowserTestBody) => Promise<BrowserTestRun>
  listBrowserTests: (projectId: string) => Promise<BrowserTestRun[]>
  getBrowserTest: (projectId: string, testId: string) => Promise<BrowserTestRun>
  /** Phase 2.8 — on-demand security scan. */
  runSecurityScan: (projectId: string, body?: SecurityScanBody) => Promise<SecurityScanResult>
  getSecurityScan: (projectId: string) => Promise<SecurityScanResult>
  /** Phase 3.7 — generated-app connectors (Stripe / Resend / AI router). */
  listProjectConnectors: (projectId: string) => Promise<{ connectors: ProjectConnector[]; mode?: string }>
  setProjectConnector: (projectId: string, kind: ProjectConnectorKind, enabled: boolean) => Promise<ProjectConnector>
  /** Phase 3.8 — published app page views. */
  getProjectAnalytics: (projectId: string) => Promise<ProjectAnalytics>
  seedProjectAnalytics: (projectId: string, pageViews: number) => Promise<ProjectAnalytics>
  /** Phase 3.9 — presence + shared project chat. */
  getProjectCollab: (projectId: string) => Promise<ProjectCollab>
  heartbeatProjectPresence: (projectId: string, displayName?: string) => Promise<ProjectCollab>
  postProjectCollabChat: (projectId: string, text: string, displayName?: string) => Promise<ProjectCollab>
  getFile: (runId: string, path: string) => Promise<string>
  streamRunEvents: (runId: string, onEvent: (event: StreamEvent) => void, options?: AbortSignal | StreamRunOptions) => Promise<void>
}

export type ProjectConnectorKind = 'stripe' | 'resend' | 'ai_router'

export interface ProjectConnector {
  kind: ProjectConnectorKind | string
  label?: string
  description?: string
  enabled?: boolean
  status?: string
  source?: string
  note?: string | null
  secret_names?: string[]
  catalog_type?: string | null
  updated_at?: string | null
}

export interface ProjectAnalytics {
  project_id: string
  page_views: number
  html_views?: number
  last_view_at?: string | null
  by_path?: Record<string, number>
  source?: string
  note?: string
}

export interface PresencePeer {
  actor_id: string
  display_name: string
  role?: string
  last_seen_at?: string
}

export interface CollabChatMessage {
  message_id: string
  actor_id: string
  display_name: string
  text: string
  created_at: string
}

export interface ProjectCollab {
  project_id: string
  presence: PresencePeer[]
  online_count: number
  messages: CollabChatMessage[]
}

export type VisualEditKind = 'text' | 'color' | 'spacing' | 'class'

export interface VisualEditBody {
  kind: VisualEditKind
  value: string
  selector?: string
  snippet?: string
  loc?: string | null
  tag?: string | null
  text?: string | null
}

export interface VisualEditResult {
  applied: boolean
  mode: 'codemod' | 'llm' | string
  path?: string | null
  message?: string
  prompt?: string | null
}

export interface ApplyPatchBody {
  path: string
  content?: string | null
  patch?: string | null
  label?: string
  checkpoint?: boolean
}

export interface ApplyPatchResult {
  ok: boolean
  path: string
  message?: string
  file_changes?: FileChange[]
  checkpoint?: CheckpointView | null
}

export interface PreviewMeta {
  project_id: string
  path: string
  title?: string | null
  description?: string | null
  og_image?: string | null
  og_title?: string | null
}

export interface PtyInfo {
  project_id: string
  available: boolean
  mode: 'sandbox' | 'host' | 'offline' | string
  ws_path: string
  detail?: string
}

export interface ProjectLeaseInfo {
  project_id: string
  mode: string
  lease?: {
    lease_id: string
    sandbox_id?: string
    expires_at?: string | number
    allowed_tools?: string[]
  } | null
  detail?: string
}

export interface BrowserTestBody {
  preview_url?: string
  acceptance?: string[]
  force_offline?: boolean
}

export interface BrowserTestStep {
  n: number
  t: number
  kind: string
  [key: string]: unknown
}

export interface BrowserTestRun {
  test_id: string
  project_id: string
  status: string
  mode: string
  preview_url?: string
  started_at?: string
  finished_at?: string
  summary?: string
  steps?: BrowserTestStep[]
  artifact_dir?: string
  video_path?: string | null
  trace_path?: string | null
  test_user?: { email?: string; password?: string; label?: string } | null
  error?: string | null
}

export interface SecurityFinding {
  rule_id: string
  severity: string
  stage?: string
  path?: string | null
  line?: number | null
  message: string
  plain?: string
  blocks_publish?: boolean
}

export interface SecurityScanBody {
  gate?: 'build' | 'deploy' | string
  force_offline?: boolean
}

export interface SecurityScanResult {
  scan_id?: string
  project_id?: string
  mode?: string
  gate?: string
  passed?: boolean
  stub?: boolean
  blocking_count?: number
  advisory_count?: number
  findings?: SecurityFinding[]
  summary?: string
  notes?: string[]
  started_at?: string
  finished_at?: string
}

export function createLoopitClient(options: LoopitClientOptions = {}): LoopitClient {
  const baseUrl = (options.baseUrl ?? LOOPIT_API_BASE).replace(/\/$/, '')
  const store = createTokenStore(options)

  async function apiFetch<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const token = await store.getToken(attempt > 0)
    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer ${token}`)
    let response: Response
    try {
      response = await fetchImpl(options)(`${baseUrl}${path}`, { ...init, headers })
    } catch (cause) {
      if (isAbort(cause)) throw cause
      throw new ApiError(0, cause instanceof Error ? cause.message : 'Failed to fetch')
    }
    if (response.status === 401 && attempt === 0) {
      store.clear()
      return apiFetch<T>(path, init, 1)
    }
    return readJson<T>(response)
  }

  return {
    getToken: store.getToken,
    clearToken: store.clear,
    getHealth: () => apiFetch<Health>('/health'),
    getMe: () => apiFetch<Me>('/auth/me'),
    listRuns: async () => {
      const body = await apiFetch<unknown>('/runs')
      if (!Array.isArray(body)) throw new ApiError(502, 'unexpected runs payload')
      return body as RunSummary[]
    },
    getRun: (runId) => apiFetch<RunDetail>(`/runs/${encodeURIComponent(runId)}`),
    startRun: (prompt, runOptions = {}) => apiFetch<RunSummary>('/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        project_id: runOptions.projectId ?? null,
        // Only pin an iteration budget when the caller explicitly asks for one.
        // The engine sizes its budget from the brief's complexity (8/14/24/40);
        // a hardcoded low cap starved medium builds into budget_exceeded
        // ("Failed" badge) before they could finish.
        ...(runOptions.maxIterations != null ? { max_iterations: runOptions.maxIterations } : {}),
        ...(runOptions.tier ? { tier: runOptions.tier } : {}),
        ...(runOptions.mode ? { mode: runOptions.mode } : {}),
        ...(runOptions.attachmentUrls?.length ? { attachment_urls: runOptions.attachmentUrls } : {}),
        ...(runOptions.background ? { background: true } : {}),
        ...(runOptions.browser ? { browser: true, browser_device_id: runOptions.browserDeviceId, ...(runOptions.browserGrantId ? { browser_grant_id: runOptions.browserGrantId } : {}) } : {}),
      }),
    }),
    listNotifications: async (listOptions = {}) => {
      const qs = listOptions.unreadOnly ? '?unread_only=true' : ''
      return apiFetch<{ notifications: BuildNotification[]; unread_count: number }>(`/notifications${qs}`)
    },
    markNotificationsRead: (notificationId) =>
      apiFetch<{ marked: number; unread_count: number }>('/notifications/read', {
        method: 'POST',
        body: JSON.stringify(notificationId ? { notification_id: notificationId } : {}),
      }),
    listReviews: async (listOptions = {}) => {
      const params = new URLSearchParams()
      if (listOptions.projectId) params.set('project_id', listOptions.projectId)
      if (listOptions.status === null) params.set('status', '')
      else if (listOptions.status) params.set('status', listOptions.status)
      const qs = params.toString() ? `?${params}` : ''
      const body = await apiFetch<unknown>(`/reviews${qs}`)
      if (!Array.isArray(body)) throw new ApiError(502, 'unexpected reviews payload')
      return body as PendingReview[]
    },
    getReview: (reviewId) => apiFetch<PendingReview>(`/reviews/${encodeURIComponent(reviewId)}`),
    applyReview: (reviewId, reason = 'apply background build') =>
      apiFetch<{ review: PendingReview; checkpoint?: CheckpointView }>(
        `/reviews/${encodeURIComponent(reviewId)}/apply`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmed: true, reason }),
        },
      ),
    dismissReview: (reviewId, reason = 'dismiss background build') =>
      apiFetch<PendingReview>(`/reviews/${encodeURIComponent(reviewId)}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, reason }),
      }),
    sendRunMessage: (runId, message) => apiFetch<{ queued: boolean }>(`/runs/${encodeURIComponent(runId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
    cancelRun: (runId) => apiFetch<{ cancelled: boolean }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
    listProjects: async (listOptions = {}) => {
      const qs = listOptions.includeArchived ? '?include_archived=true' : ''
      const body = await apiFetch<unknown>(`/projects${qs}`)
      if (!Array.isArray(body)) throw new ApiError(502, 'unexpected projects payload')
      return body as ProjectSummary[]
    },
    getProject: (projectId) => apiFetch<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`),
    renameProject: (projectId, name) => apiFetch<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
    archiveProject: (projectId) => apiFetch<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}/archive`, {
      method: 'POST',
    }),
    restoreProject: (projectId) => apiFetch<ProjectSummary>(`/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
    duplicateProject: (projectId) => apiFetch<{ project_id: string; name?: string }>(`/projects/${encodeURIComponent(projectId)}/duplicate`, {
      method: 'POST',
    }),
    putProjectKnowledge: (projectId, knowledge) => apiFetch<{ project_id: string; knowledge: string }>(
      `/projects/${encodeURIComponent(projectId)}/knowledge`,
      { method: 'PUT', body: JSON.stringify({ knowledge }) },
    ),
    setProjectVisibility: (projectId, visibility, title) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/visibility`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility, ...(title ? { title } : {}) }),
      }),
    getGitStatus: (projectId) => apiFetch(`/projects/${encodeURIComponent(projectId)}/git`),
    bindGitRemote: (projectId, owner, name, options = {}) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/git/bind`, {
        method: 'POST',
        body: JSON.stringify({
          owner,
          name,
          create: options.create ?? true,
          auto_push: options.autoPush ?? true,
          ...(options.accessToken ? { access_token: options.accessToken } : {}),
        }),
      }),
    unbindGitRemote: async (projectId) => {
      await apiFetch(`/projects/${encodeURIComponent(projectId)}/git`, { method: 'DELETE' })
    },
    pushGitCheckpoint: (projectId, checkpointId, accessToken) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/git/push`, {
        method: 'POST',
        body: JSON.stringify({
          checkpoint_id: checkpointId,
          ...(accessToken ? { access_token: accessToken } : {}),
        }),
      }),
    pullGitWebhook: (projectId, payload) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/git/webhook`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    listProjectDomains: (projectId) => apiFetch(`/projects/${encodeURIComponent(projectId)}/domains`),
    claimProjectDomain: (projectId, hostname) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/domains`, {
        method: 'POST',
        body: JSON.stringify({ hostname }),
      }),
    verifyProjectDomain: (projectId, hostname, seedTxt = true) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}/verify`, {
        method: 'POST',
        body: JSON.stringify({ seed_txt: seedTxt }),
      }),
    getPublicShare: async (shareId) => {
      // Public page — no identity token required.
      const response = await fetchImpl(options)(
        `${baseUrl}/public/share/${encodeURIComponent(shareId)}`,
      )
      const body = await readJson<PublicShare>(response)
      if (!body?.production_url) return body
      return {
        ...body,
        production_url: resolvePreviewUrl(body.production_url, baseUrl),
      }
    },
    remixPublicShare: (shareId) =>
      apiFetch(`/public/share/${encodeURIComponent(shareId)}/remix`, { method: 'POST' }),
    listTemplates: async () => {
      const response = await fetchImpl(options)(`${baseUrl}/templates`)
      return readJson<BuildTemplate[]>(response)
    },
    getTemplate: async (templateId) => {
      const response = await fetchImpl(options)(
        `${baseUrl}/templates/${encodeURIComponent(templateId)}`,
      )
      return readJson<BuildTemplate>(response)
    },
    remixTemplate: (templateId) =>
      apiFetch(`/templates/${encodeURIComponent(templateId)}/remix`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      }),
    getCheckpointFile: async (projectId, checkpointId, path) => {
      const body = await apiFetch<{ content: string }>(
        `/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/file?path=${encodeURIComponent(path)}`,
      )
      return body.content
    },
    execCommand: (projectId, command, timeoutSeconds) => apiFetch<{ command: string; exit_code: number; stdout: string; stderr: string; duration_seconds: number; truncated: boolean }>(`/projects/${encodeURIComponent(projectId)}/exec`, {
      method: 'POST',
      body: JSON.stringify({ command, ...(timeoutSeconds != null ? { timeout_seconds: timeoutSeconds } : {}) }),
    }),
    deployProject: async (projectId, checkpointId, reason, options = {}) => {
      const body = await apiFetch<{ production_url: string; status: string; deployment_id?: string }>(`/projects/${encodeURIComponent(projectId)}/deploy`, {
        method: 'POST',
        body: JSON.stringify({
          checkpoint_id: checkpointId,
          confirmed: true,
          reason,
          ...(options.overrideSecurity ? { override_security: true } : {}),
        }),
      })
      // The engine returns a root-relative site path; route it through the
      // gateway so the "Open app" link actually loads the deployed site.
      return {
        production_url: resolvePreviewUrl(body.production_url, baseUrl),
        status: body.status,
        ...(body.deployment_id ? { deployment_id: body.deployment_id } : {}),
      }
    },
    // Engine Phase 0.4: POST .../deployments/{id}/unpublish|republish.
    unpublishProject: async (projectId, deploymentId) => {
      await apiFetch(`/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/unpublish`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      })
    },
    rollbackDeployment: async (projectId, deploymentId) => {
      const body = await apiFetch<{ production_url?: string; status: string; deployment_id?: string }>(
        `/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/rollback`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmed: true }),
        },
      )
      return {
        status: body.status,
        ...(body.production_url ? { production_url: resolvePreviewUrl(body.production_url, baseUrl) } : {}),
        ...(body.deployment_id ? { deployment_id: body.deployment_id } : { deployment_id: deploymentId }),
      }
    },
    listDeployments: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/deployments`),
    listProjectSecrets: (projectId, environment = 'build') =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/secrets?environment=${encodeURIComponent(environment)}`),
    putProjectSecret: async (projectId, name, value, environment = 'build') => {
      await apiFetch(`/projects/${encodeURIComponent(projectId)}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ name, value, environment }),
      })
    },
    deleteProjectSecret: async (projectId, name, environment = 'build') => {
      await apiFetch(
        `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(name)}?environment=${encodeURIComponent(environment)}`,
        { method: 'DELETE' },
      )
    },
    getProjectDatabase: (projectId, environment = 'dev') =>
      apiFetch(
        `/projects/${encodeURIComponent(projectId)}/database?environment=${encodeURIComponent(environment)}`,
      ),
    getProjectDatabaseTable: (projectId, table, environment = 'dev') =>
      apiFetch(
        `/projects/${encodeURIComponent(projectId)}/database/tables/${encodeURIComponent(table)}?environment=${encodeURIComponent(environment)}`,
      ),
    republishProject: async (projectId, deploymentId) => {
      const body = await apiFetch<{ production_url?: string; status: string; deployment_id?: string }>(
        `/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/republish`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmed: true }),
        },
      )
      return {
        status: body.status,
        ...(body.deployment_id ? { deployment_id: body.deployment_id } : { deployment_id: deploymentId }),
        ...(body.production_url ? { production_url: resolvePreviewUrl(body.production_url, baseUrl) } : {}),
      }
    },
    approveGate: async (runId, gateId, reason) => {
      await apiFetch(`/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
    },
    rejectGate: async (runId, gateId, reason) => {
      await apiFetch(`/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
    },
    rollbackCheckpoint: async (projectId, checkpointId) => {
      await apiFetch(`/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      })
    },
    forkCheckpoint: (projectId, checkpointId) => apiFetch(`/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/fork`, {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
    }),
    createPreviewUrl: async (projectId, path = 'index.html') => {
      const body = await apiFetch<{
        url: string
        expires_at?: string | number | null
        expires_at_iso?: string | null
        mode?: 'static' | 'hmr' | string | null
      }>(
        `/projects/${encodeURIComponent(projectId)}/preview`,
        {
          method: 'POST',
          body: JSON.stringify({ path }),
        },
      )
      const mode = body.mode === 'hmr' ? 'hmr' : 'static'
      return {
        // Absolute HMR URLs (preview-proxy) pass through; static site paths are gateway-prefixed.
        url: mode === 'hmr' ? body.url : resolvePreviewUrl(body.url, baseUrl),
        expiresAt: parsePreviewExpiresAt(body.expires_at ?? body.expires_at_iso),
        mode,
      }
    },
    reportConsoleError: async (projectId, payload: { level: string; text: string; href?: string }) => {
      await apiFetch(`/projects/${encodeURIComponent(projectId)}/console`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    applyVisualEdit: (projectId, body) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/visual-edit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    applyProjectPatch: (projectId, body) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/apply-patch`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getPreviewMeta: (projectId, path = 'index.html') =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/preview-meta?path=${encodeURIComponent(path)}`),
    getPtyInfo: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/pty`),
    getProjectLease: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/lease`),
    startBrowserTest: (projectId, body = {}) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/browser-tests`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listBrowserTests: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/browser-tests`),
    getBrowserTest: (projectId, testId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/browser-tests/${encodeURIComponent(testId)}`),
    runSecurityScan: (projectId, body = {}) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/security-scan`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getSecurityScan: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/security-scan`),
    listProjectConnectors: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/connectors`),
    setProjectConnector: (projectId, kind, enabled) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/connectors`, {
        method: 'PUT',
        body: JSON.stringify({ kind, enabled }),
      }),
    getProjectAnalytics: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/analytics`),
    seedProjectAnalytics: (projectId, pageViews) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/analytics/seed`, {
        method: 'POST',
        body: JSON.stringify({ page_views: pageViews }),
      }),
    getProjectCollab: (projectId) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/collab`),
    heartbeatProjectPresence: (projectId, displayName) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/collab/presence`, {
        method: 'POST',
        body: JSON.stringify(displayName ? { display_name: displayName } : {}),
      }),
    postProjectCollabChat: (projectId, text, displayName) =>
      apiFetch(`/projects/${encodeURIComponent(projectId)}/collab/chat`, {
        method: 'POST',
        body: JSON.stringify({ text, ...(displayName ? { display_name: displayName } : {}) }),
      }),
    getFile: async (runId, path) => {
      const body = await apiFetch<{ content: string }>(`/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(path)}`)
      return body.content
    },
    streamRunEvents: (runId, onEvent, signalOrOptions) => {
      const opts = normalizeStreamOptions(signalOrOptions)
      return streamEvents(store, baseUrl, options, runId, onEvent, opts)
    },
  }
}

/** Resolve engine expires_at (ISO string, unix seconds, or ms) to epoch ms. */
export function parsePreviewExpiresAt(value: string | number | null | undefined, now = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Heuristic: values below 1e12 are unix seconds.
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return now + PREVIEW_TTL_SECONDS * 1000
}

function normalizeStreamOptions(signalOrOptions?: AbortSignal | StreamRunOptions): StreamRunOptions {
  if (!signalOrOptions) return {}
  if (typeof AbortSignal !== 'undefined' && signalOrOptions instanceof AbortSignal) {
    return { signal: signalOrOptions }
  }
  return signalOrOptions as StreamRunOptions
}

function fetchImpl(options: LoopitClientOptions): typeof fetch {
  return options.fetchImpl ?? fetch
}

/**
 * Make an engine-returned site URL loadable from the browser.
 *
 * The engine hands back paths on its own data plane
 * (`/api/projects/<id>/site/t/<token>/index.html`). The nginx gateway strips
 * the `/api/loopit` prefix and re-adds `/api` itself (`proxy_pass
 * $upstream/api/$path`), so the browser URL keeps the base's `/api` and drops
 * the path's: `/api/loopit/projects/...`. A full-URL base (direct engine
 * access, no gateway) keeps the path verbatim. Absolute URLs pass through,
 * and already-routed paths are idempotent.
 */
/**
 * Build a browser websocket URL for the project PTY (Phase 3.2).
 * `wsPath` is the engine path from ``getPtyInfo`` (e.g. `/api/projects/…/pty/ws`).
 */
export function buildPtyWebSocketUrl(wsPath: string, token: string, baseUrl = LOOPIT_API_BASE): string {
  const path = wsPath.startsWith('/') ? wsPath : `/${wsPath}`
  // Gateway mounts engine under /api/loopit; engine paths start with /api/…
  const routed = path.startsWith('/api/projects/')
    ? `${baseUrl.replace(/\/$/, '')}${path.slice('/api'.length)}`
    : path.startsWith(baseUrl)
      ? path
      : `${baseUrl.replace(/\/$/, '')}${path}`
  const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost'
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  if (routed.startsWith('ws://') || routed.startsWith('wss://')) return `${routed}${qs}`
  return `${proto}//${host}${routed}${qs}`
}

export function resolvePreviewUrl(url: string, baseUrl = LOOPIT_API_BASE): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  const base = baseUrl.replace(/\/$/, '')
  if (url.startsWith('/')) {
    // Idempotency: a path that already carries the base must not be prefixed twice.
    if (url === base || url.startsWith(`${base}/`)) return url
    // The gateway base contributes /api; nginx re-adds it upstream.
    const enginePath = base.startsWith('http') ? url : url.replace(/^\/api(?=\/)/, '')
    return `${base}${enginePath}`
  }
  return `${base}/${url.replace(/^\//, '')}`
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response))
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.text()
  let message = body || `${response.status} ${response.statusText}`
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown }
    if (typeof parsed.detail === 'string') message = parsed.detail
    else if (typeof parsed.error === 'string') message = parsed.error
  } catch { /* keep raw body */ }
  return message
}

async function streamEvents(
  store: TokenStore,
  baseUrl: string,
  options: LoopitClientOptions,
  runId: string,
  onEvent: (event: StreamEvent) => void,
  streamOptions: StreamRunOptions = {},
  attempt = 0,
): Promise<void> {
  const token = await store.getToken(attempt > 0)
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', 'text/event-stream')
  const afterQs = typeof streamOptions.after === 'number' && streamOptions.after > 0
    ? `?after=${encodeURIComponent(String(streamOptions.after))}`
    : ''
  let response: Response
  try {
    response = await fetchImpl(options)(`${baseUrl}/runs/${encodeURIComponent(runId)}/events${afterQs}`, {
      headers,
      signal: streamOptions.signal,
    })
  } catch (cause) {
    if (isAbort(cause)) throw cause
    throw new ApiError(0, cause instanceof Error ? cause.message : 'Failed to fetch')
  }
  if (response.status === 401 && attempt === 0) {
    store.clear()
    return streamEvents(store, baseUrl, options, runId, onEvent, streamOptions, 1)
  }
  if (!response.ok) throw new ApiError(response.status, await response.text())
  if (!response.body) throw new Error('streaming is not supported by this browser')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const chunks = buffer.split(/\r?\n\r?\n/)
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const parsed = parseSseChunk(chunk)
      if (parsed === 'end') return
      if (parsed) onEvent(parsed)
    }
    if (done) break
  }
}

/** Parse one SSE event block. Malformed `data:` JSON is skipped, not thrown. */
export function parseSseChunk(chunk: string): StreamEvent | 'end' | null {
  const lines = chunk.split(/\r?\n/)
  if (lines.some((line) => line.trim() === 'event: end')) return 'end'
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
  if (!data) return null
  try {
    return JSON.parse(data) as StreamEvent
  } catch {
    return null
  }
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}
