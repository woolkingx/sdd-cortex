#!/usr/bin/env node
// cli.mjs — sdd-graph CLI (thin shell over index.mjs API)
// Schema-driven: raw argv → ObjectTree(CliArgs) → dispatch

import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { loader as rootLoader } from './lib/schema-loader.mjs'
import { ObjectTree } from './lib/schema2object.mjs'
import { analyze } from './index.mjs'
import { reportJson, reportText, reportMermaid, swimlane as renderSwimlane } from './output/index.mjs'

// ── Schema-driven arg parsing ──────────────────────────────────────────────────

let _cliArgsSchema = null
function _getCliArgsSchema() {
  if (_cliArgsSchema) return _cliArgsSchema
  _cliArgsSchema = rootLoader.resolve('schema/cli/cli.json#/definitions/CliArgs')
  return _cliArgsSchema
}

/**
 * Parse process.argv into schema-validated CliArgs.
 * @param {string[]} argv - raw args (process.argv.slice(2))
 * @returns {object} validated CliArgs with defaults applied
 */
function parseArgs(argv) {
  const raw = { paths: [] }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      // Boolean flags
      case '--json':          raw.json = true; break
      case '--mermaid':       raw.mermaid = true; break
      case '--swimlane':      raw.swimlane = true; break
      case '--ci':            raw.ci = true; break
      case '--help': case '-h': raw.help = true; break
      case '--schema-audit':  raw.schemaAudit = true; break
      case '--schema-blocks': raw.schemaBlocks = true; break
      case '--map':           raw.map = true; break
      case '--clusters':      raw.clusters = true; break
      case '--processes':     raw.processes = true; break

      // Value options
      case '--root':       raw.root = argv[++i]; break
      case '--schema':     raw.schema = argv[++i]; break
      case '--registry':   raw.registry = argv[++i]; break
      case '--ext':        raw.ext = argv[++i]; break
      case '-o': case '--output': raw.output = argv[++i]; break
      case '--impact':     raw.impact = argv[++i]; break
      case '--context':    raw.context = argv[++i]; break
      case '--direction':  raw.direction = argv[++i]; break
      case '--depth':      raw.depth = parseInt(argv[++i], 10); break
      case '--threshold':  raw.threshold = parseFloat(argv[++i]); break
      case '--query':      raw.query = argv[++i]; break

      // Positional
      default:
        if (!a.startsWith('-')) raw.paths.push(resolve(a))
        break
    }
  }

  if (raw.paths.length === 0) raw.paths.push(resolve('.'))

  // Validate + apply defaults via schema
  const { node, loader: sub } = _getCliArgsSchema()
  return new ObjectTree(raw, node, sub).$toDict()
}

// ── Help text ──────────────────────────────────────────────────────────────────

const HELP = `sdd-graph — Schema-driven dependency graph analysis for JS/ESM projects

USAGE
  sdd-graph [options] <path...>
  sdd-graph --impact <symbol> [--direction upstream|downstream] [--depth N]
  sdd-graph --context <symbol>
  sdd-graph --clusters
  sdd-graph --processes [--threshold N]

PATHS
  <path>            File or directory to analyze (default: .)

OPTIONS
  --root DIR        Project root for relative paths (default: inferred)
  --schema FILE     Schema file for registry derivation
  --registry FILE   Pre-built PublicInterfaceRegistry JSON
  --ext .mjs,.js    File extensions to scan (default: .mjs,.js)
  -o, --output FILE Write output to file

OUTPUT FORMAT
  --json            JSON output (AnalysisResult schema)
  --mermaid         Mermaid dependency graph
  --swimlane        Swimlane dependency diagram
  --ci              Exit code 1 if violations found

QUERY MODES
  --impact SYMBOL   Blast radius analysis for a symbol or file
    --direction     upstream (default) or downstream
    --depth N       Max BFS depth (default: 3)
  --context SYMBOL  Show callers, callees, and symbol info
  --clusters        Detect module clusters (Louvain)
  --map             Architecture map (file->fn->edges bird's eye view)
  --schema-audit    Schema self-audit (dead defs, broken refs, cycles)
  --schema-blocks   Schema block boundary analysis (Louvain/$ref graph)
  --processes       Trace business processes
    --threshold N   Coupling threshold (default: 0.4)

EXAMPLES
  sdd-graph src/                    Analyze src/ directory
  sdd-graph --json -o report.json   Save JSON report
  sdd-graph --impact createUser     Show blast radius
  sdd-graph --mermaid > deps.md     Export Mermaid graph
  sdd-graph --ci src/               CI gate: fail on violations
`

// ── Main ───────────────────────────────────────────────────────────────────────

const cli = parseArgs(process.argv.slice(2))

if (cli.help || process.argv.length <= 2) {
  process.stdout.write(HELP)
  process.exit(0)
}

// Derive format from flags
const format = cli.json ? 'json' : cli.mermaid ? 'mermaid' : cli.swimlane ? 'swimlane' : 'text'

// Build analyze opts
const extensions = cli.ext.split(',').map(e => e.startsWith('.') ? e : '.' + e)
const analyzeOpts = { extensions }
if (cli.root) analyzeOpts.root = cli.root
if (cli.schema) analyzeOpts.schema = cli.schema
if (cli.registry) analyzeOpts.registry = cli.registry

// Run full analysis pipeline
const result = analyze(cli.paths, analyzeOpts)

// ── Dispatch by mode ───────────────────────────────────────────────────────────

// Query mode: --query CYPHER
if (cli.query) {
  ;(async () => {
    const { importGraph, query } = await import('./query/index.mjs')
    const { graph } = await import('./graph/index.mjs')
    process.stderr.write(`importing ${graph.nodes.size} nodes, ${graph.edges.length} edges into Cypher engine...\n`)
    await importGraph(graph)
    process.stderr.write('ready.\n')
    try {
      const qr = await query(cli.query)
      if (format === 'json') {
        process.stdout.write(JSON.stringify(qr, null, 2) + '\n')
      } else {
        if (qr.output && qr.output.length > 0) {
          const keys = Object.keys(qr.output[0])
          for (const row of qr.output) {
            process.stdout.write(keys.map(k => row[k] ?? '').join('\t') + '\n')
          }
          process.stderr.write(`\n${qr.output.length} rows\n`)
        } else {
          process.stdout.write('(no results)\n')
        }
      }
    } catch (err) {
      process.stderr.write(`cypher error: ${err}\n`)
      process.exit(1)
    }
    process.exit(0)
  })()
  await new Promise(() => {})
}

// Query mode: --impact SYMBOL
if (cli.impact) {
  const impactResult = analyze.impact(cli.impact, { direction: cli.direction, maxDepth: cli.depth })

  if (format === 'json') {
    process.stdout.write(JSON.stringify(impactResult, null, 2) + '\n')
  } else {
    const lines = [`impact(${impactResult.target}) direction=${impactResult.direction}`]
    if (impactResult.seeds.length === 0) {
      lines.push('  target not found in graph')
    } else {
      lines.push(`  seeds: ${impactResult.seeds.join(', ')}`)
      lines.push(`  total affected: ${impactResult.total}`)
      for (const d of impactResult.depths) {
        const risk = d.depth === 1 ? 'WILL BREAK'
                   : d.depth === 2 ? 'LIKELY AFFECTED'
                   : 'MAY NEED TESTING'
        lines.push(`  d=${d.depth} (${risk}): ${d.files.length}`)
        for (const f of d.files) lines.push(`    ${f}`)
      }
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exit(0)
}

// Query mode: --context SYMBOL
if (cli.context) {
  const contextResult = analyze.context(cli.context)

  if (format === 'json') {
    process.stdout.write(JSON.stringify(contextResult, null, 2) + '\n')
  } else {
    const lines = [`context(${contextResult.target})`]
    if (contextResult.symbols.length === 0 && contextResult.callers.length === 0) {
      lines.push('  target not found in graph')
    } else {
      lines.push(`  symbols: ${contextResult.symbols.length}`)
      for (const s of contextResult.symbols) {
        lines.push(`    ${s.file}:${s.name} [${s.label}${s.exported ? ', exported' : ''}]`)
      }
      lines.push(`  callers (d=1): ${contextResult.callers.length}`)
      for (const e of contextResult.callers) lines.push(`    ${e.from} →(${e.label})→`)
      lines.push(`  callees (d=1): ${contextResult.callees.length}`)
      for (const e of contextResult.callees) lines.push(`    →(${e.label})→ ${e.to}`)
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exit(0)
}

// Query mode: --clusters
if (cli.clusters) {
  const clusters = analyze.clusters()

  if (format === 'json') {
    process.stdout.write(JSON.stringify(clusters, null, 2) + '\n')
  } else {
    const lines = [`clusters: ${clusters.length}`]
    for (const c of clusters) {
      lines.push(`  [${c.size}] ${c.id}`)
      for (const f of c.files) lines.push(`    ${f}`)
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exit(0)
}

// Query mode: --schema-audit
if (cli.schemaAudit) {
  const audit = result.schema_audit

  if (format === 'json') {
    process.stdout.write(JSON.stringify(audit, null, 2) + '\n')
  } else {
    const lines = [`schema-audit: ${audit.total_definitions} definitions, ${audit.total_refs} refs, ${audit.total_properties} properties`]
    if (audit.dead_definitions.length > 0) {
      lines.push(`\n  dead definitions (${audit.dead_definitions.length}):`)
      for (const d of audit.dead_definitions) lines.push(`    ${d}`)
    }
    if (audit.broken_refs.length > 0) {
      lines.push(`\n  broken $ref (${audit.broken_refs.length}):`)
      for (const b of audit.broken_refs) lines.push(`    ${b.from} → ${b.ref} (${b.reason})`)
    }
    if (audit.ref_cycles.length > 0) {
      lines.push(`\n  $ref cycles (${audit.ref_cycles.length}):`)
      for (const c of audit.ref_cycles) lines.push(`    ${c.path.join(' → ')}`)
    }
    if (audit.duplicate_names.length > 0) {
      lines.push(`\n  duplicate names: ${audit.duplicate_names.join(', ')}`)
    }
    if (audit.orphan_files.length > 0) {
      lines.push(`\n  orphan schema files: ${audit.orphan_files.join(', ')}`)
    }
    if (audit.dead_definitions.length === 0 && audit.broken_refs.length === 0 && audit.ref_cycles.length === 0) {
      lines.push('  (no issues found)')
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exit(0)
}

// Query mode: --schema-blocks
if (cli.schemaBlocks) {
  const sb = analyze.schemaBlocks()

  if (format === 'json') {
    process.stdout.write(JSON.stringify(sb, null, 2) + '\n')
  } else {
    const lines = []
    lines.push(`# Schema Block Analysis`)
    lines.push(``)
    lines.push(`  ${sb.nodes} definitions, ${sb.edges} $ref edges`)
    lines.push(``)
    lines.push(`## Suggested Blocks (Louvain clusters)`)
    lines.push(``)
    for (const c of sb.clusters) {
      lines.push(`  [${c.size}] cluster ${c.id}`)
      for (const m of c.members) lines.push(`    ${m}`)
    }
    if (sb.bridges.length > 0) {
      lines.push(``)
      lines.push(`## Bridge Definitions (high betweenness — block public interfaces)`)
      lines.push(``)
      for (const b of sb.bridges) {
        lines.push(`  ${b.score.toFixed(4)}  ${b.id}`)
      }
    }
    lines.push(``)
    lines.push(`## $ref Cycles`)
    if (sb.cycles.length === 0) {
      lines.push(`  (none)`)
    } else {
      for (const c of sb.cycles) lines.push(`  ${c.join(' → ')}`)
    }
    lines.push(``)
    lines.push(`## File Alignment`)
    lines.push(``)
    const misaligned = sb.fileAlignment.filter(fa => !fa.aligned)
    if (misaligned.length === 0) {
      lines.push(`  All clusters align with schema files`)
    } else {
      lines.push(`  ${misaligned.length} clusters span multiple files:`)
      for (const fa of misaligned) {
        lines.push(`    cluster ${fa.cluster} (${fa.size}): ${fa.files.map(f => f.file).join(', ')}`)
      }
    }
    lines.push(``)
    lines.push(`## Code Block Alignment`)
    lines.push(``)
    const mixed = sb.blockAlignment.filter(ba => ba.mixedBlocks)
    if (mixed.length === 0) {
      lines.push(`  All clusters map to single code blocks`)
    } else {
      lines.push(`  ${mixed.length} clusters span multiple code blocks:`)
      for (const ba of mixed) {
        lines.push(`    cluster ${ba.cluster} (${ba.size}): ${ba.blocks.map(b => `${b.block}(${b.count})`).join(', ')}`)
      }
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exit(0)
}

// Query mode: --map (architecture bird's eye view)
if (cli.map) {
  const nodes = result.nodes
  const edges = result.edges
  const audit = result.schema_audit

  if (format === 'json') {
    const map = {}
    const fileNodes = nodes.filter(n => n.label === 'FILE')
    for (const f of fileNodes) {
      const syms = nodes.filter(n => n.file === f.id && n.label !== 'FILE')
      const exp = syms.filter(n => n.exported).map(n => n.name)
      const int = syms.filter(n => !n.exported).map(n => n.name)
      const imports = edges.filter(e => e.from === f.id && e.label === 'IMPORT').map(e => e.to)
      const callsOut = edges.filter(e => e.label === 'CALL' && nodes.find(n => n.id === e.from)?.file === f.id && nodes.find(n => n.id === e.to)?.file !== f.id)
        .map(e => e.to)
      map[f.id] = { exports: exp, internals: int, imports, callsOut }
    }
    process.stdout.write(JSON.stringify({ files: map, schema: audit ? { defs: audit.total_definitions, refs: audit.total_refs, dead: audit.dead_definitions.length, broken: audit.broken_refs.length, cycles: audit.ref_cycles.length } : null }, null, 2) + '\n')
  } else {
    const lines = []
    const fileNodes = nodes.filter(n => n.label === 'FILE')
    const symNodes = nodes.filter(n => n.label !== 'FILE' && !n.id.startsWith('schema::'))
    const callEdges = edges.filter(e => e.label === 'CALL' || e.label === 'CALLBACK' || e.label === 'CALL_INDIRECT')
    const importEdges = edges.filter(e => e.label === 'IMPORT' || e.label === 'DYNAMIC_IMPORT' || e.label === 'REEXPORT')

    lines.push(`# Architecture Map\n`)
    lines.push(`  ${fileNodes.length} files, ${symNodes.length} symbols, ${importEdges.length} imports, ${callEdges.length} call edges`)
    if (audit) lines.push(`  schema: ${audit.total_definitions} defs, ${audit.total_refs} refs, ${audit.dead_definitions.length} dead, ${audit.broken_refs.length} broken`)
    lines.push('')

    const fanIn = new Map()
    const fanOut = new Map()
    for (const e of importEdges) {
      fanIn.set(e.to, (fanIn.get(e.to) || 0) + 1)
      fanOut.set(e.from, (fanOut.get(e.from) || 0) + 1)
    }

    const sorted = [...fileNodes].sort((a, b) => (fanIn.get(b.id) || 0) - (fanIn.get(a.id) || 0))

    for (const f of sorted) {
      const syms = nodes.filter(n => n.file === f.id && n.label !== 'FILE')
      const exp = syms.filter(n => n.exported)
      const int = syms.filter(n => !n.exported)
      const fi = fanIn.get(f.id) || 0
      const fo = fanOut.get(f.id) || 0
      const outCalls = callEdges.filter(e => {
        const fromNode = nodes.find(n => n.id === e.from)
        const toNode = nodes.find(n => n.id === e.to)
        return fromNode?.file === f.id && toNode?.file !== f.id
      })

      lines.push(`  ${f.id}  [in:${fi} out:${fo}] ${exp.length} exp, ${int.length} int`)
      if (exp.length > 0) {
        for (const n of exp) {
          const sig = n.attrs?.signature || n.name
          const doc = n.attrs?.jsdoc ? `  — ${n.attrs.jsdoc}` : ''
          lines.push(`    ${sig}${doc}`)
        }
      }
      if (outCalls.length > 0) {
        const targets = [...new Set(outCalls.map(e => e.to))]
        lines.push(`    calls→ ${targets.join(', ')}`)
      }
    }

    if (result.cycles.length > 0 || result.violations.filter(v => v.confirmed).length > 0) {
      lines.push('\n## Issues')
      if (result.cycles.length > 0) lines.push(`  cycles: ${result.cycles.length}`)
      const confirmed = result.violations.filter(v => v.confirmed)
      if (confirmed.length > 0) lines.push(`  violations: ${confirmed.length}`)
    }

    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exit(0)
}

// Query mode: --processes
if (cli.processes) {
  const procs = analyze.processes({ threshold: cli.threshold })

  if (format === 'json') {
    process.stdout.write(JSON.stringify(procs, null, 2) + '\n')
  } else {
    const lines = [`processes: ${procs.length} (threshold=${cli.threshold})`]
    for (const p of procs) {
      lines.push(``)
      lines.push(`  entry: ${p.entry}  depth=${p.depth}  steps=${p.steps.length}`)
      if (p.terminals.length > 0) lines.push(`  terminals: ${p.terminals.join(', ')}`)
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exit(0)
}

// ── Full analysis output ───────────────────────────────────────────────────────

let content
if (format === 'json') {
  content = reportJson(result)
} else if (format === 'mermaid') {
  content = reportMermaid(result)
} else if (format === 'swimlane') {
  content = renderSwimlane(result)
} else {
  content = reportText(result)
}

if (cli.output) {
  writeFileSync(resolve(cli.output), content + '\n', 'utf8')
  console.log(`wrote ${resolve(cli.output)}`)
} else {
  process.stdout.write(content + '\n')
}

if (cli.ci && result.stats.confirmed_violations > 0) {
  process.exit(1)
}
