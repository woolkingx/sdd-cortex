/**
 * centrality.mjs — Compute graph centrality metrics using graph struct.
 * Identifies bottleneck modules via betweenness and importance via pagerank.
 */

import { betweenness, pagerank, closeness, hits } from './algorithms.mjs'
import { degree } from '../graph/index.mjs'

/**
 * Compute centrality metrics for all nodes.
 * @param {Object} g - graph struct { nodes, edges, _neighbors }
 * @returns {Array<{file, symbol, node, betweenness, pagerank, degree, closeness, hub, authority}>} sorted by betweenness descending
 */
export function computeCentrality(g) {
  if (g.nodes.size === 0) return []

  // Compute betweenness centrality
  const betweennessMap = betweenness(g)

  // Compute pagerank
  const pageRankMap = pagerank(g)

  // Compute closeness centrality
  const closenessMap = closeness(g)

  // Compute HITS
  const { hubs, authorities } = hits(g)

  // Build result array with degree metrics, including symbol-level nodes
  const results = []
  for (const node of g.nodes.keys()) {
    const file = node.includes('::') ? node.split('::')[0] : node
    const symbol = node.includes('::') ? node.split('::')[1] : null

    results.push({
      file,
      symbol,
      node,
      betweenness: betweennessMap[node] || 0,
      pagerank: pageRankMap[node] || 0,
      degree: degree(g, node) || 0,
      closeness: closenessMap[node] || 0,
      hub: hubs[node] || 0,
      authority: authorities[node] || 0,
    })
  }

  // Sort by betweenness descending
  results.sort((a, b) => b.betweenness - a.betweenness)
  return results
}

/**
 * Calculate mean and standard deviation of betweenness centrality.
 * Used for detecting bottleneck thresholds.
 * @param {Array} centrality - result from computeCentrality()
 * @returns {{mean: number, stddev: number}}
 */
export function getCentralityStats(centrality) {
  if (centrality.length === 0) return { mean: 0, stddev: 0 }

  const betweenness = centrality.map(c => c.betweenness)
  const mean = betweenness.reduce((a, b) => a + b, 0) / betweenness.length

  const variance =
    betweenness.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / betweenness.length
  const stddev = Math.sqrt(variance)

  return { mean, stddev }
}

/**
 * Identify bottleneck nodes (high betweenness centrality).
 * @param {Array} centrality - result from computeCentrality()
 * @param {number} stddevMultiplier - threshold in multiples of standard deviation (default: 2)
 * @returns {Array<{file, betweenness}>} bottleneck modules
 */
export function findBottlenecks(centrality, stddevMultiplier = 2) {
  if (centrality.length === 0) return []

  const { mean, stddev } = getCentralityStats(centrality)
  const threshold = mean + stddevMultiplier * stddev

  return centrality
    .filter(c => c.betweenness > threshold)
    .map(c => ({ file: c.file, betweenness: c.betweenness }))
}
