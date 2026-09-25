// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App'
import { Api, type Workspace } from '../src/api'
import { ClientError } from '../src/security'
import type { StreamEvent } from '../src/stream'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let container: HTMLDivElement
let root: Root
let api: Api
const workspaces: Workspace[] = [
  { id: 'personal', name: 'Personal', role: 'owner', personal: true },
  { id: 'team', name: 'Team', role: 'editor', personal: false },
  { id: 'read', name: 'Read only', role: 'viewer', personal: false },
]
function button(label: string) {
  const result = [...container.querySelectorAll('button')].find((element) => element.textContent === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function click(label: string) { await act(async () => button(label).click()) }
async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function login() {
  await change(container.querySelector('[name=email]')!, 'user@example.com')
  await change(container.querySelector('[name=password]')!, 'test-password')
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
async function send(content = 'Hello') {
  await change(container.querySelector('textarea')!, content)
  await act(async () => container.querySelector('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('loop.web.locale', 'en-US')
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  api = new Api('', vi.fn<typeof fetch>().mockRejectedValue(new Error('No network allowed')))
  vi.spyOn(api, 'login').mockResolvedValue({ token: 'in-memory-test-jwt', name: 'Test user' })
  vi.spyOn(api, 'workspaces').mockResolvedValue(workspaces)
  await act(async () => root.render(<App api={api} />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
describe('owned client lifecycle', () => {
  it('logs in, selects personal workspace, stores only locale, clears on logout', async () => {
    await login()
    expect(container.querySelector<HTMLSelectElement>('.sidebar select')!.value).toBe('personal')
    expect([...Object.keys(localStorage)]).toEqual(['loop.web.locale'])
    expect(sessionStorage.length).toBe(0)
    await click('Sign out')
    expect(container.querySelector('[name=password]')).not.toBeNull()
    expect(container.textContent).not.toContain('Test user')
  })
  it('streams escaped text, uses final replacement and returned conversation ID on continuation', async () => {
    const stream = vi.spyOn(api, 'stream').mockImplementation(async (_token, _id, _workspace, _content, _mode, _signal, emit) => {
      emit({ type: 'conversation', id: 'server-conversation' })
      emit({ type: 'delta', step: 0, text: 'interim' })
      emit({ type: 'final', content: '<img src=x onerror=alert(1)> [bad](javascript:alert(1))' })
      emit({ type: 'done' })
    })
    await login(); await send()
    expect(container.querySelector('.assistant .message-text')!.textContent).toBe('<img src=x onerror=alert(1)> [bad](javascript:alert(1))')
    expect(container.querySelector('.assistant img, .assistant a, .assistant script')).toBeNull()
    await send('Continue')
    expect(stream.mock.calls[1][1]).toBe('server-conversation')
    expect(stream.mock.calls[1][2]).toBe('personal')
  })
  it('stop aborts and ignores late deltas; switching workspace clears previous content', async () => {
    let emit!: (event: StreamEvent) => void
    let signal!: AbortSignal
    let finish!: () => void
    vi.spyOn(api, 'stream').mockImplementation(async (_token, _id, _workspace, _content, _mode, incomingSignal, incomingEmit) => {
      signal = incomingSignal; emit = incomingEmit
      emit({ type: 'delta', step: 0, text: 'partial' })
      await new Promise<void>((resolve) => { finish = resolve })
    })
    await login(); await send(); await click('Stop response')
    expect(signal.aborted).toBe(true)
    await act(async () => { emit({ type: 'final', content: 'late secret' }); finish() })
    expect(container.textContent).not.toContain('late secret')
    expect(container.textContent).toContain('partial')
    await change(container.querySelector('.sidebar select')!, 'team')
    expect(container.textContent).not.toContain('partial')
    expect(container.querySelector('textarea')!.value).toBe('')
  })
  it('workspace switch aborts an active run and rejects old workspace events', async () => {
    let emit!: (event: StreamEvent) => void
    let signal!: AbortSignal
    let finish!: () => void
    const stream = vi.spyOn(api, 'stream').mockImplementation(async (_t, _i, _w, _c, _m, s, e) => {
      signal = s; emit = e
      await new Promise<void>((resolve) => { finish = resolve })
    })
    await login(); await send()
    await change(container.querySelector('.sidebar select')!, 'team')
    expect(signal.aborted).toBe(true)
    await act(async () => { emit({ type: 'conversation', id: 'wrong-conversation' }); emit({ type: 'delta', step: 0, text: 'wrong workspace' }); finish() })
    expect(container.textContent).not.toContain('wrong workspace')
    stream.mockResolvedValue()
    await send('Team message')
    expect(stream.mock.calls[1][1]).toBe('new')
    expect(stream.mock.calls[1][2]).toBe('team')
  })
  it('logout cancels in-flight requests and stale 401 cannot sign out the next session', async () => {
    let reject!: (error: unknown) => void
    let signal!: AbortSignal
    vi.spyOn(api, 'stream').mockImplementation(async (_t, _i, _w, _c, _m, s) => {
      signal = s
      await new Promise<void>((_resolve, fail) => { reject = fail })
    })
    await login(); await send(); await click('Sign out')
    expect(signal.aborted).toBe(true)
    await login()
    await act(async () => reject(new ClientError('http', 401)))
    expect(container.querySelector('[name=password]')).toBeNull()
    expect(container.textContent).toContain('Test user')
  })
  it('a current 401 clears session and messages', async () => {
    vi.spyOn(api, 'stream').mockRejectedValue(new ClientError('http', 401))
    await login(); await send('private turn')
    expect(container.textContent).toContain('Your session expired')
    expect(container.textContent).not.toContain('private turn')
    expect(container.querySelector('[name=password]')).not.toBeNull()
  })
  it('viewer workspaces disable sending and do not contact the executor', async () => {
    const stream = vi.spyOn(api, 'stream')
    await login()
    await change(container.querySelector('.sidebar select')!, 'read')
    expect(container.querySelector('textarea')!.disabled).toBe(true)
    expect(button('Send message').disabled).toBe(true)
    expect(stream).not.toHaveBeenCalled()
  })
  it('changes all interface copy and document language to French', async () => {
    await change(container.querySelector('.locale select')!, 'fr-CA')
    expect(document.documentElement.lang).toBe('fr-CA')
    expect(container.textContent).toContain('Se connecter')
    expect(localStorage.getItem('loop.web.locale')).toBe('fr-CA')
  })
  it('pagehide clears a session and rejects a late login completion', async () => {
    await login()
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(container.querySelector('[name=password]')).not.toBeNull()
    let finish!: (value: { token: string; name: string }) => void
    vi.mocked(api.login).mockImplementation(async () => new Promise((resolve) => { finish = resolve }))
    await login()
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    await act(async () => finish({ token: 'late-token', name: 'late-user' }))
    expect(container.textContent).not.toContain('late-user')
  })
})
