/**
 * Drift tests: the TypeScript types must agree with the JSON Schemas.
 *
 * The schemas are the authority. These tests exist because a hand-maintained
 * mirror silently rots — a tool added to the schema but not to `TOOL_NAMES`
 * would otherwise be invisible until a runtime rejection in production.
 */

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  ALWAYS_DENIED_CIDRS,
  AUDIT_EVENT_TYPES,
  DESTRUCTIVE_TOOLS,
  SCHEMA_FILES,
  TASK_KINDS,
  TOOL_NAMES,
  VERIFICATION_LAYERS,
  defaultBuildPolicy,
  isDestructive,
  isProjectPath,
  readyNodes,
  schemaPath,
  validateDag,
  validateEgressPolicy,
  violatesPlaneSeparation,
} from '../src/index.js';
import type { AuditEvent, EgressPolicy, TaskDAG, TaskNode } from '../src/index.js';

type Json = Record<string, any>;

function loadSchema(name: (typeof SCHEMA_FILES)[number]): Json {
  return JSON.parse(readFileSync(schemaPath(name), 'utf-8')) as Json;
}

function compile(name: (typeof SCHEMA_FILES)[number]) {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv.compile(loadSchema(name));
}

function node(overrides: Partial<TaskNode> & Pick<TaskNode, 'id'>): TaskNode {
  return {
    kind: 'add_ui_component',
    goal: overrides.id,
    dag_parents: [],
    expected_verification: ['L1_tests'],
    destructive: false,
    ...overrides,
  };
}

describe('schemas', () => {
  it.each(SCHEMA_FILES)('%s compiles under draft 2020-12', (name) => {
    expect(() => compile(name)).not.toThrow();
  });
});

describe('tool-call types mirror the schema', () => {
  it('exposes exactly the tools the schema allows', () => {
    const fromSchema: string[] = loadSchema('tool-call.schema.json').properties.tool.enum;
    expect([...TOOL_NAMES].sort()).toEqual([...fromSchema].sort());
  });

  it('has no whole-file write tool (invariant I6)', () => {
    for (const forbidden of ['write_file', 'overwrite_file', 'create_file', 'put_file']) {
      expect(TOOL_NAMES).not.toContain(forbidden);
    }
  });

  it('treats deploy as destructive so it must pass a confirmation gate (I7)', () => {
    expect(DESTRUCTIVE_TOOLS).toContain('deploy');
    expect(isDestructive('deploy')).toBe(true);
    expect(isDestructive('read_file')).toBe(false);
  });

  it('rejects absolute paths and parent traversal', () => {
    expect(isProjectPath('src/app.ts')).toBe(true);
    expect(isProjectPath('/etc/passwd')).toBe(false);
    expect(isProjectPath('../../../etc/passwd')).toBe(false);
    expect(isProjectPath('src/../../secrets')).toBe(false);
    expect(isProjectPath('')).toBe(false);
  });

  it('agrees with the schema pattern on project paths', () => {
    const pattern = new RegExp(loadSchema('tool-call.schema.json').$defs.projectPath.pattern);
    for (const value of [
      'src/app.ts',
      'a/b/c.tsx',
      'README.md',
      '/abs/path',
      '../escape',
      'a/../../b',
    ]) {
      expect(pattern.test(value)).toBe(isProjectPath(value));
    }
  });

  it('validates a real tool call against the schema', () => {
    const validate = compile('tool-call.schema.json');
    expect(validate({ tool: 'read_file', args: { path: 'src/app.ts' } })).toBe(true);
    expect(validate({ tool: 'read_file', args: { path: '../../etc/passwd' } })).toBe(false);
  });
});

describe('audit-event types mirror the schema', () => {
  it('exposes exactly the event types the schema allows', () => {
    const fromSchema: string[] = loadSchema('audit-event.schema.json').properties.type.enum;
    expect([...AUDIT_EVENT_TYPES].sort()).toEqual([...fromSchema].sort());
  });

  it('flags an agent acting in the control plane (invariant I1)', () => {
    const base: AuditEvent = {
      event_id: 'ev_1',
      occurred_at: '2025-01-01T00:00:00Z',
      type: 'tool.called',
      actor: { kind: 'agent', id: 'agent_1' },
      tenant_id: 'tenant_a',
    };
    expect(violatesPlaneSeparation({ ...base, plane: 'control' })).toBe(true);
    expect(violatesPlaneSeparation({ ...base, plane: 'data' })).toBe(false);
    expect(violatesPlaneSeparation({ ...base, actor: { kind: 'service' }, plane: 'control' })).toBe(
      false,
    );
  });

  it('validates a real event against the schema', () => {
    const event: AuditEvent = {
      event_id: 'ev_1',
      occurred_at: '2025-01-01T00:00:00Z',
      type: 'model.called',
      actor: { kind: 'service', service: 'router-svc' },
      tenant_id: 'tenant_a',
      plane: 'control',
      outcome: 'success',
      cost: { input_tokens: 100, output_tokens: 50, credits: 0.01 },
    };
    expect(compile('audit-event.schema.json')(event)).toBe(true);
  });
});

describe('task-dag types mirror the schema', () => {
  it('exposes exactly the verification layers the schema allows', () => {
    const fromSchema: string[] =
      loadSchema('task-dag.schema.json').$defs.taskNode.properties.expected_verification.items.enum;
    expect([...VERIFICATION_LAYERS].sort()).toEqual([...fromSchema].sort());
  });

  it('exposes exactly the task kinds the schema allows', () => {
    const fromSchema: string[] =
      loadSchema('task-dag.schema.json').$defs.taskNode.properties.kind.enum;
    expect([...TASK_KINDS].sort()).toEqual([...fromSchema].sort());
  });

  it('requires a kind on every node', () => {
    // A node without a kind has no tool allowlist and no verification floor.
    const { kind, ...withoutKind } = node({ id: 'a' });
    expect(kind).toBeDefined();
    expect(compile('task-dag.schema.json')({ plan_id: 'p', goal: 'g', nodes: [withoutKind] })).toBe(
      false,
    );
  });

  it('accepts a well-formed plan', () => {
    const dag: TaskDAG = {
      plan_id: 'plan_1',
      goal: 'build a todo app',
      nodes: [node({ id: 'schema' }), node({ id: 'ui', dag_parents: ['schema'] })],
    };
    expect(validateDag(dag)).toEqual([]);
    expect(compile('task-dag.schema.json')(dag)).toBe(true);
  });

  it('detects a dependency cycle the schema cannot see', () => {
    const dag: TaskDAG = {
      plan_id: 'plan_1',
      goal: 'g',
      nodes: [node({ id: 'a', dag_parents: ['b'] }), node({ id: 'b', dag_parents: ['a'] })],
    };
    expect(compile('task-dag.schema.json')(dag)).toBe(true);
    expect(validateDag(dag).map((error) => error.code)).toContain('cycle');
  });

  it('detects a dependency on a node that does not exist', () => {
    const dag: TaskDAG = {
      plan_id: 'plan_1',
      goal: 'g',
      nodes: [node({ id: 'a', dag_parents: ['ghost'] })],
    };
    expect(validateDag(dag).map((error) => error.code)).toContain('unknown-parent');
  });

  it('requires a reason for a destructive task so the human gate can explain itself', () => {
    const dag: TaskDAG = {
      plan_id: 'plan_1',
      goal: 'g',
      nodes: [node({ id: 'a', goal: 'drop the table', destructive: true })],
    };
    expect(validateDag(dag).map((error) => error.code)).toContain('missing-destructive-reason');
    expect(compile('task-dag.schema.json')(dag)).toBe(false);
  });

  it('reports which nodes may start in parallel', () => {
    const dag: TaskDAG = {
      plan_id: 'plan_1',
      goal: 'g',
      nodes: [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c', dag_parents: ['a', 'b'] })],
    };
    expect(readyNodes(dag, new Set()).map((n) => n.id)).toEqual(['a', 'b']);
    expect(readyNodes(dag, new Set(['a', 'b'])).map((n) => n.id)).toEqual(['c']);
  });
});

describe('egress policy', () => {
  it('the default build policy is deny-by-default and validates', () => {
    const policy = defaultBuildPolicy();
    expect(policy.default_action).toBe('deny');
    expect(validateEgressPolicy(policy)).toEqual([]);
    expect(compile('egress-policy.schema.json')(policy)).toBe(true);
  });

  it('denies the cloud metadata endpoint unconditionally (invariant I4)', () => {
    expect(ALWAYS_DENIED_CIDRS).toContain('169.254.0.0/16');
    expect(ALWAYS_DENIED_CIDRS).toContain('fd00:ec2::/32');
  });

  it('refuses to leave deploy targets open outside a deploy step', () => {
    const policy: EgressPolicy = {
      default_action: 'deny',
      categories: [{ name: 'deploy_targets', enabled: true, window: 'always' }],
    };
    expect(validateEgressPolicy(policy).map((error) => error.code)).toContain('deploy-window');
    expect(compile('egress-policy.schema.json')(policy)).toBe(false);
  });

  it('refuses an unreviewable wildcard allow entry', () => {
    const policy: EgressPolicy = { ...defaultBuildPolicy(), extra_allow: ['*'] };
    expect(validateEgressPolicy(policy).map((error) => error.code)).toContain('wildcard-domain');
  });

  it('opens registries and the router but nothing else', () => {
    const enabled = defaultBuildPolicy()
      .categories.filter((category) => category.enabled)
      .map((category) => category.name);
    expect(enabled).toEqual(['package_registries', 'model_router']);
  });
});
