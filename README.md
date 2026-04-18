# sdd-cortex

Code property graph for JS/ESM. Single-pass AST builds a CPG with binding-aware call resolution, then runs graph algorithms — centrality, clustering, cycle detection, blast radius, process tracing, schema auditing — with ad-hoc Cypher queries built in.

## Install

```bash
npm install -g sdd-cortex
```

## Quick Start

```bash
# Full analysis
sdd-graph src/

# Architecture overview
sdd-graph --map src/

# Blast radius for a symbol
sdd-graph --impact createUser src/

# Who calls / who is called by a symbol
sdd-graph --context parseFile src/

# Module clusters (Louvain community detection)
sdd-graph --clusters src/

# Cypher query against the code graph
sdd-graph --query "MATCH (a)-[r:CALL]->(b) RETURN a.name, b.name" src/

# CI gate — exit 1 if violations found
sdd-graph --ci src/
```

## Programmatic API

```javascript
import { analyze } from 'sdd-cortex'

const result = await analyze(['src/'], { root: process.cwd() })
// result conforms to AnalysisResult schema
```

## What It Builds

A Code Property Graph (CPG-lite) inspired by [Joern](https://joern.io), with four layers:

| Layer | Nodes | Edges |
|-------|-------|-------|
| FileSystem | `FILE` | `IMPORT`, `DYNAMIC_IMPORT`, `REQUIRE`, `REEXPORT` |
| Structure | `FUNCTION`, `CLASS`, `METHOD` | `CONTAINS`, `METHOD_OF` |
| CallGraph | — | `CALL`, `CALLBACK`, `CALL_INDIRECT` |
| Schema | `SCHEMA_FILE`, `DEFINITION`, `PROPERTY` | `DEFINES`, `HAS_PROPERTY`, `REF` |

Call edges are resolved at walk time via a binding map — factory returns, destructured imports, and member expressions all resolve to their source file and symbol.

## What It Computes

| Analysis | Algorithm | Output |
|----------|-----------|--------|
| Centrality | Brandes betweenness, PageRank, closeness, HITS | Per-node scores |
| Clustering | Louvain modularity optimization | Community groups |
| Cycles | DFS + Tarjan SCC | Circular dependency chains |
| Blast radius | BFS upstream/downstream | Affected files per change |
| Hot paths | Longest dependency chains | Critical path sequences |
| Complexity | Per-file fan-in, fan-out, depth, internal ratio | Risk metrics |
| Violations | Encapsulation breach detection | Boundary crossings |
| Schema audit | Dead defs, broken refs, $ref cycles | Schema health |
| Process tracing | Cross-file call chain extraction | Business flows |
| Duplicate detection | Factory instantiation analysis | Redundant constructions |
| Entry points | Heuristic scoring | Likely application roots |

All algorithms are zero-dependency — betweenness, PageRank, Louvain, Tarjan, HITS ported from NetworkX.

## CLI Reference

```
sdd-graph [options] <path...>

Output Format
  --json             JSON output (AnalysisResult schema)
  --mermaid          Mermaid dependency graph
  --swimlane         ASCII swimlane diagram
  --ci               Exit code 1 if violations found
  -o, --output FILE  Write output to file

Query Modes
  --map              Architecture bird's eye view
  --impact SYMBOL    Blast radius analysis
    --direction      upstream (default) or downstream
    --depth N        Max BFS depth (default: 3)
  --context SYMBOL   Callers + callees for a symbol
  --clusters         Module cluster detection
  --processes        Business process tracing
    --threshold N    Coupling threshold (default: 0.4)
  --schema-audit     Schema health check
  --schema-blocks    Schema block boundary analysis
  --query "MATCH .." Ad-hoc Cypher query

Options
  --root DIR         Project root (default: inferred)
  --schema FILE      Schema file for registry derivation
  --registry FILE    Pre-built PublicInterfaceRegistry JSON
  --ext .mjs,.js     File extensions (default: .mjs,.js)
```

## Architecture

Five composable blocks, each with its own schema and index interface:

```
cli.mjs              CLI entry
index.mjs            Orchestrator — wires blocks together

graph/               Graph data structure (Map + neighbor index + path index)
parse/               Source -> graph mutations (single-pass AST walk)
query/               Graph queries (symbol, context, impact, Cypher)
analysis/            Graph algorithms (centrality, cycles, clusters, etc.)
output/              Formatted rendering (text, JSON, mermaid, swimlane)

schema/              JSON Schema definitions (one schema = one block)
graph-analysis.json  Hub schema with $ref to block schemas
```

## Dependencies

- [acorn](https://github.com/acornjs/acorn) — ESTree-compliant JS parser
- [acorn-walk](https://github.com/acornjs/acorn) — AST visitor
- [cli-table3](https://github.com/cli-table/cli-table3) — Terminal tables
- [cypherdotjs](https://github.com/niclasko/cypherdotjs) — In-memory Cypher engine

## License

GPL-3.0-or-later
