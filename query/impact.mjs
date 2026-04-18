// impact.mjs — Blast radius BFS over symbol-graph.
// Layer role (L1): pure fn query over L0 symbol-graph views.
// Supports both file-level and fn-level granularity.

import { basename } from 'node:path'
import { graph as _graph, getNode } from '../graph/index.mjs'
import { NL, loader as rootLoader } from '../lib/schema-loader.mjs'
import { ObjectTree } from '../lib/schema2object.mjs'
import { getSymbol, incomingEdges, outgoingEdges } from './symbol-graph.mjs'

let _impactSchema = null
function _getImpactSchema() {
  if (_impactSchema) return _impactSchema
  _impactSchema = rootLoader.resolve('schema/query/query.json#/definitions/ImpactResult')
  return _impactSchema
}

/**
 * Compute impact (blast radius) for a target.
 * @param {object} graph       - Graph instance (kept for API compat)
 * @param {string} target      - symbol id ("file::fn"), symbol name, or file path
 * @param {object} opts
 * @param {"upstream"|"downstream"} [opts.direction="upstream"]
 * @param {number} [opts.maxDepth=3]
 * @param {"auto"|"file"|"symbol"} [opts.granularity="auto"]
 * @returns {ImpactResult}
 */
export function impact(graph, target, opts = {}) {
  const direction   = opts.direction   || 'upstream'
  const maxDepth    = opts.maxDepth    || 3
  const granularity = opts.granularity || 'auto'

  const seeds = _resolveSeeds(target)
  if (seeds.length === 0) {
    const { node, loader: sub } = _getImpactSchema()
    return new ObjectTree({ target, direction, seeds: [], depths: [], total: 0 }, node, sub).$toDict()
  }

  const useFnLevel = granularity === 'symbol' ||
    (granularity === 'auto' && seeds.some(s => s.includes('::')))

  const neighborFn = useFnLevel
    ? (node) => {
        return direction === 'upstream'
          ? _graph.edges.filter(e => e.to === node).map(e => e.from)
          : _graph.edges.filter(e => e.from === node).map(e => e.to)
      }
    : (file) => {
        return direction === 'upstream'
          ? incomingEdges(file).map(e => e.from)
          : outgoingEdges(file).map(e => e.to)
      }

  const visited = new Set(seeds)
  const depths  = []
  let frontier = [...seeds]

  for (let d = 1; d <= maxDepth; d++) {
    const next = new Set()
    for (const node of frontier) {
      for (const neighbor of neighborFn(node)) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        next.add(neighbor)
      }
    }
    if (next.size === 0) break
    const nodeIds = [...next].sort()
    const nodes = nodeIds.map(id => getNode(id) || { id, label: NL.FILE, name: id, file: id, parent: null, exported: false })
    depths.push({ depth: d, nodes, files: [...new Set(nodes.map(n => n.file))] })
    frontier = nodeIds
  }

  const total = depths.reduce((sum, d) => sum + d.nodes.length, 0)
  const { node, loader: sub } = _getImpactSchema()
  return new ObjectTree({ target, direction, seeds, depths, total }, node, sub).$toDict()
}

/** @private */
function _resolveSeeds(target) {
  if (target.includes('::')) {
    return _graph.nodes.has(target) ? [target] : []
  }
  if (_graph.nodes.has(target)) return [target]

  const targetBase = basename(target)
  for (const [id, node] of _graph.nodes) {
    if (node.label === NL.FILE && basename(id) === targetBase) return [id]
  }

  // EndsWith match
  for (const [id, node] of _graph.nodes) {
    if (node.label === NL.FILE && id.endsWith(target)) return [id]
  }

  const hits = getSymbol(target)
  if (hits.length > 0) return hits.map(h => h.id)
  return []
}
