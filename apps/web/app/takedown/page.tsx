'use client'

import { useState, type FormEvent } from 'react'
import LegalLayout from '../components/LegalLayout'
import { API_URL } from '../lib/api'
import { btnPrimary, inputCls } from '@loop/ui'

export default function TakedownPage() {
  const [category, setCategory] = useState<'ncii' | 'csam' | 'impersonation' | 'violence' | 'other'>('ncii')
  const [targetType, setTargetType] = useState<'file' | 'conversation' | 'share_link' | 'url' | 'user'>('file')
  const [targetId, setTargetId] = useState('')
  const [reporterEmail, setReporterEmail] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const submitReport = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !targetId.trim() || reason.trim().length < 5) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${API_URL}/api/abuse/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          targetType,
          targetId: targetId.trim(),
          reason: reason.trim(),
          ...(reporterEmail.trim() ? { reporterEmail: reporterEmail.trim() } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResult({ ok: false, text: data?.error || 'Could not submit report.' })
      } else {
        setResult({
          ok: true,
          text: `Report #${data.id} received. SLA due by ${new Date(data.slaDueAt).toLocaleString()} (${data.slaHours}h SLA).${data.autoSuspended ? ' Public link has been immediately suspended pending review.' : ''}`,
        })
        setTargetId('')
        setReason('')
      }
    } catch {
      setResult({ ok: false, text: 'Network error while submitting report.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <LegalLayout title="DMCA, NCII & Abuse Takedown Policy" updated="October 19, 2026">
      <p>
        Loop GPT strictly prohibits Child Sexual Abuse Material (CSAM), Non-Consensual Intimate
        Imagery (NCII / unauthorized likeness deepfakes), and copyright infringement.
      </p>

      <h2>1. 48-Hour NCII &amp; Likeness Takedown Guarantee</h2>
      <p>
        If an image, video, or shared conversation uses your face or likeness without your consent:
      </p>
      <ul>
        <li>
          <strong>Immediate automatic link suspension:</strong> Submitting an NCII or CSAM report
          below with a published file ID or share token <strong>immediately revokes</strong> public
          access to that link while our safety team reviews the report.
        </li>
        <li>
          <strong>48-hour SLA:</strong> All verified NCII and likeness takedown requests are
          permanently actioned within 48 hours.
        </li>
      </ul>

      <h2>2. Submit an Immediate Takedown / Abuse Report</h2>
      <form onSubmit={submitReport} className="not-prose my-6 space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Violation Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as any)}
              className={inputCls}
              aria-label="Violation Category"
            >
              <option value="ncii">Non-Consensual Intimate Imagery (NCII / Likeness)</option>
              <option value="csam">Child Safety / CSAM (Zero Tolerance)</option>
              <option value="impersonation">Unauthorized Face-Lock / Impersonation</option>
              <option value="violence">Imminent Violence / Threats</option>
              <option value="other">DMCA Copyright / Other Abuse</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Target Type</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as any)}
              className={inputCls}
              aria-label="Target Type"
            >
              <option value="file">Published File ID / Token</option>
              <option value="share_link">Shared Conversation Token</option>
              <option value="url">Full URL</option>
              <option value="conversation">Conversation ID</option>
              <option value="user">User Account</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Target ID, Share Token, or URL *</label>
            <input
              required
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="e.g. file_abc123 or https://loop-gpt.cyou/share/..."
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Your Contact Email (optional, for SLA updates)</label>
            <input
              type="email"
              value={reporterEmail}
              onChange={(e) => setReporterEmail(e.target.value)}
              placeholder="you@example.com"
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Details / Statement of Good-Faith Belief *</label>
          <textarea
            required
            minLength={5}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Describe the unauthorized content or copyright work infringed..."
            className={inputCls}
          />
        </div>

        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy ? 'Submitting takedown…' : 'Submit Immediate Takedown Request'}
        </button>

        {result && (
          <div
            role="status"
            className={`text-xs rounded-lg p-3 border ${result.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}
          >
            {result.text}
          </div>
        )}
      </form>

      <h2>3. DMCA Copyright Notices</h2>
      <p>
        In accordance with the Digital Millennium Copyright Act (17 U.S.C. § 512), copyright owners
        may submit formal takedown notices using the form above or by emailing{' '}
        <a href="mailto:dmca@loop-gpt.cyou">dmca@loop-gpt.cyou</a> with: (a) identification of the
        copyrighted work, (b) the exact URL or File ID of the infringing material, (c) your contact
        information, (d) a statement of good-faith belief, and (e) a statement under penalty of
        perjury that you are authorized to act on behalf of the copyright owner, along with your
        physical or electronic signature.
      </p>

      <h2>4. Synthetic Media &amp; Record-Keeping Compliance</h2>
      <p>
        All outputs generated on Loop GPT are 100% synthetic AI creations and do not depict actual
        human performers engaged in real-world conduct. Where applicable on age-gated Adult Edition
        surfaces, user age assurance (18+) is verified via VerifyMy prior to access.
      </p>
    </LegalLayout>
  )
}
