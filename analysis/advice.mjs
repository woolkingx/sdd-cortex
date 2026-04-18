/**
 * advice.mjs — Generate actionable advice based on analysis results.
 * Thresholds only here; analysis modules return raw data.
 */

const DEFAULT_THRESHOLDS = {
  functions: 10,
  exports: 8,
  ratio: 5,
  calls: 20,
  fan_out: 8,
  fan_in: 8,
  coupling_degree: 9,
  modularity: 0.3,
}

/**
 * Generate advice from analysis results.
 * @param {Array<ParsedFile>} files - parsed files
 * @param {Array<Edge>} edges - graph edges
 * @param {Array} cycles - from detectCycles()
 * @param {Array} violations - from detectViolations()
 * @param {Array} hotPaths - from findHotPaths()
 * @param {Array} complexity - from computeComplexity()
 * @param {Array} clusters - from detectClusters()
 * @param {Array} centrality - from computeCentrality()
 * @param {Array} schemaGaps - from detectSchemaGaps()
 * @param {object} thresholds - optional threshold overrides
 * @param {Array} duplicates - from detectDuplicateInstantiations()
 * @returns {Array<{type, severity, file, message, detail?}>}
 */
export function generateAdvice(
  files,
  edges,
  cycles,
  violations,
  hotPaths,
  complexity,
  clusters = [],
  centrality = [],
  schemaGaps,
  thresholds = {},
  duplicates = [],
) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const advice = []

  // Build connected set
  const connected = new Set()
  for (const e of edges) {
    connected.add(e.from)
    connected.add(e.to)
  }
  const orphans = files.filter(f => !connected.has(f.path)).map(f => f.path)

  // Violations
  for (const v of violations.filter(v => v.confirmed)) {
    advice.push({
      type: 'violation',
      severity: 'error',
      file: v.definedIn,
      message: `"${v.fn}" is internal but called from ${v.calledFrom}. Export it, or refactor the caller.`,
    })
  }

  // Cycles
  for (const c of cycles) {
    advice.push({
      type: 'cycle',
      severity: 'error',
      file: c.path[0],
      message: `Circular: ${c.path.join(' → ')} → ${c.path[0]}`,
    })
  }

  // Complexity metrics
  for (const cx of complexity) {
    if (cx.functions > t.functions) {
      advice.push({
        type: 'complexity',
        severity: 'warning',
        file: cx.file,
        message: `${cx.functions} functions (threshold: ${t.functions}). ${cx.exports} exported, ${cx.internals} internal.`,
      })
    }
    if (cx.exports > t.exports) {
      advice.push({
        type: 'complexity',
        severity: 'warning',
        file: cx.file,
        message: `${cx.exports} exports (threshold: ${t.exports}). Wide API surface.`,
      })
    }
    if (cx.ratio > t.ratio) {
      advice.push({
        type: 'complexity',
        severity: 'warning',
        file: cx.file,
        message: `internal:export ratio ${cx.ratio}:1 (threshold: ${t.ratio}:1). ${cx.internals} hidden behind ${cx.exports} exports.`,
      })
    }
    if (cx.calls > t.calls) {
      advice.push({
        type: 'complexity',
        severity: 'warning',
        file: cx.file,
        message: `${cx.calls} distinct outgoing calls (threshold: ${t.calls}).`,
      })
    }
    if (cx.fan_out > t.fan_out) {
      advice.push({
        type: 'coupling',
        severity: 'warning',
        file: cx.file,
        message: `fan-out ${cx.fan_out} (threshold: ${t.fan_out}). High import coupling.`,
      })
    }
    if (cx.fan_in > t.fan_in) {
      advice.push({
        type: 'coupling',
        severity: 'info',
        file: cx.file,
        message: `fan-in ${cx.fan_in} (threshold: ${t.fan_in}). High-risk change target.`,
      })
    }

    // High coupling via degree
    const totalDegree = cx.fan_in + cx.fan_out
    if (totalDegree > t.coupling_degree) {
      advice.push({
        type: 'coupling',
        severity: 'warning',
        file: cx.file,
        message: `degree ${totalDegree} (threshold: ${t.coupling_degree}). Highly interconnected module.`,
      })
    }
  }

  // Centrality bottlenecks
  const centralityStats = _getCentralityStats(centrality)
  for (const c of centrality) {
    if (c.betweenness > centralityStats.mean + 2 * centralityStats.stddev) {
      advice.push({
        type: 'bottleneck',
        severity: 'warning',
        file: c.file,
        message: `High betweenness centrality ${c.betweenness.toFixed(2)}. Module is a dependency bottleneck.`,
        detail: `Refactoring risk is high; used by many paths.`,
      })
    }
  }

  // Clustering modularity
  if (clusters.length > 0) {
    const avgModularity = clusters
      .filter(c => typeof c.modularity === 'number')
      .reduce((sum, c) => sum + c.modularity, 0) / clusters.length
    if (avgModularity < t.modularity) {
      advice.push({
        type: 'poor_separation',
        severity: 'info',
        file: 'project',
        message: `Low modularity ${avgModularity.toFixed(2)} (threshold: ${t.modularity}). Poor separation between clusters.`,
        detail: `Consider refactoring to improve module independence.`,
      })
    }
  }

  // Orphans
  for (const file of orphans) {
    const f = files.find(f => f.path === file)
    const exp = f ? f.exports.map(e => e.name).join(', ') : ''
    advice.push({
      type: 'orphan',
      severity: 'warning',
      file,
      message: 'No edges within scanned scope.',
      detail: exp ? `exports: ${exp}` : undefined,
    })
  }

  // Hot paths
  for (const hp of hotPaths) {
    advice.push({
      type: 'hot_path',
      severity: 'info',
      file: hp.path[0],
      message: `Dependency chain ${hp.length} hops: ${hp.path.join(' → ')}`,
    })
  }

  // Duplicate instantiations
  for (const d of duplicates) {
    // Check: are all callers importing sourceFile? (normal pattern, not duplication)
    const allCallersImport = d.callers.every(caller =>
      edges.some(e => e.from === caller && e.to === d.sourceFile && e.type === 'import')
    )
    if (allCallersImport) continue // skip — normal import-and-call pattern

    advice.push({
      type: 'duplicate_instantiation',
      severity: 'warning',
      file: d.sourceFile,
      message: `"${d.factory}" instantiated in ${d.callers.length} files independently.`,
      detail: d.callers.join(', '),
    })
  }

  // Schema gaps
  for (const gap of schemaGaps) {
    advice.push(
      gap.type === 'missing_in_schema'
        ? {
            type: 'schema_gap',
            severity: 'warning',
            file: gap.file,
            message: `"${gap.symbol}" exported but not in schema.`,
          }
        : {
            type: 'schema_stale',
            severity: 'warning',
            file: gap.file,
            message: `"${gap.symbol}" in schema but not exported.`,
          },
    )
  }

  // Sort by severity
  const order = { error: 0, warning: 1, info: 2 }
  advice.sort((a, b) => order[a.severity] - order[b.severity])

  return advice
}

/**
 * Calculate centrality statistics (mean and stddev of betweenness).
 * @private
 */
function _getCentralityStats(centrality) {
  if (centrality.length === 0) return { mean: 0, stddev: 0 }

  const betweenness = centrality.map(c => c.betweenness)
  const mean = betweenness.reduce((a, b) => a + b, 0) / betweenness.length

  const variance =
    betweenness.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / betweenness.length
  const stddev = Math.sqrt(variance)

  return { mean, stddev }
}
