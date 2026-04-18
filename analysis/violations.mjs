import { NL, EL } from '../lib/schema-loader.mjs'

export function detectViolations(files, edges, graph = null) {
  if (graph && graph.nodes instanceof Map && graph.edges) {
    // CPG-lite path: graph.nodes = Map<id, GraphNode>
    const isNewModel = graph.nodes.size > 0 &&
      [...graph.nodes.values()][0]?.label !== undefined

    if (isNewModel) {
      return graph.edges
        .filter(e => e.label === EL.CALL && e.to && (e.attrs?.resolved !== false))
        .flatMap(e => {
          const fromFile = e.from.includes('::') ? e.from.split('::')[0] : e.from
          const toFile = e.to.includes('::') ? e.to.split('::')[0] : e.to

          if (fromFile === toFile) return []

          const calleeNode = graph.nodes.get(e.to)
          if (!calleeNode) return []

          if (calleeNode.exported === false) {
            // Skip methods on exported classes (e.g. BusError.draining())
            const calleeFile = calleeNode.file
            const calleeName = calleeNode.name
            let isClassMethod = false
            for (const [, n] of graph.nodes) {
              if (n.file === calleeFile && n.label === NL.CLASS && n.exported &&
                  n.attrs?.methods?.includes(calleeName)) {
                isClassMethod = true
                break
              }
            }
            if (isClassMethod) return []

            const callerNode = graph.nodes.get(e.from)
            return [{
              caller: e.from,
              callee: e.to,
              callerNode: callerNode || null,
              calleeNode,
              confirmed: true,
              reason: 'import_link',
              crossFile: true,
              // backward compat
              fn: calleeNode.name,
              definedIn: calleeNode.file,
              calledFrom: callerNode?.file || fromFile,
            }]
          }
          return []
        })
    }
  }

  // Legacy path: files-based detection
  const importGraph = new Map()
  for (const f of files) importGraph.set(f.path, new Set())
  for (const e of edges) {
    const label = (e.label || e.type || '').toUpperCase()
    if (label === EL.IMPORT || label === EL.DYNAMIC_IMPORT || label === EL.REEXPORT) {
      importGraph.get(e.from)?.add(e.to)
    }
  }

  const violations = []
  for (const f of files) {
    const internalFns = f.functions.filter(fn => !fn.isExported).map(fn => fn.name)
    for (const fn of internalFns) {
      for (const other of files) {
        if (other.path === f.path) continue
        if (!other.calls.includes(fn)) continue
        const hasImportLink = importGraph.get(other.path)?.has(f.path) ?? false
        violations.push({
          caller: `${other.path}::${fn}`,
          callee: `${f.path}::${fn}`,
          fn, definedIn: f.path, calledFrom: other.path,
          confirmed: hasImportLink,
          reason: hasImportLink ? 'import_link' : 'name_collision',
          crossFile: true,
        })
      }
    }
  }
  return violations
}
