/**
 * OAuth provider registry for connectors.
 *
 * Two tiers:
 *  - PLATFORM_OAUTH_PROVIDERS: Loop GPT's own registered OAuth apps (Google,
 *    GitHub). Client credentials come from env vars; users just click Connect.
 *  - MARKETPLACE_OAUTH_PROVIDERS: listed in the Connectors marketplace only.
 *    They are connected with the USER'S OWN OAuth app credentials (client
 *    id/secret created in the provider's developer console) — a real,
 *    end-to-end connect flow without the platform pre-registering every app.
 */

export interface OAuthProviderSpec {
  type: string
  name: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  /** Where the docs/developer-console link points (for the marketplace UI). */
  docs?: string
  /** Provider API base for the generic adapter tools. `{instanceUrl}` tokens
   * are filled from the stored connection config at call time. */
  apiBase?: string
  /** Extra query params for the authorize request (e.g. Microsoft 'prompt'). */
  extraAuthorizeParams?: Record<string, string>
  /** Whether the token response includes an `instance_url` (Salesforce). */
  hasInstanceUrl?: boolean
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

export const PLATFORM_OAUTH_PROVIDERS: Record<string, OAuthProviderSpec> = {
  google_drive: {
    type: 'google_drive', name: 'Google Drive',
    authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN,
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
    apiBase: 'https://www.googleapis.com/drive/v3',
  },
  gmail: {
    type: 'gmail', name: 'Gmail',
    authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    apiBase: 'https://gmail.googleapis.com/gmail/v1/users/me',
  },
  google_calendar: {
    type: 'google_calendar', name: 'Google Calendar',
    authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN,
    scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'],
    apiBase: 'https://www.googleapis.com/calendar/v3/calendars/primary',
  },
  google_sheets: {
    type: 'google_sheets', name: 'Google Sheets',
    authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    apiBase: 'https://sheets.googleapis.com/v4',
  },
  github: {
    type: 'github', name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
    apiBase: 'https://api.github.com',
  },
}

/** Marketplace providers — connected with user-supplied OAuth app credentials. */
export const MARKETPLACE_OAUTH_PROVIDERS: Record<string, OAuthProviderSpec> = {
  outlook: {
    type: 'outlook', name: 'Microsoft Outlook',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Calendars.Read'],
    docs: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    apiBase: 'https://graph.microsoft.com/v1.0',
    extraAuthorizeParams: { prompt: 'consent' },
  },
  onedrive: {
    type: 'onedrive', name: 'OneDrive',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'https://graph.microsoft.com/Files.Read', 'https://graph.microsoft.com/Files.ReadWrite.All'],
    docs: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    apiBase: 'https://graph.microsoft.com/v1.0/me',
    extraAuthorizeParams: { prompt: 'consent' },
  },
  dropbox: {
    type: 'dropbox', name: 'Dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: ['files.metadata.read', 'files.content.read', 'files.content.write'],
    docs: 'https://www.dropbox.com/developers/apps',
    apiBase: 'https://api.dropboxapi.com/2',
  },
  linear: {
    type: 'linear', name: 'Linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
    docs: 'https://linear.app/settings/apps/new',
    apiBase: 'https://api.linear.app',
  },
  asana: {
    type: 'asana', name: 'Asana',
    authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    scopes: ['default', 'read', 'write'],
    docs: 'https://app.asana.com/0/my-apps',
    apiBase: 'https://app.asana.com/api/1.0',
  },
  salesforce: {
    type: 'salesforce', name: 'Salesforce',
    authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    scopes: ['full', 'refresh_token'],
    docs: 'https://developer.salesforce.com/setup/org/connectedapps',
    apiBase: '{instanceUrl}',
    hasInstanceUrl: true,
  },
  figma: {
    type: 'figma', name: 'Figma',
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://www.figma.com/api/oauth/token',
    scopes: ['file_read', 'library_assets:read', 'project_reads'],
    docs: 'https://www.figma.com/developers/api',
    apiBase: 'https://api.figma.com/v1',
  },
  zoom: {
    type: 'zoom', name: 'Zoom',
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    scopes: ['meeting:read:list:admin', 'meeting:write:admin', 'user:read:admin'],
    docs: 'https://marketplace.zoom.us/develop/create',
    apiBase: 'https://api.zoom.us/v2',
  },
}

export const ALL_OAUTH_PROVIDERS: Record<string, OAuthProviderSpec> = {
  ...PLATFORM_OAUTH_PROVIDERS,
  ...MARKETPLACE_OAUTH_PROVIDERS,
}

/** Marketplace display catalog for the Connectors tab (sorted by name). */
export const MARKETPLACE_LIST = Object.values(MARKETPLACE_OAUTH_PROVIDERS).map((p) => ({
  type: p.type,
  name: p.name,
  authorizeUrl: p.authorizeUrl,
  tokenUrl: p.tokenUrl,
  scopes: p.scopes,
  docs: p.docs || null,
}))
