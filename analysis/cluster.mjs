/**
 * cluster.mjs — Community detection using Louvain algorithm.
 * Replaces hand-written label propagation with Louvain community detection.
 */

import { louvain } from './algorithms.mjs'

/**
 * Detect clusters using Louvain community detection algorithm.
 * @param {Object} g - graph struct { nodes, edges, _neighbors }
 * @returns {Array<{id: string, files: string[], modularity?: number}>}
 */
export function detectClusters(g) {
  if (g.nodes.size === 0) return []

  // Louvain returns { nodeId: communityId, ... } plain object
  const communities = louvain(g)

  // Group nodes by community
  const groups = new Map()
  for (const [node, communityId] of Object.entries(communities)) {
    if (!groups.has(communityId)) {
      groups.set(communityId, [])
    }
    groups.get(communityId).push(node)
  }

  // Convert to Cluster[] format
  const clusters = [...groups.entries()]
    .map(([id, files]) => ({
      id: String(id),
      files: files.sort(),
      size: files.length,
    }))
    .sort((a, b) => b.size - a.size)

  return clusters
}
