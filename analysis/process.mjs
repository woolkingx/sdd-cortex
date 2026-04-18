// process.mjs — Execution flow tracing from entry points.
// Layer role (L1): pure fn, depends on entry-point.mjs + symbol-graph.mjs.
//
// fn chain: scoreEntryPoints → filter seeds → BFS downstream → ProcessTrace[]

import { scoreEntryPoints } from './entry-point.mjs'
import { outgoingEdges } from '../query/index.mjs'

const DEFAULT_SCORE_THRESHOLD = 0.4

/**
 * Load x-entry-points overrides from a parsed schema object.
 * Returns array of file paths declared as explicit entry points.
 * @param {object} schema  parsed schema object
 * @returns {string[]}
 */
export function loadEntryPointOverrides(schema) {
  try {
    return (schema['x-entry-points'] || []).map(e => e.file)
  } catch {
    return []
  }
}

/**
 * Trace execution flows from likely entry points.
 * @param {object} graph   - Graph instance
 * @param {object} opts
 * @param {number} [opts.threshold=0.4]   min entry point score to use as seed
 * @param {number} [opts.maxDepth=10]
 * @param {string[]} [opts.overrides]     explicit entry file paths (bypasses scoring)
 * @returns {ProcessTrace[]}
 */
export function traceProcesses(graph, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_SCORE_THRESHOLD
  const maxDepth  = opts.maxDepth  ?? 10

  const seeds = opts.overrides?.length
    ? opts.overrides
    : scoreEntryPoints()
        .filter(e => e.score >= threshold)
        .map(e => e.file)

  return seeds.map(entry => _traceFrom(entry, maxDepth))
}

/**
 * BFS downstream from a single entry file.
 * @private
 */
function _traceFrom(entry, maxDepth) {
  const visited  = new Set([entry])
  const steps    = []
  const terminals = []
  let frontier   = [entry]
  let depth      = 0

  while (frontier.length > 0 && depth < maxDepth) {
    const next = []
    for (const file of frontier) {
      const edges = outgoingEdges(file)
      const children = edges
        .map(e => e.to)
        .filter(to => !visited.has(to))

      if (children.length === 0 && file !== entry) {
        terminals.push(file)
      }

      for (const child of children) {
        visited.add(child)
        steps.push(child)
        next.push(child)
      }
    }
    frontier = next
    if (frontier.length > 0) depth++
  }

  // Files in visited that have no outgoing edges within the trace = terminals
  // (re-compute to catch nodes that had edges but all targets already visited)
  const stepSet = new Set(steps)
  const finalTerminals = [...new Set([
    ...terminals,
    ...steps.filter(f => outgoingEdges(f).every(e => !stepSet.has(e.to) || e.to === f))
  ])].sort()

  return { entry, steps, terminals: finalTerminals, depth }
}
