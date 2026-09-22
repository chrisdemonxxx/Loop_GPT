/**
 * Marketplace connector adapters. Marketplace providers (Outlook, OneDrive,
 * Dropbox, Linear, Asana, Salesforce, Figma, Zoom) are connected with the
 * user's OWN OAuth app credentials via the standard OAuth 2.1+PKCE flow; the
 * stored access token then powers a generic, real API tool so the agent can
 * actually use the connection (REST GET/POST against the provider's API base).
 */
import type { ToolDefinition, ToolContext } from '../types'
import { configStore, type ConnectorConfig } from '../configStore'
import { MARKETPLACE_OAUTH_PROVIDERS } from './oauthProviders'

function apiBaseFor(spec: { apiBase?: string }, cfg: ConnectorConfig): string {
  return (spec.apiBase || '').replace(/\{(\w+)\}/g, (_m, k) => cfg.config[k] || '')
}

/** Build the adapter for a marketplace connector instance. */
export function marketplaceConnectorTools(cfg: ConnectorConfig): ToolDefinition[] {
  const spec = MARKETPLACE_OAUTH_PROVIDERS[cfg.type]
  if (!spec) return []
  const id = cfg.id
  const base = apiBaseFor(spec, cfg).replace(/\/+$/, '')
  if (!base) return []

  return [
    {
      name: `connector__${id}__api_request`,
      source: `connector:${id}`,
      description: `[${spec.name}] Call the connected ${spec.name} API. Args: path (e.g. "/me/events"), method (GET|POST, default GET), body (JSON object for POST).`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'API path, e.g. /me or /users/me/messages' },
          method: { type: 'string', enum: ['GET', 'POST'] },
          body: { type: 'object', description: 'JSON body for POST requests' },
        },
        required: ['path'],
      },
      async handler(args: any, ctx: ToolContext) {
        const token = cfg.config.access_token
        if (!token) return { content: `${spec.name} not connected.`, isError: true }
        try {
          const path = String(args.path || '')
          const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`
          const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
          let body: string | undefined
          if ((args.method || 'GET').toUpperCase() === 'POST') {
            headers['Content-Type'] = 'application/json'
            body = JSON.stringify(args.body ?? {})
          }
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 25000)
          const res = await fetch(url, { method: (args.method || 'GET').toUpperCase(), headers, body, signal: ctx.signal || ctrl.signal }).finally(() => clearTimeout(timer))
          const text = await res.text()
          if (!res.ok) return { content: `[${spec.name}] HTTP ${res.status}: ${text.slice(0, 600)}`, isError: true }
          return { content: text.slice(0, 8000) || '(empty response)' }
        } catch (e: any) {
          return { content: `[${spec.name}] request failed: ${e?.message || e}`, isError: true }
        }
      },
    },
  ]
}

export const MARKETPLACE_CONNECTOR_TYPES = Object.keys(MARKETPLACE_OAUTH_PROVIDERS)

export function isMarketplaceConnector(type: string): boolean {
  return !!MARKETPLACE_OAUTH_PROVIDERS[type]
}

/** Test a marketplace connector: one authenticated GET against its base. */
export async function probeMarketplaceConnector(cfg: ConnectorConfig): Promise<{ ok: boolean; invalidCredentials: boolean; message: string; ms: number }> {
  const started = Date.now()
  const spec = MARKETPLACE_OAUTH_PROVIDERS[cfg.type]
  const token = cfg.config.access_token
  if (!spec || !token) return { ok: false, invalidCredentials: false, message: 'Not connected.', ms: 0 }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    const res = await fetch(`${apiBaseFor(spec, cfg).replace(/\/+$/, '')}/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer))
    const ms = Date.now() - started
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      return { ok: false, invalidCredentials: true, message: `HTTP ${res.status}: ${text.slice(0, 300)}`, ms }
    }
    // Any other response means the token was accepted by the provider.
    return { ok: true, invalidCredentials: false, message: `Credential accepted (HTTP ${res.status}).`, ms }
  } catch (e: any) {
    return { ok: false, invalidCredentials: false, message: `Probe failed: ${e?.message || e}`, ms: Date.now() - started }
  }
}

export function refreshMarketplaceEntry(cfg: ConnectorConfig): void {
  configStore.saveConnectors(configStore.listConnectors().map((c) => (c.id === cfg.id ? cfg : c)))
}
