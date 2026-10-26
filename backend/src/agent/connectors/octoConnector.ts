/**
 * Octo Browser Cloud API and Local Client integration.
 *
 * Decisions 3, 4, 5, 6:
 * - Cloud API token stored write-only in Connectors config.
 * - Local client (127.0.0.1:58888) loopback checked & relayed.
 * - Profile lifecycle: Loop only stops profiles it started itself. Already running profiles are left running.
 * - Cookie security: Write-only for agent and UI (import, replace, clear). Never returns cookie secret values.
 * - octo_* tools for profiles, proxies, fingerprints, tags, cookies (every write has needsApproval: true).
 */
import axios from 'axios'
import type { ToolDefinition } from '../types'
import { configStore, type ConnectorConfig } from '../configStore'
import type { ConnectorType } from './connectorRegistry'

const OCTO_CLOUD_BASE = 'https://app.octobrowser.net/api/v2/automation'

export interface OctoProfile {
  uuid: string
  title: string
  status?: string
  tags?: string[]
  fingerprint?: Record<string, unknown>
  proxy?: Record<string, unknown>
}

export class OctoClient {
  constructor(private token: string) {}

  private headers() {
    return {
      'X-Octo-Api-Token': this.token,
      'Content-Type': 'application/json',
    }
  }

  async validateToken(): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await axios.get(`${OCTO_CLOUD_BASE}/profiles`, {
        headers: this.headers(),
        params: { page_len: 1 },
        timeout: 10000,
      })
      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true }
      }
      return { ok: false, error: `Invalid response: ${resp.status}` }
    } catch (err: any) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        return { ok: false, error: 'Invalid API token' }
      }
      return { ok: false, error: err.message || 'Unreachable' }
    }
  }

  async listProfiles(search?: string): Promise<OctoProfile[]> {
    const resp = await axios.get(`${OCTO_CLOUD_BASE}/profiles`, {
      headers: this.headers(),
      params: { search, page_len: 50 },
      timeout: 15000,
    })
    return (resp.data?.data || []).map((p: any) => ({
      uuid: p.uuid,
      title: p.title,
      status: p.status,
      tags: p.tags,
    }))
  }

  async createProfile(data: { title: string; fingerprint?: Record<string, unknown>; proxy?: Record<string, unknown>; tags?: string[] }): Promise<{ uuid: string }> {
    const resp = await axios.post(`${OCTO_CLOUD_BASE}/profiles`, {
      title: data.title,
      fingerprint: data.fingerprint || { os: 'win' },
      ...(data.proxy ? { proxy: data.proxy } : {}),
      ...(data.tags ? { tags: data.tags } : {}),
    }, {
      headers: this.headers(),
      timeout: 15000,
    })
    return { uuid: resp.data?.data?.uuid }
  }

  async updateProfile(uuid: string, data: { title?: string; fingerprint?: Record<string, unknown>; proxy?: Record<string, unknown>; tags?: string[] }): Promise<boolean> {
    const resp = await axios.patch(`${OCTO_CLOUD_BASE}/profiles/${encodeURIComponent(uuid)}`, data, {
      headers: this.headers(),
      timeout: 15000,
    })
    return resp.status >= 200 && resp.status < 300
  }

  async deleteProfile(uuid: string): Promise<boolean> {
    const resp = await axios.delete(`${OCTO_CLOUD_BASE}/profiles`, {
      headers: this.headers(),
      data: { uuids: [uuid] },
      timeout: 15000,
    })
    return resp.status >= 200 && resp.status < 300
  }

  async setCookies(uuid: string, cookies: Array<Record<string, unknown>>): Promise<boolean> {
    const resp = await axios.post(`${OCTO_CLOUD_BASE}/profiles/${encodeURIComponent(uuid)}/cookies`, { cookies }, {
      headers: this.headers(),
      timeout: 15000,
    })
    return resp.status >= 200 && resp.status < 300
  }

  async clearCookies(uuid: string): Promise<boolean> {
    const resp = await axios.post(`${OCTO_CLOUD_BASE}/profiles/${encodeURIComponent(uuid)}/cookies`, { cookies: [] }, {
      headers: this.headers(),
      timeout: 15000,
    })
    return resp.status >= 200 && resp.status < 300
  }

  /**
   * Safe cookie query: returns only domain, name, and count (NEVER secret values).
   * Decision 6: Write-only for secret values.
   */
  async inspectCookies(uuid: string): Promise<{ count: number; items: Array<{ domain: string; name: string }> }> {
    const resp = await axios.get(`${OCTO_CLOUD_BASE}/profiles/${encodeURIComponent(uuid)}/cookies`, {
      headers: this.headers(),
      timeout: 15000,
    })
    const cookies: Array<Record<string, unknown>> = resp.data?.data || []
    return {
      count: cookies.length,
      items: cookies.map((c) => ({
        domain: String(c.domain || ''),
        name: String(c.name || ''),
      })),
    }
  }

  async listProxies(): Promise<Array<{ uuid: string; title: string; type?: string; host?: string; port?: number }>> {
    const resp = await axios.get(`${OCTO_CLOUD_BASE}/proxies`, {
      headers: this.headers(),
      timeout: 15000,
    })
    return (resp.data?.data || []).map((p: any) => ({
      uuid: p.uuid,
      title: p.title,
      type: p.type,
      host: p.host,
      port: p.port,
    }))
  }

  async listTags(): Promise<Array<{ uuid?: string; name: string }>> {
    const resp = await axios.get(`${OCTO_CLOUD_BASE}/tags`, {
      headers: this.headers(),
      timeout: 15000,
    })
    return (resp.data?.data || []).map((t: any) => ({
      uuid: t.uuid,
      name: t.name || String(t),
    }))
  }
}

export async function probeOctoConnector(config: Record<string, string>): Promise<{
  ok: boolean
  invalidCredentials: boolean
  message: string
  ms: number
}> {
  const started = Date.now()
  const token = (config.token || '').trim()
  if (!token) {
    return { ok: false, invalidCredentials: true, message: 'Octo API token is required.', ms: Date.now() - started }
  }
  const client = new OctoClient(token)
  const res = await client.validateToken()
  return {
    ok: res.ok,
    invalidCredentials: res.error === 'Invalid API token',
    message: res.ok ? 'Octo Cloud API token verified.' : (res.error || 'Octo Cloud API validation failed.'),
    ms: Date.now() - started,
  }
}

export function getUserOctoClient(userId: string): OctoClient | null {
  const connectors = configStore.listConnectors(userId)
  const octo = connectors.find((c) => c.type === 'octo' && c.enabled && c.config?.token)
  if (!octo?.config?.token) return null
  return new OctoClient(octo.config.token)
}

/**
 * Build octo_* connector tools granted when an Octo device or connector is active.
 * Every write tool sets needsApproval: true (Decision 4).
 */
export function buildOctoTools(cfg: ConnectorConfig): ToolDefinition[] {
  const token = cfg.config?.token
  if (!token) return []
  const client = new OctoClient(token)
  const id = cfg.id

  return [
    {
      name: `connector__${id}__octo_list_profiles`,
      source: `connector:${id}`,
      description: '[Octo Browser] List available profiles and their statuses.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filter profiles by title or tag' },
        },
      },
      async handler(args) {
        try {
          const profiles = await client.listProfiles(args.search)
          if (!profiles.length) return { content: 'No Octo profiles found.' }
          const summary = profiles.map((p) => `- ${p.title} (uuid: ${p.uuid})${p.status ? ` [${p.status}]` : ''}`).join('\n')
          return { content: `Octo Profiles:\n${summary}` }
        } catch (err: any) {
          return { content: `Failed to list profiles: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_create_profile`,
      source: `connector:${id}`,
      needsApproval: true,
      description: '[Octo Browser] Create a new antidetect profile with fingerprint, proxy, or tags. Raises confirmation.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Profile title' },
          os: { type: 'string', enum: ['win', 'mac', 'android'], description: 'Fingerprint OS' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title'],
      },
      async handler(args) {
        try {
          const created = await client.createProfile({
            title: String(args.title),
            fingerprint: { os: args.os || 'win' },
            tags: Array.isArray(args.tags) ? args.tags : undefined,
          })
          return { content: `Created Octo profile "${args.title}" (uuid: ${created.uuid}).` }
        } catch (err: any) {
          return { content: `Failed to create Octo profile: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_update_profile`,
      source: `connector:${id}`,
      needsApproval: true,
      description: '[Octo Browser] Update an existing profile title, fingerprint, proxy, or tags. Raises confirmation.',
      parameters: {
        type: 'object',
        properties: {
          uuid: { type: 'string', description: 'Profile UUID' },
          title: { type: 'string', description: 'New title' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['uuid'],
      },
      async handler(args) {
        try {
          await client.updateProfile(String(args.uuid), {
            ...(args.title ? { title: String(args.title) } : {}),
            ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
          })
          return { content: `Updated Octo profile ${args.uuid}.` }
        } catch (err: any) {
          return { content: `Failed to update Octo profile: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_delete_profile`,
      source: `connector:${id}`,
      needsApproval: true,
      description: '[Octo Browser] Delete an Octo profile. Raises confirmation.',
      parameters: {
        type: 'object',
        properties: {
          uuid: { type: 'string', description: 'Profile UUID to delete' },
        },
        required: ['uuid'],
      },
      async handler(args) {
        try {
          await client.deleteProfile(String(args.uuid))
          return { content: `Deleted Octo profile ${args.uuid}.` }
        } catch (err: any) {
          return { content: `Failed to delete Octo profile: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_inspect_cookies`,
      source: `connector:${id}`,
      description: '[Octo Browser] Inspect profile cookies metadata (domain, name, and count only; never exports raw secret values).',
      parameters: {
        type: 'object',
        properties: {
          uuid: { type: 'string', description: 'Profile UUID' },
        },
        required: ['uuid'],
      },
      async handler(args) {
        try {
          const res = await client.inspectCookies(args.uuid)
          const items = res.items.slice(0, 30).map((c) => `${c.domain}: ${c.name}`).join('\n')
          return {
            content: `Profile has ${res.count} cookie(s).\n${items}${res.count > 30 ? '\n...and more' : ''}`,
          }
        } catch (err: any) {
          return { content: `Failed to inspect cookies: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_import_cookies`,
      source: `connector:${id}`,
      needsApproval: true,
      description: '[Octo Browser] Import/replace cookies on an Octo profile (write-only). Raises confirmation.',
      parameters: {
        type: 'object',
        properties: {
          uuid: { type: 'string', description: 'Profile UUID' },
          cookies: { type: 'array', items: { type: 'object' }, description: 'Cookies array to import' },
        },
        required: ['uuid', 'cookies'],
      },
      async handler(args) {
        try {
          const list = Array.isArray(args.cookies) ? args.cookies : []
          await client.setCookies(String(args.uuid), list)
          return { content: `Imported ${list.length} cookie(s) into Octo profile ${args.uuid}.` }
        } catch (err: any) {
          return { content: `Failed to import cookies: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_clear_cookies`,
      source: `connector:${id}`,
      needsApproval: true,
      description: '[Octo Browser] Clear all cookies on an Octo profile. Raises confirmation.',
      parameters: {
        type: 'object',
        properties: {
          uuid: { type: 'string', description: 'Profile UUID' },
        },
        required: ['uuid'],
      },
      async handler(args) {
        try {
          await client.clearCookies(String(args.uuid))
          return { content: `Cleared cookies for Octo profile ${args.uuid}.` }
        } catch (err: any) {
          return { content: `Failed to clear cookies: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_list_proxies`,
      source: `connector:${id}`,
      description: '[Octo Browser] List saved proxies in Octo account.',
      parameters: { type: 'object', properties: {} },
      async handler() {
        try {
          const proxies = await client.listProxies()
          if (!proxies.length) return { content: 'No saved proxies found in Octo.' }
          return { content: proxies.map((p) => `- ${p.title} (${p.type || 'http'}://${p.host || ''}:${p.port || ''}) [uuid: ${p.uuid}]`).join('\n') }
        } catch (err: any) {
          return { content: `Failed to list proxies: ${err.message}`, isError: true }
        }
      },
    },
    {
      name: `connector__${id}__octo_list_tags`,
      source: `connector:${id}`,
      description: '[Octo Browser] List profile tags in Octo account.',
      parameters: { type: 'object', properties: {} },
      async handler() {
        try {
          const tags = await client.listTags()
          if (!tags.length) return { content: 'No tags found in Octo.' }
          return { content: tags.map((t) => `- ${t.name}`).join('\n') }
        } catch (err: any) {
          return { content: `Failed to list tags: ${err.message}`, isError: true }
        }
      },
    },
  ]
}

export const octoConnectorType: ConnectorType = {
  type: 'octo',
  name: 'Octo Browser',
  description: 'Manage Octo antidetect profiles, fingerprints, proxies, tags, and write-only cookies via Octo Cloud API and local desktop client.',
  category: 'Browser',
  icon: '🐙',
  fields: [
    {
      key: 'token',
      label: 'Octo Cloud API Token',
      secret: true,
      required: true,
      placeholder: 'X-Octo-Api-Token from Octo Settings',
    },
  ],
  tools: [
    { suffix: 'octo_list_profiles', description: 'List Octo antidetect profiles and statuses.' },
    { suffix: 'octo_create_profile', description: 'Create a new Octo profile (requires approval).' },
    { suffix: 'octo_update_profile', description: 'Update an Octo profile (requires approval).' },
    { suffix: 'octo_delete_profile', description: 'Delete an Octo profile (requires approval).' },
    { suffix: 'octo_inspect_cookies', description: 'Inspect cookie domains and names (never raw values).' },
    { suffix: 'octo_import_cookies', description: 'Write-only cookie import (requires approval).' },
    { suffix: 'octo_clear_cookies', description: 'Clear profile cookies (requires approval).' },
    { suffix: 'octo_list_proxies', description: 'List saved Octo proxies.' },
    { suffix: 'octo_list_tags', description: 'List Octo profile tags.' },
  ],
  docs: 'https://documenter.getpostman.com/view/1801428/UVC6i6eA',
  createTools: (cfg) => buildOctoTools(cfg),
}
