'use client'

import { useEffect, useState } from 'react'
import { ShieldCheck, ChevronLeft, FileText, MessageSquare, FolderOpen, Star, Brain } from 'lucide-react'
import Link from 'next/link'
import { API_URL, authHeaders } from '../../lib/api'
import { usePrefs } from '../../lib/prefs'
import type { PrivacySub } from '../../lib/settingsHash'
import { SectionHeader, Toggle, EmptyState } from '../ui/primitives'

interface Props { sub?: PrivacySub; onOpenSub: (sub: PrivacySub | undefined) => void; onOpenMemory: () => void }

/**
 * Privacy (blueprint §8): preference toggles (client prefs), policy links,
 * and the five "Your data" sub-panels. shared-chats and uploaded-files read
 * their real APIs; shared-artifacts and your-feedback render honest empty
 * states (no backend surface yet); memory-preferences hands off to Memory.
 */
export default function PrivacyTab({ sub, onOpenSub, onOpenMemory }: Props) {
  const { prefs, update } = usePrefs()

  if (sub) return <PrivacySubPanel sub={sub} onBack={() => onOpenSub(undefined)} onOpenMemory={onOpenMemory} />

  return (
    <div className="space-y-5">
      <SectionHeader title="Your data" />
      <div className="grid gap-2">
        {([
          ['shared-chats', 'Shared chats', 'Chats you have shared links to', MessageSquare],
          ['shared-artifacts', 'Shared artifacts', 'Artifacts visible through share links', FileText],
          ['uploaded-files', 'Uploaded files', 'Files you have attached to chats', FolderOpen],
          ['your-feedback', 'Your feedback', 'Ratings and comments you have sent', Star],
          ['memory-preferences', 'Memory preferences', 'What the assistant remembers about you', Brain],
        ] as Array<[PrivacySub, string, string, typeof Star]>).map(([id, label, hint, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpenSub(id)}
            className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-3.5 py-3 text-left transition hover:border-white/[0.14] hover:bg-white/[0.03]"
          >
            <span className="flex min-w-0 items-start gap-2.5 text-[13px]">
              <Icon size={14} className="mt-0.5 shrink-0 text-slate-500" />
              <span>
                <span className="block text-slate-300">{label}</span>
                <span className="block text-[11px] text-slate-500">{hint}</span>
              </span>
            </span>
            <ChevronLeft size={14} className="shrink-0 rotate-180 text-slate-500" />
          </button>
        ))}
      </div>

      <SectionHeader title="Preferences" />
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-3.5 py-3">
          <span className="min-w-0 text-[13px]">
            <span className="block text-slate-300">Help improve models</span>
            <span className="block text-[11px] text-slate-500">Allow anonymized snippets to train future Loop models</span>
          </span>
          <Toggle on={prefs.helpImproveModels} onChange={(on) => update({ helpImproveModels: on })} label="Help improve models" />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] px-3.5 py-3">
          <span className="min-w-0 text-[13px]">
            <span className="block text-slate-300">Location metadata</span>
            <span className="block text-[11px] text-slate-500">Attach coarse location to requests for local answers</span>
          </span>
          <Toggle on={prefs.locationMetadata} onChange={(on) => update({ locationMetadata: on })} label="Location metadata" />
        </div>
      </div>

      <SectionHeader title="Policies" />
      <div className="flex flex-wrap gap-2">
        {([['/privacy', 'Privacy policy'], ['/terms', 'Terms of use'], ['/acceptable-use', 'Acceptable use']] as Array<[string, string]>).map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-300 transition hover:border-white/25 hover:text-slate-100"
          >
            <ShieldCheck size={12} className="text-slate-500" /> {label}
          </Link>
        ))}
      </div>
    </div>
  )
}

/** One of the five blueprint sub-panels. */
function isSharedChat(c: { shareId?: string; shareToken?: string; shareUrl?: string; shareEnabled?: boolean; shared?: boolean; isShared?: boolean }) {
  return Boolean(c?.shareId || c?.shareToken || c?.shareUrl || c?.shareEnabled || c?.shared || c?.isShared)
}

function PrivacySubPanel({ sub, onBack, onOpenMemory }: { sub: PrivacySub; onBack: () => void; onOpenMemory: () => void }) {
  const [rows, setRows] = useState<Array<{ id?: string; title: string; hint?: string }> | null>(null)
  const [failed, setFailed] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    if (sub === 'shared-chats') {
      fetch(`${API_URL}/api/conversations`, { headers: authHeaders() })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((list) => {
          const raw = Array.isArray(list) ? list : (Array.isArray(list?.conversations) ? list.conversations : [])
          const shared = raw.filter((c: any) => isSharedChat(c))
          setRows(shared.map((c: any) => ({ id: c.id, title: c.title || 'Untitled chat', hint: c.updatedAt ? `Shared ${String(c.updatedAt).slice(0, 10)}` : undefined })))
        })
        .catch(() => { setFailed(true); setRows([]) })
    } else if (sub === 'uploaded-files') {
      fetch(`${API_URL}/api/files`, { headers: authHeaders() })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          const list = Array.isArray(d) ? d : (Array.isArray(d?.files) ? d.files : [])
          setRows(list.map((f: any) => ({ id: f.id, title: f.name || f.filename || 'File', hint: f.size != null ? `${f.size} B` : undefined })))
        })
        .catch(() => { setFailed(true); setRows([]) })
    } else if (sub === 'memory-preferences') {
      setRows([])
    } else {
      setRows([])
    }
  }, [sub])

  const TITLES: Record<PrivacySub, string> = {
    'shared-chats': 'Shared chats',
    'shared-artifacts': 'Shared artifacts',
    'uploaded-files': 'Uploaded files',
    'your-feedback': 'Your feedback',
    'memory-preferences': 'Memory preferences',
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[12px] text-slate-400 transition hover:text-slate-200"
      >
        <ChevronLeft size={14} /> Privacy
      </button>
      <SectionHeader title={TITLES[sub]} />

      {sub === 'memory-preferences' ? (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-slate-400">
            Memory is managed in one place: enable or disable generation, review every remembered item, and delete anything
            individually.
          </p>
          <button
            type="button"
            onClick={onOpenMemory}
            className="inline-flex items-center gap-2 rounded-xl border border-[#c96442]/40 bg-[#c96442]/[0.08] px-4 py-2.5 text-[13px] font-medium text-[#e79d7f] transition hover:bg-[#c96442]/[0.14]"
          >
            <Brain size={14} /> Open memory settings
          </button>
        </div>
      ) : rows === null ? (
        <p className="text-[12px] text-slate-500" role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck size={20} />}
          title={failed ? 'Could not load this list.' : 'No shared content found'}
          body={sub === 'shared-artifacts'
            ? 'Artifacts you share from a chat will be listed here.'
            : sub === 'your-feedback'
              ? 'Feedback you send on responses will appear here.'
              : undefined}
        />
      ) : (
        <ul className="divide-y divide-white/5 rounded-xl border border-white/[0.06]">
          {rows.map((r, i) => (
            <li key={r.id || i} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13px]">
              <span className="min-w-0 truncate text-slate-300">{r.title}</span>
              <span className="flex shrink-0 items-center gap-2">
                {r.hint && <span className="text-[11px] text-slate-500">{r.hint}</span>}
                {sub === 'shared-chats' && r.id && (
                  <button
                    type="button"
                    disabled={revoking === r.id}
                    onClick={async () => {
                      setRevoking(r.id!)
                      const res = await fetch(`${API_URL}/api/conversations/${r.id}/share`, { method: 'DELETE', headers: authHeaders() }).catch(() => null)
                      setRevoking(null)
                      if (res?.ok) setRows((prev) => (prev || []).filter((row) => row.id !== r.id))
                    }}
                    className="text-[11px] text-rose-300 hover:underline disabled:opacity-50"
                  >
                    {revoking === r.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}