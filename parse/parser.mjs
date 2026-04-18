// parser.mjs — Schema-driven AST walk that populates Graph directly
// Graph extraction rules loaded from acorn schema x-graph extensions at boot

import { parse } from 'acorn'
import { simple, ancestor } from 'acorn-walk'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { graph, rootDir, resolveImportTarget, addNode } from '../graph/index.mjs'
import { NL, EL } from '../lib/schema-loader.mjs'
import { enrichNodes } from './enrich.mjs'

const ACORN_OPTS = { ecmaVersion: 2022, sourceType: 'module', locations: true }
let _graphRules = null

function _loadGraphRules() {
  if (_graphRules !== null) return _graphRules
  _graphRules = {}
  const acornFiles = [
    'schema/acorn/function.json', 'schema/acorn/module.json', 'schema/acorn/class.json',
    'schema/acorn/expression.json', 'schema/acorn/statement.json', 'schema/acorn/pattern.json',
    'schema/acorn/node.json',
  ]
  for (const file of acornFiles) {
    try {
      const raw = JSON.parse(readFileSync(join(rootDir, file), 'utf8'))
      for (const [name, def] of Object.entries(raw.definitions || {})) {
        if (def['x-graph']) _graphRules[name] = def['x-graph']
      }
    } catch {}
  }
  return _graphRules
}

// ── Helper functions ──────────────────────────────────────────────────────────

function _fnMetrics(fnNode) {
  const bodyNode = fnNode.body || fnNode
  const fnLines = fnNode.loc ? (fnNode.loc.end.line - fnNode.loc.start.line + 1) : 0
  let complexity = 1, calls = 0
  const rules = _loadGraphRules()
  const complexityVisitor = {}
  for (const [type, rule] of Object.entries(rules)) {
    if (rule.complexity) {
      complexityVisitor[type] = (n) => { if (_conditionMet(rule.condition, n)) complexity++ }
    }
  }
  complexityVisitor.CallExpression = (n) => { if (n.callee.type === 'Identifier' || n.callee.type === 'MemberExpression') calls++ }
  simple(bodyNode, complexityVisitor)
  return { lines: fnLines, complexity, calls }
}

function _conditionMet(condition, node) {
  if (!condition) return true
  try {
    if (condition === 'node.superClass != null') return node.superClass != null
    if (condition === 'node.test != null') return node.test != null
    if (condition === 'node.source != null') return node.source != null
    if (condition === "node.right.type === 'Identifier'") return node.right?.type === 'Identifier'
    if (condition === "node.operator === '&&' || node.operator === '||'") return node.operator === '&&' || node.operator === '||'
    if (condition === "callee.name === 'require' && args[0].type === 'Literal'")
      return node.callee?.name === 'require' && node.arguments?.[0]?.type === 'Literal'
    if (condition === "callee.property.name in ['call','apply','bind']")
      return ['call', 'apply', 'bind'].includes(node.callee?.property?.name)
    return true
  } catch { return true }
}

function _createVisitors(ctx) {
  const { fileNodes, fileBindings, imports, exports_, functions, classes, callSet, exportedNames, factoryExposed, rel, registry, edges } = ctx
  const edgeMap = new Map()

  function getOrCreateEdge(from, to, label, fromLabel = NL.FILE, toLabel = NL.FILE) {
    const key = `${from}→${to}:${label}`
    if (edgeMap.has(key)) return edgeMap.get(key)
    const edge = { from, to, label, fromLabel, toLabel, attrs: { resolved: true, symbols: [] } }
    edgeMap.set(key, edge)
    edges.push(edge)
    return edge
  }

  function resolveSchemaName(name, targetPath) {
    if (!registry) return null
    const publicMethods = registry[targetPath]
    return publicMethods?.includes(name) ? name : null
  }

  return {
    ImportDeclaration(node) {
      const source = node.source.value
      const target = resolveImportTarget(source, rel)
      for (const spec of node.specifiers) {
        const importedName = spec.type === 'ImportDefaultSpecifier' ? 'default'
                           : spec.type === 'ImportNamespaceSpecifier' ? '*'
                           : spec.imported.name
        const alias = spec.local.name
        imports.push({
          name: importedName, alias, source,
          isDefault: spec.type === 'ImportDefaultSpecifier',
          isDynamic: false,
          isNamespace: spec.type === 'ImportNamespaceSpecifier'
        })
        if (target && target !== rel) {
          fileBindings.set(alias, { sourceFile: target, symbolName: importedName, kind: 'import' })
          const edge = getOrCreateEdge(rel, target, EL.IMPORT)
          if (!edge.attrs.symbols.some(s => s.name === importedName)) {
            edge.attrs.symbols.push({ name: importedName, kind: 'unknown', schema: resolveSchemaName(importedName, target) })
          }
        } else if (!target && source.startsWith('.')) {
          const edge = getOrCreateEdge(rel, source, EL.IMPORT)
          edge.attrs.resolved = false
          edge.attrs.symbols.push({ name: importedName, kind: 'unknown', schema: null })
        }
      }
    },

    ImportExpression(node) {
      if (node.source.type !== 'Literal') return
      const source = node.source.value
      imports.push({ name: '*', alias: '*', source, isDefault: false, isDynamic: true, isNamespace: true })
      const target = resolveImportTarget(source, rel)
      if (target && target !== rel) {
        const edge = getOrCreateEdge(rel, target, EL.DYNAMIC_IMPORT)
        if (!edge.attrs.symbols.some(s => s.name === '*')) {
          edge.attrs.symbols.push({ name: '*', kind: 'namespace', schema: null })
        }
      }
    },

    ExportNamedDeclaration(node) {
      if (node.source) {
        const target = resolveImportTarget(node.source.value, rel)
        for (const spec of node.specifiers) {
          const name = spec.exported.name || spec.exported.value
          exports_.push({ name, type: 'reexport', source: node.source.value })
          exportedNames.add(name)
          fileNodes.set(name, { kind: 'unknown', exported: true })
          if (target && target !== rel) {
            const edge = getOrCreateEdge(rel, target, EL.REEXPORT)
            if (!edge.attrs.symbols.some(s => s.name === name)) {
              edge.attrs.symbols.push({ name, kind: 'unknown', schema: resolveSchemaName(name, target) })
            }
          }
        }
        return
      }
      if (node.declaration) {
        const decl = node.declaration
        if (decl.type === 'FunctionDeclaration') {
          exportedNames.add(decl.id.name)
          exports_.push({ name: decl.id.name, type: 'function' })
          fileNodes.set(decl.id.name, { kind: 'function', exported: true })
        } else if (decl.type === 'ClassDeclaration') {
          exportedNames.add(decl.id.name)
          exports_.push({ name: decl.id.name, type: 'class' })
          fileNodes.set(decl.id.name, { kind: 'class', exported: true })
        } else if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id.type === 'Identifier') {
              exportedNames.add(d.id.name)
              exports_.push({ name: d.id.name, type: decl.kind })
              const kind = (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression') ? 'function' : decl.kind
              fileNodes.set(d.id.name, { kind, exported: true })
            }
          }
        }
      }
      for (const spec of node.specifiers) {
        const name = spec.exported.name || spec.exported.value
        exportedNames.add(name)
        exports_.push({ name, type: 'const' })
        if (!fileNodes.has(name)) fileNodes.set(name, { kind: 'unknown', exported: true })
        else fileNodes.get(name).exported = true
      }
    },

    ExportDefaultDeclaration(node) {
      const decl = node.declaration
      const name = decl.id?.name || 'default'
      exportedNames.add(name)
      if (name !== 'default') exportedNames.add('default')
      const type = decl.type === 'FunctionDeclaration' ? 'function'
                 : decl.type === 'ClassDeclaration' ? 'class' : 'default'
      exports_.push({ name, type })
      fileNodes.set(name, { kind: type, exported: true })
      if (name !== 'default') fileNodes.set('default', { kind: type, exported: true })
    },

    ExportAllDeclaration(node) {
      const name = node.exported ? (node.exported.name || node.exported.value) : '*'
      exports_.push({ name, type: 'reexport', source: node.source.value })
      const target = resolveImportTarget(node.source.value, rel)
      if (target && target !== rel) {
        const edge = getOrCreateEdge(rel, target, EL.REEXPORT)
        if (!edge.attrs.symbols.some(s => s.name === name)) {
          edge.attrs.symbols.push({ name, kind: 'unknown', schema: null })
        }
      }
    },

    FunctionDeclaration(node) {
      if (node.id) {
        const { lines: fnLines, complexity, calls: fnCalls } = _fnMetrics(node)
        const loc = node.loc ? { start: node.loc.start.line, end: node.loc.end.line } : null
        functions.push({
          name: node.id.name, isExported: false, isAsync: node.async || false,
          isArrow: false, paramCount: node.params.length,
          lines: fnLines, complexity, calls: fnCalls, loc,
        })
        if (!fileNodes.has(node.id.name)) {
          fileNodes.set(node.id.name, { kind: 'function', exported: false })
        }
      }
    },

    FunctionExpression(node) {
      if (node.id) {
        const { lines: fnLines, complexity, calls: fnCalls } = _fnMetrics(node)
        const loc = node.loc ? { start: node.loc.start.line, end: node.loc.end.line } : null
        functions.push({
          name: node.id.name, isExported: false, isAsync: node.async || false,
          isArrow: false, paramCount: node.params.length,
          lines: fnLines, complexity, calls: fnCalls, loc,
        })
        if (!fileNodes.has(node.id.name)) {
          fileNodes.set(node.id.name, { kind: 'function', exported: false })
        }
      }
    },

    ArrowFunctionExpression(node) {
      if (node.parent?.type !== 'VariableDeclarator' && node.id) {
        const { lines: fnLines, complexity, calls: fnCalls } = _fnMetrics(node)
        functions.push({
          name: node.id.name, isExported: false, isAsync: node.async || false,
          isArrow: true, paramCount: node.params.length,
          lines: fnLines, complexity, calls: fnCalls,
        })
        if (!fileNodes.has(node.id.name)) {
          fileNodes.set(node.id.name, { kind: 'function', exported: false })
        }
      }
    },

    VariableDeclarator(node) {
      if (!node.id || !node.init) return
      if (node.id.type === 'Identifier' && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) {
        const { lines: fnLines, complexity, calls: fnCalls } = _fnMetrics(node.init)
        const loc = node.init.loc ? { start: node.init.loc.start.line, end: node.init.loc.end.line } : null
        functions.push({
          name: node.id.name, isExported: false, isAsync: node.init.async || false,
          isArrow: node.init.type === 'ArrowFunctionExpression', paramCount: node.init.params.length,
          lines: fnLines, complexity, calls: fnCalls, loc,
        })
        if (!fileNodes.has(node.id.name)) {
          fileNodes.set(node.id.name, { kind: 'function', exported: false })
        }
        return
      }
      if (node.id.type === 'Identifier' && node.init.type === 'CallExpression') {
        const fnName = node.init.callee.type === 'Identifier' ? node.init.callee.name : null
        if (fnName && fileBindings.has(fnName)) {
          const binding = fileBindings.get(fnName)
          fileBindings.set(node.id.name, {
            sourceFile: binding.sourceFile,
            symbolName: fnName,
            kind: 'factory_instance',
          })
        }
      }
      if (node.id.type === 'ObjectPattern' && node.init.type === 'CallExpression') {
        const fnName = node.init.callee.type === 'Identifier' ? node.init.callee.name : null
        if (fnName && fileBindings.has(fnName)) {
          const binding = fileBindings.get(fnName)
          for (const prop of node.id.properties) {
            if (prop.key?.type === 'Identifier') {
              fileBindings.set(prop.key.name, {
                sourceFile: binding.sourceFile,
                symbolName: prop.key.name,
                kind: 'destructure',
              })
            }
          }
        }
      }
      if (node.id.type === 'ArrayPattern' && node.init) {
        const fnName = node.init.callee?.type === 'Identifier' ? node.init.callee.name : null
        if (fnName && fileBindings.has(fnName)) {
          const binding = fileBindings.get(fnName)
          for (const elem of node.id.elements) {
            if (elem?.type === 'Identifier') {
              fileBindings.set(elem.name, {
                sourceFile: binding.sourceFile,
                symbolName: elem.name,
                kind: 'array_destructure',
              })
            }
          }
        }
      }
      if (node.id.type === 'Identifier' && !node.init.type.includes('Function')) {
        fileNodes.set(node.id.name, { kind: 'variable', exported: false })
      }
    },

    ClassDeclaration(node) {
      const methods = []
      if (node.body?.body) {
        for (const member of node.body.body) {
          if (member.type === 'MethodDefinition' && member.key.type === 'Identifier') {
            methods.push(member.key.name)
            fileNodes.set(member.key.name, { kind: 'method', exported: false })
          }
          if (member.type === 'PropertyDefinition' && member.key.type === 'Identifier') {
            fileNodes.set(member.key.name, { kind: 'property', exported: false })
          }
        }
      }
      classes.push({
        name: node.id.name, isExported: false,
        ...(node.superClass?.type === 'Identifier' ? { extends: node.superClass.name } : {}),
        methods,
      })
      if (!fileNodes.has(node.id.name)) {
        fileNodes.set(node.id.name, { kind: 'class', exported: false })
      }
      if (node.superClass?.type === 'Identifier' && _conditionMet(_graphRules?.ClassDeclaration?.condition, node)) {
        const superName = node.superClass.name
        const binding = fileBindings.get(superName)
        if (binding) {
          const edge = getOrCreateEdge(rel, binding.sourceFile, EL.EXTEND)
          if (!edge.attrs.symbols.some(s => s.name === superName)) {
            edge.attrs.symbols.push({ name: superName, kind: 'class', schema: resolveSchemaName(superName, binding.sourceFile) })
          }
        }
      }
    },

    ClassExpression(node) {
      if (node.superClass?.type === 'Identifier' && _conditionMet(_graphRules?.ClassExpression?.condition, node)) {
        const superName = node.superClass.name
        const binding = fileBindings.get(superName)
        if (binding) {
          const edge = getOrCreateEdge(rel, binding.sourceFile, EL.EXTEND)
          if (!edge.attrs.symbols.some(s => s.name === superName)) {
            edge.attrs.symbols.push({ name: superName, kind: 'class', schema: resolveSchemaName(superName, binding.sourceFile) })
          }
        }
      }
    },

    MethodDefinition(node) {
      if (node.key.type === 'Identifier' && node.value.type === 'FunctionExpression') {
        const { lines: fnLines, complexity, calls: fnCalls } = _fnMetrics(node.value)
        const loc = node.loc ? { start: node.loc.start.line, end: node.loc.end.line } : null
        functions.push({
          name: node.key.name, isExported: false, isAsync: node.value.async || false,
          isArrow: false, paramCount: node.value.params.length,
          lines: fnLines, complexity, calls: fnCalls, loc,
        })
      }
    },

    PropertyDefinition(node) {
      if (node.key.type === 'Identifier') {
        fileNodes.set(node.key.name, { kind: 'property', exported: false })
      }
    },

    CallExpression(node) {
      if (_conditionMet("callee.name === 'require' && args[0].type === 'Literal'", node)) {
        const source = node.arguments[0].value
        const target = resolveImportTarget(source, rel)
        if (target && target !== rel) {
          const edge = getOrCreateEdge(rel, target, EL.REQUIRE)
          if (!edge.attrs.symbols.some(s => s.name === '*')) {
            edge.attrs.symbols.push({ name: '*', kind: 'namespace', schema: null })
          }
        }
        return
      }
      if (_conditionMet("callee.property.name in ['call','apply','bind']", node)) {
        const obj = node.callee.object
        if (obj.type === 'Identifier') {
          const binding = fileBindings.get(obj.name)
          if (binding) {
            const toId = `${binding.sourceFile}::${obj.name}`
            const edge = getOrCreateEdge(rel, toId, EL.CALL_INDIRECT, NL.FILE, NL.FUNCTION)
            if (!edge.attrs.symbols.some(s => s.name === obj.name)) {
              edge.attrs.symbols.push({ name: obj.name, kind: 'unknown', schema: null })
            }
          }
        }
      }
      if (node.callee.type === 'Identifier') {
        callSet.add(node.callee.name)
      } else if (node.callee.type === 'MemberExpression') {
        const obj = node.callee.object
        const method = node.callee.property
        if (obj.type === 'Identifier' && method.type === 'Identifier' && obj.name !== 'this') {
          const binding = fileBindings.get(obj.name)
          if (binding) {
            const toId = `${binding.sourceFile}::${method.name}`
            const edge = getOrCreateEdge(rel, toId, EL.CALL, NL.FILE, NL.FUNCTION)
            if (!edge.attrs.symbols.some(s => s.name === method.name)) {
              edge.attrs.symbols.push({ name: method.name, kind: 'unknown', schema: resolveSchemaName(method.name, binding.sourceFile) })
            }
          }
        }
      }
    },

    NewExpression(node) {
      const callee = node.callee
      if (callee.type === 'Identifier') {
        const binding = fileBindings.get(callee.name)
        if (binding) {
          const toId = `${binding.sourceFile}::${callee.name}`
          const edge = getOrCreateEdge(rel, toId, EL.CALL, NL.FILE, NL.CLASS)
          if (!edge.attrs.symbols.some(s => s.name === callee.name)) {
            edge.attrs.symbols.push({ name: callee.name, kind: 'class', schema: resolveSchemaName(callee.name, binding.sourceFile) })
          }
        }
      }
    },

    TaggedTemplateExpression(node) {
      const tag = node.tag
      if (tag.type === 'Identifier') {
        const binding = fileBindings.get(tag.name)
        if (binding) {
          const toId = `${binding.sourceFile}::${tag.name}`
          const edge = getOrCreateEdge(rel, toId, EL.CALL, NL.FILE, NL.FUNCTION)
          if (!edge.attrs.symbols.some(s => s.name === tag.name)) {
            edge.attrs.symbols.push({ name: tag.name, kind: 'function', schema: resolveSchemaName(tag.name, binding.sourceFile) })
          }
        }
      }
    },

    AssignmentExpression(node) {
      if (node.right.type === 'Identifier' && fileBindings.has(node.right.name)) {
        if (node.left.type === 'Identifier') {
          const rightBinding = fileBindings.get(node.right.name)
          fileBindings.set(node.left.name, {
            sourceFile: rightBinding.sourceFile,
            symbolName: rightBinding.symbolName,
            kind: 'reassignment',
          })
        }
      }
    },

    SpreadElement(node) {
      if (node.argument.type === 'Identifier' && fileBindings.has(node.argument.name)) {
        const binding = fileBindings.get(node.argument.name)
        if (binding.kind === 'import' || binding.kind === 'factory_instance') {
          const edge = getOrCreateEdge(rel, binding.sourceFile, EL.CALL)
          if (!edge.attrs.symbols.some(s => s.name === binding.symbolName)) {
            edge.attrs.symbols.push({ name: binding.symbolName, kind: 'unknown', schema: null })
          }
        }
      }
    },
  }
}

/**
 * Parse a single file and collect mutations locally.
 * Returns parsed file data plus mutations (nodes, edges, bindings) for caller to apply.
 * Requires initGraph() to have been called first.
 * @param {string} filePath  - absolute path
 * @param {object} registry  - optional PublicInterfaceRegistry
 * @returns {object}  { path, imports, exports, functions, classes, calls, lines, nodes, edges, bindings }
 */
export function parseFile(filePath, registry = null) {
  _loadGraphRules()

  let code = readFileSync(filePath, 'utf8')
  if (code.startsWith('#!')) code = code.replace(/^#![^\n]*\n/, '\n')
  const rel   = relative(rootDir, filePath)
  const lines = code.split('\n').length

  let ast
  try {
    ast = parse(code, ACORN_OPTS)
  } catch (err) {
    console.error(`parse error: ${rel}: ${err.message}`)
    return {
      path: rel, imports: [], exports: [], functions: [], classes: [], calls: [], lines,
      nodes: new Map(), edges: [], bindings: new Map()
    }
  }

  const fileNodes    = new Map()
  const fileBindings = new Map()
  const edges        = []

  const imports   = []
  const exports_  = []
  const functions = []
  const classes   = []
  const callSet   = new Set()
  const exportedNames   = new Set()
  const factoryExposed  = new Set()

  const ctx = { fileNodes, fileBindings, imports, exports_, functions, classes, callSet, exportedNames, factoryExposed, rel, registry, edges }
  const visitors = _createVisitors(ctx)

  simple(ast, visitors)

  ancestor(ast, {
    ReturnStatement(node, ancestors) {
      if (!node.argument) return

      for (let i = ancestors.length - 2; i >= 0; i--) {
        const a = ancestors[i]
        const fnName = a.type === 'FunctionDeclaration' ? a.id?.name
                     : (a.type === 'VariableDeclarator' && a.id?.type === 'Identifier' &&
                        (a.init?.type === 'ArrowFunctionExpression' || a.init?.type === 'FunctionExpression'))
                       ? a.id.name : null
        if (!fnName) continue
        if (!exportedNames.has(fnName)) break

        // Pattern A: return { foo, bar }
        if (node.argument.type === 'ObjectExpression') {
          for (const prop of node.argument.properties) {
            if (prop.key?.type === 'Identifier') factoryExposed.add(prop.key.name)
          }
        }
        // Pattern B: return new ClassName()
        else if (node.argument.type === 'NewExpression' && node.argument.callee?.type === 'Identifier') {
          const className = node.argument.callee.name
          const cls = classes.find(c => c.name === className)
          if (cls && cls.methods) {
            for (const method of cls.methods) {
              factoryExposed.add(method)
            }
          }
        }
        // Pattern C: return identifier (after property assignments)
        else if (node.argument.type === 'Identifier') {
          const varName = node.argument.name
          // Find the enclosing function body
          for (let j = ancestors.length - 2; j >= 0; j--) {
            const ancestor = ancestors[j]
            let fnBody = null
            if (ancestor.type === 'FunctionDeclaration' && ancestor.body) {
              fnBody = ancestor.body.body
            } else if (ancestor.type === 'ArrowFunctionExpression' && ancestor.body?.type === 'BlockStatement') {
              fnBody = ancestor.body.body
            } else if (ancestor.type === 'FunctionExpression' && ancestor.body) {
              fnBody = ancestor.body.body
            }

            if (fnBody) {
              // Scan for assignments to varName
              for (const stmt of fnBody) {
                if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'AssignmentExpression') {
                  const assign = stmt.expression
                  if (assign.left?.type === 'MemberExpression' &&
                      assign.left.object?.type === 'Identifier' &&
                      assign.left.object.name === varName &&
                      assign.left.property?.type === 'Identifier') {
                    factoryExposed.add(assign.left.property.name)
                  }
                }
              }
              break
            }
          }
        }
        break
      }
    }
  })

  // Scoped call tracking — find enclosing function for each call
  const scopedCalls = []
  const SKIP = new Set(['if','for','while','switch','catch','return','typeof','new','require','async','await'])

  ancestor(ast, {
    CallExpression(node, ancestors) {
      const calleeName = node.callee.type === 'Identifier' ? node.callee.name
                       : (node.callee.type === 'MemberExpression' && node.callee.property?.type === 'Identifier')
                         ? node.callee.property.name
                         : null
      if (!calleeName || SKIP.has(calleeName)) return

      // Find enclosing function scope
      let callerFnName = null
      for (let i = ancestors.length - 2; i >= 0; i--) {
        const a = ancestors[i]
        if (a.type === 'FunctionDeclaration' && a.id) {
          callerFnName = a.id.name
          break
        }
        if (a.type === 'VariableDeclarator' && a.id?.type === 'Identifier' &&
            (a.init?.type === 'ArrowFunctionExpression' || a.init?.type === 'FunctionExpression')) {
          callerFnName = a.id.name
          break
        }
        if (a.type === 'MethodDefinition' && a.key?.type === 'Identifier') {
          callerFnName = a.key.name
          break
        }
      }

      scopedCalls.push({ callerFn: callerFnName, calleeName, line: node.loc?.start?.line || 0 })
    }
  })

  // ── Create FILE node ──
  addNode({
    id: rel, label: NL.FILE, name: rel, fullName: rel,
    file: rel, parent: null, exported: false,
    loc: { start: 1, end: lines },
  })

  // ── Create FUNCTION nodes + CONTAINS edges ──
  for (const fn of functions) {
    fn.isExported = exportedNames.has(fn.name) || factoryExposed.has(fn.name)
    if (fileNodes.has(fn.name)) fileNodes.get(fn.name).exported = fn.isExported
    else fileNodes.set(fn.name, { kind: 'function', exported: fn.isExported })

    addNode({
      id: `${rel}::${fn.name}`, label: NL.FUNCTION, name: fn.name, fullName: `${rel}::${fn.name}`,
      file: rel, parent: rel, exported: fn.isExported,
      loc: fn.loc || null,
      attrs: { async: fn.isAsync, arrow: fn.isArrow, paramCount: fn.paramCount, lines: fn.lines, complexity: fn.complexity },
    })
    edges.push({
      from: rel, to: `${rel}::${fn.name}`, label: EL.CONTAINS,
      fromLabel: NL.FILE, toLabel: NL.FUNCTION,
      attrs: { resolved: true, symbols: [{ name: fn.name, kind: 'function', schema: null }] },
    })
  }

  // ── Create CLASS nodes + CONTAINS edges + METHOD nodes + METHOD_OF edges ──
  for (const cls of classes) {
    cls.isExported = exportedNames.has(cls.name)
    if (fileNodes.has(cls.name)) fileNodes.get(cls.name).exported = cls.isExported

    addNode({
      id: `${rel}::${cls.name}`, label: NL.CLASS, name: cls.name, fullName: `${rel}::${cls.name}`,
      file: rel, parent: rel, exported: cls.isExported,
      attrs: { superClass: cls.extends || null, methods: cls.methods || [] },
    })
    edges.push({
      from: rel, to: `${rel}::${cls.name}`, label: EL.CONTAINS,
      fromLabel: NL.FILE, toLabel: NL.CLASS,
      attrs: { resolved: true, symbols: [{ name: cls.name, kind: 'class', schema: null }] },
    })

    for (const methodName of cls.methods || []) {
      addNode({
        id: `${rel}::${cls.name}.${methodName}`, label: NL.METHOD, name: methodName,
        fullName: `${rel}::${cls.name}.${methodName}`,
        file: rel, parent: `${rel}::${cls.name}`, exported: cls.isExported,
      })
      edges.push({
        from: `${rel}::${cls.name}`, to: `${rel}::${cls.name}.${methodName}`, label: EL.METHOD_OF,
        fromLabel: NL.CLASS, toLabel: NL.METHOD,
        attrs: { resolved: true, symbols: [{ name: methodName }] },
      })
    }
  }

  // ── Scoped CALL edges (fn→fn) ──
  for (const { callerFn, calleeName, line } of scopedCalls) {
    const binding = fileBindings.get(calleeName)
    if (!binding) continue

    const fromId = callerFn ? `${rel}::${callerFn}` : rel
    const toId = `${binding.sourceFile}::${binding.symbolName}`
    const fromNode = graph.nodes.get(fromId)
    const toNode = graph.nodes.get(toId)

    let edge = edges.find(e => e.from === fromId && e.to === toId && e.label === EL.CALL)
    if (!edge) {
      edge = {
        from: fromId, to: toId, label: EL.CALL,
        fromLabel: fromNode?.label || (fromId.includes('::') ? NL.FUNCTION : NL.FILE),
        toLabel: toNode?.label || NL.FUNCTION,
        attrs: { resolved: true, symbols: [] },
        loc: { line },
      }
      edges.push(edge)
    }
    if (!edge.attrs.symbols.some(s => s.name === calleeName)) {
      const publicMethods = registry ? registry[binding.sourceFile] : null
      const schema = publicMethods?.includes(calleeName) ? calleeName : null
      edge.attrs.symbols.push({ name: calleeName, kind: 'unknown', schema })
    }
  }

  const calls = [...new Set(scopedCalls.map(c => c.calleeName))].filter(c => !SKIP.has(c))

  // Enrich FUNCTION/METHOD nodes with params, jsdoc, body, signature
  enrichNodes(rel, code)

  return {
    path: rel, imports, exports: exports_, functions, classes, calls, lines,
    nodes: fileNodes, edges, bindings: fileBindings
  }
}

export function scanDir(dir, extensions = ['.mjs', '.js']) {
  const files = []
  function walk(d) {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(d, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (extensions.some(ext => entry.endsWith(ext))) files.push(full)
    }
  }
  walk(dir)
  return files
}
