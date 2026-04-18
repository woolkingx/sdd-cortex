// analysis/schema-blocks.mjs — Schema block boundary analysis via graph algorithms
// Extracts schema $ref subgraph, runs Louvain/Betweenness/Tarjan, suggests block grouping

import { louvain, betweenness, tarjanSCC } from './algorithms.mjs'
import { createGraph } from '../graph/index.mjs'

/**
 * Analyze schema $ref structure and suggest optimal block boundaries.
 * @param {object} g - unified graph (must have schema DEFINITION nodes + REF edges)
 * @returns {object} SchemaBlocksResult
 */
export function analyzeSchemaBlocks(g) {
  // 1. Extract schema subgraph (DEFINITION nodes + REF edges only)
  const sg = createGraph()
  const schemaDefs = new Set()

  for (const [id, node] of g.nodes) {
    if (id.startsWith('schema::') && node.label === 'DEFINITION') {
      sg.nodes.set(id, node)
      sg._neighbors.set(id, { in: new Set(), out: new Set() })
      schemaDefs.add(id)
    }
  }

  for (const e of g.edges) {
    if (e.label === 'REF' && schemaDefs.has(e.from) && schemaDefs.has(e.to)) {
      const idx = sg.edges.length
      sg.edges.push(e)
      sg._neighbors.get(e.from).out.add(idx)
      sg._neighbors.get(e.to).in.add(idx)
    }
  }

  if (sg.nodes.size === 0) {
    return { nodes: 0, edges: 0, clusters: [], bridges: [], cycles: [], fileAlignment: [], blockAlignment: [] }
  }

  // 2. Run algorithms
  const communities = louvain(sg)
  const bc = betweenness(sg)
  const sccs = tarjanSCC(sg)

  // 3. Group into clusters
  const clusterMap = new Map()
  for (const [id, cid] of Object.entries(communities)) {
    if (!clusterMap.has(cid)) clusterMap.set(cid, [])
    clusterMap.get(cid).push(id)
  }

  const clusters = [...clusterMap.entries()]
    .map(([id, members]) => ({
      id: String(id),
      members: members.map(m => m.replace('schema::', '')),
      size: members.length,
    }))
    .sort((a, b) => b.size - a.size)

  // 4. Identify bridges (top betweenness)
  const bridges = Object.entries(bc)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id, score]) => ({ id: id.replace('schema::', ''), score }))

  // 5. Detect $ref cycles
  const cycles = sccs
    .filter(c => c.length > 1)
    .map(c => c.map(id => id.replace('schema::', '')))

  // 6. File alignment: compare Louvain clusters vs actual schema file grouping
  const fileAlignment = _computeFileAlignment(clusters)

  // 7. Block alignment: compare Louvain clusters vs code block directories
  const blockAlignment = _computeBlockAlignment(clusters)

  return {
    nodes: sg.nodes.size,
    edges: sg.edges.length,
    clusters,
    bridges,
    cycles,
    fileAlignment,
    blockAlignment,
  }
}

/**
 * Compare Louvain clusters against actual schema file grouping.
 * @private
 */
function _computeFileAlignment(clusters) {
  return clusters.map(c => {
    const files = new Map()
    for (const m of c.members) {
      const file = m.split('#')[0]
      if (!files.has(file)) files.set(file, [])
      files.get(file).push(m.split('#')[1] || m)
    }
    const fileList = [...files.entries()]
      .map(([f, defs]) => ({ file: f, defs, count: defs.length }))
      .sort((a, b) => b.count - a.count)
    return {
      cluster: c.id,
      size: c.size,
      files: fileList,
      aligned: fileList.length === 1,
      primaryFile: fileList[0]?.file,
      spillover: fileList.length > 1 ? fileList.slice(1).map(f => f.file) : [],
    }
  })
}

/**
 * Map schema file paths to code block directories.
 * @private
 */
function _computeBlockAlignment(clusters) {
  const schemaToBlock = (file) => {
    if (file.startsWith('schema/graph/')) return 'graph'
    if (file.startsWith('schema/acorn/')) return 'parse'
    if (file.startsWith('schema/parse/')) return 'parse'
    if (file.startsWith('schema/analysis/')) return 'analysis'
    if (file.startsWith('schema/query/')) return 'query'
    if (file.startsWith('schema/output/')) return 'output'
    if (file.startsWith('schema/tool/')) return 'tool'
    if (file.startsWith('schema/cli/')) return 'cli'
    if (file === 'graph-analysis.json') return 'system'
    return 'unknown'
  }

  return clusters.map(c => {
    const blocks = new Map()
    for (const m of c.members) {
      const file = m.split('#')[0]
      const block = schemaToBlock(file)
      if (!blocks.has(block)) blocks.set(block, 0)
      blocks.set(block, blocks.get(block) + 1)
    }
    const blockList = [...blocks.entries()]
      .map(([b, count]) => ({ block: b, count }))
      .sort((a, b) => b.count - a.count)
    return {
      cluster: c.id,
      size: c.size,
      blocks: blockList,
      aligned: blockList.length === 1,
      primaryBlock: blockList[0]?.block,
      mixedBlocks: blockList.length > 1,
    }
  })
}
