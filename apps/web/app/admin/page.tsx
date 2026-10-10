'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import {
  Users, Zap, DollarSign, Activity, Ticket, Loader2, Plus, Crown,
  Infinity as InfinityIcon, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/api'
import { AppPage } from '../components/AppPage'
import { ErrorState, btnGhost, btnPrimary, btnSecondary, selectCls } from '@loop/ui'

interface Stats {
  hasDb: boolean
  users?: { total: number; admins: number; unlimited: number; pro: number; gold: number; free: number; new24h: number }
  tokens?: { inTotal: number; outTotal: number; in24h: number; out24h: number }
  activity?: { messagesTotal: number; imagesTotal: number; events24h: number; byKind24h: { kind: string; count: number }[] }
  revenue?: { totalCents: number; payments: number }
}

interface AdminUser {
  id: string; name: string; email: string; role: string; plan: string
  unlimited: boolean; credits: number; imageCredits: number
  tokensInTotal?: number; tokensOutTotal?: number; messagesTotal: number
}
interface UsageEvent { id: string; kind: string; userId?: string; user?: { email?: string }; tokensIn: number; tokensOut: number; createdAt: string }
interface Voucher { id: string; code: string; type: string; plan?: string; credits?: number; imageCredits?: number; active: boolean; redemptionCount: number; maxRedemptions: number }
interface Payment { id: string; userId?: string; user?: { email?: string }; provider: string; amount: number; status: string }

interface Dashboard {
  stats: Stats
  users: AdminUser[]
  usage: UsageEvent[]
  vouchers: Voucher[]
  payments: Payment[]
}

const fmt = (n = 0) => n.toLocaleString()
const money = (c = 0) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`

function Card({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="glass rounded-xl p-4">
      <div className={`flex items-center gap-2 text-ui-xs mb-1 ${accent || 'text-[var(--ink-muted)]'}`}>{icon}{label}</div>
      <div className="text-2xl font-semibold text-[var(--ink-primary)]">{value}</div>
      {sub && <div className="text-ui-xs text-[var(--ink-muted)] mt-0.5">{sub}</div>}
    </div>
  )
}

export default function AdminPage() {
  const queryClient = useQueryClient()
  const [live, setLive] = useState(true)
  const [tab, setTab] = useState<'users' | 'usage' | 'vouchers' | 'payments'>('users')

  const dashboard = useQuery<Dashboard>({
    queryKey: ['admin', 'dashboard'],
    queryFn: async () => {
      const [s, u, us, v, p] = await Promise.all([
        apiFetch<Stats>('/api/admin/stats'),
        apiFetch<{ users?: AdminUser[] }>('/api/admin/users?take=25'),
        apiFetch<{ events?: UsageEvent[] }>('/api/admin/usage?take=40'),
        apiFetch<{ vouchers?: Voucher[] }>('/api/admin/vouchers'),
        apiFetch<{ payments?: Payment[] }>('/api/admin/payments?take=25'),
      ])
      return {
        stats: s,
        users: u.users || [],
        usage: us.events || [],
        vouchers: v.vouchers || [],
        payments: p.payments || [],
      }
    },
    enabled: typeof window !== 'undefined',
    retry: false,
    refetchInterval: live ? 5000 : false,
  })

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] }) }

  const stats = dashboard.data?.stats ?? null
  const users = dashboard.data?.users ?? []
  const usage = dashboard.data?.usage ?? []
  const vouchers = dashboard.data?.vouchers ?? []
  const payments = dashboard.data?.payments ?? []
  const error = dashboard.isError
    ? ((dashboard.error as { message?: string })?.message || 'Failed to load admin data')
    : ''

  // Voucher form
  const [vType, setVType] = useState<'gold' | 'pro' | 'unlimited' | 'credits'>('gold')
  const [vCount, setVCount] = useState(1)
  const [vMax, setVMax] = useState(1)
  const [vCredits, setVCredits] = useState(0)
  const [vImages, setVImages] = useState(0)
  const [actionError, setActionError] = useState('')

  const createVoucher = useMutation({
    mutationFn: (input: { type: string; count: number; maxRedemptions: number; credits: number; imageCredits: number }) =>
      apiFetch('/api/admin/vouchers', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => refresh(),
    onError: (e: any) => { setActionError(e?.message) },
  })

  async function patchUser(id: string, data: Record<string, unknown>) {
    try {
      await apiFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
      refresh()
    } catch (e: any) {
      setActionError(e?.message)
    }
  }

  async function toggleVoucher(v: Voucher) {
    await apiFetch(`/api/admin/vouchers/${v.id}`, { method: 'PATCH', body: JSON.stringify({ active: !v.active }) }).catch(() => {})
    refresh()
  }

  function onCreateVoucher(e: FormEvent) {
    e.preventDefault()
    createVoucher.mutate({ type: vType, count: vCount, maxRedemptions: vMax, credits: vCredits, imageCredits: vImages })
  }

  const noDb = stats && stats.hasDb === false

  return (
    <AppPage
      title="Admin Portal"
      documentTitle="Admin"
      back={{ href: '/chat', label: 'Chat' }}
      width="wide"
      icon={<ShieldCheck size={18} className="text-[var(--accent-text)]" aria-hidden />}
      actions={(
        <>
          <Link href="/admin/loopit" className={`${btnSecondary} px-3 py-1.5 text-ui-xs`}>Loop-IT ops</Link>
          <Link href="/admin/bot" className={`${btnSecondary} px-3 py-1.5 text-ui-xs`}>Bot computer</Link>
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className={`inline-flex items-center gap-1.5 text-ui-xs px-3 py-1.5 rounded-lg border transition ${live ? 'text-[var(--success)] border-[var(--border-subtle)] bg-[var(--bg-tint)]' : 'text-[var(--ink-muted)] border-[var(--border-strong)]'}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-[var(--success)] animate-pulse' : 'bg-[var(--ink-muted)]'}`} aria-hidden /> {live ? 'Live' : 'Paused'}
          </button>
          <button type="button" onClick={refresh} aria-label="Refresh stats" className={`${btnGhost} px-2.5 py-1.5 text-ui-xs`}><RefreshCw size={13} aria-hidden /></button>
        </>
      )}
    >
      {error && <div className="mb-4"><ErrorState title={error} compact /></div>}
      {actionError && <div className="mb-4"><ErrorState title={actionError} compact onDismiss={() => setActionError('')} /></div>}
      {noDb && (
        <div role="note" className="mb-4 text-ui-xs text-[var(--warning)] bg-[var(--bg-tint)] border border-[var(--border-subtle)] rounded-lg px-3 py-2">
          Running without a database — connect Postgres (DATABASE_URL) to see live stats.
        </div>
      )}

      {/* Headline stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card icon={<Users size={13} aria-hidden />} label="Users" value={fmt(stats?.users?.total)} sub={`+${fmt(stats?.users?.new24h)} in 24h`} accent="text-[var(--accent-text)]" />
        <Card icon={<Zap size={13} aria-hidden />} label="Tokens (24h)" value={fmt((stats?.tokens?.in24h || 0) + (stats?.tokens?.out24h || 0))} sub={`${fmt(stats?.tokens?.inTotal)} in / ${fmt(stats?.tokens?.outTotal)} out total`} accent="text-[var(--accent-text)]" />
        <Card icon={<Activity size={13} aria-hidden />} label="Actions (24h)" value={fmt(stats?.activity?.events24h)} sub={`${fmt(stats?.activity?.imagesTotal)} images all-time`} accent="text-[var(--warning)]" />
        <Card icon={<DollarSign size={13} aria-hidden />} label="Revenue" value={money(stats?.revenue?.totalCents)} sub={`${fmt(stats?.revenue?.payments)} payments`} accent="text-[var(--success)]" />
      </div>

      {/* Plan mix */}
      <div className="flex flex-wrap gap-2 mb-6 text-ui-xs">
        <span className="px-2.5 py-1 rounded-full bg-[var(--bg-raised)] border border-[var(--border-strong)] text-[var(--ink-secondary)]">Free: {fmt(stats?.users?.free)}</span>
        <span className="px-2.5 py-1 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] text-[var(--accent-text)]">Pro: {fmt(stats?.users?.pro)}</span>
        <span className="px-2.5 py-1 rounded-full bg-[var(--bg-tint)] border border-[var(--border-subtle)] text-[var(--warning)] flex items-center gap-1"><Crown size={11} aria-hidden /> Gold: {fmt(stats?.users?.gold)}</span>
        <span className="px-2.5 py-1 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-soft-border)] text-[var(--accent-text)] flex items-center gap-1"><InfinityIcon size={11} aria-hidden /> Unlimited: {fmt(stats?.users?.unlimited)}</span>
        <span className="px-2.5 py-1 rounded-full bg-[var(--bg-raised)] border border-[var(--border-strong)] text-[var(--ink-secondary)]">Admins: {fmt(stats?.users?.admins)}</span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-[var(--border-subtle)]">
        {(['users', 'usage', 'vouchers', 'payments'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-current={tab === t ? 'true' : undefined} className={`px-3 py-2 text-sm capitalize transition border-b-2 -mb-px ${tab === t ? 'text-[var(--ink-primary)] border-[var(--accent-fill)]' : 'text-[var(--ink-muted)] border-transparent hover:text-[var(--ink-secondary)]'}`}>{t}</button>
        ))}
      </div>

      {tab === 'users' && (
        <div className="glass rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[var(--ink-muted)] text-ui-xs bg-[var(--bg-sunken)]"><tr>
              <th className="text-left px-3 py-2 font-medium">User</th>
              <th className="text-left px-3 py-2 font-medium">Plan</th>
              <th className="text-right px-3 py-2 font-medium">Credits</th>
              <th className="text-right px-3 py-2 font-medium">Tokens</th>
              <th className="text-right px-3 py-2 font-medium">Msgs</th>
              <th className="text-center px-3 py-2 font-medium">Actions</th>
            </tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-[var(--border-subtle)]">
                  <td className="px-3 py-2">
                    <div className="text-[var(--ink-primary)] flex items-center gap-1.5">{u.name} {u.role === 'admin' && <ShieldCheck size={12} className="text-[var(--accent-text)]" aria-hidden />} {u.unlimited && <InfinityIcon size={12} className="text-[var(--accent-text)]" aria-hidden />}</div>
                    <div className="text-ui-xs text-[var(--ink-muted)]">{u.email}</div>
                  </td>
                  <td className="px-3 py-2"><span className={`text-ui-xs px-2 py-0.5 rounded-full ${u.plan === 'gold' ? 'bg-[var(--bg-tint)] text-[var(--warning)]' : u.plan === 'pro' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'bg-[var(--bg-raised)] text-[var(--ink-secondary)]'}`}>{u.plan}</span></td>
                  <td className="px-3 py-2 text-right text-[var(--ink-secondary)]">{u.unlimited ? '∞' : `${u.credits}/${u.imageCredits}img`}</td>
                  <td className="px-3 py-2 text-right text-[var(--ink-muted)]">{fmt((u.tokensInTotal || 0) + (u.tokensOutTotal || 0))}</td>
                  <td className="px-3 py-2 text-right text-[var(--ink-muted)]">{fmt(u.messagesTotal)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button type="button" onClick={() => void patchUser(u.id, { plan: 'gold' })} title="Make Gold" className="text-ui-xs px-1.5 py-0.5 rounded bg-[var(--bg-tint)] text-[var(--warning)] hover:bg-[var(--bg-hover)]">Gold</button>
                      <button type="button" onClick={() => void patchUser(u.id, { unlimited: !u.unlimited })} title="Toggle unlimited" className="text-ui-xs px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)] hover:bg-[var(--accent-soft-hover)]">∞</button>
                      <button type="button" onClick={() => void patchUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })} title="Toggle admin" className="text-ui-xs px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)] hover:bg-[var(--accent-soft-hover)]">Admin</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!users.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-[var(--ink-muted)]">No users yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'usage' && (
        <div className="glass rounded-xl p-2 max-h-[480px] overflow-y-auto">
          {usage.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-2 py-1.5 text-ui-xs border-b border-[var(--border-subtle)] last:border-0">
              <div className="flex items-center gap-2">
                <span className={`px-1.5 py-0.5 rounded ${e.kind === 'image' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : e.kind === 'research' ? 'bg-[var(--bg-tint)] text-[var(--warning)]' : 'bg-[var(--accent-soft)] text-[var(--accent-text)]'}`}>{e.kind}</span>
                <span className="text-[var(--ink-muted)]">{e.user?.email || e.userId}</span>
              </div>
              <div className="text-[var(--ink-muted)]">{e.tokensIn + e.tokensOut} tok · {new Date(e.createdAt).toLocaleTimeString()}</div>
            </div>
          ))}
          {!usage.length && <div className="px-3 py-8 text-center text-[var(--ink-muted)] text-sm">No activity yet.</div>}
        </div>
      )}

      {tab === 'vouchers' && (
        <div className="space-y-4">
          <form onSubmit={onCreateVoucher} className="glass rounded-xl p-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="text-ui-xs text-[var(--ink-muted)] block mb-1">Type</label>
              <select value={vType} onChange={(e) => setVType(e.target.value as typeof vType)} className={`${selectCls} px-2.5 py-2 text-sm`}>
                <option value="gold">T1 Gold (team, capped-max)</option>
                <option value="pro">Pro</option>
                <option value="unlimited">Unlimited (internal)</option>
                <option value="credits">Credits top-up</option>
              </select>
            </div>
            <div><label className="text-ui-xs text-[var(--ink-muted)] block mb-1">Count</label><input type="number" min={1} max={100} value={vCount} onChange={(e) => setVCount(+e.target.value)} className="w-20 bg-[var(--bg-raised)] border border-[var(--border-strong)] rounded-lg px-2.5 py-2 text-sm text-[var(--ink-primary)]" /></div>
            <div><label className="text-ui-xs text-[var(--ink-muted)] block mb-1">Max uses</label><input type="number" min={1} value={vMax} onChange={(e) => setVMax(+e.target.value)} className="w-20 bg-[var(--bg-raised)] border border-[var(--border-strong)] rounded-lg px-2.5 py-2 text-sm text-[var(--ink-primary)]" /></div>
            {vType === 'credits' && (
              <>
                <div><label className="text-ui-xs text-[var(--ink-muted)] block mb-1">+Msg credits</label><input type="number" min={0} value={vCredits} onChange={(e) => setVCredits(+e.target.value)} className="w-24 bg-[var(--bg-raised)] border border-[var(--border-strong)] rounded-lg px-2.5 py-2 text-sm text-[var(--ink-primary)]" /></div>
                <div><label className="text-ui-xs text-[var(--ink-muted)] block mb-1">+Image credits</label><input type="number" min={0} value={vImages} onChange={(e) => setVImages(+e.target.value)} className="w-24 bg-[var(--bg-raised)] border border-[var(--border-strong)] rounded-lg px-2.5 py-2 text-sm text-[var(--ink-primary)]" /></div>
              </>
            )}
            <button type="submit" disabled={createVoucher.isPending} className={btnPrimary}>
              {createVoucher.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />} Generate
            </button>
          </form>

          <div className="glass rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[var(--ink-muted)] text-ui-xs bg-[var(--bg-sunken)]"><tr>
                <th className="text-left px-3 py-2 font-medium">Code</th>
                <th className="text-left px-3 py-2 font-medium">Type / Plan</th>
                <th className="text-right px-3 py-2 font-medium">Uses</th>
                <th className="text-center px-3 py-2 font-medium">Status</th>
              </tr></thead>
              <tbody>
                {vouchers.map((v) => (
                  <tr key={v.id} className="border-t border-[var(--border-subtle)]">
                    <td className="px-3 py-2 font-mono text-[var(--ink-primary)] flex items-center gap-1.5">{v.type === 'unlimited' && <InfinityIcon size={12} className="text-[var(--accent-text)]" aria-hidden />}{v.plan === 'gold' && <Crown size={12} className="text-[var(--warning)]" aria-hidden />}{v.code}</td>
                    <td className="px-3 py-2 text-[var(--ink-muted)]">{v.type}{v.plan ? ` · ${v.plan}` : ''}{v.credits ? ` · +${v.credits}c` : ''}{v.imageCredits ? ` +${v.imageCredits}img` : ''}</td>
                    <td className="px-3 py-2 text-right text-[var(--ink-muted)]">{v.redemptionCount}/{v.maxRedemptions}</td>
                    <td className="px-3 py-2 text-center"><button type="button" onClick={() => void toggleVoucher(v)} className={`text-ui-xs px-2 py-0.5 rounded-full ${v.active ? 'bg-[var(--bg-tint)] text-[var(--success)]' : 'bg-[var(--bg-hover)] text-[var(--ink-muted)]'}`}>{v.active ? 'active' : 'off'}</button></td>
                  </tr>
                ))}
                {!vouchers.length && <tr><td colSpan={4} className="px-3 py-8 text-center text-[var(--ink-muted)]">No vouchers yet — generate T1 Gold codes above.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'payments' && (
        <div className="glass rounded-xl p-2 max-h-[480px] overflow-y-auto">
          {payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-2 py-1.5 text-ui-xs border-b border-[var(--border-subtle)] last:border-0">
              <div className="text-[var(--ink-secondary)]">{p.user?.email || p.userId} <span className="text-[var(--ink-muted)]">· {p.provider}</span></div>
              <div className="flex items-center gap-2"><span className="text-[var(--success)]">{money(p.amount)}</span><span className={`px-1.5 py-0.5 rounded ${p.status === 'succeeded' ? 'bg-[var(--bg-tint)] text-[var(--success)]' : 'bg-[var(--bg-tint)] text-[var(--warning)]'}`}>{p.status}</span></div>
            </div>
          ))}
          {!payments.length && <div className="px-3 py-8 text-center text-[var(--ink-muted)] text-sm">No payments recorded yet.</div>}
        </div>
      )}

      <div className="mt-6 flex items-center gap-1.5 text-ui-xs text-[var(--ink-muted)]"><Ticket size={12} aria-hidden /> Tip: generate T1 Gold vouchers for team members — capped-max usage, far above free, but not unlimited.</div>
    </AppPage>
  )
}
