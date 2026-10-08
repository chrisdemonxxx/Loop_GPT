'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  X, Wrench, Puzzle, Blocks, Cable, Brain, Palette, SunMoon,
  Settings2, UserRound, ShieldCheck, CreditCard, Clock, Terminal,
} from 'lucide-react'
import MemoryTab from './settings/MemoryTab'
import PersonalizationTab from './settings/PersonalizationTab'
import SkillsTab from './settings/SkillsTab'
import ConnectorsTab from './settings/ConnectorsTab'
import PluginsTab from './settings/PluginsTab'
import ToolsTab from './settings/ToolsTab'
import AppearanceTab from './settings/AppearanceTab'
import GeneralTab from './settings/GeneralTab'
import AccountTab from './settings/AccountTab'
import PrivacyTab from './settings/PrivacyTab'
import BillingTab from './settings/BillingTab'
import TimeFocusTab from './settings/TimeFocusTab'
import CodeTab from './settings/CodeTab'
import { pushSettingsHash, readCurrentSettingsHash, parseSettingsHash, type PrivacySub } from '../lib/settingsHash'
import { useFocusTrap } from '@loop/ui'

interface Props { onClose: () => void; initialTab?: string; workspaceId?: string | null; asPage?: boolean }

/**
 * Agent settings — one dialog, one visual system, every panel addressable by
 * URL hash (S2, blueprint §8; contract team/CONTRACT_S2_SETTINGS.md).
 *
 * Tab groups (blueprint IA): Settings — general · account · privacy · billing ·
 * tools(≡capabilities) · memory · reflect · time · code; Customize — skills ·
 * connectors · plugins · personalization · appearance.
 *
 * `#settings/<panel>` / `#settings/privacy/<sub>` drive the active panel:
 * selecting pushes a history entry (back/forward walks panels), and leaving
 * the hash (browser back, Esc, X) closes the dialog.
 */
export default function SettingsPanel({ onClose, initialTab, workspaceId, asPage = false }: Props) {
  const hashRoute = readCurrentSettingsHash()
  const [tab, setTab] = useState(initialTab || hashRoute?.panel || 'general')
  const [privacySub, setPrivacySub] = useState<PrivacySub | undefined>(hashRoute?.sub)
  // Tab-strip scroll edges (fade indicators so off-screen tabs are discoverable).
  const [tabScroll, setTabScroll] = useState({ left: false, right: false })
  const tabStripRef = useRef<HTMLDivElement>(null)
  // Measure overflow on mount + resize (NOT in a ref callback — a setState
  // there re-renders, the new ref identity re-fires, and the loop depth-caps).
  useEffect(() => {
    const el = tabStripRef.current
    if (!el) return
    const measure = () => setTabScroll({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 })
    measure()
    // jsdom (tests) has no ResizeObserver — window resize covers the rest.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Hash → panel: back/forward and typed URLs select panels; an emptied hash
  // closes the dialog (only in dialog mode). popstate AND hashchange are both
  // wired: traversing history between pushState entries (our tab pushes)
  // fires popstate; anchor/typed navigation fires hashchange. The handler is
  // idempotent, so a double fire is harmless.
  useEffect(() => {
    const onHash = () => {
      const route = readCurrentSettingsHash()
      if (route) {
        setTab(route.panel)
        setPrivacySub(route.sub)
      } else if (!asPage) {
        onClose()
      }
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [onClose, asPage])

  // Escape closes the dialog even when focus is in a field. X and backdrop
  // stay on their own click handlers.
  useEffect(() => {
    if (asPage) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Nested credential sheet, or an edit that already claimed Escape.
      if (document.querySelector('[data-settings-nested-dialog]')) return
      close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  /** Select a panel (and optional privacy sub-panel) — hash is the truth. */
  const selectTab = (id: string, sub?: PrivacySub) => {
    setTab(id)
    setPrivacySub(sub)
    pushSettingsHash(id, sub)
  }

  /** Close: with a settings hash present (dialog mode), history.back()
   *  empties it and the hashchange handler closes; otherwise close directly.
   *  asPage has no dialog semantics — X always hands off to onClose. */
  const close = () => {
    if (!asPage && parseSettingsHash(window.location.hash)) window.history.back()
    else onClose()
  }

  const dialogRef = useFocusTrap<HTMLDivElement>(!asPage)
  const groups: Array<{ label: string; tabs: Array<{ id: string; label: string; Icon: typeof Wrench }> }> = [
    {
      label: 'Settings',
      tabs: [
        { id: 'general', label: 'General', Icon: Settings2 },
        { id: 'account', label: 'Account', Icon: UserRound },
        { id: 'privacy', label: 'Privacy', Icon: ShieldCheck },
        { id: 'billing', label: 'Billing', Icon: CreditCard },
        { id: 'tools', label: 'Tools', Icon: Wrench },
        { id: 'memory', label: 'Memory', Icon: Brain },
        { id: 'time', label: 'Time and focus', Icon: Clock },
        { id: 'code', label: 'Loop Code', Icon: Terminal },
      ],
    },
    {
      label: 'Customize',
      tabs: [
        { id: 'skills', label: 'Skills', Icon: Blocks },
        { id: 'connectors', label: 'Connectors', Icon: Cable },
        { id: 'plugins', label: 'Plugins', Icon: Puzzle },
        { id: 'personalization', label: 'Personalization', Icon: Palette },
        { id: 'appearance', label: 'Appearance', Icon: SunMoon },
      ],
    },
  ]
  // The strip renders group-aware (labels inline); hash routing targets ids.

  return (
    <div className={asPage ? "min-h-screen bg-[#08080a] text-slate-200" : "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(env(safe-area-inset-bottom)+6.5rem)]"} onClick={asPage ? undefined : close}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className={asPage ? "w-full max-w-2xl mx-auto min-h-screen flex flex-col" : "glass-strong rounded-2xl w-full max-w-2xl max-h-[min(86vh,calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-7.5rem))] flex flex-col overflow-hidden shadow-panel"}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role={asPage ? "main" : "dialog"} aria-modal={asPage ? undefined : true} aria-label="Agent settings"
      >
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-gradient">Agent settings</h2>
          <button onClick={close} className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400" aria-label="Close settings"><X size={18} /></button>
        </div>
        {/* Tab strip: group labels inline (P1: groups were computed but never
            rendered) + scroll-fade edges so off-screen tabs are discoverable
            (P1: half the tabs were hidden with no indicator). */}
        <div className="relative shrink-0 border-b border-white/5">
          <div
            className="min-w-0 flex flex-nowrap items-end text-sm overflow-x-auto no-scrollbar"
            role="tablist"
            aria-label="Settings sections"
            ref={tabStripRef}
            onScroll={(e) => {
              const el = e.currentTarget
              setTabScroll({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 })
            }}
          >
            {groups.map((g, gi) => (
              <div key={g.label} className="flex flex-nowrap items-end shrink-0">
                <span className={`shrink-0 px-3 pb-2 text-[10px] uppercase tracking-widest text-slate-600 font-medium select-none ${gi > 0 ? 'border-l border-white/[0.06] ml-1 pl-3' : ''}`} aria-hidden>
                  {g.label}
                </span>
                {g.tabs.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => selectTab(id)}
                    className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 whitespace-nowrap border-b-2 transition ${
                      tab === id ? 'border-[#c96442] text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-200'
                    }`}
                  >
                    <Icon size={15} /> {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {tabScroll.left && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[#0f0f12] to-transparent" />
          )}
          {tabScroll.right && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#0f0f12] to-transparent" />
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {tab === 'general' && <GeneralTab />}
          {tab === 'account' && <AccountTab />}
          {tab === 'privacy' && <PrivacyTab sub={privacySub} onOpenSub={(sub) => selectTab('privacy', sub)} onOpenMemory={() => selectTab('memory')} />}
          {tab === 'billing' && <BillingTab />}
          {tab === 'tools' && <ToolsTab />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'time' && <TimeFocusTab />}
          {tab === 'code' && <CodeTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'connectors' && <ConnectorsTab workspaceId={workspaceId} />}
          {tab === 'plugins' && <PluginsTab />}
          {tab === 'personalization' && <PersonalizationTab />}
          {tab === 'appearance' && <AppearanceTab />}
        </div>
        {/* P5: the last row was landing under the phone's bottom toolbar
            (the sheet sat flush at 844). Same env(safe-area-inset-bottom)
            pattern as the composer footer (page.tsx:615). */}
        <div className="shrink-0 h-[env(safe-area-inset-bottom)]" aria-hidden="true" />
      </motion.div>
    </div>
  )
}