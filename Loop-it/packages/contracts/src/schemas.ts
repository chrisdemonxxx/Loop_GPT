/**
 * Locating the schema files at runtime.
 *
 * Consumers validate against the shipped `.json` files rather than a copy
 * embedded in this bundle, so there is exactly one authoritative definition and
 * no possibility of the TypeScript build going stale against it.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SCHEMA_FILES = [
  'tool-call.schema.json',
  'task-dag.schema.json',
  'audit-event.schema.json',
  'egress-policy.schema.json',
] as const;

export type SchemaFile = (typeof SCHEMA_FILES)[number];

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function schemaPath(name: SchemaFile): string {
  return join(packageRoot, 'schemas', name);
}
