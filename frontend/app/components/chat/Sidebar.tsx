'use client'

import { useState } from 'react'
import {
  Plus, PanelLeft, Search, MessageSquare, Edit2, Trash2,
  Settings, CreditCard, ShieldCheck, LogOut, ChevronDown, Sparkles,
} from 'lucide-react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'

interface Conversation { id: string; title: string; createdAt: string; updatedAt: string }

interface SidebarProps {
  conversations: Conversation[]
  currentConversationId: string | null
  user: any
  onSelectConversation: (id: string | null) => void
  onClose: () => void
  onOpenSettings: () => void
  onLogout: () => void
  onRenameConversation: (id: string, title: string) => void
  onDeleteConversation: (id: string) => void
}

export default function Sidebar({
  conversations, currentConversationId, user,
  onSelectConversation, onClose, onOpenSettings, onLogout,
  onRenameConversation, onDeleteConversation,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [showUserMenu, setShowUserMenu] = useState(false)

  const filtered = conversations.filter((c) =>
    !searchQuery || (c.title || '').toLowerCase().includes(searchQuery.toLowerCase())
  )

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
          className="ml-auto p-1.5 rounded-lg hover:bg-white/5 text-slate-500 hover:text-slate-300 transition"
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
          <Plus size={17} strokeWidth={2.5} /> New session
        </button>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search chats…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[13px] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-white/12 focus:bg-white/[0.06] transition"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto py-1.5 px-2 mt-1 space-y-0.5 min-h-0">
        {filtered.map((c) => (
          <div
            key={c.id}
            className={`group rounded-lg transition-colors ${
              currentConversationId === c.id
                ? 'bg-white/[0.07]'
                : 'hover:bg-white/[0.04]'
            }`}
          >
            {editingId === c.id ? (
              <input
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                autoFocus
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                className="w-full m-1 px-2 py-1 text-[13px] bg-ink-800 border border-white/10 rounded text-slate-100 focus:outline-none"
              />
            ) : (
              <button
                onClick={() => { onSelectConversation(c.id); onClose() }}
                className="w-full text-left px-2.5 py-2 text-[13px] text-slate-300 flex items-center gap-2"
              >
                <MessageSquare size={13} className="text-slate-600 shrink-0" />
                <span className="truncate flex-1">{c.title || 'New session'}</span>
                <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingId(c.id)
                      setEditingTitle(c.title || '')
                    }}
                    className="p-1 hover:bg-white/10 rounded text-slate-500 hover:text-slate-300"
                  >
                    <Edit2 size={12} />
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm('Delete this session?')) onDeleteConversation(c.id)
                    }}
                    className="p-1 hover:bg-white/10 rounded text-slate-500 hover:text-rose-400"
                  >
                    <Trash2 size={12} />
                  </span>
                </span>
              </button>
            )}
          </div>
        ))}
        {searchQuery && filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-slate-500">
            No chats match &quot;{searchQuery}&quot;
          </p>
        )}
        {!searchQuery && conversations.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-slate-600">No sessions yet</p>
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
              <div className="text-[13px] text-slate-200 truncate">{user?.name || user?.email || 'Anonymous'}</div>
              {user?.plan && (
                <div className="text-[11px] text-slate-500 capitalize">{user.plan} plan</div>
              )}
            </div>
            <ChevronDown
              size={14}
              className={`text-slate-500 transition-transform shrink-0 ${showUserMenu ? 'rotate-180' : ''}`}
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
                <MenuItem icon={LogOut} label="Sign out" onClick={onLogout} danger />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
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
