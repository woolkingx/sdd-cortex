// entry-point.mjs — Heuristic entry point scoring.
// Layer role (L1): pure fn, no threshold, pure data out.
//
// fn chain: fan counts → name score → composite → EntryPoint[]

import { graph } from '../graph/index.mjs'

// Name patterns that signal entry points, with weights
const NAME_PATTERNS = [
  { re: /(^|\/)index\.[^/]+$/, weight: 0.4, label: 'name:index' },
  { re: /(^|\/)main\.[^/]+$/,  weight: 0.4, label: 'name:main'  },
  { re: /background/i,         weight: 0.35, label: 'name:background' },
  { re: /cli\.[^/]+$/,         weight: 0.35, label: 'name:cli'  },
  { re: /app\.[^/]+$/,         weight: 0.25, label: 'name:app'  },
  { re: /server\.[^/]+$/,      weight: 0.25, label: 'name:server' },
]

/**
 * Score all files as potential entry points.
 * Returns all files sorted by score descending.
 * No threshold applied — caller decides cutoff.
 * @returns {EntryPoint[]}
 */
export function scoreEntryPoints() {
  const files = [...graph.nodes.keys()]
  if (files.length === 0) return []

  const fanIn  = _computeFanIn(files)
  const fanOut = _computeFanOut(files)
  const maxIn  = Math.max(1, ...fanIn.values())

  return files
    .map(file => _scoreFile(file, fanIn.get(file) || 0, fanOut.get(file) || 0, maxIn))
    .sort((a, b) => b.score - a.score)
}

/**
 * @private
 */
function _computeFanIn(files) {
  const counts = new Map(files.map(f => [f, 0]))
  for (const edge of graph.edges) {
    if (counts.has(edge.to)) counts.set(edge.to, counts.get(edge.to) + 1)
  }
  return counts
}

/**
 * @private
 */
function _computeFanOut(files) {
  const counts = new Map(files.map(f => [f, 0]))
  for (const edge of graph.edges) {
    if (counts.has(edge.from)) counts.set(edge.from, counts.get(edge.from) + 1)
  }
  return counts
}

/**
 * @private
 */
function _scoreFile(file, fan_in, fan_out, maxIn) {
  const reasons = []
  let score = 0

  // Name pattern score
  for (const { re, weight, label } of NAME_PATTERNS) {
    if (re.test(file)) {
      score += weight
      reasons.push(label)
      break // only first match
    }
  }

  // Fan-in score: normalised 0-0.4
  const fanInScore = (fan_in / maxIn) * 0.4
  score += fanInScore
  if (fan_in > 0) reasons.push(`fan_in:${fan_in}`)

  // Low fan-out bonus: entry points tend to import many, not be imported AND import many
  // But scripts like cli.mjs have high fan-out — reward files with fan_in > fan_out
  if (fan_in > fan_out && fan_in > 0) {
    score += 0.1
    reasons.push('fan_in_dominant')
  }

  // Orphan penalty: nothing imports this and name isn't a known entry pattern
  if (fan_in === 0 && reasons.length === 0) {
    score = Math.max(0, score - 0.1)
    reasons.push('orphan')
  }

  return { file, score: Math.min(1, Math.round(score * 100) / 100), reasons, fan_in, fan_out }
}
