/**
 * Google OAuth connector adapters. The OAuth callback (routes/oauthConnector)
 * stores { access_token, refresh_token, expires_at } in the connector config;
 * these adapters turn that config into real agent tools. Access tokens are
 * short-lived, so calls go through ensureGoogleToken which refreshes (with the
 * platform client credentials) and persists the new token when needed.
 */
import type { ToolDefinition } from '../types'
import { configStore, type ConnectorConfig } from '../configStore'

const GOOGLE_CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET

async function refreshAccessToken(cfg: ConnectorConfig): Promise<string | null> {
  const refreshToken = cfg.config.refresh_token
  const clientId = GOOGLE_CLIENT_ID()
  const clientSecret = GOOGLE_CLIENT_SECRET()
  if (!refreshToken || !clientId || !clientSecret) return null
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
      }).toString(),
    })
    const tokens = await res.json() as any
    if (!tokens.access_token) return null
    cfg.config.access_token = tokens.access_token
    cfg.config.expires_at = String(Date.now() + (tokens.expires_in || 3600) * 1000)
    configStore.saveConnectors(configStore.listConnectors().map((c) => (c.id === cfg.id ? cfg : c)))
    return tokens.access_token
  } catch {
    return null
  }
}

/** A valid, current access token (refreshing when about to expire). */
export async function ensureGoogleToken(cfg: ConnectorConfig): Promise<string> {
  const expiresAt = Number(cfg.config.expires_at || 0)
  const token = cfg.config.access_token
  if (token && expiresAt > Date.now() + 60_000) return token
  const refreshed = await refreshAccessToken(cfg)
  return refreshed || token || ''
}

async function googleGet(url: string, token: string, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal })
  const text = await res.text()
  if (!res.ok) return { __error: `HTTP ${res.status}: ${text.slice(0, 400)}` }
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 4000) } }
}

function summarizeList(items: any[], field: (i: any) => string, empty = 'No results found.'): string {
  if (!items?.length) return empty
  return items.slice(0, 10).map(field).join('\n')
}

export function googleDriveConnectorTools(cfg: ConnectorConfig): ToolDefinition[] {
  const id = cfg.id
  const base = 'https://www.googleapis.com/drive/v3'
  return [
    {
      name: `connector__${id}__drive_list_files`,
      source: `connector:${id}`,
      description: '[Google Drive] List/search files in the connected Drive. Args: query (optional name search), max (default 10).',
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } } },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Google Drive not connected.', isError: true }
        const q = args.query ? ` and name contains '${String(args.query).replace(/'/g, "\\'")}'` : ''
        const data = await googleGet(`${base}/files?q=trashed=false${q}&pageSize=${Math.min(Number(args.max) || 10, 25)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, token, ctx.signal)
        if (data.__error) return { content: `[Google Drive] ${data.__error}`, isError: true }
        return { content: summarizeList(data.files, (f) => `${f.name} (${f.mimeType})\n${f.webViewLink}`) }
      },
    },
    {
      name: `connector__${id}__drive_read_file`,
      source: `connector:${id}`,
      description: '[Google Drive] Read the text content of a Drive file by ID. Args: fileId.',
      parameters: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Google Drive not connected.', isError: true }
        const res = await fetch(`${base}/files/${args.fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal })
        const text = await res.text()
        if (!res.ok) return { content: `[Google Drive] HTTP ${res.status}: ${text.slice(0, 400)}`, isError: true }
        return { content: text.slice(0, 8000) }
      },
    },
  ]
}

export function gmailConnectorTools(cfg: ConnectorConfig): ToolDefinition[] {
  const id = cfg.id
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me'
  return [
    {
      name: `connector__${id}__gmail_search`,
      source: `connector:${id}`,
      description: '[Gmail] Search the connected inbox. Args: query (Gmail search syntax, e.g. "from:boss is:unread"), max (default 10).',
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } }, required: ['query'] },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Gmail not connected.', isError: true }
        const data = await googleGet(`${base}/messages?q=${encodeURIComponent(String(args.query))}&maxResults=${Math.min(Number(args.max) || 10, 25)}`, token, ctx.signal)
        if (data.__error) return { content: `[Gmail] ${data.__error}`, isError: true }
        return { content: (data.messages || []).slice(0, 10).map((m: any) => m.id).join('\n') || 'No messages found.' }
      },
    },
    {
      name: `connector__${id}__gmail_read`,
      source: `connector:${id}`,
      description: '[Gmail] Read a message by ID (subject, from, and body). Args: messageId.',
      parameters: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Gmail not connected.', isError: true }
        const data = await googleGet(`${base}/messages/${args.messageId}?format=full`, token, ctx.signal)
        if (data.__error) return { content: `[Gmail] ${data.__error}`, isError: true }
        const headers = data.payload?.headers || []
        const get = (name: string) => headers.find((h: any) => h.name?.toLowerCase() === name)?.value || ''
        const bodyPart = data.payload?.parts?.find((p: any) => p.mimeType === 'text/plain') || data.payload
        let body = ''
        if (bodyPart?.body?.data) body = Buffer.from(bodyPart.body.data, 'base64url').toString('utf-8')
        return { content: `From: ${get('from')}\nSubject: ${get('subject')}\nDate: ${get('date')}\n\n${body.slice(0, 4000)}` }
      },
    },
    {
      name: `connector__${id}__gmail_send`,
      source: `connector:${id}`,
      description: '[Gmail] Send an email from the connected account. Args: to, subject, body.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Gmail not connected.', isError: true }
        const mime = [`To: ${args.to}`, `Subject: ${args.subject}`, 'Content-Type: text/plain; charset="UTF-8"', '', args.body].join('\r\n')
        const raw = Buffer.from(mime).toString('base64url')
        const res = await fetch(`${base}/messages/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }), signal: ctx.signal,
        })
        const text = await res.text()
        if (!res.ok) return { content: `[Gmail] HTTP ${res.status}: ${text.slice(0, 400)}`, isError: true }
        return { content: `Email sent to ${args.to}.` }
      },
    },
  ]
}

export function googleCalendarConnectorTools(cfg: ConnectorConfig): ToolDefinition[] {
  const id = cfg.id
  const base = 'https://www.googleapis.com/calendar/v3/calendars/primary'
  return [
    {
      name: `connector__${id}__calendar_list_events`,
      source: `connector:${id}`,
      description: '[Google Calendar] List upcoming events on the primary calendar. Args: max (default 10).',
      parameters: { type: 'object', properties: { max: { type: 'number' } } },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Google Calendar not connected.', isError: true }
        const data = await googleGet(`${base}/events?orderBy=startTime&singleEvents=true&timeMin=${encodeURIComponent(new Date().toISOString())}&maxResults=${Math.min(Number(args.max) || 10, 25)}`, token, ctx.signal)
        if (data.__error) return { content: `[Google Calendar] ${data.__error}`, isError: true }
        return { content: summarizeList(data.items, (e: any) => `${e.start?.dateTime || e.start?.date} — ${e.summary || '(no title)'}${e.location ? ` @ ${e.location}` : ''}`) }
      },
    },
    {
      name: `connector__${id}__calendar_create_event`,
      source: `connector:${id}`,
      description: '[Google Calendar] Create an event on the primary calendar. Args: summary, startISO, endISO, description (optional).',
      parameters: { type: 'object', properties: { summary: { type: 'string' }, startISO: { type: 'string', description: 'RFC3339, e.g. 2026-10-01T15:00:00Z' }, endISO: { type: 'string' }, description: { type: 'string' } }, required: ['summary', 'startISO', 'endISO'] },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Google Calendar not connected.', isError: true }
        const res = await fetch(`${base}/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: args.summary, description: args.description || '',
            start: { dateTime: args.startISO }, end: { dateTime: args.endISO },
          }),
          signal: ctx.signal,
        })
        const text = await res.text()
        if (!res.ok) return { content: `[Google Calendar] HTTP ${res.status}: ${text.slice(0, 400)}`, isError: true }
        const created = JSON.parse(text)
        return { content: `Created "${created.summary}" — ${created.htmlLink}` }
      },
    },
  ]
}

export function googleSheetsConnectorTools(cfg: ConnectorConfig): ToolDefinition[] {
  const id = cfg.id
  return [
    {
      name: `connector__${id}__sheets_read_rows`,
      source: `connector:${id}`,
      description: '[Google Sheets] Read a range of cells. Args: spreadsheetId, range (A1 notation, e.g. "Sheet1!A1:D20").',
      parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } }, required: ['spreadsheetId', 'range'] },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Google Sheets not connected.', isError: true }
        const data = await googleGet(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(String(args.range))}`, token, ctx.signal)
        if (data.__error) return { content: `[Google Sheets] ${data.__error}`, isError: true }
        const rows = (data.values || []) as string[][]
        return { content: rows.slice(0, 40).map((r) => r.join(' | ')).join('\n') || 'Empty range.' }
      },
    },
    {
      name: `connector__${id}__sheets_write_rows`,
      source: `connector:${id}`,
      description: '[Google Sheets] Append rows below existing data. Args: spreadsheetId, range (A1 notation table start, e.g. "Sheet1!A1"), rows (array of arrays).',
      parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: {} } } }, required: ['spreadsheetId', 'range', 'rows'] },
      async handler(args, ctx) {
        const token = await ensureGoogleToken(cfg)
        if (!token) return { content: 'Google Sheets not connected.', isError: true }
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(String(args.range))}:append?valueInputOption=USER_ENTERED`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: args.rows }), signal: ctx.signal,
        })
        const text = await res.text()
        if (!res.ok) return { content: `[Google Sheets] HTTP ${res.status}: ${text.slice(0, 400)}`, isError: true }
        return { content: `Appended ${(args.rows || []).length} rows.` }
      },
    },
  ]
}

export const GOOGLE_CONNECTOR_ADAPTERS: Record<string, (cfg: ConnectorConfig) => ToolDefinition[]> = {
  google_drive: googleDriveConnectorTools,
  gmail: gmailConnectorTools,
  google_calendar: googleCalendarConnectorTools,
  google_sheets: googleSheetsConnectorTools,
}
