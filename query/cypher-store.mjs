// cypher-store.mjs — Bridge between graph singleton and Cypher.js query engine
// Imports graph nodes+edges into an in-memory Cypher.js instance for ad-hoc Cypher queries.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const Cypher = require('cypherdotjs')

let _engine = null

/**
 * Import graph singleton data into Cypher.js engine.
 * Uses batch CREATE for speed (~500 nodes in ~500ms).
 * @param {object} graph - graph singleton { nodes: Map, edges: Array }
 */
export function importGraph(graph) {
  _engine = new Cypher()

  const nodes = [...graph.nodes.values()]
  const edges = graph.edges

  return new Promise((resolve, reject) => {
    // Batch CREATE nodes in chunks (avoid statement too large)
    const CHUNK = 200
    const nodeChunks = []
    for (let i = 0; i < nodes.length; i += CHUNK) {
      nodeChunks.push(nodes.slice(i, i + CHUNK))
    }

    let ci = 0
    function nextNodeChunk() {
      if (ci >= nodeChunks.length) {
        importEdgeChunks()
        return
      }
      const chunk = nodeChunks[ci++]
      const stmts = chunk.map(n => {
        const labels = n.label || 'NODE'
        const props = _nodeProps(n)
        return `CREATE (:${labels} {gid: "${_esc(n.id)}", ${props}})`
      })
      const stmt = stmts.join(' ') + ' RETURN 1'
      _engine.execute(stmt, () => nextNodeChunk(), (err) => {
        console.error(`cypher-store: node chunk ${ci} error: ${err}`)
        nextNodeChunk()
      })
    }

    function importEdgeChunks() {
      // Edges need MATCH first, so must be done individually or in small batches
      // Use sequential single-statement for edges
      let ei = 0
      function nextEdge() {
        if (ei >= edges.length) { resolve(); return }
        const e = edges[ei++]
        const label = e.label || 'EDGE'
        const stmt = `MATCH (a {gid: "${_esc(e.from)}"}), (b {gid: "${_esc(e.to)}"}) CREATE (a)-[:${label}]->(b) RETURN 1`
        _engine.execute(stmt, () => nextEdge(), () => nextEdge())
      }
      nextEdge()
    }

    nextNodeChunk()
  })
}

/**
 * Execute a Cypher query against the imported graph.
 * @param {string} cypher - Cypher query string
 * @returns {Promise<object>} query result
 */
export function query(cypher) {
  if (!_engine) throw new Error('call importGraph() first')
  return new Promise((resolve, reject) => {
    _engine.execute(cypher, resolve, reject)
  })
}

/**
 * Get the Cypher.js engine instance (for advanced use).
 */
export function getEngine() {
  return _engine
}

// ── Helpers ──

function _esc(s) {
  if (!s) return ''
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
}

function _nodeProps(node) {
  const parts = []
  if (node.name) parts.push(`name: "${_esc(node.name)}"`)
  if (node.file) parts.push(`file: "${_esc(node.file)}"`)
  if (node.parent) parts.push(`parent: "${_esc(node.parent)}"`)
  if (node.exported != null) parts.push(`exported: ${node.exported}`)

  if (node.attrs) {
    if (node.attrs.signature) parts.push(`signature: "${_esc(node.attrs.signature)}"`)
    if (node.attrs.jsdoc) parts.push(`jsdoc: "${_esc(node.attrs.jsdoc)}"`)
    if (node.attrs.params) parts.push(`paramCount: ${node.attrs.params.length}`)
    if (node.attrs.returns) parts.push(`returns: "${_esc(node.attrs.returns)}"`)
    if (node.attrs.async) parts.push(`async: true`)
    if (node.attrs.lines) parts.push(`lines: ${node.attrs.lines}`)
    if (node.attrs.complexity) parts.push(`complexity: ${node.attrs.complexity}`)
  }

  if (node.loc) {
    parts.push(`locStart: ${node.loc.start}`)
    parts.push(`locEnd: ${node.loc.end}`)
  }

  return parts.join(', ')
}
