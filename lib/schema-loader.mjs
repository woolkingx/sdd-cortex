// schema-loader.mjs — Root Loader hub for all schemas
// Config Hub Pattern (per schema2object-usage.md):
// graph-analysis.json is root hub, $ref's schema/acorn/ and schema/graph/.
// Single Loader, base dir = master/ (project root).

import { Loader } from './schema2object.mjs'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const _rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

// graph-analysis.json = root hub schema
// $ref paths like "schema/graph/edge.json" resolve relative to _rootDir (master/)
const _analysisPath = join(_rootDir, 'graph-analysis.json')
const _analysisSchema = JSON.parse(readFileSync(_analysisPath, 'utf8'))

// Single root Loader — resolves ALL $ref chains through one hub
// Base dir = _rootDir so "schema/acorn/node.json" → master/schema/acorn/node.json
export const loader = new Loader(_analysisSchema, _rootDir)

export function resolve(ref) {
  return loader.resolve(ref)
}

export const defs = _analysisSchema.definitions

// ── Schema-resolved enums (CPG-lite labels) ──────────────────────────────────
// Read from schema at boot — code never hardcodes these strings.
const _nodeSchema = JSON.parse(readFileSync(join(_rootDir, 'schema', 'graph', 'node.json'), 'utf8'))
const _edgeSchema = JSON.parse(readFileSync(join(_rootDir, 'schema', 'graph', 'edge.json'), 'utf8'))

/** NodeLabel enum values from schema/graph/node.json */
export const NODE_LABELS = _nodeSchema.definitions.NodeLabel.enum
/** EdgeLabel enum values from schema/graph/edge.json */
export const EDGE_LABELS = _edgeSchema.definitions.EdgeLabel.enum

/** Lookup sets for O(1) validation */
export const NODE_LABEL_SET = new Set(NODE_LABELS)
export const EDGE_LABEL_SET = new Set(EDGE_LABELS)

/** Shorthand accessors — import { NL, EL } from './schema-loader.mjs' */
export const NL = Object.fromEntries(NODE_LABELS.map(l => [l, l]))
export const EL = Object.fromEntries(EDGE_LABELS.map(l => [l, l]))

// Backward compat — same loader, no separate instance
export const analysisLoader = loader
