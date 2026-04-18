# Changelog

## 0.10.1

- Rename to sdd-cortex
- Add GPL-3.0 license
- Move plan files into master worktree

## 0.10.0

- Acorn schema-driven parser: AST-to-graph mapping rules defined in `x-graph` schema extensions
- Delete mapping.json — parser reads mapping from acorn schema
- Exclude exported class methods from violation detection (false positive fix)
- Schema-audit scans target project, not tool itself

## 0.9.1

- Split graph-analysis.json into 6 leaf sub-schemas + hub
- One schema = one block boundary
- Connect graph.json to hub (no orphan root)
- Remove orphan schema files

## 0.9.0 — Composable Block Architecture

- Five blocks: graph, parse, query, analysis, output
- Each block has index.mjs interface + own schema
- Add `--schema-blocks` CLI for schema $ref graph analysis via Louvain/betweenness/Tarjan
- Add query/ and output/ block schemas

## 0.8.1

- Add closeness centrality and HITS algorithms
- Integrate into centrality pipeline

## 0.8.0 — Unified Graph Module

- Unified graph.mjs: struct + neighbor index + path index + persist
- Port betweenness, PageRank, Louvain from NetworkX — zero dependencies
- Remove graphology dependency
- Add `--query` flag for ad-hoc Cypher queries via cypherdotjs

## 0.7.0 — Schema Graph + Node Enrichment

- Schema graph: build DEFINITION/PROPERTY/REF graph from JSON Schema files
- Schema audit: dead defs, broken refs, $ref cycles, duplicates, orphans
- `--schema-audit` and `--map` CLI modes
- Enrich nodes with params, jsdoc, body, signature

## 0.6.0 — CPG-lite Graph Model

- Code Property Graph model inspired by Joern
- Schema-driven node/edge labels (NL/EL resolved from schema enums at boot)
- MemberExpression/NewExpression/TaggedTemplate target symbol-level nodes
- SCHEMA_FILE/DEFINITION/PROPERTY labels

## 0.5.0 — Function-Level Graph

- CONTAINS edges (FILE -> FUNCTION/CLASS)
- Scoped call edges via ancestor walk
- Function-level centrality and violations
- Schema $ref refactor: hub references block sub-schemas

## 0.4.1

- Quality cleanup, output module split
- Fix factory return detection, impact partial match, duplicate false positive

## 0.4.0 — Programmatic API

- `analyze()` programmatic entry point
- CLI help text
- Procedural style refactor: eliminate global state from analysis layer
- Test suite: 62 tests

## 0.3.0 — Schema-Driven Graph

- Graph + schema2object as module-level singletons
- Detect duplicate factory instantiations
- Schema validation for ParsedFile/FunctionInfo/Edge

## 0.2.0

- Single-pass AST walk builds graph directly (no parse-flatten-rebuild)
- Binding-aware call resolution (factory returns, destructured imports, member expressions)
- Function-level metrics: lines, cyclomatic complexity, call count

## 0.1.0

- AST-based graph analysis with acorn
- Multi-layer architecture (file, import, call)
- Encapsulation violation detection
- Mermaid dependency graph output
