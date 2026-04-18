/**
 * stats.mjs — Aggregate analysis statistics.
 * Extends with modularity, betweenness, pagerank, and clustering metrics.
 */

import { outNeighbors, inNeighbors, outEdges } from '../graph/index.mjs'

/**
 * Compute aggregate statistics from analysis results.
 * @param {Array<ParsedFile>} files - parsed files
 * @param {Array<Edge>} edges - graph edges
 * @param {Object} g - graph struct { nodes, edges, _neighbors }
 * @param {Array} cycles - from detectCycles()
 * @param {Array} violations - from detectViolations()
 * @param {Array} hotPaths - from findHotPaths()
 * @param {Array} complexity - from computeComplexity()
 * @param {Array} clusters - from detectClusters()
 * @param {Array} centrality - from computeCentrality()
 * @param {Array} duplicates - from detectDuplicateInstantiations()
 * @returns {object} statistics object
 */
export function computeStats(
  files,
  edges,
  g,
  cycles,
  violations,
  hotPaths,
  complexity,
  clusters = [],
  centrality = [],
  duplicates = [],
) {
  const depthMap = _computeDepth(g)

  const connected = new Set()
  for (const e of edges) {
    connected.add(e.from)
    connected.add(e.to)
  }
  const orphans = files.filter(f => !connected.has(f.path))

  // Centrality statistics
  const avgBetweenness = centrality.length > 0
    ? centrality.reduce((sum, c) => sum + c.betweenness, 0) / centrality.length
    : 0
  const maxBetweenness = centrality.length > 0
    ? Math.max(...centrality.map(c => c.betweenness))
    : 0
  const maxPagerank = centrality.length > 0
    ? Math.max(...centrality.map(c => c.pagerank))
    : 0

  // Clustering modularity
  const avgModularity = clusters.length > 0
    ? clusters.filter(c => typeof c.modularity === 'number').reduce((sum, c) => sum + c.modularity, 0) /
      clusters.length
    : 0

  // Clustering coefficient (simplified: local density)
  const clusteringCoeff = _computeClusteringCoefficient(g)

  return {
    total_files: files.length,
    total_edges: edges.length,
    confirmed_violations: violations.filter(v => v.confirmed).length,
    false_positives: violations.filter(v => !v.confirmed).length,
    orphan_nodes: orphans.length,
    complex_files: complexity.length,
    cycles: cycles.length,
    max_fan_in: complexity.length > 0 ? Math.max(...complexity.map(c => c.fan_in)) : 0,
    max_fan_out: complexity.length > 0 ? Math.max(...complexity.map(c => c.fan_out)) : 0,
    longest_path: hotPaths.length > 0 ? hotPaths[0].length : 0,
    max_depth: Math.max(0, ...depthMap.values()),
    duplicate_instantiations: duplicates.length,

    // New metrics
    modularity: avgModularity,
    num_clusters: clusters.length,
    max_betweenness: maxBetweenness,
    avg_betweenness: avgBetweenness,
    max_pagerank: maxPagerank,
    avg_clustering_coefficient: clusteringCoeff,
  }
}

/**
 * Compute longest path depth from each node using graph struct.
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

/**
 * Compute average clustering coefficient (local transitivity).
 * Approximated: ratio of actual triangles to possible triangles per node.
 * @private
 */
function _computeClusteringCoefficient(g) {
  if (g.nodes.size === 0) return 0

  let totalCoeff = 0
  let count = 0

  for (const node of g.nodes.keys()) {
    const neighbors = new Set([
      ...inNeighbors(g, node),
      ...outNeighbors(g, node),
    ])

    if (neighbors.size < 2) continue

    // Count edges between neighbors
    let edgeCount = 0
    const neighborArray = [...neighbors]
    for (let i = 0; i < neighborArray.length; i++) {
      for (let j = i + 1; j < neighborArray.length; j++) {
        // Check if edge exists in either direction
        const hasForward = outEdges(g, neighborArray[i]).some(e => e.to === neighborArray[j])
        const hasBackward = outEdges(g, neighborArray[j]).some(e => e.to === neighborArray[i])
        if (hasForward || hasBackward) {
          edgeCount++
        }
      }
    }

    // Possible edges between neighbors
    const possibleEdges = (neighbors.size * (neighbors.size - 1)) / 2
    const coeff = edgeCount / possibleEdges
    totalCoeff += coeff
    count++
  }

  return count > 0 ? totalCoeff / count : 0
}
