import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Api, defaultWorkspace, type Mode, type Overview, type Session, type Workspace } from './api'
import { errorKey, localeNames, locales, selectLocale, translations, type Copy, type CopyKey, type Locale } from './i18n'
import { Requests } from './requests'
import { ClientError, safeFilename } from './security'
import { applyEvent, type Artifact, type Reply } from './stream'

function initialLocale() {
  let saved: string | null = null
  try { saved = localStorage.getItem('loop.web.locale') } catch { /* storage may be disabled */ }
  return selectLocale(saved, navigator.languages)
}
function useRequests() {
  const [requests] = useState(() => new Requests())
  useEffect(() => {
    const cancel = () => requests.cancelAll()
    window.addEventListener('pagehide', cancel)
    return () => { window.removeEventListener('pagehide', cancel); cancel() }
  }, [requests])
  return requests
}
function Notice({ copy, message, clear }: { copy: Copy; message: CopyKey | null; clear: () => void }) {
  return message ? <div className="notice" role="alert"><span>{copy[message]}</span><button type="button" aria-label={copy.dismiss} onClick={clear}>×</button></div> : null
}

export function App({ api, configError = false }: { api: Api; configError?: boolean }) {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const [online, setOnline] = useState(navigator.onLine)
  const [session, setSession] = useState<Session | null>(null)
  const [notice, setNotice] = useState<CopyKey | null>(configError ? 'config' : null)
  const copy = translations[locale]
  useEffect(() => {
    document.documentElement.lang = locale
    try { localStorage.setItem('loop.web.locale', locale) } catch { /* optional preference only */ }
  }, [locale])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    const clear = () => setSession(null) // Also clears a restored back/forward-cache page.
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    window.addEventListener('pagehide', clear)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      window.removeEventListener('pagehide', clear)
    }
  }, [])
  return <>
    <a className="skip" href="#main">{copy.skip}</a>
    <header className="topbar">
      <a className="brand" href="#main" aria-label="Loop GPT"><img src="/icon.svg" alt="" width="38" height="38" />Loop GPT</a>
      <label className="locale"><span>{copy.language}</span><select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
        {locales.map((value) => <option key={value} value={value}>{localeNames[value]}</option>)}
      </select></label>
      {session && <button type="button" onClick={() => { setSession(null); setNotice(null) }}>{copy.logout}</button>}
    </header>
    <div className="connection" role="status">{online ? copy.foundation : copy.offline}</div>
    <Notice copy={copy} message={notice} clear={() => setNotice(null)} />
    {session ? <WorkspaceClient key={session.token} api={api} session={session} copy={copy} locale={locale} online={online}
      expire={() => { setSession((current) => current === session ? null : current); setNotice('expired') }} />
      : <Login api={api} copy={copy} disabled={!online || configError} onLogin={(value) => { setNotice(null); setSession(value) }} />}
  </>
}

function Login({ api, copy, disabled, onLogin }: { api: Api; copy: Copy; disabled: boolean; onLogin: (session: Session) => void }) {
  const requests = useRequests()
  const pending = useRef<ReturnType<Requests['start']> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CopyKey | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || pending.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    const email = String(data.get('email') ?? '').trim()
    const password = String(data.get('password') ?? '')
    form.reset()
    const ticket = requests.start()
    pending.current = ticket; setBusy(true); setError(null)
    try {
      const session = await api.login(email, password, ticket.signal)
      if (ticket.current()) onLogin(session)
    } catch (error) {
      if (pending.current === ticket && (!ticket.signal.aborted || ticket.signal.reason?.name === 'TimeoutError')) setError(errorKey(error, true))
    } finally {
      ticket.finish()
      if (pending.current === ticket) { pending.current = null; setBusy(false) }
    }
  }
  useEffect(() => {
    const clear = () => { requests.cancelAll(); pending.current = null; setBusy(false) }
    window.addEventListener('pagehide', clear)
    return () => window.removeEventListener('pagehide', clear)
  }, [requests])
  return <main id="main" className="login-layout" tabIndex={-1}>
    <section className="welcome"><p className="eyebrow">Loop GPT</p><h1>{copy.welcome}</h1><p>{copy.intro}</p></section>
    <form className="panel login" onSubmit={(event) => { void submit(event) }} aria-busy={busy}>
      <h2>{copy.login}</h2>
      <label>{copy.email}<input name="email" type="email" autoComplete="username" required maxLength={254} disabled={busy} /></label>
      <label>{copy.password}<input name="password" type="password" autoComplete="current-password" required maxLength={1024} disabled={busy} /></label>
      <Notice copy={copy} message={error} clear={() => setError(null)} />
      <button className="primary" disabled={disabled || busy}>{busy ? copy.signingIn : copy.login}</button>
      <p className="muted">{copy.memory}</p>
    </form>
  </main>
}

interface Message extends Reply { id: number; role: 'user' | 'assistant' }
function WorkspaceClient({ api, session, copy, locale, online, expire }: {
  api: Api; session: Session; copy: Copy; locale: Locale; online: boolean; expire: () => void
}) {
  const requests = useRequests()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspace, setWorkspace] = useState('')
  const [loading, setLoading] = useState(true)
  const [conversation, setConversation] = useState('new')
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<Mode>('chat')
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState<CopyKey>('ready')
  const [error, setError] = useState<CopyKey | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [overviewBusy, setOverviewBusy] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const streamRef = useRef<ReturnType<Requests['start']> | null>(null)
  const sequence = useRef(0)
  const bottom = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const log = useRef<HTMLDivElement>(null)
  const objectUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const activeWorkspace = workspaces.find((item) => item.id === workspace)

  function report(error: unknown) {
    if (error instanceof ClientError && error.status === 401) { requests.cancelAll(); expire(); return }
    setError(errorKey(error))
  }
  function stop() {
    streamRef.current?.abort(); streamRef.current = null
    setStreaming(false); setStatus('stopped')
  }
  function clearConversation() {
    stop(); setMessages([]); setDraft(''); setConversation('new'); setStatus('ready'); setError(null)
  }
  async function loadWorkspaces(provision = false) {
    requests.cancelAll(); clearConversation(); setWorkspaces([]); setWorkspace(''); setLoading(true)
    setOverviewBusy(false); setDownloadBusy(false)
    const ticket = requests.start()
    try {
      if (provision) await api.provisionPersonal(session.token, ticket.signal)
      const rows = await api.workspaces(session.token, ticket.signal)
      if (ticket.current()) { setWorkspaces(rows); setWorkspace(defaultWorkspace(rows)) }
    } catch (error) { if (ticket.current() || ticket.signal.reason?.name === 'TimeoutError') report(error) }
    finally { if (ticket.current() || ticket.signal.reason?.name === 'TimeoutError') setLoading(false); ticket.finish() }
  }
  useEffect(() => { void loadWorkspaces() }, [])
  useEffect(() => {
    if (!online) {
      requests.cancelAll(); streamRef.current = null; setStreaming(false); setLoading(false)
      setOverviewBusy(false); setDownloadBusy(false); setStatus('offline')
    }
  }, [online, requests])
  useEffect(() => () => {
    for (const [url, timer] of objectUrls.current) { clearTimeout(timer); URL.revokeObjectURL(url) }
    objectUrls.current.clear()
  }, [])
  useEffect(() => {
    if (nearBottom.current) bottom.current?.scrollIntoView?.({ block: 'nearest' })
  }, [messages])

  async function send(event: FormEvent) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || content.length > 100_000 || !online || loading || !activeWorkspace || activeWorkspace.role === 'viewer' || streamRef.current) return
    const ticket = requests.start(10 * 60_000)
    streamRef.current = ticket
    setStreaming(true); setStatus('working'); setError(null); setDraft('')
    const userId = ++sequence.current
    const assistantId = ++sequence.current
    let reply: Reply = { content: '', artifacts: [] }
    setMessages((items) => [...items, { id: userId, role: 'user', content, artifacts: [] }, { id: assistantId, role: 'assistant', ...reply }])
    nearBottom.current = true
    try {
      await api.stream(session.token, conversation, workspace, content, mode, ticket.signal, (event) => {
        if (!ticket.current()) return
        if (event.type === 'conversation') setConversation(event.id)
        if (event.type === 'warming') setStatus('warming')
        if (event.type === 'tool_call' || event.type === 'tool_result') setStatus('tool')
        if (event.type === 'delta') setStatus('working')
        reply = applyEvent(reply, event)
        setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, ...reply } : item))
      })
      if (ticket.current()) setStatus('complete')
    } catch (error) {
      if (ticket.current() || ticket.signal.reason?.name === 'TimeoutError') { setStatus('failed'); report(error) }
    } finally {
      if (streamRef.current === ticket) { streamRef.current = null; setStreaming(false) }
      ticket.finish()
    }
  }
  async function download(artifact: Artifact) {
    if (!online || downloadBusy) return
    const ticket = requests.start(60_000)
    setDownloadBusy(true); setError(null)
    try {
      const blob = await api.download(session.token, artifact.id, ticket.signal)
      if (!ticket.current()) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = safeFilename(artifact.name); anchor.rel = 'noopener'
      document.body.append(anchor); anchor.click(); anchor.remove()
      const timer = setTimeout(() => { URL.revokeObjectURL(url); objectUrls.current.delete(url) }, 30_000)
      objectUrls.current.set(url, timer)
      setStatus('downloaded')
    } catch (error) { if (ticket.current() || ticket.signal.reason?.name === 'TimeoutError') report(error) }
    finally { if (ticket.current() || ticket.signal.reason?.name === 'TimeoutError') setDownloadBusy(false); ticket.finish() }
  }
  async function loadOverview() {
    if (overviewBusy || !online) return
    const ticket = requests.start()
    setOverviewBusy(true); setError(null)
    try {
      const result = await api.overview(session.token, ticket.signal)
      if (ticket.current()) setOverview(result)
    } catch (error) { if (ticket.current() || ticket.signal.reason?.name === 'TimeoutError') report(error) }
    finally { if (ticket.current() || ticket.signal.reason?.name === 'TimeoutError') setOverviewBusy(false); ticket.finish() }
  }
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' })
  const number = new Intl.NumberFormat(locale)
  return <main id="main" className="workspace-layout" tabIndex={-1}>
    <aside className="panel sidebar" aria-label={copy.workspace}>
      <p className="eyebrow">{session.name}</p>
      <label>{copy.workspace}<select value={workspace} disabled={loading || !workspaces.length}
        onChange={(event) => { requests.cancelAll(); setDownloadBusy(false); setOverviewBusy(false); clearConversation(); setWorkspace(event.target.value) }}>
        {!workspace && <option value="">{copy.selectWorkspace}</option>}
        {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {copy[item.role]}</option>)}
      </select></label>
      <button type="button" disabled={loading || !online} onClick={() => { void loadWorkspaces() }}>{loading ? copy.loading : copy.refresh}</button>
      {!loading && !workspaces.length && <p>{copy.emptyWorkspaces}</p>}
      {!loading && !workspaces.some((item) => item.personal) && <button type="button" disabled={!online} onClick={() => { void loadWorkspaces(true) }}>{copy.personal}</button>}
      <button type="button" disabled={!workspace} onClick={clearConversation}>{copy.newChat}</button>
      <p className="muted">{copy.sessionChat}</p>
      <details className="developer"><summary>{copy.developer}</summary><p className="muted">{copy.usageNote}</p>
        <button type="button" disabled={!online || overviewBusy} onClick={() => { void loadOverview() }}>{overviewBusy ? copy.loading : copy.loadUsage}</button>
        {overview && <dl><dt>{copy.balance}</dt><dd>{money.format(overview.balance)}</dd><dt>{copy.requests}</dt><dd>{number.format(overview.requests)}</dd>
          <dt>{copy.spend}</dt><dd>{money.format(overview.spend)}</dd><dt>{copy.tokens}</dt><dd>{number.format(overview.tokens)}</dd></dl>}
      </details>
    </aside>
    <section className="panel conversation" aria-labelledby="conversation-heading">
      <div className="conversation-header"><h1 id="conversation-heading">{copy.conversation}</h1><span className="badge">{copy[mode]}</span></div>
      <Notice copy={copy} message={error} clear={() => setError(null)} />
      <div className="messages" ref={log} role="region" aria-label={copy.conversation} tabIndex={0} onScroll={() => {
        const element = log.current
        if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
      }}>
        {!messages.length && <div className="empty"><div className="spark" aria-hidden="true">✳</div><h2>{copy.emptyChat}</h2><p>{copy.emptyHint}</p></div>}
        {messages.map((item) => <article className={`message ${item.role}`} key={item.id} aria-label={item.role === 'user' ? copy.you : copy.assistant}>
          <h2>{item.role === 'user' ? copy.you : copy.assistant}</h2><div className="message-text">{item.content}</div>
          {item.artifacts.map((artifact) => <button type="button" key={artifact.id} disabled={!online || downloadBusy}
            onClick={() => { void download(artifact) }}>{downloadBusy ? copy.downloading : copy.download}: {artifact.name}</button>)}
        </article>)}<div ref={bottom} />
      </div>
      <p className="run-status" role="status" aria-live="polite">{copy[status]}</p>
      <form className="composer" onSubmit={(event) => { void send(event) }}>
        <label className="mode">{copy.mode}<select value={mode} disabled={streaming} onChange={(event) => setMode(event.target.value as Mode)}>
          <option value="chat">{copy.chat}</option><option value="agent">{copy.agent}</option><option value="research">{copy.research}</option>
        </select></label>
        <p className="muted" id="mode-hint">{copy[mode === 'chat' ? 'chatHint' : mode === 'agent' ? 'agentHint' : 'researchHint']}</p>
        {activeWorkspace?.role === 'viewer' && <p>{copy.viewerNote}</p>}
        <label>{copy.message}<textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={copy.placeholder}
          rows={3} maxLength={100_000} aria-describedby="mode-hint message-limit" disabled={streaming || !workspace || activeWorkspace?.role === 'viewer'} /></label>
        <div className="composer-actions"><small id="message-limit">{copy.limit}</small>
          {streaming ? <button type="button" className="primary" onClick={stop}>{copy.stop}</button>
            : <button className="primary" disabled={!online || loading || !workspace || activeWorkspace?.role === 'viewer' || !draft.trim()}>{copy.send}</button>}
        </div>
      </form>
      <p className="privacy muted">{copy.privacy}</p>
    </section>
  </main>
}
