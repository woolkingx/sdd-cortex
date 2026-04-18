/**
 * schema2object v0.5.2 — Schema context in observer events
 * Internal: C-style struct (ctx) + pure fns. External: object API unchanged.
 * New: observer hook receives schema node as 5th param: fn(op, path, key, val, schema)
 */

import { readFileSync } from 'fs'
import { join as pathJoin, dirname, resolve } from 'path'

// ─── Shared (identical to v1) ─────────────────────────────────────────────────

const _unicodeLen = s => [...s].length
const _unescapePointer = p => p.replace(/~[01]/g, m => m === '~1' ? '/' : '~')
const _reCache = new Map()
const MAX_RE_CACHE = 100
const _re = pat => {
  if (!_reCache.has(pat)) {
    if (_reCache.size >= MAX_RE_CACHE) _reCache.clear()
    try { _reCache.set(pat, new RegExp(pat)) }
    catch { throw new TypeError(`invalid regex pattern: ${pat}`) }
  }
  return _reCache.get(pat)
}

function _deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => _deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
    if (ka.length !== kb.length) return false
    return ka.every((k, i) => k === kb[i] && _deepEqual(a[k], b[k]))
  }
  return false
}

function _deepMerge(a, b) {
  if (typeof a !== 'object' || a === null) return b
  if (typeof b !== 'object' || b === null) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (k === 'properties' && out.properties) {
      out.properties = { ...out.properties }
      for (const [pk, pv] of Object.entries(v))
        out.properties[pk] = out.properties[pk] ? _deepMerge(out.properties[pk], pv) : pv
    } else if (k === 'required' && Array.isArray(out.required) && Array.isArray(v)) {
      out.required = [...new Set([...out.required, ...v])]
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = _deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

function _resolveUri(ref, base) {
  if (!base || ref.match(/^[a-zA-Z][a-zA-Z0-9+\-.]*:/)) return ref
  if (ref.startsWith('#')) return ref
  try { return new URL(ref, base).href } catch { return ref }
}

function _splitFragment(uri) {
  const idx = uri.indexOf('#')
  if (idx === -1) return [uri, null]
  const frag = uri.slice(idx + 1)
  return [uri.slice(0, idx), frag || null]
}

function _jsonPointer(root, pointer, percentDecode = false) {
  const parts = pointer.replace(/^\//, '').split('/').map(p => {
    const unescaped = _unescapePointer(p)
    return percentDecode ? decodeURIComponent(unescaped) : unescaped
  })
  let node = root
  for (const p of parts) {
    if (node == null || typeof node !== 'object') throw new TypeError(`$ref path not found: ${pointer}`)
    node = node[p]
  }
  if (node === undefined) throw new TypeError(`$ref not found: ${pointer}`)
  return node
}

// ─── Loader (identical to v1) ─────────────────────────────────────────────────

export class Loader {
  #root; #idMap; #scopeMap; #resolver; #remoteCache

  constructor(root, resolver, documentBase) {
    this.#root = root
    this.#resolver = resolver || null
    this.#remoteCache = new Map()
    this.#idMap = new Map()
    this.#scopeMap = new WeakMap()
    const rawBase = documentBase || (typeof root.$id === 'string' ? root.$id : null)
    const base = rawBase?.endsWith('#') ? rawBase.slice(0, -1) : rawBase
    this.#scanIds(root, base, base)
  }

  #scanIds(node, baseUri, resourceRoot) {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) { node.forEach(n => this.#scanIds(n, baseUri, resourceRoot)); return }
    let currentBase = baseUri
    let currentResource = resourceRoot
    if (typeof node.$id === 'string') {
      currentBase = _resolveUri(node.$id, baseUri)
      const normalized = currentBase.endsWith('#') ? currentBase.slice(0, -1) : currentBase
      this.#idMap.set(normalized, node)
      if (normalized !== currentBase) this.#idMap.set(currentBase, node)
      if (node.$id.startsWith('#')) this.#idMap.set(node.$id, node)
      currentBase = normalized
      currentResource = normalized
    }
    this.#scopeMap.set(node, { scope: currentBase, parentScope: baseUri, resource: currentResource })
    for (const v of Object.values(node)) this.#scanIds(v, currentBase, currentResource)
  }

  scopeOf(node)       { return this.#scopeMap.get(node)?.scope || null }
  parentScopeOf(node) { return this.#scopeMap.get(node)?.parentScope || null }
  resourceOf(node)    { return this.#scopeMap.get(node)?.resource || null }

  resolve(ref, baseUri, resourceUri) {
    if (ref === '#') {
      const resNode = resourceUri ? this.#idMap.get(resourceUri) : null
      return { node: resNode || this.#root, loader: this }
    }
    if (ref.startsWith('#/')) {
      const resNode = resourceUri ? this.#idMap.get(resourceUri) : null
      return { node: _jsonPointer(resNode || this.#root, ref.slice(1), true), loader: this }
    }
    if (ref.startsWith('#')) {
      if (this.#idMap.has(ref)) return { node: this.#idMap.get(ref), loader: this }
      throw new TypeError(`$ref anchor not found: ${ref}`)
    }
    const resolved = _resolveUri(ref, baseUri)
    const [docUri, fragment] = _splitFragment(resolved)
    const docNode = this.#idMap.get(docUri)
    if (docNode) {
      if (!fragment) return { node: docNode, loader: this }
      const subLoader = new Loader(docNode, this.#resolver)
      return subLoader.resolve('#' + fragment, null)
    }
    if (this.#resolver) return this.#resolveRemote(docUri, fragment)
    throw new TypeError(`Unsupported $ref: ${ref}`)
  }

  #resolveRemote(docUri, fragment) {
    if (!this.#remoteCache.has(docUri)) {
      const schema = this.#loadSchema(docUri)
      this.#remoteCache.set(docUri, new Loader(schema, this.#resolver, docUri))
    }
    const subLoader = this.#remoteCache.get(docUri)
    if (!fragment) return { node: subLoader.#root, loader: subLoader }
    return subLoader.resolve('#' + fragment, null)
  }

  #loadSchema(docUri) {
    const r = this.#resolver
    if (!r) throw new TypeError(`$ref remote not supported (no resolver): ${docUri}`)
    if (typeof r === 'function') {
      const schema = r(docUri)
      if (!schema) throw new TypeError(`$ref resolver returned nothing for: ${docUri}`)
      return schema
    }
    if (typeof r === 'object' && !Array.isArray(r)) {
      const schema = r[docUri]
      if (schema) return schema
      throw new TypeError(`$ref not found in schema map: ${docUri}`)
    }
    if (typeof r === 'string') {
      if (docUri.match(/^https?:\/\//)) throw new TypeError(`$ref HTTP not supported with filesystem resolver: ${docUri}`)
      const full = pathJoin(r, docUri)
      try { return JSON.parse(readFileSync(full, 'utf8')) }
      catch { throw new TypeError(`$ref file not found: ${full}`) }
    }
    throw new TypeError(`$ref unsupported resolver type: ${typeof r}`)
  }
  get root()     { return this.#root }
  get resolver() { return this.#resolver }
}

// ─── Validation fns — error accumulation, pure, parallelisable ───────────────

const TYPE_CHECKS = {
  string:  v => typeof v === 'string',
  integer: v => typeof v === 'number' && !Number.isNaN(v) && Number.isInteger(v),
  number:  v => typeof v === 'number' && !Number.isNaN(v),
  boolean: v => typeof v === 'boolean',
  array:   v => Array.isArray(v),
  object:  v => v !== null && typeof v === 'object' && !Array.isArray(v),
  null:    v => v === null,
}

// Each fn: (value, schema, path, loader, errors) — pushes to errors[], never throws
function _vType(value, schema, path, errors) {
  const { type } = schema
  if (type === undefined) return
  const types = Array.isArray(type) ? type : [type]
  if (typeof value === 'boolean' && !types.includes('boolean'))
    { errors.push(`${path}: expected ${types.join('|')}, got boolean`); return }
  if (!types.some(t => TYPE_CHECKS[t]?.(value)))
    errors.push(`${path}: expected ${types.join('|')}, got ${value === null ? 'null' : typeof value}`)
}

function _vEnum(value, schema, path, errors) {
  const { const: constVal, enum: enumVals } = schema
  if (constVal !== undefined && !_deepEqual(value, constVal))
    errors.push(`${path}: must equal const ${JSON.stringify(constVal)}`)
  if (enumVals !== undefined && !enumVals.some(e => _deepEqual(e, value)))
    errors.push(`${path}: not in enum`)
}

function _vNumeric(value, schema, path, errors) {
  if (typeof value !== 'number') return
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema
  if (minimum !== undefined && value < minimum) errors.push(`${path}: ${value} < minimum ${minimum}`)
  if (maximum !== undefined && value > maximum) errors.push(`${path}: ${value} > maximum ${maximum}`)
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) errors.push(`${path}: ${value} <= exclusiveMinimum ${exclusiveMinimum}`)
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) errors.push(`${path}: ${value} >= exclusiveMaximum ${exclusiveMaximum}`)
  if (multipleOf !== undefined) {
    const q = value / multipleOf
    if (!isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q)))
      errors.push(`${path}: ${value} not multipleOf ${multipleOf}`)
  }
}

function _vString(value, schema, path, errors) {
  if (typeof value !== 'string') return
  const { minLength, maxLength, pattern } = schema
  const len = _unicodeLen(value)
  if (minLength !== undefined && len < minLength) errors.push(`${path}: length ${len} < minLength ${minLength}`)
  if (maxLength !== undefined && len > maxLength) errors.push(`${path}: length ${len} > maxLength ${maxLength}`)
  if (pattern !== undefined && !_re(pattern).test(value)) errors.push(`${path}: does not match pattern ${pattern}`)
}

function _vArray(value, schema, path, loader, errors, validate) {
  if (!Array.isArray(value)) return
  const { minItems, maxItems, uniqueItems, items, additionalItems, contains } = schema
  if (minItems !== undefined && value.length < minItems) errors.push(`${path}: length ${value.length} < minItems ${minItems}`)
  if (maxItems !== undefined && value.length > maxItems) errors.push(`${path}: length ${value.length} > maxItems ${maxItems}`)
  if (uniqueItems) {
    if (value.length > 1000) { errors.push(`${path}: uniqueItems check: array too large (max 1000)`); return }
    const allPrimitive = value.every(v => v === null || typeof v !== 'object')
    if (allPrimitive) {
      if (new Set(value.map(v => `${typeof v}:${v}`)).size !== value.length) errors.push(`${path}: duplicate items`)
    } else {
      for (let i = 0; i < value.length; i++)
        for (let j = i + 1; j < value.length; j++)
          if (_deepEqual(value[i], value[j])) { errors.push(`${path}: duplicate items at [${i}] and [${j}]`); break }
    }
  }
  if (items !== undefined) {
    if (Array.isArray(items)) {
      items.forEach((s, i) => { if (i < value.length) validate(value[i], s, `${path}[${i}]`, loader, errors) })
      if (value.length > items.length && additionalItems !== undefined)
        for (let i = items.length; i < value.length; i++)
          validate(value[i], additionalItems, `${path}[${i}]`, loader, errors)
    } else {
      value.forEach((v, i) => validate(v, items, `${path}[${i}]`, loader, errors))
    }
  }
  if (contains !== undefined && !value.some(v => _softValidate(v, contains, loader)))
    errors.push(`${path}: no item matches contains`)
}

function _vObject(value, schema, path, loader, errors, validate) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const { minProperties, maxProperties, required, propertyNames,
          properties, patternProperties, additionalProperties, dependencies } = schema
  const keys = Object.keys(value)
  if (minProperties !== undefined && keys.length < minProperties) errors.push(`${path}: ${keys.length} properties < minProperties ${minProperties}`)
  if (maxProperties !== undefined && keys.length > maxProperties) errors.push(`${path}: ${keys.length} properties > maxProperties ${maxProperties}`)
  if (required !== undefined)
    for (const k of required)
      if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push(`${path}: missing required "${k}"`)
  if (propertyNames !== undefined)
    for (const k of keys) validate(k, propertyNames, `${path}/<key:${k}>`, loader, errors)
  if (properties !== undefined)
    for (const [k, s] of Object.entries(properties))
      if (Object.prototype.hasOwnProperty.call(value, k)) validate(value[k], s, `${path}.${k}`, loader, errors)
  if (patternProperties !== undefined)
    for (const [pat, s] of Object.entries(patternProperties)) {
      const re = _re(pat)
      for (const k of keys) if (re.test(k)) validate(value[k], s, `${path}.${k}`, loader, errors)
    }
  if (additionalProperties !== undefined && additionalProperties !== true) {
    const known = properties ? new Set(Object.keys(properties)) : new Set()
    const ppRe  = patternProperties ? Object.keys(patternProperties).map(p => _re(p)) : []
    for (const k of keys) {
      if (known.has(k) || ppRe.some(re => re.test(k))) continue
      if (additionalProperties === false) errors.push(`${path}: additional property "${k}" not allowed`)
      else validate(value[k], additionalProperties, `${path}.${k}`, loader, errors)
    }
  }
  if (dependencies !== undefined)
    for (const [k, dep] of Object.entries(dependencies)) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue
      if (Array.isArray(dep)) {
        for (const req of dep)
          if (!Object.prototype.hasOwnProperty.call(value, req))
            errors.push(`${path}: dependency "${k}" requires "${req}"`)
      } else {
        validate(value, dep, path, loader, errors)
      }
    }
}

function _vCombinators(value, schema, path, loader, errors, validate) {
  const { not, allOf, anyOf, oneOf, if: ifSchema, then: thenSchema, else: elseSchema } = schema
  if (not !== undefined && _softValidate(value, not, loader)) errors.push(`${path}: matches "not" schema`)
  if (allOf !== undefined) for (const s of allOf) validate(value, s, path, loader, errors)
  if (anyOf !== undefined && !anyOf.some(s => _softValidate(value, s, loader))) errors.push(`${path}: matches none of anyOf`)
  if (oneOf !== undefined) {
    const n = oneOf.filter(s => _softValidate(value, s, loader)).length
    if (n !== 1) errors.push(`${path}: matched ${n} of oneOf (expected 1)`)
  }
  if (ifSchema !== undefined) {
    if (_softValidate(value, ifSchema, loader)) {
      if (thenSchema !== undefined) validate(value, thenSchema, path, loader, errors)
    } else {
      if (elseSchema !== undefined) validate(value, elseSchema, path, loader, errors)
    }
  }
}

// Main validate — accumulates errors, throws AggregateError if any
function validateType(value, schema, path = '$', loader, _errors) {
  const root = !_errors
  const errors = _errors ?? []
  if (schema === true || schema === undefined) { if (root && errors.length) throw new AggregateError(errors.map(m => new TypeError(m)), 'validation failed'); return }
  if (schema === false) { errors.push(`${path}: schema is false`); if (root) throw new AggregateError(errors.map(m => new TypeError(m)), 'validation failed'); return }
  if (schema === null || typeof schema !== 'object') { errors.push(`${path}: invalid schema`); if (root) throw new AggregateError(errors.map(m => new TypeError(m)), 'validation failed'); return }
  if (schema.$ref !== undefined) {
    if (!loader) loader = new Loader(schema)
    const { node, loader: refLoader } = loader.resolve(schema.$ref, loader.parentScopeOf(schema), loader.resourceOf(schema))
    validateType(value, node, path, refLoader, errors)
    if (root && errors.length) throw new AggregateError(errors.map(m => new TypeError(m)), 'validation failed')
    return
  }
  if (!loader) loader = new Loader(schema)

  // 7 independent fns — all run, all collect
  _vType(value, schema, path, errors)
  _vEnum(value, schema, path, errors)
  _vNumeric(value, schema, path, errors)
  _vString(value, schema, path, errors)
  _vArray(value, schema, path, loader, errors, validateType)
  _vObject(value, schema, path, loader, errors, validateType)
  _vCombinators(value, schema, path, loader, errors, validateType)

  if (root && errors.length) throw new AggregateError(errors.map(m => new TypeError(m)), 'validation failed')
}

// _softValidate — error-list mode, no try/catch overhead
function _softValidate(data, schema, loader) {
  const errors = []
  validateType(data, schema, '$', loader, errors)
  return errors.length === 0
}

// ─── ctx pipeline — direct call sequence (replaces graph scheduler) ──────────

function _runPipeline(ctx) {
  _ctxResolveSchema(ctx)
  _vType(ctx.raw, ctx.schema, ctx.path, ctx.errors)
  _vEnum(ctx.raw, ctx.schema, ctx.path, ctx.errors)
  _vNumeric(ctx.raw, ctx.schema, ctx.path, ctx.errors)
  _vString(ctx.raw, ctx.schema, ctx.path, ctx.errors)
  _vArray(ctx.raw, ctx.schema, ctx.path, ctx.loader, ctx.errors, validateType)
  _vObject(ctx.raw, ctx.schema, ctx.path, ctx.loader, ctx.errors, validateType)
  _vCombinators(ctx.raw, ctx.schema, ctx.path, ctx.loader, ctx.errors, validateType)
  _ctxApplyDefaults(ctx)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _schemaToDict(schema) {
  if (schema === null || typeof schema !== 'object') return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties') {
      out.properties = {}
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = _schemaToDict(pv)
    } else if (Array.isArray(v)) {
      out[k] = v.map(_schemaToDict)
    } else if (typeof v === 'object' && v !== null) {
      out[k] = _schemaToDict(v)
    } else {
      out[k] = v
    }
  }
  return out
}

// ─── ObjectTree v2 — Proxy cursor ─────────────────────────────────────────────

const _RAW    = Symbol('raw')
const _SCHEMA = Symbol('schema')
const _LOADER = Symbol('loader')
const _PATH   = Symbol('path')
const _CACHE  = Symbol('cache')

// Keys that bypass Proxy and go straight to the ObjectTree instance
const _PASS_THROUGH = new Set([
  'constructor', 'then', '__proto__', 'toJSON',
  '$value', '$schema', '$oneOf', '$anyOf', '$allOf', '$notOf', '$ifThen',
  '$project', '$withDefaults', '$contains', '$toDict', '$toJSON',
  '$getSchema', '$getExtensions',
  _RAW, _SCHEMA, _LOADER, _PATH, _CACHE,
])

// Lazy array cursor — Proxy over raw array, per-index ObjectTree cache
function _makeArrayCursor(target, itemSchema, loader, basePath) {
  const indexCache = new Map()

  const _cursorAt = (i) => {
    if (indexCache.has(i)) return indexCache.get(i)
    const item = target[i]
    const cursor = item !== null && typeof item === 'object'
      ? new ObjectTree(item, itemSchema, loader, `${basePath}[${i}]`)
      : item
    indexCache.set(i, cursor)
    return cursor
  }

  return new Proxy(target, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      const i = Number(prop)
      if (Number.isInteger(i) && i >= 0 && i < target.length) return _cursorAt(i)
      return Reflect.get(target, prop, receiver)
    },

    set(target, prop, value, receiver) {
      const i = Number(prop)
      if (Number.isInteger(i) && i >= 0) { indexCache.delete(i); target[i] = value; return true }
      return Reflect.set(target, prop, value, receiver)
    },

    deleteProperty(target, prop) {
      const i = Number(prop)
      if (Number.isInteger(i) && i >= 0) { indexCache.delete(i); return delete target[i] }
      return Reflect.deleteProperty(target, prop)
    },

    ownKeys: (target) => Reflect.ownKeys(target),

    getOwnPropertyDescriptor(target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(target, prop)
      if (desc && typeof prop !== 'symbol' && Number.isInteger(Number(prop)))
        desc.configurable = true
      return desc
    },
  })
}

// Resolve a schema default value for a given key (returns undefined if none)
function _schemaDefault(schema, loader, key) {
  const subSchema = schema?.properties?.[key]
  if (!subSchema) return undefined
  const resolved = subSchema?.$ref
    ? loader.resolve(subSchema.$ref, loader.scopeOf(subSchema), loader.resourceOf(subSchema)).node
    : subSchema
  if (Object.prototype.hasOwnProperty.call(subSchema ?? {}, 'default')) return subSchema.default
  if (resolved && Object.prototype.hasOwnProperty.call(resolved, 'default')) return resolved.default
  return undefined
}

const _HANDLER = {
  get(target, key, receiver) {
    if (typeof key === 'symbol' || _PASS_THROUGH.has(key))
      return Reflect.get(target, key, receiver)

    const raw = target[_RAW]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined

    const schema = target[_SCHEMA]
    const loader = target[_LOADER]
    const path   = target[_PATH]
    const cache  = target[_CACHE]

    // Resolve value: raw key or schema default
    let val
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      val = raw[key]
    } else {
      const def = _schemaDefault(schema, loader, key)
      if (def === undefined) return undefined
      val = typeof def === 'object' && def !== null ? structuredClone(def) : def
    }

    // Wrap plain objects as ObjectTree (cached)
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      if (cache.has(key)) return cache.get(key)
      const child = new ObjectTree(val, schema?.properties?.[key] ?? true, loader, `${path}.${key}`)
      cache.set(key, child)
      if (ObjectTree._observer) ObjectTree._observer('get', path, key, child, schema?.properties?.[key])
      return child
    }

    // Wrap array as lazy cursor Proxy — per-index cache, stable identity
    if (Array.isArray(val)) {
      if (cache.has(key)) return cache.get(key)
      const itemSchema = schema?.properties?.[key]?.items
      const proxy = itemSchema
        ? _makeArrayCursor(val, itemSchema, loader, `${path}.${key}`)
        : val
      cache.set(key, proxy)
      if (ObjectTree._observer) ObjectTree._observer('get', path, key, proxy, schema?.properties?.[key])
      return proxy
    }

    if (ObjectTree._observer) ObjectTree._observer('get', path, key, val, schema?.properties?.[key])
    return val
  },

  set(target, key, value) {
    if (typeof key === 'symbol' || key.startsWith('$'))
      return Reflect.set(target, key, value)
    
    // Dot key support: "a.b.c" = v → walk schema path, set nested
    if (typeof key === 'string' && key.includes('.')) {
      const parts = key.split('.')
      let cur = new Proxy(target, _HANDLER)
      for (let i = 0; i < parts.length - 1; i++) {
        let next = cur[parts[i]]
        if (next === undefined || next === null) {
          cur[parts[i]] = {}
          next = cur[parts[i]]
        }
        cur = next
      }
      cur[parts.at(-1)] = value
      return true
    }
    
    const schema = target[_SCHEMA]
    const loader = target[_LOADER]
    const path   = target[_PATH]
    const subSchema = schema?.properties?.[key] ?? true
    validateType(value, subSchema, `${path}.${key}`, loader)
    target[_RAW][key] = value
    target[_CACHE].delete(key)
    if (ObjectTree._observer) ObjectTree._observer('set', path, key, value, subSchema)
    return true
  },

  has(target, key) {
    const raw = target[_RAW]
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) return true
      return _schemaDefault(target[_SCHEMA], target[_LOADER], key) !== undefined
    }
    return key in target
  },

  ownKeys(target) {
    const raw = target[_RAW]
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const rawKeys = Object.keys(raw)
      const schemaProps = target[_SCHEMA]?.properties
      if (!schemaProps) return rawKeys
      const extra = Object.keys(schemaProps).filter(
        k => !Object.prototype.hasOwnProperty.call(raw, k) &&
             _schemaDefault(target[_SCHEMA], target[_LOADER], k) !== undefined
      )
      return extra.length ? [...rawKeys, ...extra] : rawKeys
    }
    return Reflect.ownKeys(target)
  },

  getOwnPropertyDescriptor(target, key) {
    const raw = target[_RAW]
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const inRaw = Object.prototype.hasOwnProperty.call(raw, key)
      const hasDefault = !inRaw && _schemaDefault(target[_SCHEMA], target[_LOADER], key) !== undefined
      if (inRaw || hasDefault)
        return { value: this.get(target, key, target), writable: true, enumerable: true, configurable: true }
    }
    return Reflect.getOwnPropertyDescriptor(target, key)
  },
}

// ─── ctx fn pipeline ──────────────────────────────────────────────────────────

// Step 1 — resolve $ref chain until schema has no $ref (handles nested remote refs)
function _ctxResolveSchema(ctx) {
  let schema = ctx.schema
  let loader = ctx.loader
  const seen = new Set()
  while (schema && typeof schema === 'object' && schema.$ref) {
    const ref = schema.$ref
    if (seen.has(ref)) throw new TypeError(`circular $ref: ${ref}`)
    seen.add(ref)
    const { node, loader: refLoader } = loader.resolve(
      ref, loader.scopeOf(schema), loader.resourceOf(schema))
    schema = node
    loader = refLoader
  }
  ctx.schema = schema
  ctx.loader = loader
}

// Step 2 — validate via graph scheduler (all 7 fns run in dependency order)
// Handled by _scheduleGraph — no separate _ctxValidate needed

// Step 3 — overlay top-level defaults into raw (only missing keys)
function _ctxApplyDefaults(ctx) {
  const { schema, loader, path } = ctx
  let { raw } = ctx
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const props = schema?.properties
  if (!props) return
  let overlay = null
  for (const [key, subSchema] of Object.entries(props)) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) continue
    const resolved = subSchema?.$ref
      ? loader.resolve(subSchema.$ref, loader.scopeOf(subSchema), loader.resourceOf(subSchema)).node
      : subSchema
    const def = Object.prototype.hasOwnProperty.call(subSchema ?? {}, 'default') ? subSchema.default
              : (resolved && Object.prototype.hasOwnProperty.call(resolved, 'default')) ? resolved.default
              : undefined
    if (def !== undefined) {
      validateType(def, subSchema, `${path}.${key}.<default>`, loader)
      if (!overlay) overlay = Object.assign(Object.create(null), raw)
      overlay[key] = typeof def === 'object' && def !== null ? structuredClone(def) : def
    }
  }
  if (overlay) ctx.raw = overlay
}

export class ObjectTree {
  // L1 observer hook — null = disabled (zero cost). Set to fn(op, path, key, val, schema) to observe.
  // schema = schema node for the property (undefined if no schema constraint)
  static _observer = null

  constructor(data, schema, resolver, _path = '$') {
    if (schema === true || schema === undefined) {
      this[_RAW] = data; this[_SCHEMA] = schema; this[_LOADER] = null; this[_PATH] = _path; this[_CACHE] = new Map()
      return new Proxy(this, _HANDLER)
    }
    if (schema === false) throw new TypeError(`${_path}: schema is false`)
    if (schema === null || typeof schema !== 'object') throw new TypeError(`${_path}: invalid schema`)

    // Build ctx — the shared memory struct, all fns operate on this pointer
    const ctx = {
      raw:    data,
      schema: schema,
      loader: resolver instanceof Loader ? resolver
        : new Loader(schema ?? true, typeof resolver === 'string' ? dirname(resolver) : (resolver || null)),
      path:   _path,
      errors: [],
    }

    // Pipeline — resolveSchema → 7 validate fns → applyDefaults
    _runPipeline(ctx)

    // Error gate — all errors collected, throw once
    if (ctx.errors.length) {
      if (ctx.errors.length === 1) throw new TypeError(ctx.errors[0])
      throw new AggregateError(ctx.errors.map(m => new TypeError(m)), 'validation failed')
    }

    // Mount ctx onto instance + wrap in Proxy
    this[_RAW]    = ctx.raw
    this[_SCHEMA] = ctx.schema
    this[_LOADER] = ctx.loader
    this[_PATH]   = ctx.path
    this[_CACHE]  = new Map()
    return new Proxy(this, _HANDLER)
  }

  get $value() {
    const raw = this[_RAW]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
    const schema  = this[_SCHEMA]
    const loader  = this[_LOADER]
    const path    = this[_PATH]
    const cache   = this[_CACHE]
    const props   = schema?.properties
    // Collect keys: raw keys + schema-default-only keys
    const keys = Object.keys(raw)
    if (props) {
      for (const k of Object.keys(props))
        if (!Object.prototype.hasOwnProperty.call(raw, k) &&
            _schemaDefault(schema, loader, k) !== undefined)
          keys.push(k)
    }
    const out = Object.create(null)
    for (const k of keys) {
      let v = Object.prototype.hasOwnProperty.call(raw, k) ? raw[k]
            : (() => { const d = _schemaDefault(schema, loader, k); return typeof d === 'object' && d !== null ? structuredClone(d) : d })()
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const cached = cache.get(k)
        out[k] = cached ? cached.$value : v
      } else if (Array.isArray(v)) {
        const itemSchema = schema?.properties?.[k]?.items
        if (itemSchema) {
          const arrayCursor = cache.has(k) ? cache.get(k) : _makeArrayCursor(v, itemSchema, loader, `${path}.${k}`)
          out[k] = v.map((_, i) => {
            const item = arrayCursor[i]
            return item instanceof ObjectTree ? item.$value : item
          })
        } else {
          out[k] = v
        }
      } else {
        out[k] = v
      }
    }
    return out
  }

  set $value(v) {
    validateType(v, this[_SCHEMA], this[_PATH], this[_LOADER])
    this[_RAW] = v
    this[_CACHE].clear()
  }

  get $schema() { return _schemaToDict(this[_SCHEMA]) }

  $oneOf() {
    const schemas = this[_SCHEMA]?.oneOf
    if (!schemas) throw new Error('Schema has no oneOf')
    const data = this[_RAW]
    const loader = this[_LOADER]
    const matches = schemas.filter(s => _softValidate(data, s, loader))
    if (matches.length !== 1) throw new TypeError(`oneOf: expected exactly 1 match, got ${matches.length}`)
    return new ObjectTree(data, matches[0], loader)
  }

  $anyOf() {
    const schemas = this[_SCHEMA]?.anyOf
    if (!schemas) throw new Error('Schema has no anyOf')
    const data = this[_RAW]
    const loader = this[_LOADER]
    const matches = schemas.filter(s => _softValidate(data, s, loader))
    if (matches.length === 0) throw new TypeError('anyOf: no schema matched')
    return matches.map(s => new ObjectTree(data, s, loader))
  }

  $allOf() {
    const schemas = this[_SCHEMA]?.allOf
    if (!schemas) throw new Error('Schema has no allOf')
    return new ObjectTree(this[_RAW], schemas.reduce(_deepMerge, {}), this[_LOADER])
  }

  $notOf() {
    const notSchema = this[_SCHEMA]?.not
    if (!notSchema) return true
    return !_softValidate(this[_RAW], notSchema, this[_LOADER])
  }

  $ifThen() {
    const { if: ifSchema, then: thenSchema, else: elseSchema } = this[_SCHEMA] ?? {}
    if (!ifSchema) return this
    const data = this[_RAW]
    const loader = this[_LOADER]
    const branch = _softValidate(data, ifSchema, loader) ? thenSchema : elseSchema
    return branch ? new ObjectTree(data, branch, loader) : this
  }

  $project() {
    const raw = this[_RAW]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('project: data must be an object')
    const props = this[_SCHEMA]?.properties
    if (!props) return new ObjectTree(raw, this[_SCHEMA], this[_LOADER])
    const out = Object.create(null)
    for (const key of Object.keys(props))
      if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key]
    return new ObjectTree(out, this[_SCHEMA], this[_LOADER])
  }

  $withDefaults() {
    const raw = this[_RAW]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('withDefaults: data must be an object')
    return new ObjectTree(_applyDefaults({ ...raw }, this[_SCHEMA], this[_LOADER]),
                          this[_SCHEMA], this[_LOADER])
  }

  $contains() {
    const raw = this[_RAW]
    if (!Array.isArray(raw)) return null
    const cs = this[_SCHEMA]?.contains
    if (!cs) return null
    return raw.some(item => _softValidate(item, cs, this[_LOADER]))
  }

  $toDict() {
    const raw = this[_RAW]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
    const props = this[_SCHEMA]?.properties
    const keys = props ? Object.keys(props).filter(k => Object.prototype.hasOwnProperty.call(raw, k)) : Object.keys(raw)
    const out = Object.create(null)
    for (const k of keys) out[k] = raw[k]
    return out
  }

  $getSchema(path = '') {
    if (!path) return this.$schema
    const parts = path.split('.').filter(Boolean)
    let node = this[_SCHEMA]
    for (const part of parts) {
      if (!node || typeof node !== 'object') return undefined
      const props = node.properties
      if (!props || !(part in props)) return undefined
      node = props[part]
    }
    return _schemaToDict(node)
  }

  $getExtensions(path = '') {
    const node = path ? this.$getSchema(path) : this.$schema
    if (!node || typeof node !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(node)) if (k.startsWith('x-')) out[k] = v
    return out
  }

  toJSON()  { return this.$toDict() }
  $toJSON() { return JSON.stringify(this.toJSON(), null, 2) }
}

function _applyDefaults(data, schema, loader) {
  if (!schema || typeof schema !== 'object') return data
  const resolved = schema.$ref
    ? loader.resolve(schema.$ref, loader.scopeOf(schema), loader.resourceOf(schema)).node
    : schema
  const props = resolved.properties
  if (!props || typeof props !== 'object') return data
  for (const [k, rawS] of Object.entries(props)) {
    const s = rawS?.$ref ? loader.resolve(rawS.$ref, loader.scopeOf(rawS), loader.resourceOf(rawS)).node : rawS
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k]))
        data[k] = _applyDefaults({ ...data[k] }, rawS, loader)
      else if (Array.isArray(data[k]) && s?.items && typeof s.items === 'object' && !Array.isArray(s.items))
        data[k] = data[k].map(item =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? _applyDefaults({ ...item }, s.items, loader)
            : item)
    } else {
      const def = Object.prototype.hasOwnProperty.call(rawS ?? {}, 'default') ? rawS.default
                : (s && Object.prototype.hasOwnProperty.call(s, 'default')) ? s.default
                : undefined
      if (def !== undefined)
        data[k] = typeof def === 'object' && def !== null ? structuredClone(def) : def
    }
  }
  return data
}

export function validate(data, schema, resolver) {
  try { new ObjectTree(data, schema, resolver); return { valid: true } }
  catch (e) { return { valid: false, error: e.message } }
}
