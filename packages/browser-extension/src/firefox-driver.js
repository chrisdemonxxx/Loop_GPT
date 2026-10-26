import { createBuffers } from './buffers.js'
import { isRiskyIntent, looksSensitive, readPageSignals } from './protocol.js'

const CONSOLE_INSTALL = () => {
  if (window.__loopConsoleInstalled) return
  window.__loopConsoleInstalled = true
  window.__loopConsole = []
  const levels = ['log', 'debug', 'info', 'warn', 'error', 'trace']
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      window.__loopConsole.push({ level, text: args.map((arg) => String(arg)).join(' ').slice(0, 2000), timestamp: Date.now() })
      original(...args)
    }
  }
  window.addEventListener('error', (event) => {
    window.__loopConsole.push({ level: 'error', text: String(event.message || 'error'), stack: event.error && event.error.stack, timestamp: Date.now() })
  })
  window.addEventListener('unhandledrejection', (event) => {
    window.__loopConsole.push({ level: 'error', text: String(event.reason || 'unhandledrejection'), timestamp: Date.now() })
  })
}

export function createFirefoxDriver(pkg) {
  const buffers = createBuffers()
  const state = { tabId: null, windowId: null, runTabs: new Set(), tracking: false }

  function track(tabId, on) {
    state.tracking = on
    state.tabId = tabId
  }

  if (chrome.webRequest?.onCompleted) {
    chrome.webRequest.onCompleted.addListener((details) => {
      if (!state.tracking || details.tabId !== state.tabId) return
      buffers.noteRequest(details.requestId, {
        url: details.url,
        method: details.method,
        status: details.statusCode,
        type: details.type,
        timing: details.timeStamp,
      })
    }, { urls: ['<all_urls>'] })
  }
  if (chrome.webRequest?.filterResponseData && chrome.webRequest.onBeforeRequest) {
    try {
      chrome.webRequest.onBeforeRequest.addListener((details) => {
        if (!state.tracking || details.tabId !== state.tabId) return
        if (!['main_frame', 'xmlhttprequest'].includes(details.type)) return
        const filter = chrome.webRequest.filterResponseData(details.requestId)
        const chunks = []
        filter.ondata = (event) => {
          chunks.push(new Uint8Array(event.data))
          filter.write(event.data)
        }
        filter.onstop = () => {
          filter.close()
          let size = 0
          for (const chunk of chunks) size += chunk.length
          const merged = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
          buffers.attachBody(details.requestId, new TextDecoder().decode(merged).slice(0, 65536))
        }
        filter.onerror = () => { try { filter.close() } catch { /* closed */ } }
      }, { urls: ['<all_urls>'] }, ['blocking'])
    } catch { /* filterResponseData is Firefox-only */ }
  }

  async function injectConsole(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: CONSOLE_INSTALL, world: 'MAIN', injectImmediately: true })
    } catch {
      try { await chrome.scripting.executeScript({ target: { tabId }, func: CONSOLE_INSTALL }) } catch { /* page not ready */ }
    }
  }

  async function pullConsole(tabId) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const lines = window.__loopConsole || []
          window.__loopConsole = []
          return lines
        },
      })
      for (const line of result || []) buffers.pushConsole(line)
    } catch { /* MAIN world unavailable on this page */ }
  }

  async function ensureTab(url) {
    if (state.tabId != null) {
      try {
        await chrome.tabs.update(state.tabId, { url, active: true })
        await waitComplete(state.tabId, pkg.pageWaitMs)
        await injectConsole(state.tabId)
        track(state.tabId, true)
        return state.tabId
      } catch { state.tabId = null }
    }
    let tab
    try {
      const win = await chrome.windows.create({ url, focused: true, type: 'normal' })
      tab = win.tabs && win.tabs[0]
      state.windowId = win.id
    } catch {
      tab = await chrome.tabs.create({ url, active: true })
      state.windowId = tab.windowId
    }
    state.tabId = tab.id
    state.runTabs.add(tab.id)
    await waitComplete(tab.id, pkg.pageWaitMs)
    await injectConsole(tab.id)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { document.title = `Loop — ${document.title}` },
      })
    } catch { /* title is cosmetic */ }
    track(tab.id, true)
    return tab.id
  }

  async function signals() {
    await pullConsole(state.tabId)
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: readPageSignals })
    return result || {}
  }

  function handoff(page, reason) {
    const kind = reason === 'captcha' ? 'captcha' : reason === 'confirm' ? 'confirm' : 'login'
    return {
      ok: true,
      needsYou: {
        reason: kind,
        message: 'Continue in your browser',
        ...(page?.captchaInfo ? { captchaInfo: page.captchaInfo } : {}),
      },
      ...(page?.captchaInfo ? { captchaInfo: page.captchaInfo } : {}),
      url: page?.url,
      title: page?.title,
      text: page?.text,
      snapshot: page?.snapshot,
      summary: page?.title || 'Paused for you',
    }
  }

  async function confirmRiskyAction(description) {
    const [{ result: allowed }] = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: (label) => window.confirm(`Loop is about to ${label} in this window. Continue?`),
      args: [String(description || 'continue').slice(0, 80)],
    })
    return Boolean(allowed)
  }

  return {
    takeDelta: () => buffers.takeDelta(),
    consolePage(page, pageSize) {
      const body = buffers.pageConsole(page, pageSize)
      return { ok: true, summary: `Console page ${body.page}.`, ...body }
    },
    networkPage(page, pageSize) {
      const body = buffers.pageNetwork(page, pageSize)
      return { ok: true, summary: `Network page ${body.page}.`, ...body }
    },
    async navigate(url) {
      await ensureTab(url)
      const page = await signals()
      if (page.captcha) return handoff(page, 'captcha')
      if (page.password) return handoff(page, 'login')
      return { ok: true, url: page.url, title: page.title, text: page.text, snapshot: page.snapshot, summary: page.title || url }
    },
    async snapshot() {
      const page = await signals()
      if (page.captcha) return handoff(page, 'captcha')
      if (page.password) return handoff(page, 'login')
      return { ok: true, url: page.url, title: page.title, text: page.text, snapshot: page.snapshot, summary: page.snapshot || page.title || 'Snapshot' }
    },
    async screenshot() {
      const tab = await chrome.tabs.get(state.tabId)
      const win = await chrome.windows.get(tab.windowId)
      const image = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 55 })
      return { ok: true, summary: 'Screenshot attached.', imageDataUri: image }
    },
    async click(args) {
      const page = await signals()
      if (page.captcha) return handoff(page, 'captcha')
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (selector, x, y) => {
          const el = selector ? document.querySelector(selector) : document.elementFromPoint(x, y)
          if (!el) return null
          return {
            label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().slice(0, 120),
            autocomplete: (el.getAttribute && el.getAttribute('autocomplete')) || '',
          }
        },
        args: [args.selector || '', Number(args.x) || 0, Number(args.y) || 0],
      })
      if (!result) return { ok: false, error: 'No element to click.' }
      if (looksSensitive(result.label, args.intent, result)) {
        const allowed = await confirmRiskyAction(result.label || args.intent || 'continue')
        if (!allowed) return { ok: false, error: 'Action denied by user in browser window.' }
      }
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (selector, x, y) => {
          const el = selector ? document.querySelector(selector) : document.elementFromPoint(x, y)
          if (el) el.click()
        },
        args: [args.selector || '', Number(args.x) || 0, Number(args.y) || 0],
      })
      return { ok: true, summary: `Clicked ${result.label || 'the page'}.` }
    },
    async type(args) {
      const [{ result: fieldMeta }] = await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (selector) => {
          const el = selector ? document.querySelector(selector) : document.activeElement
          if (!el) return { missing: true }
          if (el.type === 'password') return { password: true }
          return {
            password: false,
            autocomplete: (el.getAttribute && el.getAttribute('autocomplete')) || '',
            label: ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name'))) || '').trim().slice(0, 80),
          }
        },
        args: [args.selector || ''],
      })
      if (fieldMeta?.missing) return { ok: false, error: 'No element to type into.' }
      if (fieldMeta?.password) return handoff(await signals(), 'login')
      if (looksSensitive(fieldMeta?.label || '', args.intent, fieldMeta)) {
        const allowed = await confirmRiskyAction(fieldMeta?.label || args.intent || 'enter sensitive information')
        if (!allowed) return { ok: false, error: 'Action denied by user in browser window.' }
      }
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (selector, text) => {
          const el = selector ? document.querySelector(selector) : document.activeElement
          if (!el) return
          el.focus()
          el.value = `${el.value || ''}${text}`
          el.dispatchEvent(new Event('input', { bubbles: true }))
        },
        args: [args.selector || '', String(args.text || '')],
      })
      return { ok: true, summary: 'Typed into the page.' }
    },
    async key(argsOrKey) {
      const key = typeof argsOrKey === 'string' ? argsOrKey : String(argsOrKey?.key || '')
      const intent = typeof argsOrKey === 'object' ? argsOrKey?.intent : undefined
      if (isRiskyIntent(intent)) {
        const allowed = await confirmRiskyAction(`${intent} (${key})`)
        if (!allowed) return { ok: false, error: 'Action denied by user in browser window.' }
      }
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (name) => document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })),
        args: [key],
      })
      return { ok: true, summary: `Pressed ${key}.` }
    },
    async injectCaptcha(args) {
      const token = String(args?.token || '')
      if (!token) return { ok: false, error: 'Missing captcha token.' }
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (solvedToken) => {
          const selectors = ['textarea[name="g-recaptcha-response"]', 'textarea[name="h-captcha-response"]', '#g-recaptcha-response']
          for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
              el.value = solvedToken
              el.innerHTML = solvedToken
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
            }
          }
          const widget = document.querySelector('[data-callback]')
          const cbName = widget && widget.getAttribute('data-callback')
          if (cbName && typeof window[cbName] === 'function') {
            try { window[cbName](solvedToken) } catch { /* ignore callback failure */ }
          }
        },
        args: [token],
      })
      const page = await signals()
      return { ok: true, url: page.url, title: page.title, text: page.text, snapshot: page.snapshot, summary: page.title || 'Captcha solved.' }
    },
    async scroll(args) {
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (x, y, selector) => {
          const el = selector ? document.querySelector(selector) : window
          ;(el || window).scrollBy(x, y)
        },
        args: [Number(args.dx) || 0, Number(args.dy) || 0, args.selector || ''],
      })
      return { ok: true, summary: 'Scrolled.' }
    },
    async tabs(args) {
      if (args.action === 'new') return this.navigate(String(args.url || 'about:blank'))
      if (args.action === 'close' && state.runTabs.has(args.tabId)) {
        await chrome.tabs.remove(args.tabId)
        state.runTabs.delete(args.tabId)
        return { ok: true, summary: `Closed tab ${args.tabId}.` }
      }
      if (args.action === 'switch' && args.tabId) {
        await chrome.tabs.update(args.tabId, { active: true })
        state.tabId = args.tabId
        await injectConsole(args.tabId)
        return { ok: true, summary: `Switched to tab ${args.tabId}.` }
      }
      const tabs = await chrome.tabs.query(state.windowId ? { windowId: state.windowId } : {})
      return { ok: true, summary: 'Open tabs.', tabs: tabs.filter((tab) => state.runTabs.has(tab.id)).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active })) }
    },
    async wait(args, host) {
      const ms = Math.min(Math.max(Number(args.ms) || host.pageWaitMs, 0), host.actionTimeoutMs)
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { ok: true, summary: `Waited ${ms}ms.` }
    },
    async endRun({ closeTabs }) {
      await pullConsole(state.tabId).catch(() => {})
      state.tracking = false
      buffers.clear()
      if (closeTabs) {
        const ids = [...state.runTabs]
        if (ids.length) {
          try { await chrome.tabs.remove(ids) } catch { /* already closed */ }
        }
      }
      state.tabId = null
      state.windowId = null
      state.runTabs.clear()
    },
  }
}

function waitComplete(tabId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout)
    function done() {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve()
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') done()
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
}
