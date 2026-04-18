/**
 * cycles.mjs — Detect circular dependencies using DFS.
 * Uses graph struct for efficient traversal.
 */

import { outNeighbors } from '../graph/index.mjs'

/**
 * Detect cycles in the dependency graph using depth-first search.
 * @param {Object} g - graph struct { nodes, edges, _neighbors }
 * @returns {Array<{path: string[], length: number}>}
 */
export function detectCycles(g) {
  const cycles = []
  const visited = new Set()
  const stack = new Set()
  const path = []

  function _dfs(node) {
    if (stack.has(node)) {
      const idx = path.indexOf(node)
      if (idx >= 0) {
        const cycle = path.slice(idx)
        cycles.push({ path: cycle, length: cycle.length })
      }
      return
    }
    if (visited.has(node)) return

    visited.add(node)
    stack.add(node)
    path.push(node)

    // Use graph struct neighbors API
    for (const next of outNeighbors(g, node)) {
      _dfs(next)
    }

    path.pop()
    stack.delete(node)
  }

  // Start DFS from all nodes
  for (const node of g.nodes.keys()) {
    if (!visited.has(node)) {
      _dfs(node)
    }
  }

  return cycles
}
