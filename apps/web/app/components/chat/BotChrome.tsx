'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Users, X } from 'lucide-react'
import { AVATAR_COLORS, type BotGroup, type NamedBot } from '../../lib/namedBots'
import { listBotSkills, type BotSkillRef } from '../../lib/bot'
import { useTeachSession } from '../team-bot/useTeachSession'

function useDismissOnEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
}

export function BotAvatar({ name, color, working, unread, size = 28 }: {
  name: string
  color: string
  working?: boolean
  unread?: boolean
  size?: number
}) {
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      <span
        className="flex items-center justify-center rounded-full text-white font-semibold"
        style={{ width: size, height: size, background: color, fontSize: size < 26 ? 10 : 12 }}
        aria-hidden
      >
        {(name || '?').slice(0, 1).toUpperCase()}
      </span>
      {working && <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse ring-2 ring-[#0a0a0c]" aria-label="Working" />}
      {!working && unread && <span className="absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full bg-[#c96442]" aria-label="Unread" />}
    </span>
  )
}

export function BotSidebarSection({
  bots, groups, activeBotId, activeGroupId, onOpenBot, onOpenGroup, onCreateBot, onCreateGroup,
}: {
  bots: NamedBot[]
  groups: BotGroup[]
  activeBotId?: string | null
  activeGroupId?: string | null
  onOpenBot: (bot: NamedBot) => void
  onOpenGroup: (group: BotGroup) => void
  onCreateBot: () => void
  onCreateGroup: () => void
}) {
  if (!bots.length && !groups.length) return null
  return (
    <div className="px-2 pt-2 space-y-0.5">
      <div className="px-2.5 pt-1 pb-0.5 text-[10px] uppercase tracking-widest text-slate-500 font-medium flex items-center justify-between">
        <span>Bots</span>
        <button type="button" onClick={onCreateBot} aria-label="Create new Bot" className="p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.05]"><Plus size={12} /></button>
      </div>
      {bots.map((bot) => (
        <button
          key={bot.id}
          type="button"
          onClick={() => onOpenBot(bot)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition ${activeBotId === bot.id ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
        >
          <BotAvatar name={bot.name} color={bot.avatarColor} working={bot.working} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-slate-200">{bot.name}</span>
            <span className="block truncate text-[11px] text-slate-500">{bot.preview || bot.label || 'No messages yet'}</span>
          </span>
        </button>
      ))}
      <button type="button" onClick={onCreateGroup} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]">
        <Users size={13} /> Create group chat
      </button>
      {groups.length > 0 && (
        <div className="pt-1 space-y-0.5">
          <div className="px-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-medium">Groups</div>
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => onOpenGroup(group)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition ${activeGroupId === group.id ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
            >
              <span className="w-7 h-7 rounded-full bg-white/[0.06] flex items-center justify-center text-slate-300 shrink-0"><Users size={13} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-slate-200">{group.title}</span>
                <span className="block truncate text-[11px] text-slate-500">{group.preview || `${group.botIds.length} bots`}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function StartChatPicker({
  bots, onClose, onCreateBot, onCreateGroup, onPickBot,
}: {
  bots: NamedBot[]
  onClose: () => void
  onCreateBot: () => void
  onCreateGroup: () => void
  onPickBot: (bot: NamedBot) => void
}) {
  useDismissOnEscape(onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24 px-4" onClick={onClose}>
      <div role="dialog" aria-label="Start a chat" className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#141418] shadow-panel overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 text-[13px] text-slate-400">Start a chat with…</div>
        <button type="button" onClick={onCreateBot} className="w-full text-left px-4 py-2.5 text-[14px] text-slate-100 hover:bg-white/[0.05]">＋ Create new Bot</button>
        <button type="button" onClick={onCreateGroup} className="w-full text-left px-4 py-2.5 text-[14px] text-slate-100 hover:bg-white/[0.05]">Create group chat</button>
        <div className="max-h-72 overflow-y-auto border-t border-white/[0.06] py-1">
          {bots.map((bot) => (
            <button key={bot.id} type="button" onClick={() => onPickBot(bot)} className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-white/[0.05]">
              <BotAvatar name={bot.name} color={bot.avatarColor} size={26} />
              <span className="min-w-0">
                <span className="block text-[13px] text-slate-100 truncate">{bot.name}</span>
                <span className="block text-[11px] text-slate-500 truncate">{bot.label}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const TOOL_CHOICES = ['web_search', 'create_document', 'execute_code', 'generate_image']

export function CreateBotDialog({ busy, onClose, onCreate }: {
  busy?: boolean
  onClose: () => void
  onCreate: (input: { name: string; label: string; avatarColor: string; persona: string; defaultTools: string[]; cloudComputer: boolean }) => void
}) {
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [color, setColor] = useState(AVATAR_COLORS[1])
  const [persona, setPersona] = useState('')
  const [tools, setTools] = useState<string[]>(['web_search', 'create_document'])
  const [cloud, setCloud] = useState(false)
  useDismissOnEscape(onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-label="Create new Bot"
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#141418] p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), label: label.trim(), avatarColor: color, persona: persona.trim(), defaultTools: tools, cloudComputer: cloud }) }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-medium text-slate-100">Create new Bot</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-slate-500 hover:text-slate-200"><X size={16} /></button>
        </div>
        <input aria-label="Bot name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-[14px] text-slate-100" />
        <input aria-label="Role" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Role, e.g. Coding lead" className="w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-[14px] text-slate-100" />
        <div className="flex gap-2" role="radiogroup" aria-label="Avatar color">
          {AVATAR_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} aria-checked={color === c} role="radio" onClick={() => setColor(c)} className={`w-6 h-6 rounded-full ${color === c ? 'ring-2 ring-white' : ''}`} style={{ background: c }} />
          ))}
        </div>
        <textarea aria-label="Persona" value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="How should this bot work?" rows={3} className="w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-[14px] text-slate-100" />
        <div className="flex flex-wrap gap-1.5">
          {TOOL_CHOICES.map((tool) => {
            const on = tools.includes(tool)
            return (
              <button key={tool} type="button" aria-pressed={on} onClick={() => setTools((prev) => on ? prev.filter((t) => t !== tool) : [...prev, tool])} className={`px-2 py-1 rounded-lg text-[11px] border ${on ? 'border-[#c96442]/50 text-[#e79d7f]' : 'border-white/10 text-slate-400'}`}>{tool.replace(/_/g, ' ')}</button>
            )
          })}
        </div>
        <label className="flex items-center gap-2 text-[13px] text-slate-300">
          <input type="checkbox" checked={cloud} onChange={(e) => setCloud(e.target.checked)} /> Cloud computer
        </label>
        <button type="submit" disabled={busy || !name.trim()} className="w-full rounded-xl bg-[#c96442] text-white py-2 text-[14px] font-medium disabled:opacity-50">Create bot</button>
      </form>
    </div>
  )
}

export function CreateGroupDialog({ bots, busy, onClose, onCreate }: {
  bots: NamedBot[]
  busy?: boolean
  onClose: () => void
  onCreate: (botIds: string[], name: string) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [name, setName] = useState('')
  const toggle = (id: string) => setPicked((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  useDismissOnEscape(onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-label="Create group chat"
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#141418] p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (picked.length >= 2) onCreate(picked, name.trim()) }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-medium text-slate-100">Create group chat</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-slate-500 hover:text-slate-200"><X size={16} /></button>
        </div>
        <input aria-label="Group name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-[14px] text-slate-100" />
        <div className="max-h-60 overflow-y-auto space-y-1">
          {bots.map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 px-1 py-1.5 text-[13px] text-slate-200">
              <input type="checkbox" checked={picked.includes(bot.id)} onChange={() => toggle(bot.id)} />
              <BotAvatar name={bot.name} color={bot.avatarColor} size={22} />
              {bot.name}
            </label>
          ))}
        </div>
        <button type="submit" disabled={busy || picked.length < 2} className="w-full rounded-xl bg-[#c96442] text-white py-2 text-[14px] font-medium disabled:opacity-50">Create group</button>
      </form>
    </div>
  )
}

export function BotProfilePanel({ bot, onLabel }: {
  bot: NamedBot
  onLabel: (label: string) => void
}) {
  const [tab, setTab] = useState<'details' | 'library' | 'computer'>('details')
  const [label, setLabel] = useState(bot.label || '')
  const [skills, setSkills] = useState<BotSkillRef[]>([])
  const [enlarged, setEnlarged] = useState(false)
  const teach = useTeachSession(() => { void listBotSkills(bot.id).then((d) => setSkills(d.skills || [])).catch(() => {}) }, bot.id)
  useEffect(() => { setLabel(bot.label || '') }, [bot.id, bot.label])
  useEffect(() => {
    if (tab !== 'library') return
    void listBotSkills(bot.id).then((d) => setSkills(d.skills || [])).catch(() => {})
  }, [tab, bot.id, teach.phase])
  const teachPhase = teach.phase
  const takeOver = teach.takeOver
  useEffect(() => {
    if (teachPhase === 'waiting') void takeOver()
  }, [teachPhase, takeOver])

  const view = (teach.computer?.takeoverRequested && teach.computer.interactiveUrl) || teach.computer?.viewUrl || ''
  const teachLabel = teach.phase === 'recording' || teach.phase === 'waiting' ? 'Stop' : 'Teach a task'

  const computer = (
    <div className="space-y-2">
      {view ? (
        <button type="button" onClick={() => setEnlarged(true)} className="block w-full rounded-xl overflow-hidden border border-white/10" aria-label="Enlarge computer">
          <iframe title={`${bot.name} computer`} src={view} className="w-full h-36 pointer-events-none bg-black" />
        </button>
      ) : (
        <p className="text-[12px] text-slate-500">No computer session yet. Teach a task to open one.</p>
      )}
      <button
        type="button"
        onClick={() => { if (teach.phase === 'recording' || teach.phase === 'waiting') void teach.stop(); else void teach.start(`Watch how I work and save it as a skill for ${bot.name}.`) }}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/10 text-[12px] text-slate-200 hover:bg-white/[0.05]"
      >
        <span aria-hidden>⏺</span> {teachLabel}
      </button>
      {teach.error && <p className="text-[12px] text-rose-300">{teach.error}</p>}
    </div>
  )

  return (
    <>
      <aside aria-label={`${bot.name} profile`} className="hidden lg:flex w-[300px] shrink-0 h-full flex-col border-l border-white/[0.06] bg-[#0c0c0e]">
        <div className="px-4 pt-5 pb-3">
          <BotAvatar name={bot.name} color={bot.avatarColor} working={bot.working} size={44} />
          <div className="mt-3 text-[16px] font-medium text-slate-100">{bot.name}</div>
          <input
            aria-label="Add a label"
            value={label}
            placeholder="Add a label"
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => { if (label.trim() !== (bot.label || '')) onLabel(label.trim()) }}
            className="mt-1 w-full bg-transparent text-[12px] text-slate-400 placeholder-slate-600 focus:outline-none"
          />
        </div>
        <div className="px-3 flex gap-1 text-[12px]">
          {(['details', 'library', 'computer'] as const).map((id) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`px-2.5 py-1 rounded-lg capitalize ${tab === id ? 'bg-white/[0.08] text-slate-100' : 'text-slate-500'}`} aria-pressed={tab === id}>{id}</button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 text-[13px] text-slate-300">
          {tab === 'details' && (
            <div className="space-y-2">
              <p className="text-slate-400 whitespace-pre-wrap">{bot.persona || 'No persona yet.'}</p>
              {bot.defaultTools?.length > 0 && <p className="text-[12px] text-slate-500">Tools: {bot.defaultTools.join(', ')}</p>}
            </div>
          )}
          {tab === 'library' && (
            skills.length === 0
              ? <p className="text-slate-500">No skills yet. Teach a task and it lands here.</p>
              : <ul className="space-y-2">{skills.map((s) => <li key={s.id} className="rounded-lg border border-white/[0.06] px-3 py-2"><div className="text-slate-100">{s.name}</div><div className="text-[12px] text-slate-500">{s.description}</div></li>)}</ul>
          )}
          {tab === 'computer' && computer}
        </div>
      </aside>
      <AnimatePresence>
        {enlarged && (
          <motion.div
            className="fixed inset-0 z-40 bg-[#0c0c0e] flex flex-col"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.18 }}
          >
            <div className="h-12 px-4 flex items-center gap-2 border-b border-white/[0.06]">
              <span className="text-[13px] text-slate-200 flex-1 truncate">{bot.name} · Computer</span>
              <button type="button" onClick={() => { if (teach.phase === 'recording' || teach.phase === 'waiting') void teach.stop(); else void teach.start(`Watch how I work and save it as a skill for ${bot.name}.`) }} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-white/15 text-[12px] text-slate-100"><span aria-hidden>⏺</span> {teachLabel}</button>
              <button type="button" onClick={() => setEnlarged(false)} aria-label="Collapse computer" className="px-2 py-1 text-[12px] text-slate-400 hover:text-slate-100">Collapse</button>
            </div>
            {view ? <iframe title={`${bot.name} computer enlarged`} src={view} className="flex-1 w-full bg-black" /> : <div className="flex-1 flex items-center justify-center text-slate-500">The computer will appear here once the session starts.</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
