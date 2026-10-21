import { describe, expect, it } from 'vitest';
import { emptyRunUiState, formatTokens, orderedDagNodes, reduceRunEvent } from '../src/runState';
import type { TaskDagView } from '../src/api';

const dag: TaskDagView = {
  plan_id: 'plan-a',
  goal: 'ship app',
  nodes: [
    { id: 'deploy', goal: 'deploy', dag_parents: ['ui', 'api'], expected_verification: ['L2_browser_smoke'], destructive: true, destructive_reason: 'publishes externally', status: 'blocked' },
    { id: 'api', goal: 'api', dag_parents: [], expected_verification: ['L1_tests'], destructive: false, status: 'running' },
    { id: 'ui', goal: 'ui', dag_parents: [], expected_verification: ['L1_tests'], destructive: false, status: 'merged' },
  ],
};

describe('run UI reducer', () => {
  it('orders DAG nodes topologically while keeping stable sibling order', () => {
    expect(orderedDagNodes(dag).map((node) => node.id)).toEqual(['api', 'ui', 'deploy']);
  });

  it('merges SSE events for gates, checkpoints, cost, and errors', () => {
    let state = emptyRunUiState();
    state = reduceRunEvent(state, { kind: 'dag', dag });
    state = reduceRunEvent(state, { kind: 'gate', gate: { gate_id: 'gate-a', action: 'Deploy', reason: 'Production write', destructive: true } });
    state = reduceRunEvent(state, { kind: 'checkpoints', checkpoints: [{ checkpoint_id: 'ckpt-a', parent_id: null, created_at: '2026-01-01T00:00:00Z', verified: true, live: true }] });
    state = reduceRunEvent(state, { kind: 'cost', cost: { input_tokens: 10, output_tokens: 12, iterations: 2 } });
    state = reduceRunEvent(state, { kind: 'error', message: 'boom' });
    expect(state.dag?.plan_id).toBe('plan-a');
    expect(state.gates).toHaveLength(1);
    expect(state.checkpoints[0]?.live).toBe(true);
    expect(formatTokens(state.cost)).toBe('22');
    expect(state.error).toBe('boom');
  });

  it('removes resolved gates from live prompts', () => {
    let state = reduceRunEvent(emptyRunUiState(), { kind: 'gate', gate: { gate_id: 'gate-a', action: 'A', reason: 'R', destructive: true } });
    state = reduceRunEvent(state, { kind: 'gate', gate: { gate_id: 'gate-a', action: 'A', reason: 'R', destructive: true, status: 'approved' } });
    expect(state.gates).toEqual([]);
  });
});
