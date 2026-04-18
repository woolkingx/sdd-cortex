// algorithms.mjs — Pure graph algorithms: betweenness, pagerank, louvain
// Ported from NetworkX reference implementations. No external dependencies.
// Each function takes a graph struct { nodes, edges, _neighbors } and returns { nodeId: score }

/**
 * Betweenness centrality via Brandes algorithm.
 * BFS from each node, accumulate pair-dependencies, normalize for directed graph.
 * @param {Object} g - Graph struct { nodes, edges, _neighbors }
 * @returns {Object} { nodeId: score }
 */
export function betweenness(g) {
  const nodeIds = [...g.nodes.keys()]
  const n = nodeIds.length
  const betweennessMap = new Map(nodeIds.map(id => [id, 0]))

  // Normalize factor for directed graph
  const scale = n > 2 ? 1 / ((n - 1) * (n - 2)) : 1

  // Brandes algorithm: BFS from each source node
  for (const source of nodeIds) {
    const stack = []
    const paths = new Map(nodeIds.map(id => [id, []]))
    const sigma = new Map(nodeIds.map(id => [id, 0]))
    const dist = new Map(nodeIds.map(id => [id, -1]))

    sigma.set(source, 1)
    dist.set(source, 0)

    // BFS phase
    const queue = [source]
    let qIdx = 0
    while (qIdx < queue.length) {
      const v = queue[qIdx++]
      stack.push(v)

      const neighbors = _outNeighbors(g, v)
      for (const w of neighbors) {
        if (dist.get(w) < 0) {
          dist.set(w, dist.get(v) + 1)
          queue.push(w)
        }
        if (dist.get(w) === dist.get(v) + 1) {
          sigma.set(w, sigma.get(w) + sigma.get(v))
          paths.get(w).push(v)
        }
      }
    }

    // Accumulation phase
    const delta = new Map(nodeIds.map(id => [id, 0]))
    while (stack.length > 0) {
      const w = stack.pop()
      for (const v of paths.get(w)) {
        const c = (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w))
        delta.set(v, delta.get(v) + c)
      }
      if (w !== source) {
        betweennessMap.set(w, betweennessMap.get(w) + delta.get(w))
      }
    }
  }

  // Normalize and return
  const result = {}
  for (const [id, score] of betweennessMap) {
    result[id] = score * scale
  }
  return result
}

/**
 * PageRank via power iteration.
 * @param {Object} g - Graph struct
 * @param {Object} opts - { alpha = 0.85, maxIter = 100, tol = 1e-6 }
 * @returns {Object} { nodeId: score }
 */
export function pagerank(g, opts = {}) {
  const { alpha = 0.85, maxIter = 100, tol = 1e-6 } = opts
  const nodeIds = [...g.nodes.keys()]
  const n = nodeIds.length

  if (n === 0) return {}

  const uniform = 1 / n
  let x = new Map(nodeIds.map(id => [id, uniform]))
  const danglingNodes = []

  // Identify dangling nodes (no outgoing edges)
  for (const id of nodeIds) {
    if (_outNeighbors(g, id).length === 0) {
      danglingNodes.push(id)
    }
  }

  // Power iteration
  for (let iteration = 0; iteration < maxIter; iteration++) {
    const xNew = new Map()

    // Recompute danglingSum each iteration from current rank values
    let danglingSum = 0
    for (const id of danglingNodes) {
      danglingSum += x.get(id)
    }

    for (const id of nodeIds) {
      let score = (1 - alpha) / n

      const inNeighbors = _inNeighbors(g, id)
      for (const neighbor of inNeighbors) {
        const outDeg = _outNeighbors(g, neighbor).length
        if (outDeg > 0) {
          score += (alpha * x.get(neighbor)) / outDeg
        }
      }

      // Always add dangling contribution
      score += (alpha * danglingSum) / n

      xNew.set(id, score)
    }

    // Check convergence
    let maxDelta = 0
    for (const id of nodeIds) {
      const delta = Math.abs(xNew.get(id) - x.get(id))
      maxDelta = Math.max(maxDelta, delta)
    }

    x = xNew
    if (maxDelta < tol) break
  }

  const result = {}
  for (const [id, score] of x) {
    result[id] = score
  }
  return result
}

/**
 * Tarjan's strongly connected components.
 * @param {Object} g - Graph struct
 * @returns {Array<string[]>} SCCs, largest first
 */
export function tarjanSCC(g) {
  const nodeIds = [...g.nodes.keys()]
  if (nodeIds.length === 0) return []

  let index = 0
  const indices = new Map()
  const lowlink = new Map()
  const onStack = new Set()
  const stack = []
  const sccs = []

  function strongconnect(v) {
    indices.set(v, index)
    lowlink.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)

    for (const w of _outNeighbors(g, v)) {
      if (!indices.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)))
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc = []
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      sccs.push(scc)
    }
  }

  for (const v of nodeIds) {
    if (!indices.has(v)) strongconnect(v)
  }

  return sccs.sort((a, b) => b.length - a.length)
}

/**
 * Topological sort via Kahn's algorithm.
 * @param {Object} g - Graph struct
 * @returns {string[]|null} sorted ids, or null if cyclic
 */
export function topoSort(g) {
  const nodeIds = [...g.nodes.keys()]
  if (nodeIds.length === 0) return []

  const inDeg = new Map(nodeIds.map(id => [id, 0]))
  for (const e of g.edges) {
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1)
  }

  const queue = []
  for (const [id, d] of inDeg) {
    if (d === 0) queue.push(id)
  }

  const sorted = []
  let qi = 0
  while (qi < queue.length) {
    const node = queue[qi++]
    sorted.push(node)
    for (const next of _outNeighbors(g, node)) {
      const d = inDeg.get(next) - 1
      inDeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }

  return sorted.length === nodeIds.length ? sorted : null
}

/**
 * Shortest path between two nodes via BFS.
 * @param {Object} g - Graph struct
 * @param {string} source
 * @param {string} target
 * @returns {string[]|null} path, or null if unreachable
 */
export function shortestPath(g, source, target) {
  if (!g.nodes.has(source) || !g.nodes.has(target)) return null
  if (source === target) return [source]

  const visited = new Set([source])
  const prev = new Map()
  const queue = [source]
  let qi = 0

  while (qi < queue.length) {
    const v = queue[qi++]
    for (const w of _outNeighbors(g, v)) {
      if (visited.has(w)) continue
      visited.add(w)
      prev.set(w, v)
      if (w === target) {
        const path = [target]
        let cur = target
        while (prev.has(cur)) {
          cur = prev.get(cur)
          path.unshift(cur)
        }
        return path
      }
      queue.push(w)
    }
  }

  return null
}

/**
 * Closeness centrality: inverse of average shortest path distance.
 * @param {Object} g - Graph struct
 * @returns {Object} { nodeId: score }
 */
export function closeness(g) {
  const nodeIds = [...g.nodes.keys()]
  const n = nodeIds.length
  if (n === 0) return {}

  const result = {}
  for (const source of nodeIds) {
    const dist = new Map([[source, 0]])
    const queue = [source]
    let qi = 0
    while (qi < queue.length) {
      const v = queue[qi++]
      for (const w of _outNeighbors(g, v)) {
        if (!dist.has(w)) {
          dist.set(w, dist.get(v) + 1)
          queue.push(w)
        }
      }
    }

    const reachable = dist.size - 1
    if (reachable === 0) {
      result[source] = 0
    } else {
      let totalDist = 0
      for (const [, d] of dist) totalDist += d
      result[source] = (reachable / (n - 1)) * (reachable / totalDist)
    }
  }

  return result
}

/**
 * HITS — hub and authority scores.
 * @param {Object} g - Graph struct
 * @param {Object} opts - { maxIter = 100, tol = 1e-6 }
 * @returns {{ hubs: Object, authorities: Object }}
 */
export function hits(g, opts = {}) {
  const { maxIter = 100, tol = 1e-6 } = opts
  const nodeIds = [...g.nodes.keys()]
  const n = nodeIds.length

  if (n === 0) return { hubs: {}, authorities: {} }

  let hub = new Map(nodeIds.map(id => [id, 1 / n]))
  let auth = new Map(nodeIds.map(id => [id, 1 / n]))

  for (let iter = 0; iter < maxIter; iter++) {
    const newAuth = new Map(nodeIds.map(id => [id, 0]))
    const newHub = new Map(nodeIds.map(id => [id, 0]))

    for (const id of nodeIds) {
      let sum = 0
      for (const src of _inNeighbors(g, id)) {
        sum += hub.get(src)
      }
      newAuth.set(id, sum)
    }

    for (const id of nodeIds) {
      let sum = 0
      for (const dst of _outNeighbors(g, id)) {
        sum += newAuth.get(dst)
      }
      newHub.set(id, sum)
    }

    let authNorm = 0
    let hubNorm = 0
    for (const id of nodeIds) {
      authNorm += newAuth.get(id) ** 2
      hubNorm += newHub.get(id) ** 2
    }
    authNorm = Math.sqrt(authNorm) || 1
    hubNorm = Math.sqrt(hubNorm) || 1

    let maxDelta = 0
    for (const id of nodeIds) {
      const a = newAuth.get(id) / authNorm
      const h = newHub.get(id) / hubNorm
      maxDelta = Math.max(maxDelta, Math.abs(a - auth.get(id)), Math.abs(h - hub.get(id)))
      newAuth.set(id, a)
      newHub.set(id, h)
    }

    auth = newAuth
    hub = newHub
    if (maxDelta < tol) break
  }

  let authSum = 0
  let hubSum = 0
  for (const id of nodeIds) {
    authSum += auth.get(id)
    hubSum += hub.get(id)
  }

  const hubs = {}
  const authorities = {}
  for (const id of nodeIds) {
    hubs[id] = hubSum > 0 ? hub.get(id) / hubSum : 0
    authorities[id] = authSum > 0 ? auth.get(id) / authSum : 0
  }

  return { hubs, authorities }
}

/**
 * Louvain modularity optimization for community detection.
 * Treats directed graph as undirected (uses both in and out neighbors).
 * Phase 1: greedily move nodes to neighbor communities that maximize modularity gain.
 * Phase 2: collapse communities, repeat until no improvement.
 * @param {Object} g - Graph struct
 * @returns {Object} { nodeId: communityId }
 */
export function louvain(g) {
  const nodeIds = [...g.nodes.keys()]
  const n = nodeIds.length

  if (n === 0) return {}
  if (n === 1) return { [nodeIds[0]]: 0 }

  let communities = new Map(nodeIds.map(id => [id, id]))

  const nodeDegree = new Map()
  for (const id of nodeIds) {
    nodeDegree.set(id, _allNeighbors(g, id).size)
  }

  const communityDegree = new Map()
  for (const id of nodeIds) {
    communityDegree.set(id, nodeDegree.get(id))
  }

  let improved = true
  let iteration = 0
  const maxIterations = 50

  while (improved && iteration < maxIterations) {
    improved = false
    iteration++

    for (const node of nodeIds) {
      const currentCommunity = communities.get(node)
      const neighborCommunities = _getNeighborCommunities(g, node, communities)

      let bestCommunity = currentCommunity
      let bestGain = 0

      for (const community of neighborCommunities) {
        const gain = _modularityGain(g, node, communities, currentCommunity, community, communityDegree)
        if (gain > bestGain) {
          bestGain = gain
          bestCommunity = community
        }
      }

      if (bestCommunity !== currentCommunity) {
        const kI = nodeDegree.get(node)
        communityDegree.set(currentCommunity, (communityDegree.get(currentCommunity) || 0) - kI)
        communityDegree.set(bestCommunity, (communityDegree.get(bestCommunity) || 0) + kI)
        communities.set(node, bestCommunity)
        improved = true
      }
    }
  }

  const communityMap = new Map()
  let nextId = 0
  const result = {}

  for (const [nodeId, communityId] of communities) {
    if (!communityMap.has(communityId)) {
      communityMap.set(communityId, nextId++)
    }
    result[nodeId] = communityMap.get(communityId)
  }

  return result
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _outNeighbors(g, id) {
  const nb = g._neighbors.get(id)
  if (!nb) return []
  const result = []
  for (const i of nb.out) result.push(g.edges[i].to)
  return result
}

function _inNeighbors(g, id) {
  const nb = g._neighbors.get(id)
  if (!nb) return []
  const result = []
  for (const i of nb.in) result.push(g.edges[i].from)
  return result
}

function _allNeighbors(g, id) {
  const neighbors = new Set()
  const out = _outNeighbors(g, id)
  const inn = _inNeighbors(g, id)
  for (const n of out) neighbors.add(n)
  for (const n of inn) neighbors.add(n)
  return neighbors
}

function _getNeighborCommunities(g, node, communities) {
  const neighbors = _allNeighbors(g, node)
  const communitySet = new Set()
  communitySet.add(communities.get(node))
  for (const neighbor of neighbors) {
    communitySet.add(communities.get(neighbor))
  }
  return [...communitySet]
}

function _modularityGain(g, node, communities, oldCommunity, newCommunity, communityDegree) {
  if (oldCommunity === newCommunity) return 0
  const m = g.edges.length
  if (m === 0) return 0

  const neighbors = _allNeighbors(g, node)
  const kI = neighbors.size

  let edgesToOld = 0
  let edgesToNew = 0
  for (const neighbor of neighbors) {
    const nc = communities.get(neighbor)
    if (nc === oldCommunity && neighbor !== node) edgesToOld++
    if (nc === newCommunity) edgesToNew++
  }

  const sigmaOld = (communityDegree.get(oldCommunity) || 0) - kI
  const sigmaNew = communityDegree.get(newCommunity) || 0

  const twoM = 2 * m
  return ((edgesToNew - edgesToOld) / twoM) -
         ((kI * (sigmaNew - sigmaOld)) / (twoM * twoM))
}
