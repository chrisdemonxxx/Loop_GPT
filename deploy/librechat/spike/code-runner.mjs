#!/usr/bin/env node
/**
 * Loop GPT MCP code runner (stdio) — sandboxed code execution + web fetch.
 *
 * Tools:
 *   run_javascript  — Node.js snippet, 30s cap, isolated cwd, scrubbed env
 *   run_python      — Python 3 snippet when the interpreter exists
 *   run_shell       — POSIX sh command (30s cap, sandbox cwd)
 *   fetch_url       — HTTP GET/POST with size caps (web reading for the agent)
 *
 * Sandbox: cwd /tmp/loop-sandbox, 30s timeout, 512KB output cap, minimal env.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = join(tmpdir(), 'loop-sandbox');
const FILES_DIR = join(tmpdir(), 'loop-files');
for (const d of [SANDBOX, FILES_DIR]) mkdirSync(d, { recursive: true });

const TIMEOUT_MS = 30_000;
const MAX_OUT = 512 * 1024;

/** Minimal env for child processes — never leak service secrets. */
function cleanEnv() {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: SANDBOX,
    TMPDIR: SANDBOX,
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
  };
}

function run(cmd, args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: cwd || SANDBOX, env: cleanEnv(), shell: false });
    } catch (e) {
      return resolve({ ok: false, error: `spawn failed: ${e?.message || e}`, stdout: '', stderr: '', ms: 0 });
    }
    const t = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e?.message || String(e), stdout, stderr, ms: Date.now() - started }); });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0 && !killed, code, killed, stdout, stderr, ms: Date.now() - started });
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function fmt(r) {
  const parts = [];
  if (r.killed) parts.push(`[timed out after ${TIMEOUT_MS / 1000}s — process killed]`);
  if (r.error) parts.push(`[error] ${r.error}`);
  if (r.stdout) parts.push(r.stdout.length > MAX_OUT ? r.stdout.slice(0, MAX_OUT) + '\n[stdout truncated]' : r.stdout);
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.length > MAX_OUT ? r.stderr.slice(0, MAX_OUT) + '\n[truncated]' : r.stderr}`);
  if (!parts.length) parts.push('(no output)');
  parts.push(`\n— exit ${r.code ?? '?'} in ${r.ms}ms`);
  return parts.join('\n');
}

function listSandboxFiles() {
  try {
    return readdirSync(SANDBOX)
      .map((f) => {
        const st = statSync(join(SANDBOX, f));
        return `${f} (${st.size}B)`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

const server = new McpServer({ name: 'loop-code', version: '0.2.0' });

server.tool(
  'run_javascript',
  'Execute JavaScript (Node.js) in a sandbox and return stdout/stderr. Use for calculations, data processing, algorithm tests, file generation.',
  { code: z.string().describe('JavaScript source to execute with Node.js') },
  async ({ code }) => {
    const f = join(SANDBOX, `snippet-${Date.now()}.mjs`);
    writeFileSync(f, code);
    const r = await run('node', [f]);
    const files = listSandboxFiles();
    return { content: [{ type: 'text', text: fmt(r) + (files ? `\n\n[sandbox files]\n${files}` : '') }] };
  }
);

server.tool(
  'run_python',
  'Execute Python 3 in a sandbox and return stdout/stderr. Use for data science, math, scripting, file generation.',
  { code: z.string().describe('Python source to execute with python3') },
  async ({ code }) => {
    const f = join(SANDBOX, `snippet-${Date.now()}.py`);
    writeFileSync(f, code);
    const r = await run('python3', [f]);
    if (r.error && /spawn failed|ENOENT/i.test(r.error)) {
      return { content: [{ type: 'text', text: 'Python 3 is not installed in this environment. Use run_javascript instead.' }] };
    }
    const files = listSandboxFiles();
    return { content: [{ type: 'text', text: fmt(r) + (files ? `\n\n[sandbox files]\n${files}` : '') }] };
  }
);

server.tool(
  'run_shell',
  'Run a POSIX shell command in the sandbox (30s cap). Use for file ops, text processing, system inspection.',
  { command: z.string().describe('Shell command to execute via sh -c') },
  async ({ command }) => {
    const r = await run('sh', ['-c', command]);
    return { content: [{ type: 'text', text: fmt(r) }] };
  }
);

server.tool(
  'fetch_url',
  'Fetch a URL (GET/POST) and return the body (capped). Use to read web pages, APIs, and raw files.',
  {
    url: z.string().url().describe('Absolute http(s) URL'),
    method: z.enum(['GET', 'POST']).optional(),
    body: z.string().optional(),
    headers: z.record(z.string()).optional(),
  },
  async ({ url, method = 'GET', body, headers = {} }) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': 'LoopGPT-Agent/1.0', ...headers },
        body: method === 'POST' ? body : undefined,
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(t);
      const text = await res.text();
      const capped = text.length > 200_000 ? text.slice(0, 200_000) + '\n[truncated]' : text;
      return {
        content: [
          { type: 'text', text: `HTTP ${res.status} ${res.headers.get('content-type') || ''}\n\n${capped}` },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `fetch failed: ${e?.message || e}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[loop-code] MCP server ready');
