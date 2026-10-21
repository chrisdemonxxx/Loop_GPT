/**
 * `@loop-it/contracts` — the shared contract between planes.
 *
 * The JSON Schemas under `schemas/` are the single source of truth; everything
 * exported here mirrors them and is checked against them in CI. Any service in
 * any language validates against the same schema files, so a contract change
 * cannot land in one plane and quietly break another.
 */

export * from './audit-event.js';
export * from './egress-policy.js';
export * from './task-dag.js';
export * from './tool-call.js';

export { schemaPath, SCHEMA_FILES } from './schemas.js';
