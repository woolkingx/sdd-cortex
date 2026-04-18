// graph.mjs — Unified graph module: struct + neighbor index + path index + persist
// Single source of truth for CPG-lite graph data.
// Design: composable blocks (create/query/persist), singleton compat at bottom.
// Block fns take (g, ...) — singleton wrappers exported for backward compat.

import { readFileSync, writeFileSync, statSync } from 'node:fs'

// ── Block 1: Graph Struct ────────────────────────────────────────────────────

/**
 * Create a new empty graph.
 * @returns {{ nodes: Map, edges: Array, bindings: Map, _neighbors: Map }}
 */
export function createGraph() {
  return {
    nodes:      new Map(),   // id → GraphNode
    edges:      [],          // GraphEdge[]
    bindings:   new Map(),   // filePath → Map<localName, BindingInfo>
    _neighbors: new Map(),   // id → { in: Set<edgeIdx>, out: Set<edgeIdx> }
  }
}

function _addNode(g, node) {
  g.nodes.set(node.id, node)
  if (!g._neighbors.has(node.id)) {
    g._neighbors.set(node.id, { in: new Set(), out: new Set() })
  }
}

function _addEdge(g, edge) {
  const idx = g.edges.length
  g.edges.push(edge)
  if (!g._neighbors.has(edge.from)) {
    g._neighbors.set(edge.from, { in: new Set(), out: new Set() })
  }
  if (!g._neighbors.has(edge.to)) {
    g._neighbors.set(edge.to, { in: new Set(), out: new Set() })
  }
  g._neighbors.get(edge.from).out.add(idx)
  g._neighbors.get(edge.to).in.add(idx)
}

function _getNode(g, id) {
  return g.nodes.get(id)
}

/**
 * Get all incoming edges for a node. O(degree).
 */
export function inEdges(g, id) {
  const nb = g._neighbors.get(id)
  if (!nb) return []
  const result = []
  for (const i of nb.in) result.push(g.edges[i])
  return result
}

/**
 * Get all outgoing edges for a node. O(degree).
 */
export function outEdges(g, id) {
  const nb = g._neighbors.get(id)
  if (!nb) return []
  const result = []
  for (const i of nb.out) result.push(g.edges[i])
  return result
}

/**
 * Iterate all linked nodes (in + out neighbors).
 * cb(neighborNode, edge, direction) where direction = 'in'|'out'
 */
export function forEachLinkedNode(g, id, cb) {
  const nb = g._neighbors.get(id)
  if (!nb) return
  for (const i of nb.out) {
    const e = g.edges[i]
    cb(g.nodes.get(e.to), e, 'out')
  }
  for (const i of nb.in) {
    const e = g.edges[i]
    cb(g.nodes.get(e.from), e, 'in')
  }
}

/**
 * Degree (in + out) for a node.
 */
export function degree(g, id) {
  const nb = g._neighbors.get(id)
  return nb ? nb.in.size + nb.out.size : 0
}

/**
 * In-degree for a node.
 */
export function inDegree(g, id) {
  const nb = g._neighbors.get(id)
  return nb ? nb.in.size : 0
}

/**
 * Out-degree for a node.
 */
export function outDegree(g, id) {
  const nb = g._neighbors.get(id)
  return nb ? nb.out.size : 0
}

/**
 * All out-neighbor node ids.
 */
export function outNeighbors(g, id) {
  const nb = g._neighbors.get(id)
  if (!nb) return []
  const result = []
  for (const i of nb.out) result.push(g.edges[i].to)
  return result
}

/**
 * All in-neighbor node ids.
 */
export function inNeighbors(g, id) {
  const nb = g._neighbors.get(id)
  if (!nb) return []
  const result = []
  for (const i of nb.in) result.push(g.edges[i].from)
  return result
}

/**
 * Rebuild _neighbors index from current nodes and edges.
 * Call this after bulk-adding edges directly to g.edges array.
 */
export function rebuildNeighborIndex(g) {
  g._neighbors.clear()
  for (const node of g.nodes.keys()) {
    g._neighbors.set(node, { in: new Set(), out: new Set() })
  }
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i]
    if (!g._neighbors.has(e.from)) {
      g._neighbors.set(e.from, { in: new Set(), out: new Set() })
    }
    if (!g._neighbors.has(e.to)) {
      g._neighbors.set(e.to, { in: new Set(), out: new Set() })
    }
    g._neighbors.get(e.from).out.add(i)
    g._neighbors.get(e.to).in.add(i)
  }
}

// ── Block 2: Path Index ──────────────────────────────────────────────────────

/**
 * Build path index from file list.
 * Maps normalized paths to canonical relative paths.
 */
export function buildPathIndex(filePaths, projectRoot) {
  const index = new Map()
  const rootLen = projectRoot.endsWith('/') ? projectRoot.length : projectRoot.length + 1
  for (const abs of filePaths) {
    const rel = abs.startsWith(projectRoot) ? abs.slice(rootLen) : abs
    index.set(rel, rel)
    const noExt = rel.replace(/\.\w+$/, '')
    if (!index.has(noExt)) index.set(noExt, rel)
    if (noExt.endsWith('/index')) {
      const dir = noExt.slice(0, -6)
      if (!index.has(dir)) index.set(dir, rel)
    }
  }
  return index
}

function _resolveImportTarget(index, source, fromPath) {
  if (!source.startsWith('.')) return null
  const lastSlash = fromPath.lastIndexOf('/')
  const fromDir = lastSlash >= 0 ? fromPath.slice(0, lastSlash) : ''
  const prefix = fromDir ? fromDir + '/' : ''
  const resolved = _normalizePath(prefix + source)
  return index.get(resolved) || null
}

function _normalizePath(p) {
  const parts = []
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

// ── Block 3: Persist ─────────────────────────────────────────────────────────

const PERSIST_VERSION = 1

/**
 * Save graph to JSON file.
 */
export function save(g, filePath) {
  const data = {
    v: PERSIST_VERSION,
    nodes: [...g.nodes.values()],
    edges: g.edges,
    bindings: Object.fromEntries(
      [...g.bindings].map(([k, m]) => [k, Object.fromEntries(m)])
    ),
  }
  writeFileSync(filePath, JSON.stringify(data))
}

/**
 * Load graph from JSON file. Rebuilds neighbor index.
 */
export function load(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'))
  const g = createGraph()
  for (const n of raw.nodes) _addNode(g, n)
  for (const e of raw.edges) _addEdge(g, e)
  for (const [file, obj] of Object.entries(raw.bindings || {})) {
    g.bindings.set(file, new Map(Object.entries(obj)))
  }
  return g
}

/**
 * Check if cache file is stale (any src file newer than cache).
 */
export function isStale(cachePath, srcFiles) {
  try {
    const cacheMtime = statSync(cachePath).mtimeMs
    return srcFiles.some(f => statSync(f).mtimeMs > cacheMtime)
  } catch { return true }
}

// ── Singleton compat ─────────────────────────────────────────────────────────
// Consumers import { graph, initGraph, addNode, getNode, ... } with old signatures.
// These delegate to block fns using the module-level singleton.

export let graph = createGraph()
export let pathIndex = new Map()
export let rootDir = ''

/**
 * Initialize (or re-initialize) the global graph singleton.
 */
export function initGraph(filePaths, projectRoot) {
  rootDir = projectRoot
  graph = createGraph()
  pathIndex = buildPathIndex(filePaths, projectRoot)
}

/** Add node to singleton. */
export function addNode(node) { _addNode(graph, node) }

/** Get node from singleton. */
export function getNode(id) { return _getNode(graph, id) }

/** Get all FILE nodes from singleton. */
export function getFileNodes() {
  return [...graph.nodes.values()].filter(n => n.label === 'FILE')
}

/** Get all non-FILE nodes from singleton. */
export function getSymbolNodes() {
  return [...graph.nodes.values()].filter(n => n.label !== 'FILE')
}

/** Get nodes by file from singleton. */
export function getNodesByFile(file) {
  return [...graph.nodes.values()].filter(n => n.file === file)
}

/** Resolve import target using singleton pathIndex. */
export function resolveImportTarget(source, fromPath) {
  return _resolveImportTarget(pathIndex, source, fromPath)
}

/** Resolve edge kind from singleton. */
export function resolveEdgeKind(symbolName, targetFile) {
  const node = graph.nodes.get(`${targetFile}::${symbolName}`)
  if (node) return node.label.toLowerCase()
  if (symbolName === '*') return 'namespace'
  return 'unknown'
}
