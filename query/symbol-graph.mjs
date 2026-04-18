// symbol-graph.mjs — Derived views over CPG-lite graph singleton.
// Pure fns, no new state. L0 query primitives.

import { graph } from '../graph/index.mjs'
import { NL, EL } from '../lib/schema-loader.mjs'

/**
 * Find all symbol occurrences by name across the project.
 * @param {string} name
 * @returns {GraphNode[]}
 */
export function getSymbol(name) {
  const hits = []
  for (const node of graph.nodes.values()) {
    if (node.name === name && node.label !== NL.FILE) hits.push(node)
  }
  return hits
}

/**
 * Look up a single symbol at a specific file. O(1).
 * @returns {GraphNode|null}
 */
export function getSymbolAt(file, name) {
  return graph.nodes.get(`${file}::${name}`) || null
}

/**
 * File-level edges pointing INTO a file.
 * @param {string} file
 * @returns {GraphEdge[]}
 */
export function incomingEdges(file) {
  return graph.edges.filter(e => e.to === file && e.toLabel === NL.FILE)
}

/**
 * File-level edges pointing OUT from a file.
 * @param {string} file
 * @returns {GraphEdge[]}
 */
export function outgoingEdges(file) {
  return graph.edges.filter(e => e.from === file && e.fromLabel === NL.FILE)
}

/**
 * Edges pointing INTO a specific symbol.
 * @param {string} file
 * @param {string} symbol
 * @returns {GraphEdge[]}
 */
export function incomingSymbolEdges(file, symbol) {
  const target = `${file}::${symbol}`
  return graph.edges.filter(e => e.to === target)
}

/**
 * Edges pointing OUT from a specific symbol.
 * @param {string} file
 * @param {string} symbol
 * @returns {GraphEdge[]}
 */
export function outgoingSymbolEdges(file, symbol) {
  const source = `${file}::${symbol}`
  return graph.edges.filter(e => e.from === source)
}

/**
 * All file-level edges (both endpoints are FILE).
 * @returns {GraphEdge[]}
 */
export function fileEdges() {
  return graph.edges.filter(e => e.fromLabel === NL.FILE && e.toLabel === NL.FILE)
}

/**
 * All symbol-level edges (at least one endpoint is not FILE).
 * @returns {GraphEdge[]}
 */
export function symbolEdges() {
  return graph.edges.filter(e => e.fromLabel !== NL.FILE || e.toLabel !== NL.FILE)
}

/**
 * Iterate every symbol node in the graph.
 * @returns {Generator<GraphNode>}
 */
export function* allSymbols() {
  for (const node of graph.nodes.values()) {
    if (node.label !== NL.FILE) yield node
  }
}
