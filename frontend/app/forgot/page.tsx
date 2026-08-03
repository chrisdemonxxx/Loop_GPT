'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Sparkles, Loader2, MailCheck } from 'lucide-react'
import { API_URL } from '../lib/api'

export default function ForgotPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      await fetch(`${API_URL}/api/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    } catch {
      /* ignore */
    }
    setSent(true)
    setLoading(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-neon-violet to-neon-cyan flex items-center justify-center shadow-glow"><Sparkles size={16} className="text-white" /></div>
          <span className="font-semibold text-gradient text-lg">Loop GPT</span>
        </Link>
        <div className="glass-strong rounded-2xl p-6 shadow-panel">
          {sent ? (
            <div className="text-center py-4">
              <MailCheck size={32} className="text-emerald-400 mx-auto mb-3" />
              <h1 className="text-lg font-semibold text-slate-100 mb-1">Check your email</h1>
              <p className="text-sm text-slate-500 mb-5">If an account exists for {email || 'that address'}, a reset link is on its way.</p>
              <Link href="/login" className="text-sm text-neon-violet hover:underline">Back to login</Link>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-slate-100 mb-1">Forgot your password?</h1>
              <p className="text-sm text-slate-500 mb-5">Enter your email and we&apos;ll send a reset link.</p>
              <form onSubmit={submit} className="space-y-3">
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full bg-ink-800 border border-white/10 rounded-lg px-3 py-2.5 text-slate-100 text-sm focus:outline-none focus:accent-ring placeholder-slate-600" />
                <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-white bg-gradient-to-r from-neon-violet to-neon-indigo hover:opacity-90 disabled:opacity-50 transition shadow-glow font-medium">
                  {loading ? <Loader2 size={16} className="animate-spin" /> : 'Send reset link'}
                </button>
              </form>
              <div className="mt-4 text-center text-sm text-slate-500"><Link href="/login" className="text-neon-violet hover:underline">Back to login</Link></div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
