// output.mjs — Unified output module: dispatcher + json, summary, table
// Exports conform to AnalysisResult schema in graph-analysis.json
// Delegates text formatting to ./output/text.mjs, graphs to ./output/graph.mjs

import Table from 'cli-table3'
import { loader as rootLoader } from '../lib/schema-loader.mjs'
import { ObjectTree } from '../lib/schema2object.mjs'
import { createGraph } from '../graph/index.mjs'
import { text } from './text.mjs'
import { graph as renderGraph } from './graph.mjs'
import { swimlane as renderSwimlane } from './swimlane.mjs'

let _renderOptsSchema = null
function _getRenderOptsSchema() {
  if (_renderOptsSchema) return _renderOptsSchema
  _renderOptsSchema = rootLoader.resolve('schema/output/output.json#/definitions/RenderOpts')
  return _renderOptsSchema
}

// ── Render main dispatcher ──

export function render(result, opts = {}) {
  const { node, loader: sub } = _getRenderOptsSchema()
  const validOpts = new ObjectTree(opts, node, sub).$toDict()
  const { format = 'text' } = validOpts
  switch (format) {
    case 'json': return json(result)
    case 'mermaid': return graph(result, { format: 'mermaid' })
    case 'dot': return graph(result, { format: 'dot' })
    case 'swimlane': return swimlane(result, opts)
    case 'text':
    default: return text(result, opts)
  }
}

// ── Swimlane format ──

export function swimlane(data, opts = {}) {
  const g = createGraph()
  for (const f of data.files) {
    g.nodes.set(f.path, { id: f.path })
    g._neighbors.set(f.path, { in: new Set(), out: new Set() })
  }
  const seen = new Set()
  for (const e of data.edges) {
    const key = `${e.from}→${e.to}`
    if (seen.has(key)) continue
    seen.add(key)
    const idx = g.edges.length
    g.edges.push({ from: e.from, to: e.to })
    if (!g._neighbors.has(e.from)) g._neighbors.set(e.from, { in: new Set(), out: new Set() })
    if (!g._neighbors.has(e.to)) g._neighbors.set(e.to, { in: new Set(), out: new Set() })
    g._neighbors.get(e.from).out.add(idx)
    g._neighbors.get(e.to).in.add(idx)
  }
  return renderSwimlane(g, opts)
}

// ── Graph format dispatcher (delegates to ./output/graph.mjs) ──

export function graph(data, opts = {}) {
  return renderGraph(data, opts)
}

// ── JSON output ──

export function json(data) {
  return JSON.stringify(data, null, 2)
}

// ── Summary output ──

export function summary(data) {
  const { stats, violations, cycles } = data
  const confirmed = violations.filter(v => v.confirmed).length

  const parts = [
    `Files: ${stats.total_files}`,
    `Edges: ${stats.total_edges}`,
    `Violations: ${confirmed}`,
    `Cycles: ${stats.cycles}`,
  ]

  if (stats.complex_files > 0) {
    parts.push(`Complex: ${stats.complex_files}`)
  }

  return parts.join(' | ')
}

// ── Table output (auto-detect shape) ──

export function table(data, opts = {}) {
  const t = new Table({
    head: _detectHeaders(data),
    style: { head: [], border: ['grey'] },
  })

  const rows = _detectRows(data)
  for (const row of rows) t.push(row)

  return t.toString()
}

// ── Helper: detect table headers ──

function _detectHeaders(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return ['data']
  }

  const first = data[0]
  if (first.file !== undefined) {
    // FileComplexity
    return ['file', 'fn', 'exp', 'int', 'calls', 'in', 'out', 'depth', 'lines']
  } else if (first.fn !== undefined) {
    // Violation
    return ['function', 'defined_in', 'called_from', 'confirmed']
  } else if (first.message !== undefined) {
    // Advice
    return ['severity', 'type', 'file', 'message']
  }

  return ['data']
}

// ── Helper: detect table rows ──

function _detectRows(data) {
  if (!Array.isArray(data)) return [['(not a table)']]

  return data.map(item => {
    if (item.file !== undefined) {
      // FileComplexity
      return [
        item.file,
        item.functions,
        item.exports,
        item.internals,
        item.calls,
        item.fan_in,
        item.fan_out,
        item.depth,
        item.lines,
      ]
    } else if (item.fn !== undefined) {
      // Violation
      return [
        item.fn,
        item.definedIn,
        item.calledFrom,
        item.confirmed ? 'yes' : 'no',
      ]
    } else if (item.message !== undefined) {
      // Advice
      return [
        item.severity,
        item.type,
        item.file,
        item.message,
      ]
    }

    return [JSON.stringify(item)]
  })
}
