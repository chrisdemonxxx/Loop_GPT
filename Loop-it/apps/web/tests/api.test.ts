import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, getApiBaseUrl, loadSession, saveSession, siteUrl, streamRunEvents } from '../src/api';

describe('api base URL and auth client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    delete window.__LOOPIT_API_BASE_URL__;
  });

  it('resolves API base URL from runtime config with local fallback', () => {
    expect(getApiBaseUrl()).toBe('/api');
    window.__LOOPIT_API_BASE_URL__ = 'https://api.example.test/';
    expect(getApiBaseUrl()).toBe('https://api.example.test');
  });

  it('persists sessions in sessionStorage', () => {
    saveSession({ accessToken: 'token-a', user: null, orgs: [] });
    expect(loadSession()?.accessToken).toBe('token-a');
    expect(window.localStorage.getItem('loopit.identity.v1')).toBeNull();
  });

  it('attaches bearer tokens and surfaces 401s', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/runs', 'token-a')).rejects.toBeInstanceOf(ApiError);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(fetchMock).toHaveBeenCalledWith('/api/runs', expect.objectContaining({ headers: expect.any(Headers) }));
    expect(headers.get('Authorization')).toBe('Bearer token-a');
  });

  it('keeps previews under the API proxy path', () => {
    expect(siteUrl('proj-a', 'token-a', 'index.html')).toBe('/api/projects/proj-a/site/index.html');
  });
});

describe('SSE streaming', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses streamed run events and stops at end', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"kind":"error","message":"x"}\n\n'));
        controller.enqueue(encoder.encode('event: end\ndata: {}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const events: unknown[] = [];
    await streamRunEvents('token-a', 'run-a', (event) => events.push(event));
    expect(events).toEqual([{ kind: 'error', message: 'x' }]);
  });
});
