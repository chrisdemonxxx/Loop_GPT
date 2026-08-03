'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Users, Zap, DollarSign, Activity, Ticket, ArrowLeft, Loader2, Plus, Crown,
  Infinity as InfinityIcon, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { apiFetch } from '../lib/api'

interface Stats {
  hasDb: boolean
  users?: { total: number; admins: number; unlimited: number; pro: number; gold: number; free: number; new24h: number }
  tokens?: { inTotal: number; outTotal: number; in24h: number; out24h: number }
  activity?: { messagesTotal: number; imagesTotal: number; events24h: number; byKind24h: { kind: string; count: number }[] }
  revenue?: { totalCents: number; payments: number }
}

const fmt = (n = 0) => n.toLocaleString()
const money = (c = 0) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`

function Card({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="glass rounded-xl p-4">
      <div className={`flex items-center gap-2 text-xs mb-1 ${accent || 'text-slate-400'}`}>{icon}{label}</div>
      <div className="text-2xl font-semibold text-slate-100">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [users, setUsers] = useState<any[]>([])
  const [usage, setUsage] = useState<any[]>([])
  const [vouchers, setVouchers] = useState<any[]>([])
  const [payments, setPayments] = useState<any[]>([])
  const [error, setError] = useState('')
  const [live, setLive] = useState(true)
  const [tab, setTab] = useState<'users' | 'usage' | 'vouchers' | 'payments'>('users')

  // Voucher form
  const [vType, setVType] = useState<'gold' | 'pro' | 'unlimited' | 'credits'>('gold')
  const [vCount, setVCount] = useState(1)
  const [vMax, setVMax] = useState(1)
  const [vCredits, setVCredits] = useState(0)
  const [vImages, setVImages] = useState(0)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [s, u, us, v, p] = await Promise.all([
        apiFetch<Stats>('/api/admin/stats'),
        apiFetch<any>('/api/admin/users?take=25'),
        apiFetch<any>('/api/admin/usage?take=40'),
        apiFetch<any>('/api/admin/vouchers'),
        apiFetch<any>('/api/admin/payments?take=25'),
      ])
      setStats(s)
      setUsers(u.users || [])
      setUsage(us.events || [])
      setVouchers(v.vouchers || [])
      setPayments(p.payments || [])
      setError('')
    } catch (e: any) {
      setError(e?.message || 'Failed to load admin data')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!live) return
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [live, refresh])

  async function createVoucher(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      await apiFetch('/api/admin/vouchers', {
        method: 'POST',
        body: JSON.stringify({ type: vType, count: vCount, maxRedemptions: vMax, credits: vCredits, imageCredits: vImages }),
      })
      refresh()
    } catch (e: any) {
      setError(e?.message)
    } finally {
      setCreating(false)
    }
  }

  async function patchUser(id: string, data: any) {
    try {
      await apiFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
      refresh()
    } catch (e: any) {
      setError(e?.message)
    }
  }

  async function toggleVoucher(v: any) {
    await apiFetch(`/api/admin/vouchers/${v.id}`, { method: 'PATCH', body: JSON.stringify({ active: !v.active }) }).catch(() => {})
    refresh()
  }

  const noDb = stats && stats.hasDb === false

  return (
    <div className="min-h-screen px-5 py-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/chat" className="text-slate-400 hover:text-slate-200"><ArrowLeft size={18} /></Link>
          <h1 className="text-xl font-semibold text-slate-100 flex items-center gap-2"><ShieldCheck size={18} className="text-neon-violet" /> Admin Portal</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setLive((v) => !v)} className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${live ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-slate-400 border-white/10'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} /> {live ? 'Live' : 'Paused'}
          </button>
          <button onClick={refresh} className="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-slate-200"><RefreshCw size={13} /></button>
        </div>
      </div>

      {error && <div className="mb-4 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">{error}</div>}
      {noDb && <div className="mb-4 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">Running without a database — connect Postgres (DATABASE_URL) to see live stats.</div>}

      {/* Headline stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card icon={<Users size={13} />} label="Users" value={fmt(stats?.users?.total)} sub={`+${fmt(stats?.users?.new24h)} in 24h`} accent="text-neon-cyan" />
        <Card icon={<Zap size={13} />} label="Tokens (24h)" value={fmt((stats?.tokens?.in24h || 0) + (stats?.tokens?.out24h || 0))} sub={`${fmt(stats?.tokens?.inTotal)} in / ${fmt(stats?.tokens?.outTotal)} out total`} accent="text-neon-violet" />
        <Card icon={<Activity size={13} />} label="Actions (24h)" value={fmt(stats?.activity?.events24h)} sub={`${fmt(stats?.activity?.imagesTotal)} images all-time`} accent="text-amber-400" />
        <Card icon={<DollarSign size={13} />} label="Revenue" value={money(stats?.revenue?.totalCents)} sub={`${fmt(stats?.revenue?.payments)} payments`} accent="text-emerald-400" />
      </div>

      {/* Plan mix */}
      <div className="flex flex-wrap gap-2 mb-6 text-xs">
        <span className="px-2.5 py-1 rounded-full bg-ink-800 border border-white/10 text-slate-300">Free: {fmt(stats?.users?.free)}</span>
        <span className="px-2.5 py-1 rounded-full bg-neon-violet/10 border border-neon-violet/20 text-neon-violet">Pro: {fmt(stats?.users?.pro)}</span>
        <span className="px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center gap-1"><Crown size={11} /> Gold: {fmt(stats?.users?.gold)}</span>
        <span className="px-2.5 py-1 rounded-full bg-neon-cyan/10 border border-neon-cyan/20 text-neon-cyan flex items-center gap-1"><InfinityIcon size={11} /> Unlimited: {fmt(stats?.users?.unlimited)}</span>
        <span className="px-2.5 py-1 rounded-full bg-ink-800 border border-white/10 text-slate-300">Admins: {fmt(stats?.users?.admins)}</span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-white/5">
        {(['users', 'usage', 'vouchers', 'payments'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm capitalize transition border-b-2 -mb-px ${tab === t ? 'text-slate-100 border-neon-violet' : 'text-slate-500 border-transparent hover:text-slate-300'}`}>{t}</button>
        ))}
      </div>

      {tab === 'users' && (
        <div className="glass rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-xs bg-ink-900/50"><tr>
              <th className="text-left px-3 py-2 font-medium">User</th>
              <th className="text-left px-3 py-2 font-medium">Plan</th>
              <th className="text-right px-3 py-2 font-medium">Credits</th>
              <th className="text-right px-3 py-2 font-medium">Tokens</th>
              <th className="text-right px-3 py-2 font-medium">Msgs</th>
              <th className="text-center px-3 py-2 font-medium">Actions</th>
            </tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-white/5">
                  <td className="px-3 py-2">
                    <div className="text-slate-200 flex items-center gap-1.5">{u.name} {u.role === 'admin' && <ShieldCheck size={12} className="text-neon-violet" />} {u.unlimited && <InfinityIcon size={12} className="text-neon-cyan" />}</div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </td>
                  <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${u.plan === 'gold' ? 'bg-amber-500/10 text-amber-400' : u.plan === 'pro' ? 'bg-neon-violet/10 text-neon-violet' : 'bg-ink-800 text-slate-400'}`}>{u.plan}</span></td>
                  <td className="px-3 py-2 text-right text-slate-300">{u.unlimited ? '∞' : `${u.credits}/${u.imageCredits}img`}</td>
                  <td className="px-3 py-2 text-right text-slate-400">{fmt((u.tokensInTotal || 0) + (u.tokensOutTotal || 0))}</td>
                  <td className="px-3 py-2 text-right text-slate-400">{fmt(u.messagesTotal)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => patchUser(u.id, { plan: 'gold' })} title="Make Gold" className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20">Gold</button>
                      <button onClick={() => patchUser(u.id, { unlimited: !u.unlimited })} title="Toggle unlimited" className="text-xs px-1.5 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20">∞</button>
                      <button onClick={() => patchUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })} title="Toggle admin" className="text-xs px-1.5 py-0.5 rounded bg-neon-violet/10 text-neon-violet hover:bg-neon-violet/20">Admin</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!users.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-600">No users yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'usage' && (
        <div className="glass rounded-xl p-2 max-h-[480px] overflow-y-auto">
          {usage.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-2 py-1.5 text-xs border-b border-white/5 last:border-0">
              <div className="flex items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded ${e.kind === 'image' ? 'bg-pink-500/10 text-pink-400' : e.kind === 'research' ? 'bg-amber-500/10 text-amber-400' : 'bg-neon-violet/10 text-neon-violet'}`}>{e.kind}</span>
                <span className="text-slate-400">{e.user?.email || e.userId}</span>
              </div>
              <div className="text-slate-500">{e.tokensIn + e.tokensOut} tok · {new Date(e.createdAt).toLocaleTimeString()}</div>
            </div>
          ))}
          {!usage.length && <div className="px-3 py-8 text-center text-slate-600 text-sm">No activity yet.</div>}
        </div>
      )}

      {tab === 'vouchers' && (
        <div className="space-y-4">
          <form onSubmit={createVoucher} className="glass rounded-xl p-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Type</label>
              <select value={vType} onChange={(e) => setVType(e.target.value as any)} className="bg-ink-800 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-slate-100">
                <option value="gold">T1 Gold (team, capped-max)</option>
                <option value="pro">Pro</option>
                <option value="unlimited">Unlimited (internal)</option>
                <option value="credits">Credits top-up</option>
              </select>
            </div>
            <div><label className="text-xs text-slate-500 block mb-1">Count</label><input type="number" min={1} max={100} value={vCount} onChange={(e) => setVCount(+e.target.value)} className="w-20 bg-ink-800 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-slate-100" /></div>
            <div><label className="text-xs text-slate-500 block mb-1">Max uses</label><input type="number" min={1} value={vMax} onChange={(e) => setVMax(+e.target.value)} className="w-20 bg-ink-800 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-slate-100" /></div>
            {vType === 'credits' && (
              <>
                <div><label className="text-xs text-slate-500 block mb-1">+Msg credits</label><input type="number" min={0} value={vCredits} onChange={(e) => setVCredits(+e.target.value)} className="w-24 bg-ink-800 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-slate-100" /></div>
                <div><label className="text-xs text-slate-500 block mb-1">+Image credits</label><input type="number" min={0} value={vImages} onChange={(e) => setVImages(+e.target.value)} className="w-24 bg-ink-800 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-slate-100" /></div>
              </>
            )}
            <button type="submit" disabled={creating} className="px-4 py-2 rounded-lg text-white bg-gradient-to-r from-neon-violet to-neon-indigo hover:opacity-90 disabled:opacity-50 shadow-glow text-sm font-medium flex items-center gap-1.5">
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Generate
            </button>
          </form>

          <div className="glass rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-500 text-xs bg-ink-900/50"><tr>
                <th className="text-left px-3 py-2 font-medium">Code</th>
                <th className="text-left px-3 py-2 font-medium">Type / Plan</th>
                <th className="text-right px-3 py-2 font-medium">Uses</th>
                <th className="text-center px-3 py-2 font-medium">Status</th>
              </tr></thead>
              <tbody>
                {vouchers.map((v) => (
                  <tr key={v.id} className="border-t border-white/5">
                    <td className="px-3 py-2 font-mono text-slate-200 flex items-center gap-1.5">{v.type === 'unlimited' && <InfinityIcon size={12} className="text-neon-cyan" />}{v.plan === 'gold' && <Crown size={12} className="text-amber-400" />}{v.code}</td>
                    <td className="px-3 py-2 text-slate-400">{v.type}{v.plan ? ` · ${v.plan}` : ''}{v.credits ? ` · +${v.credits}c` : ''}{v.imageCredits ? ` +${v.imageCredits}img` : ''}</td>
                    <td className="px-3 py-2 text-right text-slate-400">{v.redemptionCount}/{v.maxRedemptions}</td>
                    <td className="px-3 py-2 text-center"><button onClick={() => toggleVoucher(v)} className={`text-xs px-2 py-0.5 rounded-full ${v.active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-500'}`}>{v.active ? 'active' : 'off'}</button></td>
                  </tr>
                ))}
                {!vouchers.length && <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-600">No vouchers yet — generate T1 Gold codes above.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'payments' && (
        <div className="glass rounded-xl p-2 max-h-[480px] overflow-y-auto">
          {payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-2 py-1.5 text-xs border-b border-white/5 last:border-0">
              <div className="text-slate-300">{p.user?.email || p.userId} <span className="text-slate-600">· {p.provider}</span></div>
              <div className="flex items-center gap-2"><span className="text-emerald-400">{money(p.amount)}</span><span className={`px-1.5 py-0.5 rounded ${p.status === 'succeeded' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>{p.status}</span></div>
            </div>
          ))}
          {!payments.length && <div className="px-3 py-8 text-center text-slate-600 text-sm">No payments recorded yet.</div>}
        </div>
      )}

      <div className="mt-6 flex items-center gap-1.5 text-xs text-slate-600"><Ticket size={12} /> Tip: generate T1 Gold vouchers for team members — capped-max usage, far above free, but not unlimited.</div>
    </div>
  )
}
