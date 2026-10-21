"""Scripts injected into HTML previews (console + click-to-edit inspector).

Console relay (Phase 1.5) posts ``console.*`` / runtime errors to the parent.
Inspector (Phase 2.1) highlights elements on hover and posts
``{selector, snippet, loc}`` on click so the Build UI can target visual edits.
"""

from __future__ import annotations

#: Injected immediately after ``<head>`` (or prepended).
CONSOLE_BRIDGE_SCRIPT = """<script data-loopit-console-bridge>(function(){
  if (window.__loopitConsoleBridge) return;
  window.__loopitConsoleBridge = true;
  var ORIGIN = '*';
  function send(level, args, extra) {
    try {
      var text = Array.prototype.map.call(args || [], function (a) {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch (e) { return String(a); }
      }).join(' ');
      parent.postMessage({
        source: 'loopit-preview',
        type: 'console',
        level: level,
        text: text,
        href: location.href,
        extra: extra || null
      }, ORIGIN);
    } catch (e) {}
  }
  ['log','info','warn','error','debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      send(level, arguments);
      if (typeof orig === 'function') return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (ev) {
    send('error', [ev.message || 'error'], {
      filename: ev.filename, lineno: ev.lineno, colno: ev.colno
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason;
    send('error', [reason && reason.message ? reason.message : String(reason)], { kind: 'unhandledrejection' });
  });
  if (typeof window.fetch === 'function') {
    var _fetch = window.fetch;
    window.fetch = function () {
      return _fetch.apply(this, arguments).then(function (res) {
        if (!res.ok) send('error', ['fetch ' + res.status + ' ' + (res.url || '')], { kind: 'fetch', status: res.status });
        return res;
      }, function (err) {
        send('error', ['fetch failed: ' + (err && err.message ? err.message : String(err))], { kind: 'fetch' });
        throw err;
      });
    };
  }
})();</script>"""

#: Click-to-edit inspector (Phase 2.1). Enabled via parent postMessage
#: ``{source:'loopit-parent', type:'inspect-mode', enabled:true}``.
INSPECTOR_BRIDGE_SCRIPT = """<script data-loopit-inspector-bridge>(function(){
  if (window.__loopitInspectorBridge) return;
  window.__loopitInspectorBridge = true;
  var ORIGIN = '*';
  var enabled = false;
  var overlay = null;
  var lastEl = null;

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      var part = cur.tagName.toLowerCase();
      if (cur.getAttribute && cur.getAttribute('data-loc')) {
        parts.unshift(part + '[data-loc="' + cur.getAttribute('data-loc') + '"]');
        break;
      }
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === cur.tagName;
        });
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-loopit-inspector-overlay', '1');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #3b82f6;background:rgba(59,130,246,0.12);display:none;';
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function paint(el) {
    if (!el || el === document.documentElement || el === document.body) {
      ensureOverlay().style.display = 'none';
      return;
    }
    var r = el.getBoundingClientRect();
    var box = ensureOverlay();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = Math.max(r.width, 1) + 'px';
    box.style.height = Math.max(r.height, 1) + 'px';
  }

  function snippet(el) {
    try {
      var html = el.outerHTML || '';
      return html.length > 400 ? html.slice(0, 400) + '…' : html;
    } catch (e) { return ''; }
  }

  function onMove(ev) {
    if (!enabled) return;
    var el = ev.target;
    if (!el || el.getAttribute && el.getAttribute('data-loopit-inspector-overlay')) return;
    lastEl = el;
    paint(el);
  }

  function onClick(ev) {
    if (!enabled) return;
    ev.preventDefault();
    ev.stopPropagation();
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    var loc = el.getAttribute && el.getAttribute('data-loc');
    try {
      parent.postMessage({
        source: 'loopit-preview',
        type: 'inspect',
        selector: cssPath(el),
        snippet: snippet(el),
        loc: loc || null,
        tag: (el.tagName || '').toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 200),
        href: location.href
      }, ORIGIN);
    } catch (e) {}
  }

  function setEnabled(next) {
    enabled = !!next;
    if (!enabled) {
      if (overlay) overlay.style.display = 'none';
      lastEl = null;
      document.documentElement.style.cursor = '';
    } else {
      document.documentElement.style.cursor = 'crosshair';
      ensureOverlay();
    }
  }

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'loopit-parent') return;
    if (data.type === 'inspect-mode') setEnabled(!!data.enabled);
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
})();</script>"""


def _as_text(html: str | bytes) -> tuple[bytes, str] | tuple[bytes, None]:
    if isinstance(html, str):
        return html.encode("utf-8"), html
    try:
        return html, html.decode("utf-8")
    except UnicodeDecodeError:
        return html, None


def _insert_after_head(text: str, script: str) -> str:
    lower = text.lower()
    marker = "<head>"
    idx = lower.find(marker)
    if idx >= 0:
        insert_at = idx + len(marker)
        return text[:insert_at] + script + text[insert_at:]
    return script + text


def inject_console_bridge(html: str | bytes) -> bytes:
    """Insert the console bridge script into an HTML document body."""
    raw, text = _as_text(html)
    if text is None:
        return raw
    if "data-loopit-console-bridge" in text:
        return raw
    return _insert_after_head(text, CONSOLE_BRIDGE_SCRIPT).encode("utf-8")


def inject_inspector_bridge(html: str | bytes) -> bytes:
    """Insert the click-to-edit inspector script."""
    raw, text = _as_text(html)
    if text is None:
        return raw
    if "data-loopit-inspector-bridge" in text:
        return raw
    return _insert_after_head(text, INSPECTOR_BRIDGE_SCRIPT).encode("utf-8")


def inject_preview_bridges(html: str | bytes) -> bytes:
    """Inject console + inspector bridges (idempotent)."""
    out = inject_console_bridge(html)
    return inject_inspector_bridge(out)


__all__ = [
    "CONSOLE_BRIDGE_SCRIPT",
    "INSPECTOR_BRIDGE_SCRIPT",
    "inject_console_bridge",
    "inject_inspector_bridge",
    "inject_preview_bridges",
]
