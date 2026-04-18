// query/index.mjs — Block interface: graph queries
export {
  getSymbol, getSymbolAt,
  incomingEdges, outgoingEdges,
  incomingSymbolEdges, outgoingSymbolEdges,
  fileEdges, symbolEdges, allSymbols,
} from './symbol-graph.mjs'
export { context } from './context.mjs'
export { impact } from './impact.mjs'
export { importGraph, query, getEngine } from './cypher-store.mjs'
