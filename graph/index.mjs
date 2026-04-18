// graph/index.mjs — Block interface: graph data structure
export {
  createGraph, addNode, getNode,
  inEdges, outEdges, outNeighbors, inNeighbors,
  degree, inDegree, outDegree,
  forEachLinkedNode, rebuildNeighborIndex,
  buildPathIndex,
  save, load, isStale,
  // Singleton compat
  graph, pathIndex, rootDir,
  initGraph, getFileNodes, getSymbolNodes, getNodesByFile,
  resolveImportTarget, resolveEdgeKind,
} from './graph.mjs'
