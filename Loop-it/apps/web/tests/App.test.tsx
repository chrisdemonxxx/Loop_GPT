import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { pickPreviewFile } from '../src/App';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

const detail = {
  run_id: 'run-a', project_id: 'proj-a', prompt: 'Build', status: 'running', started_at: '2026-01-01T00:00:00Z', finished_at: null, iterations: 1, summary: '', credits_spent: 0.25, files: ['index.html'],
  dag: { plan_id: 'plan-a', goal: 'Ship checkout', nodes: [
    { id: 'ui', goal: 'Build UI', dag_parents: [], expected_verification: ['L1_tests'], destructive: false, status: 'running' },
    { id: 'deploy', goal: 'Deploy app', dag_parents: ['ui'], expected_verification: ['L2_browser_smoke'], destructive: true, destructive_reason: 'publishes externally', status: 'blocked' },
  ] },
  gates: [{ gate_id: 'gate-a', action: 'Deploy production', reason: 'Publishes externally', destructive: true, args: { target: 'managed', environment: 'prod' }, args_hash: 'hash-a' }],
  checkpoints: [{ checkpoint_id: 'ckpt-a', parent_id: null, label: 'green', created_at: '2026-01-01T00:00:00Z', verified: true, live: true }],
  cost: { input_tokens: 100, output_tokens: 50, iterations: 1, credits_spent: 0.25, cost_per_successful_deploy: 1.23 },
};

function seedSession() {
  window.sessionStorage.setItem('loopit.identity.v1', JSON.stringify({ accessToken: 'token-a', user: { user_id: 'u1', email: 'a@example.test', org_id: 'org-a', role: 'owner', scopes: [] }, orgs: [{ org_id: 'org-a', name: 'Acme', role: 'owner' }] }));
}

function mockFetchWithRun() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/auth/me')) return json({ user_id: 'u1', email: 'a@example.test', org_id: 'org-a', role: 'owner', scopes: [] });
    if (url.endsWith('/auth/orgs')) return json([{ org_id: 'org-a', name: 'Acme', role: 'owner' }]);
    if (url.endsWith('/health')) return json({ status: 'ok', offline: false, exec_enabled: false, projects_root: '.', auth_required: true });
    if (url.endsWith('/legal/aup')) return json({ version: '2026-09-05', text: 'AUP' });
    if (url.endsWith('/billing/balance')) return json({ balance: '2.0', plan: 'free' });
    if (url.endsWith('/runs') && init?.method === 'POST') return json({ ...detail, files: undefined });
    if (url.endsWith('/runs')) return json([]);
    if (url.endsWith('/runs/run-a')) return json(detail);
    if (url.includes('/events')) return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 }));
    if (url.includes('/gates/gate-a/approve') || url.includes('/gates/gate-a/reject')) return json({ status: 'ok' });
    if (url.includes('/rollback')) return json({ status: 'ok' });
    if (url.includes('/fork')) return json({ project_id: 'proj-fork' });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App critical flows', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.__LOOPIT_API_BASE_URL__ = '/api';
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('registers, persists the session, renders org display, and logs out', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/register')) return json({ access_token: 'token-a', token_type: 'bearer', user: { user_id: 'u1', email: 'a@example.test' }, org: { org_id: 'org-a', name: 'Acme' }, role: 'owner' });
      if (url.endsWith('/auth/me')) return json({ user_id: 'u1', email: 'a@example.test', org_id: 'org-a', role: 'owner', scopes: [] });
      if (url.endsWith('/auth/orgs')) return json([{ org_id: 'org-a', name: 'Acme', role: 'owner' }]);
      if (url.endsWith('/auth/logout')) return json({ status: 'ok' });
      if (url.endsWith('/health')) return json({ status: 'ok', offline: false, exec_enabled: false, projects_root: '.', auth_required: true });
      if (url.endsWith('/legal/aup')) return json({ version: '2026-09-05', text: 'AUP' });
      if (url.endsWith('/billing/balance')) return json({ balance: '2.0', plan: 'free' });
      if (url.endsWith('/runs')) return json([]);
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByText('Need an account?'));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByLabelText('Accept AUP'));
    fireEvent.click(screen.getByText('Register'));
    expect(await screen.findByText(/Acme · owner/)).toBeTruthy();
    expect(window.sessionStorage.getItem('loopit.identity.v1')).toContain('token-a');
    fireEvent.click(screen.getByText('Logout'));
    await waitFor(() => expect(screen.getByText('Sign in to Loop-it')).toBeTruthy());
  });

  it('redirects to login on authenticated 401 responses', async () => {
    window.sessionStorage.setItem('loopit.identity.v1', JSON.stringify({ accessToken: 'bad', user: null, orgs: [] }));
    vi.stubGlobal('fetch', vi.fn(() => json({ detail: 'authentication required' }, 401)));
    render(<App />);
    expect(await screen.findByText(/Session expired/)).toBeTruthy();
    expect(screen.getByText('Sign in to Loop-it')).toBeTruthy();
  });

  it('renders DAG, gate prompt, cost, and dispatches approve', async () => {
    seedSession();
    const fetchMock = mockFetchWithRun();
    render(<App />);
    fireEvent.click(await screen.findByText('Build it'));
    expect(await screen.findByText('Ship checkout')).toBeTruthy();
    expect(screen.getByText('Deploy production')).toBeTruthy();
    expect(screen.getByText('Exact arguments to execute')).toBeTruthy();
    expect(screen.getByText(/"environment": "prod"/)).toBeTruthy();
    expect(screen.getByText('hash-a')).toBeTruthy();
    expect(screen.getByText('$1.2300')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve explicitly'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/gates/gate-a/approve', expect.any(Object)));
  });


  it('dispatches gate rejection explicitly', async () => {
    seedSession();
    const fetchMock = mockFetchWithRun();
    render(<App />);
    fireEvent.click(await screen.findByText('Build it'));
    expect(await screen.findByText('Deploy production')).toBeTruthy();
    fireEvent.click(screen.getByText('Reject'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/gates/gate-a/reject', expect.any(Object)));
  });
});

describe('pickPreviewFile', () => {
  // A generated React scaffold does not list its entrypoint first, so taking files[0]
  // showed JavaScript source on a user's first build instead of the rendered app.
  it('prefers index.html over an earlier non-renderable file', () => {
    expect(pickPreviewFile(['App.js', 'index.html', 'main.js', 'styles.css'])).toBe('index.html');
  });

  it('falls back to any html file when there is no index.html', () => {
    expect(pickPreviewFile(['App.js', 'styles.css', 'offline.htm'])).toBe('offline.htm');
  });

  it('prefers index.html over another html file that sorts earlier', () => {
    expect(pickPreviewFile(['about.html', 'index.html'])).toBe('index.html');
  });

  it('matches a nested index.html', () => {
    expect(pickPreviewFile(['src/App.js', 'public/index.html'])).toBe('public/index.html');
  });

  it('falls back to the first file when nothing is renderable', () => {
    expect(pickPreviewFile(['App.js', 'styles.css'])).toBe('App.js');
  });

  it('returns undefined for an empty file list', () => {
    expect(pickPreviewFile([])).toBeUndefined();
  });

  it('confirms rollback before dispatching checkpoint call', async () => {
    seedSession();
    const fetchMock = mockFetchWithRun();
    render(<App />);
    fireEvent.click(await screen.findByText('Build it'));
    fireEvent.click(await screen.findByText('Rollback'));
    expect(screen.getByText('Rollback checkpoint?')).toBeTruthy();
    fireEvent.click(screen.getByText('Rollback', { selector: '.ui-modal-foot .ui-button--danger' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-a/checkpoints/ckpt-a/rollback', expect.any(Object)));
  });
});
