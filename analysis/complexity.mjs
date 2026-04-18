/**
 * complexity.mjs — Compute complexity metrics using graph struct degree APIs.
 * Uses outDegree() and inDegree() for fan-in/fan-out.
 */

import { outDegree, inDegree, outNeighbors } from '../graph/index.mjs'

/**
 * Compute complexity metrics for each file node.
 * @param {Array<ParsedFile>} files - parsed file metadata
 * @param {Object} g - graph struct { nodes, edges, _neighbors }
 * @returns {Array<{file, functions, exports, internals, ratio, calls, classes, fan_in, fan_out, depth, lines}>}
 */
export function computeComplexity(files, g) {
  const depthMap = _computeDepth(g)

  return files.map(f => {
    const fanOut = outDegree(g, f.path) || 0
    const fanIn = inDegree(g, f.path) || 0

    return {
      file: f.path,
      functions: f.functions.length,
      exports: f.exports.length,
      internals: f.functions.filter(fn => !fn.isExported).length,
      ratio:
        f.exports.length > 0
          ? +(f.functions.filter(fn => !fn.isExported).length / f.exports.length).toFixed(1)
          : f.functions.filter(fn => !fn.isExported).length,
      calls: f.calls.length,
      classes: f.classes.length,
      fan_in: fanIn,
      fan_out: fanOut,
      depth: depthMap.get(f.path) || 0,
      lines: f.lines,
    }
  })
}

/**
 * Compute longest path depth from each node to any leaf.
 * @private
 */
function _computeDepth(g) {
  const memo = new Map()
  const visiting = new Set()

  function _max(node) {
    if (memo.has(node)) return memo.get(node)
    if (visiting.has(node)) return 0

    visiting.add(node)
    let m = 0

    // Use graph struct outNeighbors API
    for (const next of outNeighbors(g, node)) {
      m = Math.max(m, 1 + _max(next))
    }

    visiting.delete(node)
    memo.set(node, m)
    return m
  }

  for (const node of g.nodes.keys()) {
    _max(node)
  }

  return memo
}
