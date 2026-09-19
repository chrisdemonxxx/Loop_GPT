'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Sparkles, Loader2, CheckCircle2 } from 'lucide-react'
import { API_URL } from '../lib/api'

export default function ResetPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Passwords do not match.')
    const token = new URLSearchParams(window.location.search).get('token')
    if (!token) return setError('Missing reset token — use the link from your email.')
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/auth/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Could not reset password.')
        setLoading(false)
        return
      }
      setDone(true)
    } catch (e: any) {
      setError(e?.message || 'Network error')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-neon-violet to-neon-cyan flex items-center justify-center shadow-glow"><Sparkles size={16} className="text-white" /></div>
          <span className="font-semibold text-gradient text-lg">Loop GPT</span>
        </Link>
        <div className="glass-strong rounded-2xl p-6 shadow-panel">
          {done ? (
            <div className="text-center py-4">
              <CheckCircle2 size={32} className="text-emerald-400 mx-auto mb-3" />
              <h1 className="text-lg font-semibold text-slate-100 mb-1">Password updated</h1>
              <p className="text-sm text-slate-500 mb-5">You can now sign in with your new password.</p>
              <Link href="/login" className="inline-block px-4 py-2 rounded-lg text-white bg-gradient-to-r from-neon-violet to-neon-indigo shadow-glow text-sm font-medium">Go to login →</Link>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-slate-100 mb-1">Choose a new password</h1>
              <p className="text-sm text-slate-500 mb-5">Enter and confirm your new password.</p>
              <form onSubmit={submit} className="space-y-3">
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" className="w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-slate-100 text-sm focus:outline-none focus:accent-ring placeholder-slate-600" />
                <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm password" className="w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-slate-100 text-sm focus:outline-none focus:accent-ring placeholder-slate-600" />
                {error && <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">{error}</div>}
                <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-white bg-gradient-to-r from-neon-violet to-neon-indigo hover:opacity-90 disabled:opacity-50 transition shadow-glow font-medium">
                  {loading ? <Loader2 size={16} className="animate-spin" /> : 'Reset password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
