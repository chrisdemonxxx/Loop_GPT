import { createBuffers } from './buffers.js'
import { isRiskyIntent, looksSensitive, readPageSignals } from './protocol.js'

export function createChromiumDriver(pkg) {
  const buffers = createBuffers()
  const state = { tabId: null, groupId: null, windowId: null, attached: false, runTabs: new Set() }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!state.attached || source.tabId !== state.tabId) return
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type ?? '').join(' ')
      buffers.pushConsole({ level: params.type || 'log', text: String(text).slice(0, 2000), timestamp: Date.now() })
    } else if (method === 'Runtime.exceptionThrown') {
      const detail = params.exceptionDetails || {}
      buffers.pushConsole({ level: 'error', text: String(detail.text || detail.exception?.description || 'exception').slice(0, 2000), stack: detail.exception?.description, timestamp: Date.now() })
    } else if (method === 'Network.requestWillBeSent') {
      buffers.noteRequest(params.requestId, { url: params.request?.url, method: params.request?.method, type: params.type })
    } else if (method === 'Network.responseReceived') {
      const row = { url: params.response?.url, status: params.response?.status, type: params.type, timing: params.response?.timing?.receiveHeadersEnd }
      buffers.noteRequest(params.requestId, row)
    } else if (method === 'Network.loadingFinished') {
      void captureBody(params.requestId, params.type)
    }
  })

  async function captureBody(requestId, type) {
    if (!['Document', 'XHR', 'Fetch'].includes(type)) return
    try {
      const body = await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Network.getResponseBody', { requestId })
      const text = body.base64Encoded ? atob(body.body) : body.body
      buffers.attachBody(requestId, String(text).slice(0, 65536))
    } catch { /* body expired or unavailable */ }
  }

  async function attach(tabId) {
    if (state.attached && state.tabId === tabId) return
    if (state.attached && state.tabId != null) {
      try { await chrome.debugger.detach({ tabId: state.tabId }) } catch { /* already detached */ }
    }
    await chrome.debugger.attach({ tabId }, '1.3')
    state.attached = true
    state.tabId = tabId
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {})
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {})
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {})
  }

  async function ensureTab(url) {
    if (state.tabId != null) {
      try {
        await chrome.tabs.update(state.tabId, { url, active: true })
        await waitComplete(state.tabId, pkg.pageWaitMs)
        await attach(state.tabId)
        return state.tabId
      } catch { state.tabId = null }
    }
    const tab = await chrome.tabs.create({ url, active: true })
    state.tabId = tab.id
    state.windowId = tab.windowId
    state.runTabs.add(tab.id)
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] })
      state.groupId = groupId
      await chrome.tabGroups.update(groupId, { title: 'Loop', color: 'blue', collapsed: false })
    } catch { /* tabGroups missing: the tab stays in this visible window */ }
    await waitComplete(tab.id, pkg.pageWaitMs)
    await attach(tab.id)
    return tab.id
  }

  async function signals() {
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
      const shot = await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Page.captureScreenshot', { format: 'jpeg', quality: 55 })
      return { ok: true, summary: 'Screenshot attached.', imageDataUri: `data:image/jpeg;base64,${shot.data}` }
    },
    async click(args) {
      const page = await signals()
      if (page.captcha) return handoff(page, 'captcha')
      const target = await elementPoint(state.tabId, args)
      if (!target) return { ok: false, error: 'No element to click.' }
      if (looksSensitive(target.label, args.intent, target)) {
        const allowed = await confirmRiskyAction(target.label || args.intent || 'continue')
        if (!allowed) return { ok: false, error: 'Action denied by user in browser window.' }
      }
      const button = args.button === 'right' ? 'right' : args.button === 'middle' ? 'middle' : 'left'
      await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button, clickCount: 1 })
      await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button, clickCount: 1 })
      return { ok: true, summary: `Clicked ${target.label || `${Math.round(target.x)},${Math.round(target.y)}`}.` }
    },
    async type(args) {
      const text = String(args.text || '')
      let fieldMeta = null
      if (args.selector) {
        const field = await chrome.scripting.executeScript({
          target: { tabId: state.tabId },
          func: (selector) => {
            const el = document.querySelector(selector)
            if (!el) return null
            if (el.type === 'password') return { password: true }
            el.focus()
            return {
              password: false,
              autocomplete: el.getAttribute('autocomplete') || '',
              label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 80),
            }
          },
          args: [String(args.selector)],
        })
        fieldMeta = field?.[0]?.result || null
        if (fieldMeta?.password) return handoff(await signals(), 'login')
      }
      if (looksSensitive(fieldMeta?.label || '', args.intent, fieldMeta)) {
        const allowed = await confirmRiskyAction(fieldMeta?.label || args.intent || 'enter sensitive information')
        if (!allowed) return { ok: false, error: 'Action denied by user in browser window.' }
      }
      await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Input.insertText', { text })
      return { ok: true, summary: 'Typed into the page.' }
    },
    async key(argsOrKey) {
      const key = typeof argsOrKey === 'string' ? argsOrKey : String(argsOrKey?.key || '')
      const intent = typeof argsOrKey === 'object' ? argsOrKey?.intent : undefined
      if (isRiskyIntent(intent)) {
        const allowed = await confirmRiskyAction(`${intent} (${key})`)
        if (!allowed) return { ok: false, error: 'Action denied by user in browser window.' }
      }
      await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key })
      await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key })
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
      const dy = Number(args.dy) || 0
      const dx = Number(args.dx) || 0
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        func: (x, y, selector) => {
          const el = selector ? document.querySelector(selector) : window
          ;(el || window).scrollBy(x, y)
        },
        args: [dx, dy, args.selector || ''],
      })
      return { ok: true, summary: `Scrolled by ${dx}, ${dy}.` }
    },
    async tabs(args) {
      if (args.action === 'new') return this.navigate(String(args.url || 'about:blank'))
      if (args.action === 'switch' && args.tabId) {
        await chrome.tabs.update(args.tabId, { active: true })
        state.tabId = args.tabId
        await attach(args.tabId)
        return { ok: true, summary: `Switched to tab ${args.tabId}.` }
      }
      if (args.action === 'close' && state.runTabs.has(args.tabId)) {
        await chrome.tabs.remove(args.tabId)
        state.runTabs.delete(args.tabId)
        return { ok: true, summary: `Closed tab ${args.tabId}.` }
      }
      const tabs = await chrome.tabs.query(state.windowId ? { windowId: state.windowId } : {})
      return { ok: true, summary: 'Open tabs.', tabs: tabs.filter((tab) => state.runTabs.has(tab.id)).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active })) }
    },
    async wait(args, host) {
      const ms = Math.min(Math.max(Number(args.ms) || host.pageWaitMs, 0), host.actionTimeoutMs)
      if (args.selector) {
        const started = Date.now()
        while (Date.now() - started < ms) {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: state.tabId },
            func: (selector) => !!document.querySelector(selector),
            args: [String(args.selector)],
          })
          if (result) return { ok: true, summary: `Found ${args.selector}.` }
          await delay(250)
        }
        return { ok: false, error: `Timed out waiting for ${args.selector}.` }
      }
      await delay(ms)
      return { ok: true, summary: `Waited ${ms}ms.` }
    },
    async endRun({ closeTabs }) {
      buffers.clear()
      if (state.attached && state.tabId != null) {
        try { await chrome.debugger.detach({ tabId: state.tabId }) } catch { /* already detached */ }
      }
      state.attached = false
      if (closeTabs) {
        const ids = [...state.runTabs]
        if (ids.length) {
          try { await chrome.tabs.remove(ids) } catch { /* tab already closed */ }
        }
      }
      state.tabId = null
      state.groupId = null
      state.runTabs.clear()
    },
  }
}

async function elementPoint(tabId, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, x, y) => {
      const el = selector ? document.querySelector(selector) : document.elementFromPoint(x, y)
      if (!el || !el.getBoundingClientRect) return null
      const rect = el.getBoundingClientRect()
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().slice(0, 120),
        autocomplete: (el.getAttribute && el.getAttribute('autocomplete')) || '',
      }
    },
    args: [args.selector || '', Number(args.x) || 0, Number(args.y) || 0],
  })
  return result
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
