'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Sparkles, Bot, Search, Image as ImageIcon, FileText, Cpu, Cable, Blocks,
  Check, ArrowRight, Wrench, Eye,
} from 'lucide-react'

const FEATURES = [
  { icon: Bot, title: 'Agentic tool use', desc: 'A real tool-calling agent that searches, computes, reads, and acts — streamed live.' },
  { icon: Search, title: 'Deep research', desc: 'Plans queries, reads sources, and writes a cited report you can trust.' },
  { icon: Eye, title: 'Vision', desc: 'Upload an image and ask about it — native multimodal understanding.' },
  { icon: ImageIcon, title: 'Image generation', desc: 'Generate images from a prompt with FLUX, right in the chat.' },
  { icon: FileText, title: 'Documents', desc: 'Produce PDF, Word, Excel, and PowerPoint files as downloadable outputs.' },
  { icon: Cpu, title: 'Agent Computer', desc: 'Watch every tool call stream in a live terminal.' },
  { icon: Cable, title: 'MCP & connectors', desc: 'Plug in Model Context Protocol servers and external services.' },
  { icon: Blocks, title: 'Skills & builders', desc: 'Create skills and no-code tools that extend the agent.' },
]

const PLANS = [
  {
    name: 'Free', price: '$0', period: 'forever', cta: 'Start free', href: '/signup', highlight: false,
    features: ['~30 messages/day', 'Chat + web search + calculator', '3 images/day', '1 deep-research/day', 'PDF export', 'Community support'],
  },
  {
    name: 'Pro', price: '$15', period: '/mo', cta: 'Go Pro', href: '/signup?plan=pro', highlight: true,
    features: ['High daily limits', 'All tools + deep research', 'Vision + unlimited docs', 'MCP, connectors, skills, builders', 'Priority (warm) model', 'No image watermark'],
  },
]

export default function Landing() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav className="max-w-6xl mx-auto flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#c96442] flex items-center justify-center">
            <Sparkles size={14} className="text-white" />
          </div>
          <span className="font-semibold text-slate-100 text-[15px]">Loop GPT</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <a href="#features" className="text-slate-500 hover:text-slate-200 hidden sm:block transition">Features</a>
          <a href="#pricing" className="text-slate-500 hover:text-slate-200 hidden sm:block transition">Pricing</a>
          <Link href="/login" className="text-slate-400 hover:text-slate-100 transition">Log in</Link>
          <Link href="/signup" className="px-3 py-1.5 rounded-lg text-white bg-[#c96442] hover:bg-[#b5593a] transition text-[13px] font-medium">
            Sign up
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto text-center px-5 pt-20 pb-16">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass text-[12px] text-slate-400 mb-7">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80" />
            Agentic AI · streaming · bring your own model
          </div>
          <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight leading-[1.06] mb-5 text-slate-50">
            The <span className="text-gradient">agentic</span> chat portal<br />that actually does the work.
          </h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto mb-9 leading-relaxed">
            Deep research, vision, image &amp; document generation, MCP connectors, skills, and a live Agent Computer — all streamed in real time.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link href="/signup" className="group inline-flex items-center gap-2 px-6 py-3 rounded-xl text-white bg-[#c96442] hover:bg-[#b5593a] active:bg-[#a34e34] transition font-medium shadow-[0_2px_16px_rgba(201,100,66,0.28)]">
              Try it free <ArrowRight size={17} className="group-hover:translate-x-0.5 transition" />
            </Link>
            <a href="#pricing" className="px-6 py-3 rounded-xl glass hover:border-white/15 hover:bg-white/[0.06] transition text-slate-300 font-medium">
              See pricing
            </a>
          </div>
        </motion.div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-5 py-14">
        <h2 className="text-3xl font-semibold text-center mb-2 text-slate-100">Everything a flagship assistant has</h2>
        <p className="text-slate-500 text-center mb-10">And the transparency of watching it work.</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((f, i) => {
            const Icon = f.icon
            return (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.04 }}
                className="glass rounded-2xl p-5 hover:border-white/12 hover:bg-white/[0.06] transition cursor-default"
              >
                <div className="w-9 h-9 rounded-xl bg-[#c96442]/12 border border-[#c96442]/20 flex items-center justify-center mb-3">
                  <Icon size={17} className="text-[#c96442]" />
                </div>
                <div className="font-medium text-slate-100 text-[14px] mb-1">{f.title}</div>
                <div className="text-[13px] text-slate-500 leading-relaxed">{f.desc}</div>
              </motion.div>
            )
          })}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-4xl mx-auto px-5 py-16">
        <h2 className="text-3xl font-semibold text-center mb-2 text-slate-100">Simple pricing</h2>
        <p className="text-slate-500 text-center mb-10">Start free. Upgrade when you need more.</p>
        <div className="grid sm:grid-cols-2 gap-5">
          {PLANS.map((p) => (
            <div
              key={p.name}
              className={`rounded-2xl p-6 ${p.highlight ? 'glass-strong accent-ring' : 'glass'}`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-lg text-slate-100">{p.name}</span>
                {p.highlight && (
                  <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-[#c96442]/15 text-[#c96442] border border-[#c96442]/25 font-medium">
                    Popular
                  </span>
                )}
              </div>
              <div className="mb-5">
                <span className="text-4xl font-semibold text-white">{p.price}</span>
                <span className="text-slate-500 ml-1">{p.period}</span>
              </div>
              <ul className="space-y-2 mb-6">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[13px] text-slate-300">
                    <Check size={15} className="text-emerald-400/80 mt-0.5 shrink-0" />{f}
                  </li>
                ))}
              </ul>
              <Link
                href={p.href}
                className={`block text-center py-2.5 rounded-xl text-[14px] font-medium transition ${
                  p.highlight
                    ? 'text-white bg-[#c96442] hover:bg-[#b5593a] shadow-[0_2px_12px_rgba(201,100,66,0.22)]'
                    : 'glass hover:border-white/15 hover:bg-white/[0.06] text-slate-200'
                }`}
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>
        <p className="text-center text-[12px] text-slate-600 mt-6">
          AI usage is metered with credits so the free tier stays sustainable. Cancel anytime.
        </p>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-5 py-16 text-center">
        <div className="glass-strong rounded-3xl p-10">
          <div className="w-12 h-12 rounded-2xl bg-[#c96442]/12 border border-[#c96442]/20 flex items-center justify-center mx-auto mb-5">
            <Wrench size={22} className="text-[#c96442]" />
          </div>
          <h2 className="text-3xl font-semibold mb-3 text-slate-100">Put an agent to work in seconds.</h2>
          <p className="text-slate-400 mb-7">No setup. Ask a question, run deep research, or generate a document.</p>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-white bg-[#c96442] hover:bg-[#b5593a] transition font-medium shadow-[0_2px_16px_rgba(201,100,66,0.28)]"
          >
            Get started free <ArrowRight size={17} />
          </Link>
        </div>
      </section>

      <footer className="max-w-6xl mx-auto px-5 py-10 border-t border-white/[0.05] text-[13px] text-slate-500">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-[#c96442]" /> Loop GPT
          </div>
          <div className="flex items-center gap-4">
            <Link href="/signup" className="hover:text-slate-300 transition">Get started</Link>
            <a href="#pricing" className="hover:text-slate-300 transition">Pricing</a>
            <Link href="/login" className="hover:text-slate-300 transition">Log in</Link>
          </div>
          <span className="text-slate-600">© {new Date().getFullYear()} Loop GPT</span>
        </div>
        <div className="flex items-center justify-center gap-5 pt-4 border-t border-white/[0.04]">
          <Link href="/privacy" className="hover:text-slate-300 transition">Privacy</Link>
          <Link href="/terms" className="hover:text-slate-300 transition">Terms</Link>
          <Link href="/cookies" className="hover:text-slate-300 transition">Cookies</Link>
          <Link href="/acceptable-use" className="hover:text-slate-300 transition">Acceptable Use</Link>
        </div>
      </footer>
    </div>
  )
}
