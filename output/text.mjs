// output/text.mjs — Text format: multi-section summary report
// Composes: summary, violations, cycles, hot paths, file table, schema gaps, advice

import { basename } from 'node:path'
import Table from 'cli-table3'

// ── Main text format ──

export function text(result, opts = {}) {
  const out = []
  const { stats, violations, files, edges, cycles } = result
  const { hot_paths = [], schema_gaps = [], advice = [] } = result

  out.push(`# Graph Analysis — ${basename(result.project)}`)
  out.push(`  ${new Date(result.timestamp).toLocaleString()}\n`)

  out.push('## Summary\n')
  out.push(_summaryLines(stats).join('\n'))

  out.push('\n## Encapsulation Violations\n')
  out.push(_violationLines(violations).join('\n'))

  if (cycles.length > 0) {
    out.push('\n## Circular Dependencies\n')
    out.push(_cycleLines(cycles).join('\n'))
  }

  out.push('\n## Dependency Chains\n')
  out.push(_hotPathLines(hot_paths).join('\n'))

  out.push('\n## File Details\n')
  const { complexity = [] } = result
  const fileTable = _fileTable(files, complexity, violations)
  out.push(fileTable)

  if (schema_gaps.length > 0) {
    out.push('\n## Schema Drift\n')
    out.push(_schemaGapLines(schema_gaps).join('\n'))
  }

  const fp = violations.filter(v => !v.confirmed)
  if (fp.length > 0) {
    out.push('\n## False Positives (name collisions)\n')
    out.push(_falsePositiveLines(fp).join('\n'))
  }

  if (advice.length > 0) {
    out.push('\n## Recommendations\n')
    out.push(_adviceLines(advice).join('\n'))
  }

  return out.join('\n')
}

// ── Helper: summary lines ──

function _summaryLines(stats) {
  const rows = [
    ['Files', stats.total_files],
    ['Edges', stats.total_edges],
    ['Violations', stats.confirmed_violations],
    ['False pos.', stats.false_positives],
    ['Orphans', stats.orphan_nodes],
    ['Complex', stats.complex_files],
    ['Max depth', stats.max_depth],
    ['Cycles', stats.cycles],
    ['Max fan-in', stats.max_fan_in],
    ['Max fan-out', stats.max_fan_out],
    ['Longest path', stats.longest_path],
  ]
  const maxLabel = Math.max(...rows.map(r => r[0].length))
  return rows.map(([label, val]) => {
    const marker = (label === 'Violations' && val > 0) ? ' !!'
                 : (label === 'Cycles' && val > 0) ? ' !!'
                 : ''
    return `  ${label.padEnd(maxLabel)}  ${String(val).padStart(4)}${marker}`
  })
}

// ── Helper: violation lines ──

function _violationLines(violations) {
  const confirmed = violations.filter(v => v.confirmed)
  if (confirmed.length === 0) return ['  (none)']

  const out = []
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
  return out
}

// ── Helper: cycle lines ──

function _cycleLines(cycles) {
  return cycles.map((c, i) => `  ${i + 1}. ${c.path.join(' → ')} → ${c.path[0]}`)
}

// ── Helper: hot path lines ──

function _hotPathLines(hot_paths) {
  if (hot_paths.length === 0) return ['  (none)']

  const out = []
  for (const hp of hot_paths) {
    out.push(`  ${hp.length} hops:`)
    for (let i = 0; i < hp.path.length; i++) {
      const prefix = i === 0 ? '    ' : '    → '
      out.push(`${prefix}${hp.path[i]}`)
    }
    out.push('')
  }
  return out
}

// ── Helper: file table (cli-table3) ──

function _fileTable(files, complexity, violations) {
  const cxMap = new Map()
  for (const cx of complexity) cxMap.set(cx.file, cx)

  const connected = new Set()
  for (const v of violations) {
    connected.add(v.definedIn)
    connected.add(v.calledFrom)
  }

  const fileViolations = new Map()
  const confirmed = violations.filter(v => v.confirmed)
  for (const v of confirmed) {
    if (!fileViolations.has(v.definedIn)) fileViolations.set(v.definedIn, 0)
    fileViolations.set(v.definedIn, fileViolations.get(v.definedIn) + 1)
  }

  const sorted = [...files].sort((a, b) => {
    const da = cxMap.get(a.path)?.depth || 0
    const db = cxMap.get(b.path)?.depth || 0
    return db - da
  })

  const rows = []
  for (const f of sorted) {
    const cx = cxMap.get(f.path)
    if (!cx) continue

    const vc = fileViolations.get(f.path) || 0
    const isOrphan = !connected.has(f.path)
    const markers = []
    if (vc > 0) markers.push(`V${vc}`)
    if (isOrphan) markers.push('O')
    const mark = markers.length > 0 ? markers.join(' ') : ''

    rows.push([
      f.path.length > 50 ? f.path.slice(-47) + '...' : f.path,
      cx.functions,
      cx.exports,
      cx.internals,
      cx.ratio.toFixed(2),
      cx.calls,
      cx.fan_in,
      cx.fan_out,
      cx.depth,
      cx.lines,
      mark,
    ])
  }

  const table = new Table({
    head: ['file', 'fn', 'exp', 'int', 'ratio', 'calls', 'in', 'out', 'depth', 'lines', 'notes'],
    colWidths: [30, 5, 5, 5, 7, 7, 4, 4, 6, 7, 10],
    style: { head: [], border: ['grey'] },
  })

  for (const row of rows) table.push(row)
  return table.toString()
}

// ── Helper: schema gap lines ──

function _schemaGapLines(schema_gaps) {
  const out = []
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

  return out
}

// ── Helper: false positive lines ──

function _falsePositiveLines(fp) {
  const grouped = new Map()
  for (const v of fp) {
    if (!grouped.has(v.definedIn)) grouped.set(v.definedIn, new Set())
    grouped.get(v.definedIn).add(v.fn)
  }
  const out = []
  for (const [file, fns] of grouped) {
    out.push(`  ${file}: ${[...fns].join(', ')}`)
  }
  return out
}

// ── Helper: advice lines ──

function _adviceLines(advice) {
  const out = []
  const categories = [
    { type: 'violation', label: 'Fix Encapsulation' },
    { type: 'cycle', label: 'Break Cycles' },
    { type: 'complexity', label: 'Reduce Complexity' },
    { type: 'coupling', label: 'Reduce Coupling' },
    { type: 'orphan', label: 'Remove/Wire Orphans' },
    { type: 'schema_gap', label: 'Sync Schema' },
    { type: 'schema_stale', label: 'Clean Stale Schema' },
    { type: 'hot_path', label: 'Critical Paths' },
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

  return out
}
