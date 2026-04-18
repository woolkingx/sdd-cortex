export function detectDuplicateInstantiations(graph) {
  const factoryCallers = new Map()
  for (const [filePath, bindings] of graph.bindings) {
    for (const [, info] of bindings) {
      if (info.kind !== 'factory_instance') continue
      const key = `${info.sourceFile}::${info.symbolName}`
      if (!factoryCallers.has(key)) factoryCallers.set(key, new Set())
      factoryCallers.get(key).add(filePath)
    }
  }
  const results = []
  for (const [key, callers] of factoryCallers) {
    if (callers.size < 2) continue
    const sep = key.indexOf('::')
    results.push({ factory: key.slice(sep + 2), sourceFile: key.slice(0, sep), callers: [...callers].sort() })
  }
  return results
}
