/**
 * hot-paths.mjs — Find longest dependency paths using graph struct.
 * Computes longest path from each node via memoized recursion.
 */

import { outNeighbors } from '../graph/index.mjs'

/**
 * Find top N longest dependency paths in the graph.
 * @param {Object} g - graph struct { nodes, edges, _neighbors }
 * @param {number} [topN=3] - number of paths to return
 * @returns {Array<{path: string[], length: number}>}
 */
export function findHotPaths(g, topN = 3) {
  const memo = new Map()
  const visiting = new Set()
  const allPaths = []

  function _longestFrom(node) {
    if (memo.has(node)) return memo.get(node)
    if (visiting.has(node)) return [node]

    visiting.add(node)
    let best = [node]

    // Use graph struct outNeighbors API
    for (const next of outNeighbors(g, node)) {
      const sub = _longestFrom(next)
      if (sub.length + 1 > best.length) {
        best = [node, ...sub]
      }
    }

    visiting.delete(node)
    memo.set(node, best)
    return best
  }

  // Compute longest path from each node
  for (const node of g.nodes.keys()) {
    const p = _longestFrom(node)
    if (p.length >= 2) {
      allPaths.push({ path: p, length: p.length })
    }
  }

  // Sort by length descending, deduplicate, and return top N
  allPaths.sort((a, b) => b.length - a.length)

  const unique = []
  for (const p of allPaths) {
    const key = p.path.join('→')
    if (!unique.some(u => u.path.join('→').includes(key))) {
      unique.push(p)
    }
    if (unique.length >= topN) break
  }

  return unique
}
