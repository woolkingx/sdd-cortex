// schema-graph.mjs — Build schema structure graph from JSON Schema files.
// Walks all schema files, creates DEFINITION/PROPERTY nodes + REF/DEFINES/HAS_PROPERTY edges.
// Uses same graph singleton as code graph — unified CPG-lite model.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { graph, addNode } from '../graph/index.mjs'
import { NL, EL } from '../lib/schema-loader.mjs'

/**
 * Build schema graph from all JSON Schema files in project.
 * @param {string} rootDir - project root
 * @returns {{ totalDefinitions: number, totalRefs: number, totalProperties: number, schemaFiles: string[] }}
 */
export function buildSchemaGraph(rootDir) {
  const schemaFiles = _findSchemaFiles(rootDir)
  let totalDefinitions = 0
  let totalRefs = 0
  let totalProperties = 0

  for (const absPath of schemaFiles) {
    const relPath = relative(rootDir, absPath)
    const schemaId = `schema::${relPath}`

    let raw
    try { raw = JSON.parse(readFileSync(absPath, 'utf8')) }
    catch { continue }

    // SCHEMA_FILE node
    addNode({
      id: schemaId, label: NL.SCHEMA_FILE, name: relPath,
      fullName: schemaId, file: relPath, parent: null, exported: false,
    })

    // Walk definitions
    const defs = raw.definitions || {}
    for (const [defName, defSchema] of Object.entries(defs)) {
      const defId = `schema::${relPath}#${defName}`
      totalDefinitions++

      addNode({
        id: defId, label: NL.DEFINITION, name: defName,
        fullName: defId, file: relPath, parent: schemaId, exported: true,
        attrs: {
          type: defSchema.type || null,
          required: defSchema.required || [],
          hasXMethods: !!defSchema['x-methods'],
          hasXSource: !!defSchema['x-source'],
        },
      })

      // DEFINES edge: schema file → definition
      graph.edges.push({
        from: schemaId, to: defId, label: EL.DEFINES,
        fromLabel: NL.SCHEMA_FILE, toLabel: NL.DEFINITION,
        attrs: { resolved: true, symbols: [] },
      })

      // Walk properties → PROPERTY nodes + HAS_PROPERTY edges
      const props = defSchema.properties || {}
      for (const [propName, propSchema] of Object.entries(props)) {
        const propId = `${defId}.${propName}`
        totalProperties++

        addNode({
          id: propId, label: NL.PROPERTY, name: propName,
          fullName: propId, file: relPath, parent: defId, exported: false,
          attrs: {
            type: propSchema.type || null,
            hasRef: !!propSchema.$ref,
            refTarget: propSchema.$ref || null,
          },
        })

        graph.edges.push({
          from: defId, to: propId, label: EL.HAS_PROPERTY,
          fromLabel: NL.DEFINITION, toLabel: NL.PROPERTY,
          attrs: { resolved: true, symbols: [] },
        })

        // If property has $ref, create REF edge
        if (propSchema.$ref) {
          const targetDefId = _resolveRefToDefId(propSchema.$ref, relPath)
          totalRefs++
          graph.edges.push({
            from: defId, to: targetDefId, label: EL.REF,
            fromLabel: NL.DEFINITION, toLabel: NL.DEFINITION,
            attrs: { resolved: true, symbols: [{ name: propName }] },
          })
        }

        // If property has items.$ref (array of $ref)
        if (propSchema.items?.$ref) {
          const targetDefId = _resolveRefToDefId(propSchema.items.$ref, relPath)
          totalRefs++
          graph.edges.push({
            from: defId, to: targetDefId, label: EL.REF,
            fromLabel: NL.DEFINITION, toLabel: NL.DEFINITION,
            attrs: { resolved: true, symbols: [{ name: propName }] },
          })
        }
      }

      // Top-level $ref on definition itself (like BindingInfo.$ref, Edge.$ref)
      if (defSchema.$ref) {
        const targetDefId = _resolveRefToDefId(defSchema.$ref, relPath)
        totalRefs++
        graph.edges.push({
          from: defId, to: targetDefId, label: EL.REF,
          fromLabel: NL.DEFINITION, toLabel: NL.DEFINITION,
          attrs: { resolved: true, symbols: [] },
        })
      }

      // allOf with $ref
      if (defSchema.allOf) {
        for (const sub of defSchema.allOf) {
          if (sub.$ref) {
            const targetDefId = _resolveRefToDefId(sub.$ref, relPath)
            totalRefs++
            graph.edges.push({
              from: defId, to: targetDefId, label: EL.REF,
              fromLabel: NL.DEFINITION, toLabel: NL.DEFINITION,
              attrs: { resolved: true, symbols: [] },
            })
          }
        }
      }

      // oneOf with $ref
      if (defSchema.oneOf) {
        for (const sub of defSchema.oneOf) {
          if (sub.$ref) {
            const targetDefId = _resolveRefToDefId(sub.$ref, relPath)
            totalRefs++
            graph.edges.push({
              from: defId, to: targetDefId, label: EL.REF,
              fromLabel: NL.DEFINITION, toLabel: NL.DEFINITION,
              attrs: { resolved: true, symbols: [] },
            })
          }
        }
      }
    }
  }

  return { totalDefinitions, totalRefs, totalProperties, schemaFiles: schemaFiles.map(f => relative(rootDir, f)) }
}

/**
 * Convert a $ref path to a schema graph definition id.
 * Examples:
 *   "#/definitions/ParsedFile" → "schema::graph-analysis.json#ParsedFile"
 *   "schema/graph/edge.json#/definitions/GraphEdge" → "schema::schema/graph/edge.json#GraphEdge"
 *   "node.json#/definitions/NodeLabel" → (relative to current file dir)
 * @private
 */
function _resolveRefToDefId(ref, currentFile) {
  if (ref.startsWith('#/definitions/')) {
    const defName = ref.slice('#/definitions/'.length)
    return `schema::${currentFile}#${defName}`
  }

  const hashIdx = ref.indexOf('#')
  if (hashIdx >= 0) {
    let filePart = ref.slice(0, hashIdx)
    const fragment = ref.slice(hashIdx + 1)
    const defName = fragment.replace('/definitions/', '')

    // Resolve relative path (e.g. "node.json" relative to "schema/graph/edge.json")
    if (!filePart.startsWith('schema/')) {
      const dir = currentFile.includes('/') ? currentFile.slice(0, currentFile.lastIndexOf('/')) : ''
      filePart = dir ? `${dir}/${filePart}` : filePart
    }

    // Normalize ../ segments (e.g. "schema/analysis/../graph/node.json" → "schema/graph/node.json")
    const parts = filePart.split('/')
    const normalized = []
    for (const p of parts) {
      if (p === '..' && normalized.length > 0) normalized.pop()
      else if (p !== '.') normalized.push(p)
    }
    filePart = normalized.join('/')

    return `schema::${filePart}#${defName}`
  }

  // No hash — just a file reference
  return `schema::${ref}`
}

/**
 * Find all JSON Schema files in project.
 * @private
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.bare', '.cleanup', '.backup', '.sessions'])

function _findSchemaFiles(rootDir) {
  const files = []
  _walkJsonRecursive(rootDir, files)
  // Filter: only files with definitions or $schema (actual JSON Schema files)
  return files.filter(f => {
    try {
      const raw = readFileSync(f, 'utf8')
      // Quick string check before parsing — fast reject
      if (!raw.includes('"definitions"') && !raw.includes('"$schema"')) return false
      const obj = JSON.parse(raw)
      return obj.definitions || obj.$schema
    } catch { return false }
  })
}

function _walkJsonRecursive(dir, files) {
  try {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      const full = join(dir, entry)
      try {
        if (statSync(full).isDirectory()) { _walkJsonRecursive(full, files); continue }
      } catch { continue }
      if (entry.endsWith('.json')) files.push(full)
    }
  } catch {}
}
