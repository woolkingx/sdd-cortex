export function detectSchemaGaps(files, registry, edges = [], validator, defs) {
  const gaps = []
  const parsedFileDef = defs['ParsedFile']
  const fnDef         = defs['FunctionInfo']
  const edgeDef       = defs['Edge']

  for (const f of files) {
    const pfResult = validator(f, parsedFileDef)
    if (!pfResult.valid) gaps.push({ type: 'missing_in_schema', file: f.path, symbol: 'ParsedFile', detail: pfResult.error })
    for (const fn of f.functions) {
      const r = validator(fn, fnDef)
      if (!r.valid) gaps.push({ type: 'missing_in_schema', file: f.path, symbol: fn.name, detail: r.error })
    }
  }
  for (const e of edges) {
    const r = validator(e, edgeDef)
    if (!r.valid) gaps.push({ type: 'missing_in_schema', file: e.from, symbol: `edge→${e.to}`, detail: r.error })
  }

  if (!registry) return gaps

  for (const f of files) {
    const entry = registry[f.path] || null
    if (!entry) continue
    const publicMethods = Array.isArray(entry) ? entry : (entry.methods || [])
    const xmethods      = Array.isArray(entry) ? {} : (entry.xmethods || {})
    const params        = Array.isArray(entry) ? {} : (entry.params || {})
    const exportedNames = new Set(f.exports.filter(e => e.type !== 'reexport').map(e => e.name))
    const fnMap         = new Map(f.functions.map(fn => [fn.name, fn]))

    for (const method of publicMethods) {
      if (!exportedNames.has(method)) gaps.push({ type: 'stale_in_schema', file: f.path, symbol: method })
    }
    for (const name of exportedNames) {
      if (!publicMethods.includes(name)) gaps.push({ type: 'missing_in_schema', file: f.path, symbol: name })
    }
    for (const name of publicMethods) {
      if (exportedNames.has(name) && fnMap.has(name) && !xmethods[name])
        gaps.push({ type: 'no_xmethods', file: f.path, symbol: name })
    }
    for (const name of Object.keys(xmethods)) {
      if (!fnMap.has(name) && !exportedNames.has(name))
        gaps.push({ type: 'stale_xmethod', file: f.path, symbol: name })
    }
    for (const [name, expectedParams] of Object.entries(params)) {
      const fn = fnMap.get(name)
      if (fn && fn.paramCount !== expectedParams)
        gaps.push({ type: 'param_mismatch', file: f.path, symbol: name, detail: `schema: ${expectedParams}, code: ${fn.paramCount}` })
    }
  }
  return gaps
}
