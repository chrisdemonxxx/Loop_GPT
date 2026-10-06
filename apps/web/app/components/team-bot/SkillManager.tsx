'use client'

/** Taught-skill manager: grid of skill cards with trigger keywords, owner
 *  (admin view) and a one-click "Queue with this skill". */
import { Sparkles, Trash2 } from 'lucide-react'

export interface BotSkill {
  id: string
  name: string
  description: string
  triggers?: string[]
  tools?: string[]
  ownerId?: string
  builtin?: boolean
}

export function SkillManager({
  skills, showOwner, onDelete, onQueue,
}: {
  skills: BotSkill[]
  showOwner?: boolean
  onDelete?: (ownerId: string | undefined, id: string) => void
  onQueue?: (skill: BotSkill) => void
}) {
  if (!skills.length) return <div className="text-xs text-slate-500">No taught skills yet — use Teach mode to record one.</div>
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {skills.map((skill) => (
        <div key={`${skill.ownerId || 'me'}:${skill.id}`} className="rounded-xl bg-slate-900/50 p-3 ring-1 ring-slate-800 hover:ring-slate-700">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-200">
                <Sparkles size={12} className="text-violet-400" /> {skill.name}
              </div>
              {skill.description && <div className="mt-0.5 truncate text-[11px] text-slate-500">{skill.description}</div>}
              {!!skill.triggers?.length && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {skill.triggers.slice(0, 5).map((trigger) => (
                    <span key={trigger} className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-[10px] text-violet-300/80">{trigger}</span>
                  ))}
                </div>
              )}
              {showOwner && skill.ownerId && <div className="mt-1 font-mono text-[10px] text-slate-600">{skill.ownerId}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {onQueue && (
                <button onClick={() => onQueue(skill)} className="rounded-lg bg-violet-600/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-500">Run</button>
              )}
              {onDelete && !skill.builtin && (
                <button onClick={() => onDelete(skill.ownerId, skill.id)} className="text-slate-500 hover:text-rose-400"><Trash2 size={13} /></button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}