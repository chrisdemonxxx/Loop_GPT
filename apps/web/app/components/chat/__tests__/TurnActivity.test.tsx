import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TurnActivity from '../TurnActivity'
import type { LiveStep, StoredStep, PendingApproval } from '../types'

/** Inline agent-activity block (audit P1): summary line, auto expand/collapse,
 * per-step durations, error Retry, and the approval card. */

const toolStep = (over: Partial<LiveStep> = {}): LiveStep => ({
  index: over.index ?? 1,
  kind: 'tool',
  text: '',
  ts: over.ts ?? Date.now(),
  ...over,
  tool: { name: 'web_search', args: { query: 'cats' }, ...(over.tool || {}) },
})

describe('TurnActivity — stored turn summary', () => {
  const stored: StoredStep[] = [
    { tool: 'web_search', args: { query: 'cats' }, result: 'found' },
    { tool: 'web_fetch', args: { url: 'https://x' }, result: 'ok' },
    { tool: 'execute_code', args: { code: '1+1' }, result: '2' },
  ]

  it('renders a collapsed "Ran 3 steps" summary', () => {
    render(<TurnActivity storedSteps={stored} />)
    expect(screen.getByText('Ran 3 steps')).toBeInTheDocument()
    // Collapsed by default: the step names are not rendered yet.
    expect(screen.queryByText('web_search')).not.toBeInTheDocument()
  })

  it('expands on click and lists the step tool names', () => {
    render(<TurnActivity storedSteps={stored} />)
    fireEvent.click(screen.getByRole('button', { name: /ran 3 steps/i }))
    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.getByText('web_fetch')).toBeInTheDocument()
    expect(screen.getByText('execute_code')).toBeInTheDocument()
  })

  it('renders nothing for a stored turn without steps', () => {
    const { container } = render(<TurnActivity storedSteps={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('TurnActivity — live turn', () => {
  it('is auto-expanded while running and shows the streaming step', () => {
    const steps = [toolStep({ tool: { name: 'web_search', args: { query: 'cats' } } })]
    render(<TurnActivity running status="searching" liveSteps={steps} />)
    expect(screen.getByText('web_search')).toBeInTheDocument()
  })

  it('auto-collapses when the run finishes (audit P1 fix)', async () => {
    const steps = [toolStep({ tool: { name: 'web_search', args: {}, result: 'done' } })]
    const { rerender } = render(<TurnActivity running liveSteps={steps} />)
    expect(screen.getByText('web_search')).toBeInTheDocument()
    rerender(<TurnActivity running={false} liveSteps={steps} />)
    // The collapse runs a 180ms exit animation; wait for the timeline to leave.
    await waitFor(() => expect(screen.queryByText('web_search')).not.toBeInTheDocument())
    expect(screen.getByText('Ran 1 step')).toBeInTheDocument()
  })

  it('shows a Retry button on the error state and dispatches onRetry', () => {
    const onRetry = vi.fn()
    const steps = [toolStep({ tool: { name: 'web_search', args: {}, result: 'boom', isError: true } })]
    render(<TurnActivity running={false} liveSteps={steps} onRetry={onRetry} />)
    expect(screen.getByText('Ran 1 step')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('shows the per-step wall duration next to finished steps', () => {
    const steps = [toolStep({ tool: { name: 'web_search', args: {}, result: 'ok', durationMs: 1234 } })]
    render(<TurnActivity running liveSteps={steps} />)
    expect(screen.getByText('1.2s')).toBeInTheDocument()
  })
})

describe('TurnActivity — approval card', () => {
  it('renders Approve/Deny and dispatches the decisions', () => {
    const approve = vi.fn(() => Promise.resolve())
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    const pending: PendingApproval = { toolName: 'execute_code', approve }
    const steps = [toolStep({ tool: { name: 'execute_code', args: {} } })]
    render(<TurnActivity running liveSteps={steps} pendingApproval={pending} onApprove={onApprove} onDeny={onDeny} />)
    expect(screen.getByText(/tool requires approval/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onDeny).toHaveBeenCalledOnce()
  })
})

describe('TurnActivity — live output + progress + view-in-panel (§8-28/29)', () => {
  it('streams live stdout/stderr in the step card while running (§8-28)', () => {
    const steps = [toolStep({ tool: {
      name: 'execute_code', args: { language: 'python' },
      liveOutput: { stdout: 'training epoch 3\nloss 0.42\n', stderr: 'warn: deprecated api\n' },
    } })]
    render(<TurnActivity running liveSteps={steps} />)
    expect(screen.getByText('Live output')).toBeInTheDocument()
    expect(screen.getByText(/training epoch 3/)).toBeInTheDocument()
    expect(screen.getByText(/deprecated api/)).toBeInTheDocument()
    // No result yet: the placeholder "running…" is replaced by the live block.
    expect(screen.queryByText('running…')).not.toBeInTheDocument()
  })

  it('renders the progress checklist while the step runs (§8-29)', () => {
    const steps = [toolStep({ tool: {
      name: 'create_document', args: { format: 'pdf' },
      progress: [
        { id: 'build', label: 'Build PDF file', status: 'done' },
        { id: 'save', label: 'Save artifact', status: 'active' },
      ],
    } })]
    render(<TurnActivity running liveSteps={steps} />)
    expect(screen.getByText('Build PDF file')).toBeInTheDocument()
    expect(screen.getByText('Save artifact')).toBeInTheDocument()
  })

  it('surfaces a compact View-in-panel jump on the collapsed step row (§8-28)', () => {
    const onOpenArtifactByName = vi.fn()
    const steps = [toolStep({ tool: { name: 'execute_code', args: {}, result: 'done', artifacts: ['chart.png'] } })]
    render(<TurnActivity running={false} liveSteps={steps} onOpenArtifactByName={onOpenArtifactByName} />)
    // Expand the turn timeline first — the step rows live inside it.
    fireEvent.click(screen.getByRole('button', { name: /ran 1 step/i }))
    fireEvent.click(screen.getByRole('button', { name: /view chart\.png in panel/i }))
    expect(onOpenArtifactByName).toHaveBeenCalledWith('chart.png')
  })

  it('expands to named View-in-panel links for every step artifact', () => {
    const onOpenArtifactByName = vi.fn()
    const steps = [toolStep({ index: 1, tool: { name: 'execute_code', args: {}, result: 'ok', artifacts: ['a.png', 'b.csv'] } })]
    render(<TurnActivity running liveSteps={steps} onOpenArtifactByName={onOpenArtifactByName} />)
    fireEvent.click(screen.getByText('execute_code').closest('[role="button"]') as HTMLElement)
    fireEvent.click(screen.getByText('b.csv'))
    expect(onOpenArtifactByName).toHaveBeenCalledWith('b.csv')
  })

  it('stored steps link their persisted artifact names to View in panel', () => {
    const onOpenArtifactByName = vi.fn()
    const stored: StoredStep[] = [
      { tool: 'create_document', args: {}, result: 'created', artifacts: ['report.pdf'] },
    ]
    render(<TurnActivity storedSteps={stored} onOpenArtifactByName={onOpenArtifactByName} />)
    fireEvent.click(screen.getByRole('button', { name: /ran 1 step/i }))
    fireEvent.click(screen.getByText('create_document').closest('[role="button"]') as HTMLElement)
    fireEvent.click(screen.getByText('report.pdf'))
    expect(onOpenArtifactByName).toHaveBeenCalledWith('report.pdf')
  })
})
