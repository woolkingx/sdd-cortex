// schema-overlay.mjs — Layer 4: Optional schema overlay for SDD projects
// Loads PublicInterfaceRegistry from schema, reclassifies violations.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

// Auto-detect schema files in a project
export function findSchemas(rootDir) {
  const candidates = ['config', 'schema', 'schemas']
  const found = []

  // Check known directories
  for (const dir of candidates) {
    const full = join(rootDir, dir)
    try {
      if (statSync(full).isDirectory()) {
        for (const f of readdirSync(full)) {
          if (f.endsWith('.json')) found.push(join(full, f))
        }
      }
    } catch {}
  }

  // Check root for *.schema.json
  try {
    for (const f of readdirSync(rootDir)) {
      if (f.endsWith('.schema.json')) found.push(join(rootDir, f))
    }
  } catch {}

  return found
}

// Build PublicInterfaceRegistry from schema files
// Reads x-methods keys as public method names
export function buildRegistryFromSchemas(schemaPaths) {
  const registry = {}

  for (const schemaPath of schemaPaths) {
    try {
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
      extractPublicMethods(schema, registry)
    } catch {}
  }

  return Object.keys(registry).length > 0 ? registry : null
}

function extractPublicMethods(schema, registry) {
  if (!schema.definitions) return

  for (const [name, def] of Object.entries(schema.definitions)) {
    if (!def['x-methods']) continue
    const key      = def.title || name
    const xmethods = def['x-methods']
    const methods  = Object.keys(xmethods)

    // Extract paramCount from x-methods properties.params or required length
    const params = {}
    for (const [mName, mDef] of Object.entries(xmethods)) {
      if (typeof mDef === 'object' && mDef.properties?.params) {
        params[mName] = mDef.properties.params.minItems ?? mDef.properties.params.maxItems ?? null
      }
    }

    registry[key] = { methods, xmethods, params }
  }
}

// Load a pre-built registry from a JSON file (e.g. graph-analysis.json PublicInterfaceRegistry.default)
export function loadRegistryFromFile(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'))
    // Support both flat registry and schema with definitions.PublicInterfaceRegistry.default
    if (data.definitions?.PublicInterfaceRegistry?.default) {
      return data.definitions.PublicInterfaceRegistry.default
    }
    // Flat object: { "file.mjs": ["method1", "method2"] }
    if (typeof data === 'object' && !Array.isArray(data)) {
      const first = Object.values(data)[0]
      if (Array.isArray(first)) return data
    }
    return null
  } catch {
    return null
  }
}

// Apply schema overlay: reclassify violations based on registry
export function applyOverlay(violations, registry) {
  if (!registry) return violations

  return violations.map(v => {
    const publicMethods = registry[v.definedIn]
    if (publicMethods && publicMethods.includes(v.fn)) {
      return { ...v, confirmed: false, reason: 'schema_public' }
    }
    return v
  })
}
