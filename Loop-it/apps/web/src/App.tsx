import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Toast } from '@loopit/ui-kit';
import {
  ApiError,
  approveGate,
  clearSession,
  createPreviewUrl,
  deployProject,
  forkCheckpoint,
  getBillingBalance,
  getFile,
  getHealth,
  getLegalAup,
  getMe,
  getOrgs,
  getRun,
  listRuns,
  loadSession,
  login,
  logout,
  register,
  rejectGate,
  rollbackCheckpoint,
  saveSession,
  startRun,
  streamRunEvents,
  toUserFacingError,
  type ApprovalGate,
  type AuthSession,
  type CheckpointView,
  type Health,
  type RunCost,
  type RunDetail,
  type RunSummary,
  type StreamEvent,
  type UserFacingError,
  type TaskDagView,
  type TaskNodeView,
} from './api';
import { truncate, type Activity } from './activity';
import {
  emptyRunUiState,
  extractCost,
  extractDag,
  extractGates,
  formatTokens,
  isCompletedNode,
  orderedDagNodes,
  reduceRunEvent,
} from './runState';
import './styles.css';

type AuthMode = 'login' | 'register';
type CheckpointAction = { kind: 'rollback' | 'fork' | 'deploy'; checkpoint: CheckpointView } | null;
type AuthForm = { email: string; password: string; orgId: string; orgName: string; displayName: string; aupAccepted: boolean };
type Page = 'build' | 'pricing' | 'status' | 'legal';

const SAMPLE_PROMPTS = [
  'Build a customer intake form with an admin review table.',
  'Create a SaaS landing page with pricing cards and a waitlist form.',
  'Build a team task tracker with login, projects, and owner-only settings.',
];

const PLAN_CARDS = [
  { name: 'free', credits: '5', soft: '1', tpm: '10k', daily: '2', sandboxes: '1', egress: '100 MB' },
  { name: 'pro', credits: '100', soft: '10', tpm: '100k', daily: '25', sandboxes: '4', egress: '2 GB' },
  { name: 'team', credits: '500', soft: '50', tpm: '500k', daily: '150', sandboxes: '12', egress: '10 GB' },
];

/**
 * The onboarding copy promises the first verified HTML file opens in the preview pane, and
 * the preview is the point of the product. Generated file lists are not ordered with the
 * entrypoint first (a React scaffold leads with App.js), so selecting files[0] would show
 * source instead of the rendered app on a user's very first build.
 */
export function pickPreviewFile(files: readonly string[]): string | undefined {
  return (
    files.find((path) => /(^|\/)index\.html?$/i.test(path)) ??
    files.find((path) => /\.html?$/i.test(path)) ??
    files[0]
  );
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authForm, setAuthForm] = useState<AuthForm>({ email: '', password: '', orgId: '', orgName: '', displayName: '', aupAccepted: false });
  const [aup, setAup] = useState<{ version: string; text: string } | null>(null);
  const [billing, setBilling] = useState<{ balance: string; plan: string } | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [prompt, setPrompt] = useState('Build a small landing page for a coffee shop.');
  const [state, setState] = useState(emptyRunUiState);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileBody, setFileBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [maxIterations, setMaxIterations] = useState(12);
  const [frame, setFrame] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [checkpointAction, setCheckpointAction] = useState<CheckpointAction>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('build');
  const streamAbortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const token = session?.accessToken;
  const run = state.run;
  const currentOrg = session?.orgs.find((org) => org.org_id === session.user?.org_id) ?? session?.orgs[0];
  const isRenderable = Boolean(selected && /\.html?$/i.test(selected) && fileBody);
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

  const persistSession = useCallback((next: AuthSession) => {
    saveSession(next);
    setSession(next);
  }, []);

  const signOutLocal = useCallback((message?: string) => {
    clearSession();
    setSession(null);
    setAuthMode('login');
    setState(emptyRunUiState());
    setProjectId(null);
    setSelected(null);
    setFileBody('');
    if (message) setToast(message);
  }, []);

  useEffect(() => {
    getLegalAup().then(setAup).catch(() => setAup(null));
  }, []);

  useEffect(() => {
    getHealth(token)
      .then(setHealth)
      .catch((cause) => {
        if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
        setHealth(null);
      });
  }, [token, signOutLocal]);

  useEffect(() => {
    if (!token) return;
    Promise.all([getMe(token), getOrgs(token)])
      .then(([user, orgs]) => persistSession({ accessToken: token, user, orgs }))
      .catch((cause) => {
        if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
      });
  }, [token, persistSession, signOutLocal]);

  useEffect(() => {
    if (!token) return;
    getBillingBalance(token).then(setBilling).catch(() => setBilling(null));
    listRuns(token).then(setRuns).catch(() => setRuns([]));
  }, [token, run?.run_id]);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const node = timelineRef.current;
    if (node && autoscroll) node.scrollTop = node.scrollHeight;
  }, [autoscroll, state.activity]);

  useEffect(() => () => { streamAbortRef.current?.abort(); }, []);

  useEffect(() => {
    if (!token || !projectId || !isRenderable) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    createPreviewUrl(token, projectId, selected ?? 'index.html')
      .then((url) => {
        if (!cancelled) setPreviewUrl(url);
      })
      .catch((cause) => {
        if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
        else if (!cancelled) setToast(toUserFacingError(cause).message);
      });
    return () => { cancelled = true; };
  }, [token, projectId, selected, isRenderable, frame, signOutLocal]);

  const handleAuth = async () => {
    try {
      if (authMode === 'register' && !authForm.aupAccepted) {
        setToast('Accept the Acceptable Use Policy to create an organization.');
        return;
      }
      const response = authMode === 'login'
        ? await login({ email: authForm.email, password: authForm.password, orgId: authForm.orgId })
        : await register({ email: authForm.email, password: authForm.password, orgName: authForm.orgName, displayName: authForm.displayName, aupAccepted: authForm.aupAccepted });
      const accessToken = response.access_token;
      const [user, orgs] = await Promise.all([
        response.user && response.org
          ? Promise.resolve({ user_id: response.user.user_id, email: response.user.email, org_id: response.org.org_id, role: response.role ?? 'owner', scopes: [] })
          : getMe(accessToken),
        response.org
          ? Promise.resolve([{ org_id: response.org.org_id, name: response.org.name, role: response.role ?? 'owner' }])
          : getOrgs(accessToken),
      ]);
      persistSession({ accessToken, user, orgs });
      setToast(null);
    } catch (cause) {
      setToast(toUserFacingError(cause).message);
    }
  };

  const handleLogout = async () => {
    if (token) {
      try { await logout(token); } catch { /* local clear still logs the browser out */ }
    }
    signOutLocal();
  };

  const openFile = useCallback(async (runId: string, path: string) => {
    if (!token) return;
    setSelected(path);
    try {
      setFileBody(await getFile(token, runId, path));
    } catch (cause) {
      if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
      setFileBody(`Could not read ${path}: ${toUserFacingError(cause).message}`);
    }
  }, [token, signOutLocal]);

  const begin = useCallback(async () => {
    if (!prompt.trim() || busy || !token) return;
    setBusy(true);
    setState(emptyRunUiState());
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    try {
      const started = await startRun(token, prompt, { projectId, maxIterations });
      setProjectId(started.project_id);
      const detail = await getRun(token, started.run_id);
      setState({ ...emptyRunUiState(), run: detail, dag: extractDag(detail), gates: extractGates(detail), checkpoints: detail.checkpoints ?? [], cost: extractCost(detail) });
      void followRunStream(token, started.run_id, controller, (event) => {
        setState((previous) => reduceRunEvent(previous, event));
        if (event.kind === 'run') {
          setFrame((n) => n + 1);
          const next = selected && event.files.includes(selected) ? selected : pickPreviewFile(event.files);
          if (next) void openFile(event.run_id, next);
        }
      }, setToast).catch((cause) => {
        if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
        else setState((previous) => ({ ...previous, error: toUserFacingError(cause).message }));
      }).finally(() => setBusy(false));
    } catch (cause) {
      if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
      else setState((previous) => ({ ...previous, error: toUserFacingError(cause).message }));
      setBusy(false);
    }
  }, [prompt, busy, token, projectId, maxIterations, selected, openFile, signOutLocal]);

  const handleGate = async (gate: ApprovalGate, approved: boolean) => {
    if (!token || !run) return;
    const reason = approved ? 'approved by user in web confirmation gate' : 'rejected by user in web confirmation gate';
    try {
      if (approved) await approveGate(token, run.run_id, gate.gate_id, reason);
      else await rejectGate(token, run.run_id, gate.gate_id, reason);
      setState((previous) => ({ ...previous, gates: previous.gates.filter((item) => item.gate_id !== gate.gate_id) }));
    } catch (cause) {
      if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
      else setToast(toUserFacingError(cause).message);
    }
  };

  const confirmCheckpoint = async () => {
    if (!checkpointAction || !token || !projectId) return;
    try {
      if (checkpointAction.kind === 'rollback') {
        await rollbackCheckpoint(token, projectId, checkpointAction.checkpoint.checkpoint_id);
        setToast(`Rolled back to ${checkpointAction.checkpoint.checkpoint_id}`);
      } else if (checkpointAction.kind === 'deploy') {
        const deployed = await deployProject(token, projectId, checkpointAction.checkpoint.checkpoint_id, 'operator promoted green checkpoint');
        setToast(`Live URL: ${deployed.production_url}`);
      } else {
        const forked = await forkCheckpoint(token, projectId, checkpointAction.checkpoint.checkpoint_id);
        if (forked.project_id) setProjectId(forked.project_id);
        setToast(`Forked from ${checkpointAction.checkpoint.checkpoint_id}`);
      }
      setCheckpointAction(null);
    } catch (cause) {
      if (isUnauthorized(cause)) signOutLocal('Session expired. Please sign in again.');
      else setToast(toUserFacingError(cause).message);
    }
  };

  if (!session) {
    return <div className="app auth-shell"><AuthPanel mode={authMode} form={authForm} aup={aup} onMode={setAuthMode} onForm={setAuthForm} onSubmit={() => void handleAuth()} message={toast} /></div>;
  }

  return (
    <div className="app">
      <header className="topbar"><div className="brand">Loop<span>-it</span><em>app builder launch console</em></div><nav className="navtabs" aria-label="Primary"><Button variant={page === 'build' ? 'primary' : 'ghost'} onClick={() => setPage('build')}>Build</Button><Button variant={page === 'pricing' ? 'primary' : 'ghost'} onClick={() => setPage('pricing')}>Pricing</Button><Button variant={page === 'status' ? 'primary' : 'ghost'} onClick={() => setPage('status')}>Status</Button><Button variant={page === 'legal' ? 'primary' : 'ghost'} onClick={() => setPage('legal')}>Legal</Button></nav><div className="badges">{currentOrg && <Badge tone="info">{currentOrg.name} · {currentOrg.role}</Badge>}{billing && <Badge tone="neutral">{billing.plan} · {billing.balance} cr</Badge>}{health?.offline && <Badge tone="warning">offline — scripted, no model</Badge>}{health && !health.offline && <Badge tone="success">live model</Badge>}<Badge tone="neutral">no execution (I1)</Badge><Button variant="ghost" onClick={() => void handleLogout()}>Logout</Button></div></header>
      {page === 'build' && <><Onboarding run={run} projectId={projectId} onPick={(value) => { setPrompt(value); promptRef.current?.focus(); }} /><section className="composer" aria-label="Start or update generated app"><textarea ref={promptRef} aria-label="App prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={projectId ? 'Describe the next change…' : 'Describe what you want built…'} rows={3} disabled={busy} /><div className="controls"><Button onClick={() => void begin()} disabled={busy || !prompt.trim()}>{busy ? 'Working…' : projectId ? 'Apply change' : 'Build it'}</Button><label className="depth">Effort<select aria-label="Maximum agent iterations" value={maxIterations} onChange={(event) => setMaxIterations(Number(event.target.value))} disabled={busy}><option value={8}>Quick (8)</option><option value={12}>Normal (12)</option><option value={24}>Deep (24)</option><option value={40}>Max (40)</option></select></label>{projectId && <Button variant="secondary" onClick={() => { streamAbortRef.current?.abort(); setProjectId(null); setState(emptyRunUiState()); setSelected(null); setFileBody(''); }} disabled={busy}>New project</Button>}</div></section></>}
      {projectId && <div className="projectbar">Working in <code>{projectId}</code></div>}
      {health?.offline && <div className="offline-banner"><strong>No model is connected.</strong> Runs use a scripted stub. Set <code>HF_TOKEN</code> for real runs.</div>}
      {state.error && <ErrorNotice error={toUserFacingError(new Error(state.error))} onDismiss={() => setState((previous) => ({ ...previous, error: null }))} />}
      {toast && <Toast tone="warning" message={toast} onDismiss={() => setToast(null)} />}
      <GatePrompts gates={state.gates} onDecision={(gate, approved) => void handleGate(gate, approved)} />
      {page === 'build' && <main className="workspace-grid"><section className="left-rail"><CostPanel run={run} cost={state.cost} /><TaskBoard dag={state.dag} showCompleted={showCompleted} onToggleCompleted={() => setShowCompleted((value) => !value)} /><CheckpointTimeline checkpoints={state.checkpoints} onAction={setCheckpointAction} /></section><section className="right-rail"><ActivityPanel activity={state.activity} busy={busy} elapsedLabel={elapsedLabel} run={run} autoscroll={autoscroll} onAutoscroll={setAutoscroll} timelineRef={timelineRef} /><FilesPanel run={run} selected={selected} fileBody={fileBody} isRenderable={isRenderable} previewUrl={previewUrl} frame={frame} view={view} onView={setView} onOpen={(path) => run && void openFile(run.run_id, path)} /></section></main>}
      {page === 'pricing' && <PricingPage currentPlan={billing?.plan ?? 'free'} spent={state.cost?.credits_spent ?? 0} balance={billing?.balance ?? ''} onPick={(name) => { setToast(name === 'free' ? 'Free is already available for new orgs.' : `Upgrade to ${name} requires Stripe checkout configuration by the operator.`); }} />}
      {page === 'status' && <StatusPage health={health} runs={runs} />}
      {page === 'legal' && <LegalPage aup={aup} />}
      <ConfirmDialog open={checkpointAction !== null} title={checkpointAction?.kind === 'rollback' ? 'Rollback checkpoint?' : checkpointAction?.kind === 'deploy' ? 'Promote checkpoint to live URL?' : 'Fork checkpoint?'} destructive={checkpointAction?.kind === 'rollback' || checkpointAction?.kind === 'deploy'} confirmLabel={checkpointAction?.kind === 'rollback' ? 'Rollback' : checkpointAction?.kind === 'deploy' ? 'Deploy' : 'Fork'} message={<span>This changes the live project pointer after explicit confirmation (I7). Target: <code>{checkpointAction?.checkpoint.checkpoint_id}</code>.</span>} onCancel={() => setCheckpointAction(null)} onConfirm={() => void confirmCheckpoint()} />
    </div>
  );
}

function AuthPanel({ mode, form, aup, message, onMode, onForm, onSubmit }: { mode: AuthMode; form: AuthForm; aup: { version: string; text: string } | null; message: string | null; onMode: (mode: AuthMode) => void; onForm: (form: AuthForm) => void; onSubmit: () => void; }) {
  return <Card title={mode === 'login' ? 'Sign in to Loop-it' : 'Create a Loop-it account'} className="auth-card">{message && <Toast tone="warning" message={message} />}<p className="auth-note">New here? Register an org, pick a starter prompt, then click <strong>Build it</strong>. The first verified HTML file opens in the preview pane automatically.</p><label>Email<input aria-label="Email" autoComplete="email" value={form.email} onChange={(event) => onForm({ ...form, email: event.target.value })} /></label><label>Password<input aria-label="Password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(event) => onForm({ ...form, password: event.target.value })} /></label>{mode === 'login' ? <label>Org ID<input aria-label="Org ID" value={form.orgId} onChange={(event) => onForm({ ...form, orgId: event.target.value })} /></label> : <><label>Organization name<input aria-label="Organization name" value={form.orgName} onChange={(event) => onForm({ ...form, orgName: event.target.value })} /></label><label>Display name<input aria-label="Display name" autoComplete="name" value={form.displayName} onChange={(event) => onForm({ ...form, displayName: event.target.value })} /></label><label className="aup-accept"><input aria-label="Accept AUP" type="checkbox" checked={form.aupAccepted} onChange={(event) => onForm({ ...form, aupAccepted: event.target.checked })} /> I accept the Acceptable Use Policy{aup ? ` (${aup.version})` : ''}.</label></>}<div className="auth-actions"><Button onClick={onSubmit} disabled={mode === 'register' && !form.aupAccepted}>{mode === 'login' ? 'Login' : 'Register'}</Button><Button variant="ghost" onClick={() => onMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Need an account?' : 'Have an account?'}</Button></div><p className="auth-note">Identity tokens are kept in sessionStorage instead of localStorage, so a browser restart clears them until the API can issue HttpOnly cookies. Authorized organizations only.</p></Card>;
}

function Onboarding({ run, projectId, onPick }: { run: RunDetail | null; projectId: string | null; onPick: (prompt: string) => void }) {
  if (run || projectId) return null;
  return <section className="onboarding" aria-labelledby="onboarding-title"><div><Badge tone="info">First run</Badge><h1 id="onboarding-title">Describe an app. Loop-it builds, verifies, checkpoints, and previews it.</h1><p>Start with a concrete app goal. You can refine after the first green checkpoint without reading docs.</p></div><div className="template-grid">{SAMPLE_PROMPTS.map((sample) => <button key={sample} type="button" className="template-card" onClick={() => onPick(sample)}><span>Use template</span>{sample}</button>)}</div></section>;
}

function ErrorNotice({ error, onDismiss }: { error: UserFacingError; onDismiss: () => void }) {
  return <div className="error-notice" role="alert"><div><strong>{error.title}</strong><p>{error.message}</p><p>{error.action}</p></div><Button variant="ghost" onClick={onDismiss}>Dismiss</Button></div>;
}

function PricingPage({ currentPlan, spent, balance, onPick }: { currentPlan: string; spent: number; balance?: string; onPick: (name: string) => void }) {
  return <main className="page-shell"><Card title="Pricing and billing"><p className="muted">Plans mirror <code>services/billing</code>. Ledger balance: <strong>{balance ?? 'n/a'}</strong>. Stripe is optional; the ledger is source of truth.</p><div className="pricing-grid">{PLAN_CARDS.map((plan) => <article key={plan.name} className="plan-card"><h3>{plan.name}</h3><strong>{plan.credits} credits/month</strong><p>Warning at {plan.soft} credits remaining. Hard quota stops new paid work before spend.</p><ul><li>{plan.tpm} tokens/minute</li><li>{plan.daily} credits/day</li><li>{plan.sandboxes} concurrent sandbox lease(s)</li><li>{plan.egress} egress/day</li></ul><Button variant={plan.name === currentPlan ? 'secondary' : 'primary'} onClick={() => onPick(plan.name)}>{plan.name === currentPlan ? 'Current plan' : `Upgrade to ${plan.name}`}</Button></article>)}</div><div className="usage-strip"><strong>Current run credits spent:</strong> {spent.toFixed(6)}<span>Quota exhaustion returns a safe, actionable message and no sandbox/model spend is started.</span></div></Card></main>;
}

function StatusPage({ health, runs }: { health: Health | null; runs: RunSummary[] }) {
  const ok = health?.status === 'ok';
  return <main className="page-shell"><Card title="Public status"><div className="status-hero"><Badge tone={ok ? 'success' : 'warning'}>{ok ? 'API reachable' : 'Checking'}</Badge><p>This surface is driven by the existing health endpoint. It is a lightweight launch status page, not a measured uptime claim.</p></div><div className="metric-grid"><Metric label="API" value={health?.status ?? 'unknown'} /><Metric label="Run mode" value={health?.run_execution_mode ?? (health?.offline ? 'offline' : 'live')} /><Metric label="Auth" value={health?.auth_required === false ? 'dev only' : 'required'} /><Metric label="Persisted runs" value={String(runs.length)} /></div></Card></main>;
}

function LegalPage({ aup }: { aup: { version: string; text: string } | null }) {
  return <main className="page-shell"><Card title="Acceptable use and terms"><p className="muted">Version {aup?.version ?? 'unavailable'}.</p><p>{aup?.text}</p><p className="muted">Full operator documents live in <code>docs/legal/aup.md</code> and <code>docs/legal/tos.md</code>.</p></Card></main>;
}

async function followRunStream(token: string, runId: string, controller: AbortController, onEvent: (event: StreamEvent) => void, onNotice: (message: string) => void): Promise<void> {
  const delays = [500, 1500, 3000];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await streamRunEvents(token, runId, onEvent, controller.signal);
      return;
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (isUnauthorized(cause)) throw cause;
      if (attempt === delays.length) throw cause;
      const error = toUserFacingError(cause);
      onNotice(`${error.title}: ${error.action} Retrying live updates…`);
      await sleep(delays[attempt] ?? 0);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function GatePrompts({ gates, onDecision }: { gates: ApprovalGate[]; onDecision: (gate: ApprovalGate, approved: boolean) => void }) {
  if (!gates.length) return null;
  return <section className="gate-stack" aria-label="confirmation gates">{gates.map((gate) => <Card key={gate.gate_id} title="Human approval required" className="gate-card"><div className="gate-copy"><Badge tone="danger">Never auto-approve</Badge><strong>{gate.action}</strong><p>{gate.reason}</p>{(gate.destructive || gate.irreversible) && <p className="danger-text">Destructive/irreversible: this may delete data, alter production state, spend money, deploy, or write externally.</p>}<dl className="gate-args"><dt>Exact arguments to execute</dt><dd><pre>{formatGateArgs(gate.args)}</pre></dd>{gate.args_hash && <><dt>Approval binding</dt><dd><code>{gate.args_hash}</code></dd></>}{gate.expires_at && <><dt>Expires</dt><dd>{new Date(gate.expires_at).toLocaleString()}</dd></>}</dl></div><div className="gate-actions"><Button variant="danger" onClick={() => onDecision(gate, false)}>Reject</Button><Button onClick={() => onDecision(gate, true)}>Approve explicitly</Button></div></Card>)}</section>;
}

function formatGateArgs(args: Record<string, unknown> | undefined): string {
  return JSON.stringify(args ?? {}, null, 2);
}

function CostPanel({ run, cost }: { run: RunDetail | null; cost: RunCost | null }) {
  if (!run) return null;
  return <Card title="Cost attribution"><div className="metric-grid"><Metric label="Iterations" value={String(cost?.iterations ?? run.iterations)} /><Metric label="Credits" value={(cost?.credits_spent ?? run.credits_spent).toFixed(6)} /><Metric label="Tokens" value={formatTokens(cost)} />{cost?.cost_usd !== undefined && <Metric label="USD" value={`$${cost.cost_usd.toFixed(4)}`} />}{cost?.cost_per_successful_deploy !== undefined && <Metric label="Cost/successful deploy" value={`$${cost.cost_per_successful_deploy.toFixed(4)}`} />}</div></Card>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function TaskBoard({ dag, showCompleted, onToggleCompleted }: { dag: TaskDagView | null; showCompleted: boolean; onToggleCompleted: () => void }) {
  const nodes = useMemo(() => (dag ? orderedDagNodes(dag) : []), [dag]);
  const completed = nodes.filter(isCompletedNode);
  const visible = showCompleted ? nodes : nodes.filter((node) => !isCompletedNode(node));
  if (!dag) return <Card title="Task DAG"><EmptyState title="No DAG exposed yet">The board will render as soon as apps/api includes the run DAG.</EmptyState></Card>;
  return <Card title="Task DAG" actions={completed.length > 0 && <Button variant="ghost" onClick={onToggleCompleted}>{showCompleted ? 'Collapse completed' : `Show ${completed.length} completed`}</Button>}><p className="dag-goal">{dag.goal}</p><div className="node-list">{visible.map((node) => <TaskNodeCard key={node.id} node={node} />)}</div></Card>;
}
function TaskNodeCard({ node }: { node: TaskNodeView }) {
  const status = node.status ?? 'pending';
  return <article className={`dag-node dag-node-${status}`}><div className="node-head"><strong>{node.id}</strong><Badge tone={toneForNode(status)}>{status}</Badge>{node.destructive && <Badge tone="danger">destructive</Badge>}</div><p>{node.goal}</p><dl><dt>Parents</dt><dd>{node.dag_parents.length ? node.dag_parents.join(', ') : 'base checkpoint'}</dd><dt>Verification</dt><dd>{node.expected_verification.join(', ') || 'not declared'}</dd>{node.destructive_reason && <><dt>Destructive reason</dt><dd>{node.destructive_reason}</dd></>}</dl></article>;
}

function CheckpointTimeline({ checkpoints, onAction }: { checkpoints: CheckpointView[]; onAction: (action: CheckpointAction) => void }) {
  return <Card title="Checkpoints">{!checkpoints.length && <EmptyState title="No checkpoints exposed yet">Rollback/fork controls appear when apps/api returns the checkpoint tree.</EmptyState>}<div className="checkpoint-list">{checkpoints.map((checkpoint) => <article key={checkpoint.checkpoint_id} className={checkpoint.live ? 'checkpoint checkpoint-live' : 'checkpoint'}><div><strong>{checkpoint.label ?? checkpoint.checkpoint_id}</strong>{checkpoint.live && <Badge tone="success">live/green</Badge>}</div><small>parent {checkpoint.parent_id ?? 'root'} · {new Date(checkpoint.created_at).toLocaleString()}</small><div className="checkpoint-actions"><Button variant="secondary" disabled={!checkpoint.verified} onClick={() => onAction({ kind: 'rollback', checkpoint })}>Rollback</Button><Button variant="ghost" onClick={() => onAction({ kind: 'fork', checkpoint })}>Fork</Button><Button disabled={!checkpoint.verified} onClick={() => onAction({ kind: 'deploy', checkpoint })}>Deploy</Button></div></article>)}</div></Card>;
}

function ActivityPanel({ activity, busy, elapsedLabel, run, autoscroll, onAutoscroll, timelineRef }: { activity: Activity[]; busy: boolean; elapsedLabel: string; run: RunDetail | null; autoscroll: boolean; onAutoscroll: (value: boolean) => void; timelineRef: React.RefObject<HTMLDivElement>; }) {
  return <Card title="Activity" actions={<><Button variant="ghost" onClick={() => onAutoscroll(!autoscroll)}>{autoscroll ? 'Autoscroll on' : 'Autoscroll off'}</Button>{run && <Badge tone="info">{run.status}</Badge>}</>} className="activity-card"><div className="timeline" ref={timelineRef}>{activity.length === 0 && <EmptyState title="Nothing yet">Start a run above.</EmptyState>}{activity.map((item) => <article key={item.id} className={`step tone-${item.tone}`}><div className="step-head"><strong>{item.title}</strong><span className="raw">{item.rawType}</span><span className="at">{item.at}</span></div>{item.body && <pre className="step-body">{truncate(item.body, 1200)}</pre>}</article>)}{busy && <article className="step step-pending"><div className="step-head"><strong>Waiting for the model<span className="dots" /></strong><span className="at">{elapsedLabel}</span></div><p className="step-body">A turn is one whole completion, so nothing arrives until the model finishes.</p></article>}</div></Card>;
}

function FilesPanel({ run, selected, fileBody, isRenderable, previewUrl, frame, view, onView, onOpen }: { run: RunDetail | null; selected: string | null; fileBody: string; isRenderable: boolean; previewUrl: string | null; frame: number; view: 'preview' | 'code'; onView: (view: 'preview' | 'code') => void; onOpen: (path: string) => void; }) {
  return <Card title="Files" actions={isRenderable && <span className="viewtabs"><Button variant={view === 'preview' ? 'primary' : 'ghost'} onClick={() => onView('preview')}>Preview</Button><Button variant={view === 'code' ? 'primary' : 'ghost'} onClick={() => onView('code')}>Code</Button></span>} className="files-card"><div className="files">{!run?.files?.length && <EmptyState title="No files yet" />}{run?.files?.map((path) => <Button key={path} variant={path === selected ? 'primary' : 'secondary'} onClick={() => onOpen(path)}>{path}</Button>)}</div>{isRenderable && view === 'preview' && previewUrl ? <iframe key={`${previewUrl}-${frame}`} className="render" title="rendered page" sandbox="allow-scripts" src={previewUrl} /> : <pre className="viewer">{fileBody || 'Select a file.'}</pre>}</Card>;
}

function toneForNode(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'merged') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'blocked') return 'warning';
  if (status === 'running' || status === 'verifying') return 'info';
  return 'neutral';
}
function isUnauthorized(cause: unknown): boolean { return cause instanceof ApiError && cause.status === 401; }
