'use client'

import { useState, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import 'highlight.js/styles/atom-one-dark.css'

function CodeBlock({ className, children }: { className?: string; children: any }) {
  const [copied, setCopied] = useState(false)
  const lang = /language-(\w+)/.exec(className || '')?.[1]
  const text = String(children).replace(/\n$/, '')
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-white/10 bg-[#0d1117]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10 bg-white/[0.03]">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{lang || 'code'}</span>
        <button onClick={copy} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition">
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed"><code className={className}>{children}</code></pre>
    </div>
  )
}

/** Claude-style rich markdown for assistant messages. */
function MarkdownImpl({ content }: { content: string }) {
  return (
    <div className="prose-chat text-[15px] leading-[1.7] text-slate-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ node, className, children, ...props }: any) {
            const isBlock = /language-/.test(className || '') || String(children).includes('\n')
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>
            return <code className="rounded bg-white/10 px-1.5 py-0.5 text-[13px] text-slate-100" {...props}>{children}</code>
          },
          a: ({ node, ...props }: any) => <a {...props} target="_blank" rel="noreferrer" className="text-sky-400 underline underline-offset-2 hover:opacity-80" />,
          table: ({ node, ...props }: any) => <div className="my-3 overflow-x-auto"><table className="w-full text-sm border-collapse" {...props} /></div>,
          th: ({ node, ...props }: any) => <th className="border border-white/10 px-3 py-1.5 text-left bg-white/[0.03] font-medium" {...props} />,
          td: ({ node, ...props }: any) => <td className="border border-white/10 px-3 py-1.5" {...props} />,
          ul: ({ node, ...props }: any) => <ul className="my-2 list-disc pl-5 space-y-1" {...props} />,
          ol: ({ node, ...props }: any) => <ol className="my-2 list-decimal pl-5 space-y-1" {...props} />,
          h1: ({ node, ...props }: any) => <h1 className="mt-4 mb-2 text-xl font-semibold" {...props} />,
          h2: ({ node, ...props }: any) => <h2 className="mt-4 mb-2 text-lg font-semibold" {...props} />,
          h3: ({ node, ...props }: any) => <h3 className="mt-3 mb-1.5 text-base font-semibold" {...props} />,
          p: ({ node, ...props }: any) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
          blockquote: ({ node, ...props }: any) => <blockquote className="my-3 border-l-2 border-white/20 pl-3 text-slate-300" {...props} />,
          hr: () => <hr className="my-4 border-white/10" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
export default Markdown
