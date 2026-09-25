'use client'

import { useMemo, useState } from 'react'
import {
  Plus, PanelLeft, Search, MessageSquare, Edit2, Trash2, Star, Share2, Check,
  Settings, CreditCard, ShieldCheck, LogOut, ChevronDown, Sparkles, FolderOpen, Terminal,
} from 'lucide-react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { useI18n, locales, localeNames, type Locale } from '../../lib/i18n'
import type { Conversation } from './types'

interface SidebarProject { id: string; name: string; _count?: { knowledgeChunks: number; conversations: number } }
export interface ConversationSearchHit {
  conversationId: string
  title: string
  updatedAt: string
  pinned: boolean
  snippet: string
  matches: number
}

interface SidebarProps {
  conversations: Conversation[]
  currentConversationId: string | null
  user: any
  projects: SidebarProject[]
  activeProjectId: string | null
  onSelectConversation: (id: string | null) => void
  onClose: () => void
  onOpenSettings: () => void
  onLogout: () => void
  onRenameConversation: (id: string, title: string) => void
  onDeleteConversation: (id: string) => void
  /** Pin/unpin (audit §8-13). */
  onPinConversation: (id: string, pinned: boolean) => void
  /** Mint + copy a share link; resolves with the copied URL (audit §8-15). */
  onShareConversation: (id: string) => Promise<string | null>
  /** Search box (page-owned so the message-body search hook shares it). */
  searchQuery: string
  onSearchChange: (v: string) => void
  /** Server-side message-body hits for the current search (audit §8-16). */
  messageHits?: ConversationSearchHit[]
  onOpenProjects: () => void
  onSelectProject: (id: string | null) => void
  activeProjectName?: string
}

/** Bucket a conversation by recency (audit §8-13: grouped history render). */
function dateBucket(updatedAt: string): 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older' {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = new Date(updatedAt).getTime()
  if (t >= startOfToday) return 'Today'
  if (t >= startOfToday - 86_400_000) return 'Yesterday'
  if (t >= startOfToday - 7 * 86_400_000) return 'Previous 7 days'
  return 'Older'
}

const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const

export default function Sidebar({
  conversations, currentConversationId, user,
  projects, activeProjectId,
  onSelectConversation, onClose, onOpenSettings, onLogout,
  onRenameConversation, onDeleteConversation, onPinConversation, onShareConversation,
  searchQuery, onSearchChange, messageHits = [],
  onOpenProjects, onSelectProject, activeProjectName,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [sharedId, setSharedId] = useState<string | null>(null)
  const { locale, setLocale, t } = useI18n()

  const q = searchQuery.trim().toLowerCase()
  const titleMatches = useMemo(
    () => conversations.filter((c) => !q || (c.title || '').toLowerCase().includes(q)),
    [conversations, q],
  )
  /** Conversations found by message content only (not already in titleMatches). */
  const bodyOnly = useMemo(() => {
    const titleIds = new Set(titleMatches.map((c) => c.id))
    return messageHits.filter((h) => !titleIds.has(h.conversationId))
  }, [messageHits, titleMatches])

  /** Grouping by pinned, then date bucket (server already orders each list). */
  const groups = useMemo(() => {
    const pinned = titleMatches.filter((c) => c.pinned)
    const rest = titleMatches.filter((c) => !c.pinned)
    const byBucket = new Map<string, Conversation[]>()
    for (const c of rest) {
      const bucket = dateBucket(c.updatedAt)
      if (!byBucket.has(bucket)) byBucket.set(bucket, [])
      byBucket.get(bucket)!.push(c)
    }
    return [
      ...(pinned.length ? [{ label: 'Pinned' as const, items: pinned }] : []),
      ...BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({ label: b, items: byBucket.get(b)! })),
    ]
  }, [titleMatches])

  async function handleShare(id: string) {
    const url = await onShareConversation(id)
    if (url) {
      setSharedId(id)
      setTimeout(() => setSharedId((v) => (v === id ? null : v)), 1600)
    }
  }

  function commitEdit() {
    if (editingId && editingTitle.trim()) {
      onRenameConversation(editingId, editingTitle.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-[#c96442] flex items-center justify-center shrink-0">
          <Sparkles size={14} className="text-white" />
        </div>
        <span className="font-semibold text-slate-100 text-[15px]">Loop GPT</span>
        <button
          onClick={onClose}
          className="ml-auto p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-slate-300 transition"
        >
          <PanelLeft size={16} />
        </button>
      </div>

      {/* New chat + search */}
      <div className="px-3 space-y-2 shrink-0">
        <button
          onClick={() => { onSelectConversation(null); onClose() }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-white bg-[#c96442] hover:bg-[#b5593a] active:bg-[#a34e34] transition"
        >
          <Plus size={17} strokeWidth={2.5} /> {t('newSession')}
        </button>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder={t('searchChats')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label={t('searchChats')}
            className="w-full pl-7 pr-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[13px] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-white/12 focus:bg-white/[0.06] transition"
          />
        </div>
        {/* Projects — first-class section with inline recent projects */}
        <div className="rounded-lg border border-white/[0.06] overflow-hidden">
          <button
            onClick={() => setProjectsOpen((v) => !v)}
            aria-expanded={projectsOpen}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[13px] font-medium text-slate-300 hover:bg-white/[0.05] hover:text-slate-100 transition"
          >
            <span className="flex items-center gap-2"><FolderOpen size={14} /> Projects</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-[11px] text-slate-500 truncate max-w-[90px]">{activeProjectName || (projects.length > 0 ? '' : 'none')}</span>
              {projects.length > 0 && <span className="text-[11px] text-slate-500">{projects.length}</span>}
              <ChevronDown size={12} className={`text-slate-500 transition-transform shrink-0 ${projectsOpen ? 'rotate-180' : ''}`} />
            </span>
          </button>
          {projectsOpen && (
            <div className="pb-1.5 space-y-0.5">
              {projects.slice(0, 5).map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelectProject(activeProjectId === p.id ? null : p.id)}
                  className={`w-full text-left px-3 py-1.5 rounded-md text-[12.5px] flex items-center gap-2 transition ${
                    activeProjectId === p.id ? 'bg-[#c96442]/15 text-[#e79d7f]' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${activeProjectId === p.id ? 'bg-[#c96442]' : 'bg-slate-700'}`} />
                  <span className="truncate flex-1">{p.name}</span>
                  {typeof p._count?.conversations === 'number' && (
                    <span className="text-[10px] text-slate-500">{p._count.conversations}</span>
                  )}
                </button>
              ))}
              <button
                onClick={onOpenProjects}
                className="w-full text-left px-3 py-1.5 rounded-md text-[12px] text-slate-400 hover:text-slate-300 hover:bg-white/[0.04] transition flex items-center gap-1.5"
              >
                <Plus size={11} /> {projects.length === 0 ? 'Create a project' : 'Manage projects'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Conversation list — grouped: Pinned, then date buckets (audit §8-13). */}
      <div className="flex-1 overflow-y-auto py-1.5 px-2 mt-1 space-y-2 min-h-0">
        {groups.map((group) => (
          <div key={group.label} className="space-y-0.5">
            <div className="px-2.5 pt-1 pb-0.5 text-[10px] uppercase tracking-widest text-slate-500 font-medium">{group.label}</div>
            {group.items.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={currentConversationId === c.id}
                editing={editingId === c.id}
                editingTitle={editingTitle}
                shared={sharedId === c.id}
                onStartEdit={() => { setEditingId(c.id); setEditingTitle(c.title || '') }}
                onEditChange={setEditingTitle}
                onCommitEdit={commitEdit}
                onCancelEdit={() => setEditingId(null)}
                onSelect={() => { onSelectConversation(c.id); onClose() }}
                onPin={() => onPinConversation(c.id, !c.pinned)}
                onShare={() => handleShare(c.id)}
                onDelete={() => { if (confirm('Delete this session?')) onDeleteConversation(c.id) }}
              />
            ))}
          </div>
        ))}

        {/* Message-body hits (audit §8-16) — conversations whose MESSAGES
            matched but whose title did not. */}
        {bodyOnly.length > 0 && (
          <div className="space-y-0.5">
            <div className="px-2.5 pt-1 pb-0.5 text-[10px] uppercase tracking-widest text-slate-500 font-medium">Matching messages</div>
            {bodyOnly.map((h) => (
              <button
                key={h.conversationId}
                onClick={() => { onSelectConversation(h.conversationId); onClose() }}
                className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/[0.04] transition"
              >
                <span className="flex items-center gap-2 text-[13px] text-slate-300">
                  <MessageSquare size={13} className="text-slate-500 shrink-0" />
                  <span className="truncate flex-1">{h.title || 'New session'}</span>
                  <span className="text-[10px] text-slate-500 shrink-0">{h.matches}×</span>
                </span>
                <span className="block text-[11.5px] text-slate-500 truncate mt-0.5 pl-[21px]">{h.snippet}</span>
              </button>
            ))}
          </div>
        )}

        {searchQuery && titleMatches.length === 0 && bodyOnly.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-slate-400">
            No chats match &quot;{searchQuery}&quot;
          </p>
        )}
        {!searchQuery && conversations.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-slate-500">{t('noSessions')}</p>
        )}
      </div>

      {/* User menu */}
      <div className="border-t border-white/[0.05] p-2 shrink-0">
        <div className="relative">
          <button
            onClick={() => setShowUserMenu((v) => !v)}
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/[0.05] transition"
          >
            <div className="w-7 h-7 rounded-full bg-[#c96442] flex items-center justify-center text-xs font-semibold text-white shrink-0">
              {(user?.name?.[0] || user?.email?.[0] || 'U').toUpperCase()}
            </div>
            <div className="min-w-0 flex-1 text-left">
              <div className="text-[13px] text-slate-200 truncate">{user?.name || user?.email || t('anonymous')}</div>
              {user?.plan && (
                <div className="text-[11px] text-slate-400 capitalize">{user.plan} plan</div>
              )}
            </div>
            <ChevronDown
              size={14}
              className={`text-slate-400 transition-transform shrink-0 ${showUserMenu ? 'rotate-180' : ''}`}
            />
          </button>

          <AnimatePresence>
            {showUserMenu && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.12 }}
                className="absolute bottom-full mb-1 left-0 right-0 glass rounded-xl border border-white/[0.08] overflow-hidden shadow-panel z-10"
              >
                <MenuItem
                  icon={Settings}
                  label="Settings"
                  onClick={() => { setShowUserMenu(false); onOpenSettings() }}
                />
                <MenuItem
                  icon={CreditCard}
                  label="Account & billing"
                  href="/account"
                  onClick={() => setShowUserMenu(false)}
                />
                <MenuItem
                  icon={Terminal}
                  label="Developer API"
                  href="/developer"
                  onClick={() => setShowUserMenu(false)}
                />
                {user?.role === 'admin' && (
                  <MenuItem
                    icon={ShieldCheck}
                    label="Admin portal"
                    href="/admin"
                    onClick={() => setShowUserMenu(false)}
                    accent
                  />
                )}
                <div className="my-0.5 border-t border-white/[0.05]" />
                <MenuItem icon={LogOut} label={t('signOut')} onClick={onLogout} danger />
                <div className="px-3 py-2 border-t border-white/[0.06]">
                  <label className="block text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">{t('language')}</label>
                  <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as Locale)}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-[12px] text-slate-200 focus:outline-none focus:border-white/12 transition"
                  >
                    {locales.map((l) => <option key={l} value={l} className="bg-[#1c1c1f]">{localeNames[l]}</option>)}
                  </select>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

/** One conversation row: title, star/pin, share, rename, delete. */
function ConversationRow({
  conversation: c, active, editing, editingTitle, shared,
  onStartEdit, onEditChange, onCommitEdit, onCancelEdit, onSelect, onPin, onShare, onDelete,
}: {
  conversation: Conversation
  active: boolean
  editing: boolean
  editingTitle: string
  shared: boolean
  onStartEdit: () => void
  onEditChange: (v: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onSelect: () => void
  onPin: () => void
  onShare: () => void
  onDelete: () => void
}) {
  if (editing) {
    return (
      <input
        value={editingTitle}
        onChange={(e) => onEditChange(e.target.value)}
        autoFocus
        onBlur={onCommitEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') onCancelEdit()
        }}
        className="w-full m-1 px-2 py-1 text-[13px] bg-ink-800 border border-white/10 rounded text-slate-100 focus:outline-none"
      />
    )
  }
  return (
    <div className={`group rounded-lg transition-colors ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}>
      <div className="w-full text-left px-2.5 py-2 text-[13px] text-slate-300 flex items-center gap-2 cursor-pointer" onClick={onSelect}>
        <MessageSquare size={13} className="text-slate-500 shrink-0" />
        <span className="truncate flex-1">{c.title || 'New session'}</span>
        <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
          <RowAction title={c.pinned ? 'Unpin' : 'Pin to top'} onClick={onPin} className={c.pinned ? 'text-[#c96442]' : undefined}>
            <Star size={12} fill={c.pinned ? 'currentColor' : 'none'} />
          </RowAction>
          <RowAction title={shared ? 'Link copied' : 'Share public link'} onClick={onShare}>
            {shared ? <Check size={12} className="text-emerald-400" /> : <Share2 size={12} />}
          </RowAction>
          <RowAction title="Rename" onClick={onStartEdit}><Edit2 size={12} /></RowAction>
          <RowAction title="Delete" onClick={onDelete} danger><Trash2 size={12} /></RowAction>
        </span>
        {/* Pinned conversations keep a visible star outside hover too. */}
        {c.pinned && (
          <Star size={11} className="text-[#c96442] shrink-0 group-hover:hidden" fill="currentColor" aria-label="Pinned" />
        )}
      </div>
    </div>
  )
}

function RowAction({ title, onClick, children, danger, className }: {
  title: string
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
  danger?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      className={`tap-target p-1 hover:bg-white/10 rounded ${danger ? 'text-slate-400 hover:text-rose-400' : 'text-slate-400 hover:text-slate-300'} ${className || ''}`}
    >
      {children}
    </button>
  )
}

function MenuItem({
  icon: Icon, label, href, onClick, accent, danger,
}: {
  icon: any; label: string; href?: string; onClick?: () => void; accent?: boolean; danger?: boolean
}) {
  const cls = `w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.05] text-left transition text-[13px] ${
    danger ? 'text-rose-400' : accent ? 'text-[#c96442]' : 'text-slate-200'
  }`
  if (href) {
    return (
      <Link href={href} onClick={onClick} className={cls}>
        <Icon size={14} className="shrink-0" /> {label}
      </Link>
    )
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      <Icon size={14} className="shrink-0" /> {label}
    </button>
  )
}
