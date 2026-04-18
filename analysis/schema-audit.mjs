// schema-audit.mjs — Analyze schema graph for structural problems.
// Runs over DEFINITION/PROPERTY nodes and REF edges in the graph singleton.

import { graph } from '../graph/index.mjs'
import { NL, EL } from '../lib/schema-loader.mjs'

/**
 * Run schema self-audit on the graph singleton.
 * Requires buildSchemaGraph() to have been called first.
 * @returns {SchemaAuditResult}
 */
export function schemaAudit() {
  const defNodes = [...graph.nodes.values()].filter(n => n.label === NL.DEFINITION)
  const propNodes = [...graph.nodes.values()].filter(n => n.label === NL.PROPERTY)
  const schemaFileNodes = [...graph.nodes.values()].filter(n => n.label === NL.SCHEMA_FILE)
  const refEdges = graph.edges.filter(e => e.label === EL.REF)

  // 1. Dead definitions — not targeted by any REF edge and not a root definition (AnalysisResult)
  const refTargets = new Set(refEdges.map(e => e.to))
  const dead_definitions = defNodes
    .filter(d => !refTargets.has(d.id))
    .filter(d => !d.name.includes('AnalysisResult')) // root is always alive
    .map(d => d.id)

  // 2. Broken refs — REF edge targets a node that doesn't exist
  const broken_refs = refEdges
    .filter(e => !graph.nodes.has(e.to))
    .map(e => ({
      from: e.from,
      ref: e.to,
      reason: 'not_found',
    }))

  // 3. Ref cycles — DFS on DEFINITION nodes following REF edges
  const ref_cycles = _detectRefCycles(defNodes, refEdges)

  // 4. Duplicate names — same definition name in multiple schema files
  const nameMap = new Map()
  for (const d of defNodes) {
    if (!nameMap.has(d.name)) nameMap.set(d.name, [])
    nameMap.get(d.name).push(d.file)
  }
  const duplicate_names = [...nameMap.entries()]
    .filter(([, files]) => new Set(files).size > 1)
    .map(([name]) => name)

  // 5. Orphan schema files — not referenced by any REF edge from other files
  const refTargetFiles = new Set(refEdges.map(e => {
    const toNode = graph.nodes.get(e.to)
    return toNode?.file
  }))
  const orphan_files = schemaFileNodes
    .filter(sf => !refTargetFiles.has(sf.name))
    .filter(sf => sf.name !== 'graph-analysis.json') // root hub is never orphan
    .map(sf => sf.name)

  return {
    total_definitions: defNodes.length,
    total_refs: refEdges.length,
    total_properties: propNodes.length,
    dead_definitions,
    broken_refs,
    ref_cycles,
    duplicate_names,
    orphan_files,
  }
}

/**
 * DFS cycle detection on DEFINITION nodes following REF edges.
 * @private
 */
function _detectRefCycles(defNodes, refEdges) {
  const cycles = []
  const visited = new Set()
  const stack = new Set()
  const path = []

  // Build adjacency from REF edges
  const adj = new Map()
  for (const e of refEdges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from).push(e.to)
  }

  function dfs(node) {
    if (stack.has(node)) {
      const idx = path.indexOf(node)
      if (idx >= 0) {
        const cycle = path.slice(idx)
        const files = new Set(cycle.map(id => graph.nodes.get(id)?.file).filter(Boolean))
        cycles.push({
          path: cycle,
          nodes: cycle.map(id => graph.nodes.get(id) || { id, label: NL.DEFINITION, name: id, file: '', parent: null, exported: false }),
          length: cycle.length,
          level: 'symbol',
          crossFile: files.size > 1,
        })
      }
      return
    }
    if (visited.has(node)) return

    visited.add(node)
    stack.add(node)
    path.push(node)

    for (const next of (adj.get(node) || [])) {
      dfs(next)
    }

    path.pop()
    stack.delete(node)
  }

  for (const d of defNodes) {
    if (!visited.has(d.id)) dfs(d.id)
  }

  return cycles
}
