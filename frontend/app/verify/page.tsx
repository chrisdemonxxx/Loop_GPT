'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { API_URL } from '../lib/api'

export default function VerifyPage() {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (!token) {
      setState('error')
      return
    }
    fetch(`${API_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => setState(r.ok ? 'ok' : 'error'))
      .catch(() => setState('error'))
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center px-5">
      <div className="w-full max-w-sm text-center">
        <Link href="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-neon-violet to-neon-cyan flex items-center justify-center shadow-glow"><Sparkles size={16} className="text-white" /></div>
          <span className="font-semibold text-gradient text-lg">Loop GPT</span>
        </Link>
        <div className="glass-strong rounded-2xl p-8 shadow-panel">
          {state === 'loading' && <><Loader2 size={28} className="animate-spin text-neon-violet mx-auto mb-3" /><p className="text-slate-300">Verifying your email…</p></>}
          {state === 'ok' && <><CheckCircle2 size={32} className="text-emerald-400 mx-auto mb-3" /><h1 className="text-lg font-semibold text-slate-100 mb-1">Email verified</h1><p className="text-sm text-slate-500 mb-5">Your account is confirmed.</p><Link href="/chat" className="inline-block px-4 py-2 rounded-lg text-white bg-gradient-to-r from-neon-violet to-neon-indigo shadow-glow text-sm font-medium">Go to app →</Link></>}
          {state === 'error' && <><XCircle size={32} className="text-rose-400 mx-auto mb-3" /><h1 className="text-lg font-semibold text-slate-100 mb-1">Link invalid or expired</h1><p className="text-sm text-slate-500 mb-5">Sign in and resend the verification email from your account.</p><Link href="/login" className="inline-block px-4 py-2 rounded-lg text-white bg-gradient-to-r from-neon-violet to-neon-indigo shadow-glow text-sm font-medium">Go to login</Link></>}
        </div>
      </div>
    </div>
  )
}
