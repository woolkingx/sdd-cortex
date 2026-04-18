// reporter.mjs — Output formatters: text, json, mermaid
// Output conforms to AnalysisResult in graph-analysis.json.

import { basename } from 'node:path'

function p(val, width = 3) { return String(val).padStart(width) }

export function reportJson(result) {
  return JSON.stringify(result, null, 2)
}

export function reportText(result) {
  const out = []
  const { stats, violations, files, edges, cycles } = result
  const { hot_paths = [], schema_gaps = [], advice = [] } = result

  // ── Header ──
  out.push(`# Graph Analysis — ${basename(result.project)}`)
  out.push(`  ${new Date(result.timestamp).toLocaleString()}\n`)

  // ── Stats table ──
  out.push('## Summary\n')
  const rows = [
    ['Files',       stats.total_files],
    ['Edges',       stats.total_edges],
    ['Violations',  stats.confirmed_violations],
    ['False pos.',  stats.false_positives],
    ['Orphans',     stats.orphan_nodes],
    ['Complex',     stats.complex_files],
    ['Max depth',   stats.max_depth],
    ['Cycles',      stats.cycles],
    ['Max fan-in',  stats.max_fan_in],
    ['Max fan-out', stats.max_fan_out],
    ['Longest path', stats.longest_path],
    ['Dup. instances', stats.duplicate_instantiations ?? 0],
  ]
  const maxLabel = Math.max(...rows.map(r => r[0].length))
  for (const [label, val] of rows) {
    const marker = (label === 'Violations' && val > 0) ? ' !!'
                 : (label === 'Cycles' && val > 0) ? ' !!'
                 : ''
    out.push(`  ${label.padEnd(maxLabel)}  ${String(val).padStart(4)}${marker}`)
  }

  // ── Encapsulation Violations ──
  const confirmed = violations.filter(v => v.confirmed)
  out.push('\n## Encapsulation Violations\n')
  if (confirmed.length === 0) {
    out.push('  (none)')
  } else {
    // Group by definedIn file
    const byFile = new Map()
    for (const v of confirmed) {
      if (!byFile.has(v.definedIn)) byFile.set(v.definedIn, [])
      byFile.get(v.definedIn).push(v)
    }
    for (const [file, vs] of byFile) {
      out.push(`  ${file}`)
      for (const v of vs) {
        out.push(`    ${v.fn}() ← called from ${v.calledFrom}`)
      }
    }
  }

  // ── Circular Dependencies ──
  if (cycles.length > 0) {
    out.push('\n## Circular Dependencies\n')
    for (let i = 0; i < cycles.length; i++) {
      const c = cycles[i]
      out.push(`  ${i + 1}. ${c.path.join(' → ')} → ${c.path[0]}`)
    }
  }

  // ── Hot Paths ──
  out.push('\n## Dependency Chains\n')
  if (hot_paths.length === 0) {
    out.push('  (none)')
  } else {
    for (const hp of hot_paths) {
      out.push(`  ${hp.length} hops:`)
      for (let i = 0; i < hp.path.length; i++) {
        const prefix = i === 0 ? '    ' : '    → '
        out.push(`${prefix}${hp.path[i]}`)
      }
      out.push('')
    }
  }

  // ── File Details (all files, sorted by depth) ──
  const { complexity = [] } = result

  const connected = new Set()
  for (const e of edges) { connected.add(e.from); connected.add(e.to) }

  const fileViolations = new Map()
  for (const v of confirmed) {
    if (!fileViolations.has(v.definedIn)) fileViolations.set(v.definedIn, 0)
    fileViolations.set(v.definedIn, fileViolations.get(v.definedIn) + 1)
  }

  const cxMap = new Map()
  for (const cx of complexity) cxMap.set(cx.file, cx)

  // Sort by depth descending (deepest dependency chains first)
  const sorted = [...files].sort((a, b) => {
    const da = cxMap.get(a.path)?.depth || 0
    const db = cxMap.get(b.path)?.depth || 0
    return db - da
  })

  out.push('## File Details\n')
  out.push(`  ${'file'.padEnd(50)} fn  exp int ratio calls  in out depth  lines`)
  out.push(`  ${'─'.repeat(50)} ──  ─── ─── ───── ─────  ── ─── ─────  ─────`)

  for (const f of sorted) {
    const cx = cxMap.get(f.path)
    if (!cx) continue

    const vc = fileViolations.get(f.path) || 0
    const isOrphan = !connected.has(f.path)

    const markers = []
    if (vc > 0) markers.push(`V${vc}`)
    if (isOrphan) markers.push('O')
    const mark = markers.length > 0 ? ` ${markers.join(' ')}` : ''

    out.push(`  ${f.path.padEnd(50)} ${p(cx.functions)}  ${p(cx.exports)} ${p(cx.internals)} ${p(cx.ratio, 5)} ${p(cx.calls, 5)}  ${p(cx.fan_in)} ${p(cx.fan_out)} ${p(cx.depth, 5)}  ${p(cx.lines, 5)}${mark}`)
  }

  // Violation details per file
  const filesWithViolations = sorted.filter(f => (fileViolations.get(f.path) || 0) > 0)
  if (filesWithViolations.length > 0) {
    out.push('')
    for (const f of filesWithViolations) {
      const vs = confirmed.filter(v => v.definedIn === f.path)
      for (const v of vs) {
        out.push(`  !! ${f.path}: ${v.fn}() ← ${v.calledFrom}`)
      }
    }
  }

  out.push('')

  // ── Function Centrality (top 10) ──
  const fnCentrality = (result.centrality || []).filter(c => c.symbol)
  if (fnCentrality.length > 0) {
    out.push('## Function Centrality (top 10)\n')
    const top = fnCentrality.sort((a, b) => b.betweenness - a.betweenness).slice(0, 10)
    for (const c of top) {
      out.push(`  ${c.node.padEnd(60)} betw=${c.betweenness.toFixed(3)} pr=${c.pagerank.toFixed(3)}`)
    }
    out.push('')
  }

  // ── Schema Gaps ──
  if (schema_gaps.length > 0) {
    out.push('## Schema Drift\n')
    const missing = schema_gaps.filter(g => g.type === 'missing_in_schema')
    const stale = schema_gaps.filter(g => g.type === 'stale_in_schema')

    if (missing.length > 0) {
      out.push('  Exported but not in schema:')
      const byFile = new Map()
      for (const g of missing) {
        if (!byFile.has(g.file)) byFile.set(g.file, [])
        byFile.get(g.file).push(g.symbol)
      }
      for (const [file, syms] of byFile) {
        out.push(`    ${file}: ${syms.join(', ')}`)
      }
      out.push('')
    }
    if (stale.length > 0) {
      out.push('  In schema but not exported (stale):')
      const byFile = new Map()
      for (const g of stale) {
        if (!byFile.has(g.file)) byFile.set(g.file, [])
        byFile.get(g.file).push(g.symbol)
      }
      for (const [file, syms] of byFile) {
        out.push(`    ${file}: ${syms.join(', ')}`)
      }
      out.push('')
    }
  }

  // ── Schema Audit ──
  const audit = result.schema_audit
  if (audit) {
    out.push('\n## Schema Audit\n')
    out.push(`  Definitions: ${audit.total_definitions}`)
    out.push(`  Properties:  ${audit.total_properties}`)
    out.push(`  $ref edges:  ${audit.total_refs}`)

    if (audit.dead_definitions.length > 0) {
      out.push(`\n  Dead definitions (${audit.dead_definitions.length}):`)
      for (const d of audit.dead_definitions) {
        out.push(`    ${d}`)
      }
    }
    if (audit.broken_refs.length > 0) {
      out.push(`\n  Broken $ref (${audit.broken_refs.length}):`)
      for (const b of audit.broken_refs) {
        out.push(`    ${b.from} → ${b.ref} (${b.reason})`)
      }
    }
    if (audit.ref_cycles.length > 0) {
      out.push(`\n  $ref cycles (${audit.ref_cycles.length}):`)
      for (const c of audit.ref_cycles) {
        out.push(`    ${c.path.join(' → ')}`)
      }
    }
    if (audit.duplicate_names.length > 0) {
      out.push(`\n  Duplicate names: ${audit.duplicate_names.join(', ')}`)
    }
    if (audit.orphan_files.length > 0) {
      out.push(`\n  Orphan schema files: ${audit.orphan_files.join(', ')}`)
    }
    if (audit.dead_definitions.length === 0 && audit.broken_refs.length === 0 && audit.ref_cycles.length === 0) {
      out.push('  (no issues found)')
    }
  }

  // ── False Positives (collapsed) ──
  const fp = violations.filter(v => !v.confirmed)
  if (fp.length > 0) {
    out.push('## False Positives (name collisions)\n')
    const grouped = new Map()
    for (const v of fp) {
      if (!grouped.has(v.definedIn)) grouped.set(v.definedIn, new Set())
      grouped.get(v.definedIn).add(v.fn)
    }
    for (const [file, fns] of grouped) {
      out.push(`  ${file}: ${[...fns].join(', ')}`)
    }
  }

  // ── Recommendations ──
  if (advice.length > 0) {
    out.push('\n## Recommendations\n')

    const categories = [
      { type: 'violation',    label: 'Fix Encapsulation' },
      { type: 'cycle',        label: 'Break Cycles' },
      { type: 'complexity',   label: 'Reduce Complexity' },
      { type: 'coupling',     label: 'Reduce Coupling' },
      { type: 'orphan',       label: 'Remove/Wire Orphans' },
      { type: 'schema_gap',   label: 'Sync Schema' },
      { type: 'schema_stale', label: 'Clean Stale Schema' },
      { type: 'hot_path',              label: 'Critical Paths' },
      { type: 'duplicate_instantiation', label: 'Duplicate Instantiation' },
    ]

    for (const cat of categories) {
      const items = advice.filter(a => a.type === cat.type)
      if (items.length === 0) continue

      const icon = items[0].severity === 'error' ? '!!' : items[0].severity === 'warning' ? '! ' : '  '
      out.push(`  ${icon} ${cat.label} (${items.length})`)

      for (const a of items) {
        out.push(`     ${a.file}`)
        out.push(`       ${a.message}`)
        if (a.detail) out.push(`       ${a.detail}`)
      }
      out.push('')
    }
  }

  return out.join('\n')
}

export function reportMermaid(result) {
  const { files, edges } = result
  const out = ['graph LR']

  const nodeIds = new Map()
  let counter = 0
  function nid(path) {
    if (!nodeIds.has(path)) nodeIds.set(path, `n${counter++}`)
    return nodeIds.get(path)
  }

  for (const f of files) {
    const label = basename(f.path).replace(/\.\w+$/, '')
    out.push(`  ${nid(f.path)}[${label}]`)
  }

  const seenEdges = new Set()
  for (const e of edges) {
    const key = `${e.from}→${e.to}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    const label = e.label || e.type
    const style = label === 'EXTEND' ? '-.->|extends|'
                : label === 'DYNAMIC_IMPORT' ? '-.->|dynamic|'
                : '-->'
    out.push(`  ${nid(e.from)} ${style} ${nid(e.to)}`)
  }

  return out.join('\n')
}
