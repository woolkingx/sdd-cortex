// swimlane.mjs — Terminal swimlane diagram renderer
// Renders graph struct as Unicode box-drawing swimlanes

import { createGraph, inNeighbors } from '../graph/index.mjs'

/**
 * Render a swimlane diagram from a graph struct.
 * @param {object} graph - graph struct { nodes: Map, edges: Array, ... }
 * @param {object} opts - { maxWidth?: number, compact?: boolean }
 * @returns {string} - rendered diagram
 */
export function swimlane(graph, opts = {}) {
  const nodes = [...graph.nodes.keys()]
  if (nodes.length === 0) return ''

  // Topological sort
  const sorted = _topoSort(graph, nodes)
  const nodeIndex = new Map(sorted.map((n, i) => [n, i]))

  // Collect edges (file-level only)
  const edges = []
  for (const e of graph.edges) {
    edges.push({ from: e.from, to: e.to })
  }

  if (edges.length === 0) {
    // No edges: just render each node as a lane
    return sorted.map(n => `${n.padEnd(20)} ${'═'.repeat(20)}`).join('\n')
  }

  // Assign columns to edges
  const cols = _assignColumns(edges, nodeIndex)
  const numCols = cols.length
  const labelWidth = Math.max(...sorted.map(s => s.length)) + 1

  // Render grid
  let out = ''
  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i]
    const line = node.padEnd(labelWidth)

    // Node lane: ═══ + edge markers
    let lane = line
    for (let c = 0; c < numCols; c++) {
      const [from, to] = cols[c]
      const fromIdx = nodeIndex.get(from)
      const toIdx = nodeIndex.get(to)
      const minIdx = Math.min(fromIdx, toIdx)
      const maxIdx = Math.max(fromIdx, toIdx)

      if (i === fromIdx) {
        lane += '╤'  // outgoing
      } else if (i === toIdx) {
        lane += '╧'  // incoming
      } else if (i > minIdx && i < maxIdx) {
        lane += '╪'  // pass-through
      } else {
        lane += '═'  // no connection
      }
    }
    out += lane + '\n'

    // Spacer rows between nodes (vertical lines only)
    if (i < sorted.length - 1) {
      let spacer = ' '.repeat(labelWidth)
      for (let c = 0; c < numCols; c++) {
        const [from, to] = cols[c]
        const fromIdx = nodeIndex.get(from)
        const toIdx = nodeIndex.get(to)
        const minIdx = Math.min(fromIdx, toIdx)
        const maxIdx = Math.max(fromIdx, toIdx)

        if (i >= minIdx && i < maxIdx) {
          spacer += '│'  // vertical line active
        } else {
          spacer += ' '  // no line
        }
      }
      out += spacer + '\n'
    }
  }

  return out
}

/**
 * Render swimlane from edges array (backward compat).
 * @param {Array<{from, to, type}>} edges
 * @param {string[]} files - file paths
 * @returns {string}
 */
export function swimlaneFromEdges(edges, files) {
  // Build graph struct
  const g = createGraph()

  for (const file of files) {
    g.nodes.set(file, { id: file })
    g._neighbors.set(file, { in: new Set(), out: new Set() })
  }

  const seen = new Set()
  for (const e of edges) {
    if (!g.nodes.has(e.from) || !g.nodes.has(e.to)) continue
    const key = `${e.from}→${e.to}`
    if (seen.has(key)) continue
    seen.add(key)

    const idx = g.edges.length
    g.edges.push({ from: e.from, to: e.to })
    g._neighbors.get(e.from).out.add(idx)
    g._neighbors.get(e.to).in.add(idx)
  }

  return swimlane(g)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Topological sort via DFS.
 * Returns node list ordered by source-to-sink (no incoming edges first).
 */
function _topoSort(graph, nodes) {
  const visited = new Set()
  const visiting = new Set()
  const result = []

  function visit(node) {
    if (visited.has(node)) return
    if (visiting.has(node)) return  // cycle: skip
    visiting.add(node)

    // Visit predecessors (nodes pointing to this one)
    for (const pred of inNeighbors(graph, node)) {
      visit(pred)
    }

    visiting.delete(node)
    visited.add(node)
    result.push(node)
  }

  for (const node of nodes) {
    visit(node)
  }

  return result
}

/**
 * Assign vertical columns to edges.
 * Short spans (distance between source and target) placed first (left-to-right).
 * @param {Array<{from, to}>} edges - edge list
 * @param {Map<string, number>} nodeIndex - node → row index
 * @returns {Array<[from, to]>} - edges sorted by span length
 */
function _assignColumns(edges, nodeIndex) {
  const edgesWithSpan = edges.map(e => ({
    ...e,
    span: Math.abs(nodeIndex.get(e.to) - nodeIndex.get(e.from)),
  }))

  edgesWithSpan.sort((a, b) => a.span - b.span || nodeIndex.get(a.from) - nodeIndex.get(b.from))
  return edgesWithSpan.map(e => [e.from, e.to])
}
