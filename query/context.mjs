// context.mjs — 360-degree view of a symbol or file.
// Layer role (L1): pure fn query over L0 symbol-graph views.

import { graph } from '../graph/index.mjs'
import { NL, loader as rootLoader } from '../lib/schema-loader.mjs'
import { ObjectTree } from '../lib/schema2object.mjs'
import { getSymbol, incomingEdges, outgoingEdges, incomingSymbolEdges, outgoingSymbolEdges } from './symbol-graph.mjs'

function _getContextSchema() {
  return rootLoader.resolve('schema/query/query.json#/definitions/ContextResult')
}

/**
 * Get 360-degree context for a target symbol or file.
 * Returns both file-level and fn-level edges.
 * @param {object} _graph   - Graph instance (unused, kept for API compat)
 * @param {string} target  - symbol name, "file::fn", or file path
 * @returns {ContextResult}
 */
export function context(_graph, target) {
  const symbols = _resolveSymbols(target)
  const files = symbols.length > 0
    ? [...new Set(symbols.map(s => s.file))]
    : graph.nodes.has(target) ? [target] : []

  const callers   = files.flatMap(f => incomingEdges(f))
  const callees   = files.flatMap(f => outgoingEdges(f))
  const fnCallers = symbols.flatMap(s => incomingSymbolEdges(s.file, s.name))
  const fnCallees = symbols.flatMap(s => outgoingSymbolEdges(s.file, s.name))

  const { node, loader: sub } = _getContextSchema()
  const result = new ObjectTree({ target, symbols, callers, callees, fnCallers, fnCallees }, node, sub)
  return result.$toDict()
}

/** @private */
function _resolveSymbols(target) {
  // "file::fn" format
  if (target.includes('::')) {
    const node = graph.nodes.get(target)
    return node ? [node] : []
  }

  // File path — return all symbols in that file
  if (graph.nodes.has(target)) {
    return [...graph.nodes.values()].filter(n => n.file === target && n.label !== NL.FILE)
  }

  // Symbol name search
  return getSymbol(target)
}
