/**
 * Connector directory — a Claude.ai-style catalog of ready-to-add integrations.
 *
 * Each entry is data-driven: auth style, base URL, config fields, and a set of
 * REST tool specs. A generic factory (buildCatalogTools) turns a stored config
 * into working agent tools. Token/header/query-auth connectors work immediately;
 * OAuth-only providers are listed in the directory but marked `oauth: true`
 * (they need the OAuth setup wired) so the catalog looks complete without
 * shipping broken tools.
 */
import type { ToolDefinition, ToolContext } from '../types'
import type { ConnectorConfig } from '../configStore'

export type AuthStyle = 'bearer' | 'header' | 'query' | 'basic' | 'none'

export interface ConnectorField {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
}

export interface RestToolSpec {
  /** Tool name suffix (final name is connector__<id>__<suffix>). */
  suffix: string
  description: string
  method: 'GET' | 'POST' | 'DELETE'
  /** Path template; {name} tokens are filled from args first, then config. */
  path: string
  /** Arg keys sent as query params (GET) instead of path/body. */
  query?: string[]
  /** Arg keys sent in the JSON/form body (POST). */
  body?: string[]
  bodyType?: 'json' | 'form'
  parameters: { type: 'object'; properties: Record<string, any>; required?: string[] }
}

export interface CatalogConnector {
  type: string
  name: string
  description: string
  category: string
  icon?: string
  docs?: string
  /** OAuth-only providers: shown in the directory but need OAuth wiring. */
  oauth?: boolean
  auth?: AuthStyle
  /** Which config field holds the credential (for bearer/header/query/basic). */
  authField?: string
  /** For 'header' auth: the header name. For 'query': the query param name. */
  authName?: string
  /** For 'basic' auth: config field holding the username/email. */
  basicUserField?: string
  baseUrl?: string
  /** Static headers to always send (e.g. API versioning). */
  headers?: Record<string, string>
  fields?: ConnectorField[]
  tools?: RestToolSpec[]
}

// ---------------------------------------------------------------------------
// Working (token / key based) connectors
// ---------------------------------------------------------------------------

const WORKING: CatalogConnector[] = [
  {
    type: 'notion',
    name: 'Notion',
    description: 'Search pages and databases in your Notion workspace.',
    category: 'Productivity',
    icon: '📝',
    auth: 'bearer',
    authField: 'token',
    baseUrl: 'https://api.notion.com/v1',
    headers: { 'Notion-Version': '2022-06-28' },
    fields: [{ key: 'token', label: 'Notion integration token', secret: true, required: true, placeholder: 'secret_...' }],
    tools: [
      {
        suffix: 'search',
        description: '[Notion] Search pages and databases by text.',
        method: 'POST',
        path: '/search',
        body: ['query'],
        bodyType: 'json',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search text' } }, required: ['query'] },
      },
    ],
  },
  {
    type: 'slack',
    name: 'Slack',
    description: 'Post messages and list channels with a bot token.',
    category: 'Communication',
    icon: '💬',
    auth: 'bearer',
    authField: 'token',
    baseUrl: 'https://slack.com/api',
    fields: [{ key: 'token', label: 'Slack bot token', secret: true, required: true, placeholder: 'xoxb-...' }],
    tools: [
      {
        suffix: 'post_message',
        description: '[Slack] Post a message to a channel. Args: channel (id or #name), text.',
        method: 'POST',
        path: '/chat.postMessage',
        body: ['channel', 'text'],
        bodyType: 'json',
        parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
      },
      {
        suffix: 'list_channels',
        description: '[Slack] List public channels.',
        method: 'GET',
        path: '/conversations.list',
        query: ['limit'],
        parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max channels (default 50)' } } },
      },
    ],
  },
  {
    type: 'airtable',
    name: 'Airtable',
    description: 'Read records from an Airtable base.',
    category: 'Data',
    icon: '🗂️',
    auth: 'bearer',
    authField: 'token',
    baseUrl: 'https://api.airtable.com/v0',
    fields: [
      { key: 'token', label: 'Airtable personal access token', secret: true, required: true, placeholder: 'pat...' },
      { key: 'baseId', label: 'Base ID', required: true, placeholder: 'app...' },
    ],
    tools: [
      {
        suffix: 'list_records',
        description: '[Airtable] List records from a table. Args: table (name), maxRecords.',
        method: 'GET',
        path: '/{baseId}/{table}',
        query: ['maxRecords'],
        parameters: { type: 'object', properties: { table: { type: 'string' }, maxRecords: { type: 'number' } }, required: ['table'] },
      },
    ],
  },
  {
    type: 'todoist',
    name: 'Todoist',
    description: 'List and create tasks in Todoist.',
    category: 'Productivity',
    icon: '✅',
    auth: 'bearer',
    authField: 'token',
    baseUrl: 'https://api.todoist.com/rest/v2',
    fields: [{ key: 'token', label: 'Todoist API token', secret: true, required: true }],
    tools: [
      { suffix: 'list_tasks', description: '[Todoist] List active tasks.', method: 'GET', path: '/tasks', parameters: { type: 'object', properties: {} } },
      {
        suffix: 'create_task',
        description: '[Todoist] Create a task. Args: content (required), due_string.',
        method: 'POST',
        path: '/tasks',
        body: ['content', 'due_string'],
        bodyType: 'json',
        parameters: { type: 'object', properties: { content: { type: 'string' }, due_string: { type: 'string' } }, required: ['content'] },
      },
    ],
  },
  {
    type: 'stripe',
    name: 'Stripe',
    description: 'Read customers and charges from your Stripe account.',
    category: 'Finance',
    icon: '💳',
    auth: 'bearer',
    authField: 'secretKey',
    baseUrl: 'https://api.stripe.com/v1',
    fields: [{ key: 'secretKey', label: 'Stripe secret key', secret: true, required: true, placeholder: 'sk_live_... / rk_...' }],
    tools: [
      { suffix: 'list_customers', description: '[Stripe] List recent customers.', method: 'GET', path: '/customers', query: ['limit'], parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
      { suffix: 'list_charges', description: '[Stripe] List recent charges.', method: 'GET', path: '/charges', query: ['limit'], parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
    ],
  },
  {
    type: 'gitlab',
    name: 'GitLab',
    description: 'Search projects and read files on GitLab.',
    category: 'Developer',
    icon: '🦊',
    auth: 'header',
    authField: 'token',
    authName: 'PRIVATE-TOKEN',
    baseUrl: 'https://gitlab.com/api/v4',
    fields: [{ key: 'token', label: 'GitLab personal access token', secret: true, required: true, placeholder: 'glpat-...' }],
    tools: [
      { suffix: 'search_projects', description: '[GitLab] Search projects. Args: search.', method: 'GET', path: '/projects', query: ['search'], parameters: { type: 'object', properties: { search: { type: 'string' } }, required: ['search'] } },
    ],
  },
  {
    type: 'jira',
    name: 'Jira',
    description: 'Search issues with JQL in Jira Cloud.',
    category: 'Developer',
    icon: '🧭',
    auth: 'basic',
    authField: 'apiToken',
    basicUserField: 'email',
    fields: [
      { key: 'siteUrl', label: 'Site URL (https://your.atlassian.net)', required: true },
      { key: 'email', label: 'Account email', required: true },
      { key: 'apiToken', label: 'API token', secret: true, required: true },
    ],
    baseUrl: '{siteUrl}/rest/api/3',
    tools: [
      { suffix: 'search_issues', description: '[Jira] Search issues by JQL. Args: jql.', method: 'GET', path: '/search', query: ['jql'], parameters: { type: 'object', properties: { jql: { type: 'string', description: 'e.g. project = ABC ORDER BY created DESC' } }, required: ['jql'] } },
    ],
  },
  {
    type: 'hubspot',
    name: 'HubSpot',
    description: 'Read CRM contacts from HubSpot.',
    category: 'Marketing',
    icon: '🧲',
    auth: 'bearer',
    authField: 'token',
    baseUrl: 'https://api.hubapi.com',
    fields: [{ key: 'token', label: 'HubSpot private app token', secret: true, required: true, placeholder: 'pat-...' }],
    tools: [
      { suffix: 'list_contacts', description: '[HubSpot] List CRM contacts.', method: 'GET', path: '/crm/v3/objects/contacts', query: ['limit'], parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
    ],
  },
  {
    type: 'sentry',
    name: 'Sentry',
    description: 'List issues from a Sentry project.',
    category: 'Developer',
    icon: '🛡️',
    auth: 'bearer',
    authField: 'token',
    baseUrl: 'https://sentry.io/api/0',
    fields: [
      { key: 'token', label: 'Sentry auth token', secret: true, required: true },
      { key: 'org', label: 'Organization slug', required: true },
      { key: 'project', label: 'Project slug', required: true },
    ],
    tools: [
      { suffix: 'list_issues', description: '[Sentry] List unresolved issues.', method: 'GET', path: '/projects/{org}/{project}/issues/', query: ['query'], parameters: { type: 'object', properties: { query: { type: 'string', description: 'e.g. is:unresolved' } } } },
    ],
  },
  {
    type: 'discord',
    name: 'Discord',
    description: 'Send messages to a Discord channel via a bot.',
    category: 'Communication',
    icon: '🎮',
    auth: 'header',
    authField: 'botToken',
    authName: 'Authorization',
    baseUrl: 'https://discord.com/api/v10',
    fields: [{ key: 'botToken', label: 'Bot token (with "Bot " prefix)', secret: true, required: true, placeholder: 'Bot xxxxx' }],
    tools: [
      { suffix: 'send_message', description: '[Discord] Send a message to a channel. Args: channelId, content.', method: 'POST', path: '/channels/{channelId}/messages', body: ['content'], bodyType: 'json', parameters: { type: 'object', properties: { channelId: { type: 'string' }, content: { type: 'string' } }, required: ['channelId', 'content'] } },
    ],
  },
  {
    type: 'telegram',
    name: 'Telegram',
    description: 'Send messages via a Telegram bot.',
    category: 'Communication',
    icon: '✈️',
    auth: 'none',
    baseUrl: 'https://api.telegram.org',
    fields: [{ key: 'botToken', label: 'Bot token', secret: true, required: true, placeholder: '123456:ABC-...' }],
    tools: [
      { suffix: 'send_message', description: '[Telegram] Send a message. Args: chat_id, text.', method: 'POST', path: '/bot{botToken}/sendMessage', body: ['chat_id', 'text'], bodyType: 'json', parameters: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] } },
    ],
  },
  {
    type: 'openweather',
    name: 'OpenWeather',
    description: 'Current weather for any city.',
    category: 'Data',
    icon: '🌤️',
    auth: 'query',
    authField: 'apiKey',
    authName: 'appid',
    baseUrl: 'https://api.openweathermap.org/data/2.5',
    fields: [{ key: 'apiKey', label: 'OpenWeather API key', secret: true, required: true }],
    tools: [
      { suffix: 'current', description: '[OpenWeather] Current weather. Args: q (city), units (metric|imperial).', method: 'GET', path: '/weather', query: ['q', 'units'], parameters: { type: 'object', properties: { q: { type: 'string' }, units: { type: 'string' } }, required: ['q'] } },
    ],
  },
  {
    type: 'serpapi',
    name: 'SerpAPI',
    description: 'Google search results via SerpAPI.',
    category: 'Search',
    icon: '🔎',
    auth: 'query',
    authField: 'apiKey',
    authName: 'api_key',
    baseUrl: 'https://serpapi.com',
    fields: [{ key: 'apiKey', label: 'SerpAPI key', secret: true, required: true }],
    tools: [
      { suffix: 'search', description: '[SerpAPI] Google search. Args: q.', method: 'GET', path: '/search', query: ['q'], parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
    ],
  },
]

// ---------------------------------------------------------------------------
// Directory entries requiring OAuth (shown, but need OAuth wiring to activate)
// ---------------------------------------------------------------------------

const OAUTH_DIRECTORY: CatalogConnector[] = [
  { type: 'google_drive', name: 'Google Drive', description: 'Search and read files from Google Drive.', category: 'Productivity', icon: '📁', oauth: true },
  { type: 'gmail', name: 'Gmail', description: 'Read and send email from Gmail.', category: 'Communication', icon: '📧', oauth: true },
  { type: 'google_calendar', name: 'Google Calendar', description: 'Read and create calendar events.', category: 'Productivity', icon: '📅', oauth: true },
  { type: 'google_sheets', name: 'Google Sheets', description: 'Read and write spreadsheet data.', category: 'Data', icon: '📊', oauth: true },
  { type: 'outlook', name: 'Microsoft Outlook', description: 'Email and calendar via Microsoft 365.', category: 'Communication', icon: '📨', oauth: true },
  { type: 'onedrive', name: 'OneDrive', description: 'Files from Microsoft OneDrive.', category: 'Productivity', icon: '☁️', oauth: true },
  { type: 'dropbox', name: 'Dropbox', description: 'Search and read files from Dropbox.', category: 'Productivity', icon: '📦', oauth: true },
  { type: 'linear', name: 'Linear', description: 'Issues and projects from Linear.', category: 'Developer', icon: '📐', oauth: true },
  { type: 'asana', name: 'Asana', description: 'Tasks and projects from Asana.', category: 'Productivity', icon: '🎯', oauth: true },
  { type: 'salesforce', name: 'Salesforce', description: 'CRM records from Salesforce.', category: 'Marketing', icon: '⚡', oauth: true },
  { type: 'figma', name: 'Figma', description: 'Read design files and comments.', category: 'Developer', icon: '🎨', oauth: true },
  { type: 'zoom', name: 'Zoom', description: 'Meetings and recordings from Zoom.', category: 'Communication', icon: '🎥', oauth: true },
]

export const CONNECTOR_CATALOG: CatalogConnector[] = [...WORKING, ...OAUTH_DIRECTORY]

// ---------------------------------------------------------------------------
// Factory: build working tools from a stored config + catalog definition
// ---------------------------------------------------------------------------

function fill(template: string, args: any, cfg: ConnectorConfig): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = args?.[k] ?? cfg.config?.[k] ?? ''
    return encodeURIComponent(String(v)).replace(/%2F/g, '/')
  })
}

export function buildCatalogTools(def: CatalogConnector, cfg: ConnectorConfig): ToolDefinition[] {
  if (def.oauth || !def.tools) return []
  const id = cfg.id
  const rawBase = fill(def.baseUrl || '', {}, cfg).replace(/\/+$/, '')

  return def.tools.map((spec): ToolDefinition => ({
    name: `connector__${id}__${def.type}_${spec.suffix}`,
    source: `connector:${id}`,
    description: spec.description,
    parameters: spec.parameters,
    async handler(args: any, _ctx: ToolContext) {
      try {
        const headers: Record<string, string> = { Accept: 'application/json', ...(def.headers || {}) }
        const cred = def.authField ? cfg.config?.[def.authField] : undefined

        // Auth
        if (def.auth === 'bearer' && cred) headers['Authorization'] = `Bearer ${cred}`
        else if (def.auth === 'header' && cred && def.authName) {
          headers[def.authName] = def.authName === 'Authorization' ? String(cred) : String(cred)
        } else if (def.auth === 'basic' && cred) {
          const user = def.basicUserField ? cfg.config?.[def.basicUserField] : ''
          headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${cred}`).toString('base64')
        }

        // URL + query
        const path = fill(spec.path, args, cfg)
        const url = new URL(path.startsWith('http') ? path : `${rawBase}${path.startsWith('/') ? '' : '/'}${path}`)
        for (const q of spec.query || []) {
          if (args?.[q] != null) url.searchParams.set(q, String(args[q]))
        }
        if (def.auth === 'query' && cred && def.authName) url.searchParams.set(def.authName, String(cred))

        // Body
        let body: string | undefined
        if (spec.body && (spec.method === 'POST')) {
          const payload: any = {}
          for (const b of spec.body) if (args?.[b] != null) payload[b] = args[b]
          if (spec.bodyType === 'form') {
            body = new URLSearchParams(payload).toString()
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
          } else {
            body = JSON.stringify(payload)
            headers['Content-Type'] = 'application/json'
          }
        }

        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 25000)
        const res = await fetch(url.toString(), { method: spec.method, headers, body, signal: ctrl.signal }).finally(() => clearTimeout(timer))
        const text = await res.text()
        if (!res.ok) return { content: `[${def.name}] HTTP ${res.status}: ${text.slice(0, 600)}`, isError: true }
        return { content: text.slice(0, 8000) }
      } catch (e: any) {
        return { content: `[${def.name}] request failed: ${e?.message || e}`, isError: true }
      }
    },
  }))
}
