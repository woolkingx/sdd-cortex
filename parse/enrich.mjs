// enrich.mjs — Post-parse enrichment: extract JSDoc, params, body from source code
// Runs after parser walk, enriches existing FUNCTION/METHOD nodes in graph singleton.

import { graph } from '../graph/index.mjs'
import { NL } from '../lib/schema-loader.mjs'

/**
 * Enrich FUNCTION/METHOD nodes for a file with params, jsdoc, returns, body, signature.
 * @param {string} relPath - relative file path (matches node.file)
 * @param {string} code - full source code of the file
 */
export function enrichNodes(relPath, code) {
  const lines = code.split('\n')

  for (const node of graph.nodes.values()) {
    if (node.file !== relPath) continue
    if (node.label !== NL.FUNCTION && node.label !== NL.METHOD) continue
    if (!node.loc) continue

    const startLine = node.loc.start  // 1-based
    const endLine = node.loc.end      // 1-based

    if (!node.attrs) node.attrs = {}

    // Extract body (full source lines)
    if (startLine > 0 && endLine > 0 && endLine <= lines.length) {
      node.attrs.body = lines.slice(startLine - 1, endLine).join('\n')
    }

    // Extract params from body's first line (function signature)
    if (!node.attrs.params && node.attrs.body) {
      node.attrs.params = _extractParams(node.attrs.body)
    }

    // Extract JSDoc from lines preceding the function
    const jsdoc = _extractJSDoc(lines, startLine - 1)
    if (jsdoc) {
      node.attrs.jsdoc = jsdoc.description
      if (jsdoc.returns && !node.attrs.returns) {
        node.attrs.returns = jsdoc.returns
      }
    }

    // Build signature: name(params) → returnType
    const params = node.attrs.params || []
    const ret = node.attrs.returns
    node.attrs.signature = ret
      ? `${node.name}(${params.join(', ')}) → ${ret}`
      : `${node.name}(${params.join(', ')})`
  }
}

/**
 * Extract parameter names from function source.
 * Handles: function name(a, b), (a, b) =>, name(a, b = default), ({x, y})
 * @private
 */
function _extractParams(body) {
  // Find first ( ... ) in the function signature
  const match = body.match(/(?:function\s*\w*|(?:async\s+)?)\s*\(([^)]*)\)/)
    || body.match(/\(([^)]*)\)\s*(?:=>|{)/)
  if (!match) return []

  const raw = match[1].trim()
  if (!raw) return []

  return raw.split(',').map(p => {
    // Strip default values, destructuring, type annotations
    const cleaned = p.trim()
      .replace(/\s*=\s*.*$/, '')     // remove defaults
      .replace(/^\{.*\}$/, '...')    // destructured → ...
      .replace(/^\[.*\]$/, '...')    // array destructured → ...
    return cleaned
  }).filter(Boolean)
}

/**
 * Extract JSDoc comment block preceding a function.
 * @param {string[]} lines - all source lines
 * @param {number} fnLineIdx - 0-based index of function start line
 * @returns {{ description: string, returns: string|null } | null}
 * @private
 */
function _extractJSDoc(lines, fnLineIdx) {
  // Walk backwards from function line to find /** ... */
  let endIdx = -1
  for (let i = fnLineIdx - 1; i >= Math.max(0, fnLineIdx - 5); i--) {
    const trimmed = lines[i].trim()
    if (trimmed.endsWith('*/')) { endIdx = i; break }
    if (trimmed === '' || trimmed.startsWith('//')) continue
    break  // non-comment, non-blank = no JSDoc
  }
  if (endIdx < 0) return null

  let startIdx = endIdx
  for (let i = endIdx; i >= Math.max(0, endIdx - 30); i--) {
    if (lines[i].trim().startsWith('/**')) { startIdx = i; break }
  }

  const block = lines.slice(startIdx, endIdx + 1)
    .map(l => l.trim())
    .map(l => l.replace(/^\/\*\*\s?/, '').replace(/^\*\/\s?$/, '').replace(/^\*\s?/, ''))
    .filter(l => l.length > 0)

  // First non-tag line = description
  let description = null
  let returns = null

  for (const line of block) {
    if (line.startsWith('@returns') || line.startsWith('@return')) {
      const m = line.match(/@returns?\s+\{([^}]+)\}/)
      if (m) returns = m[1]
      continue
    }
    if (line.startsWith('@')) continue  // skip other tags
    if (!description) description = line
  }

  if (!description) return null
  return { description, returns }
}
