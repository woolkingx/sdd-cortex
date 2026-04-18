// index.mjs — programmatic API entry point
// Pure function orchestration of graph analysis pipeline

import { resolve, dirname } from 'node:path'
import { statSync, readFileSync } from 'node:fs'
import { parseFile, scanDir, findSchemas, buildRegistryFromSchemas, loadRegistryFromFile, applyOverlay, buildSchemaGraph } from './parse/index.mjs'
import { graph, initGraph, rebuildNeighborIndex } from './graph/index.mjs'
import {
  detectCycles, detectViolations, computeComplexity, findHotPaths,
  detectSchemaGaps, detectDuplicateInstantiations, generateAdvice,
  computeStats, computeCentrality, detectClusters,
  traceProcesses, loadEntryPointOverrides, schemaAudit,
  analyzeSchemaBlocks,
} from './analysis/index.mjs'
import { impact as _impact, context as _context } from './query/index.mjs'
import { validate } from './lib/schema2object.mjs'
import { analysisLoader, defs } from './lib/schema-loader.mjs'

let _state = null

function _inferRoot(paths, opts) {
  if (opts.root) return resolve(opts.root)
  const first = paths[0]
  try {
    return statSync(first).isDirectory() ? first : dirname(first)
  } catch {
    return resolve('.')
  }
}

function _collectFiles(paths, extensions) {
  const allPaths = new Set()
  for (const t of paths) {
    try {
      if (statSync(t).isDirectory()) {
        for (const f of scanDir(t, extensions)) allPaths.add(f)
      } else {
        allPaths.add(t)
      }
    } catch {
      // skip not found
    }
  }
  return [...allPaths]
}

function _buildRegistry(rootDir, opts) {
  let registry = null
  let rawSchema = null
  if (opts.registry) {
    registry = loadRegistryFromFile(resolve(opts.registry))
  } else if (opts.schema) {
    const schemaResolved = resolve(opts.schema)
    try {
      rawSchema = JSON.parse(readFileSync(schemaResolved, 'utf8'))
    } catch {
      rawSchema = null
    }
    registry = buildRegistryFromSchemas([schemaResolved])
  } else {
    const schemas = findSchemas(rootDir)
    if (schemas.length > 0) {
      registry = buildRegistryFromSchemas(schemas)
      if (schemas.length > 0) {
        try {
          rawSchema = JSON.parse(readFileSync(schemas[0], 'utf8'))
        } catch {
          rawSchema = null
        }
      }
    }
  }
  return { registry, rawSchema }
}

/**
 * Main analysis function: orchestrates full graph analysis pipeline
 * @param {string[]} paths - files or directories to analyze
 * @param {object} [opts]
 * @param {string} [opts.root] - project root (default: inferred from first path)
 * @param {string} [opts.schema] - schema file path for registry derivation
 * @param {string} [opts.registry] - pre-built PublicInterfaceRegistry JSON path
 * @param {string[]} [opts.extensions] - file extensions (default: ['.mjs', '.js'])
 * @returns {object} AnalysisResult
 */
export function analyze(paths, opts = {}) {
  const resolvedPaths = paths.map(p => resolve(p))
  const extensions = opts.extensions || ['.mjs', '.js']
  const rootDir = _inferRoot(resolvedPaths, opts)

  const pathList = _collectFiles(resolvedPaths, extensions)
  const { registry, rawSchema } = _buildRegistry(rootDir, opts)

  initGraph(pathList, rootDir)

  const files = pathList.map(f => {
    const result = parseFile(f, registry)
    const { path, edges: fileEdges, bindings } = result
    // Parser already called addNode() for FILE/FUNCTION/CLASS/METHOD nodes
    // and pushed edges to the edges array. We just push edges + bindings.
    graph.edges.push(...fileEdges)
    graph.bindings.set(path, bindings)
    return result
  })

  // Rebuild neighbor index after bulk-adding edges
  rebuildNeighborIndex(graph)

  const edges = graph.edges

  // Build schema structure graph (DEFINITION/PROPERTY/REF nodes+edges)
  const schemaGraphResult = buildSchemaGraph(rootDir)
  const schemaAuditResult = schemaAudit()

  const cycles = detectCycles(graph)
  let violations = detectViolations(files, edges, graph)

  if (registry) {
    violations = applyOverlay(violations, registry)
  }

  const complexity = computeComplexity(files, graph)
  const hotPaths = findHotPaths(graph)
  const clusters = detectClusters(graph)
  const centrality = computeCentrality(graph)
  const schemaGaps = detectSchemaGaps(files, registry, edges, (data, schema) => validate(data, schema, analysisLoader), defs)
  const duplicates = detectDuplicateInstantiations(graph)
  const stats = computeStats(files, edges, graph, cycles, violations, hotPaths, complexity, clusters, centrality, duplicates)
  const advice = generateAdvice(files, edges, cycles, violations, hotPaths, complexity, clusters, centrality, schemaGaps, {}, duplicates)

  const result = {
    project: rootDir,
    timestamp: new Date().toISOString(),
    nodes: [...graph.nodes.values()],
    files,
    edges,
    cycles,
    violations,
    complexity,
    hot_paths: hotPaths,
    clusters,
    centrality,
    schema_gaps: schemaGaps,
    duplicate_instantiations: duplicates,
    advice,
    stats,
    registry: registry || null,
    schema_audit: schemaAuditResult,
  }

  _state = { graph, files, edges, registry, rawSchema, rootDir }

  return result
}

/**
 * Impact analysis: how changes propagate upstream/downstream
 * @param {string} target - symbol or file to analyze
 * @param {object} [opts]
 * @param {string} [opts.direction] - 'upstream' or 'downstream' (default: 'upstream')
 * @param {number} [opts.maxDepth] - max traversal depth (default: 3)
 * @returns {object} ImpactResult
 */
analyze.impact = function(target, opts = {}) {
  if (!_state) throw Error('call analyze() first')
  const direction = opts.direction || 'upstream'
  const maxDepth = opts.maxDepth || 3
  return _impact(_state.graph, target, { direction, maxDepth })
}

/**
 * Context query: find all references and definitions of a symbol
 * @param {string} target - symbol name to query
 * @returns {object} ContextResult
 */
analyze.context = function(target) {
  if (!_state) throw Error('call analyze() first')
  return _context(_state.graph, target)
}

/**
 * Cluster detection: find cohesive groups of modules
 * @returns {array} ClusterInfo[]
 */
analyze.clusters = function() {
  if (!_state) throw Error('call analyze() first')
  return detectClusters(_state.graph)
}

/**
 * Process tracing: identify entry points and execution flows
 * @param {object} [opts]
 * @param {number} [opts.threshold] - centrality threshold (default: 0.4)
 * @returns {array} ProcessInfo[]
 */
analyze.processes = function(opts = {}) {
  if (!_state) throw Error('call analyze() first')
  const threshold = opts.threshold || 0.4
  const overrides = _state.rawSchema ? loadEntryPointOverrides(_state.rawSchema) : []
  return traceProcesses(_state.graph, { threshold, overrides: overrides.length ? overrides : undefined })
}

/**
 * Schema block analysis: run graph algorithms on schema $ref subgraph
 * @returns {object} SchemaBlocksResult
 */
analyze.schemaBlocks = function() {
  if (!_state) throw Error('call analyze() first')
  return analyzeSchemaBlocks(_state.graph)
}
