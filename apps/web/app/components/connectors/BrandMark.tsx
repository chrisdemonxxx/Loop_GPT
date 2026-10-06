/** Consistent brand tile. Known services get their color; everything else
 *  gets the same rounded monogram so the catalog never mixes styles. */
const BRANDS: Record<string, { bg: string; fg: string; mark: string }> = {
  GitHub: { bg: '#24292f', fg: '#ffffff', mark: 'GH' },
  GitLab: { bg: '#e24329', fg: '#ffffff', mark: 'GL' },
  'Google Drive': { bg: '#1a73e8', fg: '#ffffff', mark: 'GD' },
  'Google Calendar': { bg: '#1a73e8', fg: '#ffffff', mark: 'GC' },
  Gmail: { bg: '#ea4335', fg: '#ffffff', mark: 'GM' },
  'Google Sheets': { bg: '#188038', fg: '#ffffff', mark: 'GS' },
  'HTTP API': { bg: '#334155', fg: '#e2e8f0', mark: 'HT' },
  Sentry: { bg: '#362d59', fg: '#ffffff', mark: 'SE' },
  Notion: { bg: '#191919', fg: '#ffffff', mark: 'NO' },
  Todoist: { bg: '#e44332', fg: '#ffffff', mark: 'TD' },
  Slack: { bg: '#4a154b', fg: '#ffffff', mark: 'SL' },
  Discord: { bg: '#5865f2', fg: '#ffffff', mark: 'DC' },
  Jira: { bg: '#2684ff', fg: '#ffffff', mark: 'JI' },
  Figma: { bg: '#1abcfe', fg: '#0b1220', mark: 'FG' },
  Zoom: { bg: '#2d8cff', fg: '#ffffff', mark: 'ZM' },
  Dropbox: { bg: '#0061ff', fg: '#ffffff', mark: 'DB' },
  Linear: { bg: '#5e6ad2', fg: '#ffffff', mark: 'LN' },
  Asana: { bg: '#f06a6a', fg: '#ffffff', mark: 'AS' },
  Salesforce: { bg: '#00a1e0', fg: '#ffffff', mark: 'SF' },
  'Microsoft Outlook': { bg: '#0f6cbd', fg: '#ffffff', mark: 'MO' },
  OneDrive: { bg: '#094ab2', fg: '#ffffff', mark: 'OD' },
}

export function BrandMark({ name, size = 32 }: { name: string; size?: number }) {
  const known = BRANDS[name]
  const mark = known?.mark || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '•'
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg font-semibold shrink-0"
      style={{ width: size, height: size, background: known?.bg || '#27272a', color: known?.fg || '#e4e4e7', fontSize: size < 30 ? 10 : 11 }}
      aria-hidden
    >
      {mark}
    </span>
  )
}
