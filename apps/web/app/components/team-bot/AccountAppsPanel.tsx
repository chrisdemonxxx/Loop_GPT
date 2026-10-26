'use client'

import { useEffect, useState } from 'react'

interface ConnectorType { type: string; name: string; oauth?: boolean; description?: string }
interface Configured { id: string; type: string; name: string; enabled: boolean }

export function AccountAppsPanel({
  apiUrl,
  authHeaders,
}: {
  apiUrl: string
  authHeaders: () => Record<string, string>
}) {
  const [types, setTypes] = useState<ConnectorType[]>([])
  const [configured, setConfigured] = useState<Configured[]>([])
  const [error, setError] = useState('')

  const load = () => {
    void fetch(`${apiUrl}/api/agent/connectors`, { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load apps')
        const data = await res.json()
        setTypes(data.types || [])
        setConfigured(data.configured || [])
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load apps'))
  }
  useEffect(() => { load() }, [apiUrl])

  const connectedTypes = new Set(configured.filter((row) => row.enabled).map((row) => row.type))
  const available = types.filter((row) => !connectedTypes.has(row.type))

  const disconnect = (row: Configured) => {
    void fetch(`${apiUrl}/api/agent/connectors/${row.id}`, { method: 'DELETE', headers: authHeaders() })
      .then(() => load())
  }

  const connect = (row: ConnectorType) => {
    if (row.oauth) {
      void fetch(`${apiUrl}/api/oauth-connector/init/${row.type}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectTo: '/agents' }),
      })
      return
    }
    void fetch(`${apiUrl}/api/agent/connectors`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: row.type, name: row.name, config: {}, enabled: true }),
    }).then(() => load())
  }

  return (
    <div className="space-y-3">
      <p className="text-2xs text-[var(--ink-muted)]">Apps stay on the account. A connected app is available to this bot. Skills stay on the account too.</p>
      {error && <p className="text-ui-xs text-[var(--danger)]">{error}</p>}
      <section>
        <h3 className="text-2xs uppercase tracking-widest text-[var(--ink-muted)]">Connected</h3>
        <ul className="mt-1 space-y-1">
          {configured.filter((row) => row.enabled).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 text-ui-xs">
              <span>{row.name}</span>
              <button type="button" onClick={() => disconnect(row)} className="text-[var(--ink-muted)] hover:text-[var(--danger)]">Disconnect {row.name}</button>
            </li>
          ))}
          {configured.filter((row) => row.enabled).length === 0 && <li className="text-ui-xs text-[var(--ink-muted)]">No apps connected.</li>}
        </ul>
      </section>
      <section>
        <h3 className="text-2xs uppercase tracking-widest text-[var(--ink-muted)]">Available</h3>
        <ul className="mt-1 space-y-1">
          {available.map((row) => (
            <li key={row.type} className="flex items-center justify-between gap-2 text-ui-xs">
              <span>{row.name}</span>
              <button type="button" onClick={() => connect(row)}>Connect {row.name}</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
