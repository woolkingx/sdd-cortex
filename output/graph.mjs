// output/graph.mjs — Graph format: mermaid or dot diagram output

import { basename } from 'node:path'

// ── Graph format dispatcher ──

export function graph(data, opts = {}) {
  const { format = 'mermaid' } = opts
  const { files, edges } = data

  if (format === 'dot') return _graphDot(files, edges)
  return _graphMermaid(files, edges)
}

// ── Helper: mermaid graph ──

function _graphMermaid(files, edges) {
  const out = ['graph LR']
  const nodeIds = new Map()
  let counter = 0

  function nid(path) {
    if (!nodeIds.has(path)) nodeIds.set(path, `n${counter++}`)
    return nodeIds.get(path)
  }

  for (const f of files) {
    const label = basename(f.path).replace(/\.\w+$/, '')
    const safeLabel = label.replace(/[^\w-]/g, '_')
    out.push(`  ${nid(f.path)}["${safeLabel}"]`)
  }

  const seenEdges = new Set()
  for (const e of edges) {
    const key = `${e.from}→${e.to}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)

    const style = e.type === 'extend' ? '-.->|extends|'
                : e.type === 'dynamic_import' ? '-.->|dynamic|'
                : '-->'

    out.push(`  ${nid(e.from)} ${style} ${nid(e.to)}`)
  }

  return out.join('\n')
}

// ── Helper: dot graph ──

function _graphDot(files, edges) {
  const out = ['digraph dependencies {']
  out.push('  rankdir=LR;')
  out.push('  node [shape=box];')

  const nodeIds = new Map()
  let counter = 0

  function nid(path) {
    if (!nodeIds.has(path)) nodeIds.set(path, `n${counter++}`)
    return nodeIds.get(path)
  }

  for (const f of files) {
    const label = basename(f.path)
    const safeId = nid(f.path)
    out.push(`  ${safeId} [label="${label}"];`)
  }

  const seenEdges = new Set()
  for (const e of edges) {
    const key = `${e.from}→${e.to}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)

    const style = e.type === 'extend' ? 'style="dashed" label="extends"'
                : e.type === 'dynamic_import' ? 'style="dashed" label="dynamic"'
                : ''

    const attrs = style ? ` [${style}]` : ''
    out.push(`  ${nid(e.from)} -> ${nid(e.to)}${attrs};`)
  }

  out.push('}')
  return out.join('\n')
}
