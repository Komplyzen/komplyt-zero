# KG Benchmark Suite

## Goals

1. **Prove value**: Does the KG make AI assistants better at org-specific tasks?
2. **Catch drift**: Alert when KG quality degrades (stale knowledge, embedding rot, decay gone wrong)
3. **Track health**: Graph metrics over time (coverage, connectivity, freshness)

## What We Measure

### 1. Quality Benchmarks (LLM-judged)

Test whether KG-augmented responses beat baseline on org-specific tasks.

| Category | Tests | What it proves |
|----------|-------|----------------|
| **Decision Recall** | 4 | Can retrieve WHY we made past choices |
| **Pattern Discovery** | 4 | Can find existing implementations to reuse |
| **Guideline Adherence** | 4 | Follows org conventions without being told |
| **Dead End Avoidance** | 4 | Warns about known failures before repeating them |
| **Bug Recognition** | 4 | Recognizes symptoms, applies known fixes |
| **Org Awareness** | 4 | Knows team context, dependencies, ownership |

**Methodology**:
- 24 test cases with known-good answers from KG
- Run each case: baseline (no KG) vs +KG (with retrieval)
- Blind LLM judge (Opus) scores on 1-5 scale
- Track: win rate, avg score delta, per-category breakdown

**Hypothesis**: Sonnet + KG ≥ Opus baseline on org-specific tasks.

### 2. Drift Detection

Catch quality degradation before users notice it.

| Metric | Threshold | What it catches |
|--------|-----------|-----------------|
| **Embedding coverage** | >95% nodes | Embedding failures, model changes |
| **Semantic coherence** | Δ<5% from baseline | Embedding model drift |
| **Decay distribution** | <10% at floor | Over-aggressive decay |
| **Orphan nodes** | <5% total | Missing relations, isolated knowledge |
| **Stale high-value** | 0 critical nodes >90d | Important knowledge going cold |

**Coherence test**: Sample 100 node pairs with known relations, measure cosine similarity. Alert if mean drops >5% from baseline.

**Future distance measures** (not yet implemented):
- **Euclidean distance** (`||vecA - vecB||`): Raw vector difference magnitude
- **Poincaré/hyperbolic distance**: Better for hierarchical relationships (parent→child closer in hyperbolic space)
- **Angular distance**: Normalized cosine, less sensitive to vector magnitude

SurrealDB currently only supports cosine similarity natively. Other measures would require client-side computation.

### Scoring Formula

The combined relevance score blends recency and semantic similarity:

```
combined_score = decay_score * 0.3 + semantic_score * 0.7
```

Where:
- `decay_score`: Time-based relevance (0.0 = stale, 1.0 = fresh/recently activated)
- `semantic_score`: Cosine similarity to query embedding

This formula prioritizes semantic relevance (70%) while still surfacing recently-used knowledge (30%).

### 3. Graph Health Metrics

Structural health of the knowledge graph.

| Metric | Healthy Range | Risk |
|--------|---------------|------|
| **Node count** | Growing or stable | Stagnation = not using KG |
| **Edge density** | 2-5 edges/node | <2 = isolated, >5 = noise |
| **Type distribution** | Per project baseline | Imbalance = missing perspectives |
| **Session activity** | >1/week per project | Dead projects |
| **Activation spread** | Bimodal (hot/cold) | All-hot = no signal, all-cold = decay broken |

### 4. Performance Benchmarks

Latency and throughput for CI gates.

| Operation | P50 Target | P99 Target |
|-----------|------------|------------|
| `kg_query` (semantic) | <500ms | <2s |
| `kg_node_create` (with embed) | <1s | <3s |
| `kg_session_start` | <200ms | <1s |
| `kg_relate` | <100ms | <500ms |

## Test Cases

Each test case has:
- `id`: Unique identifier (e.g., `decision-recall-01`)
- `category`: One of the 6 quality categories
- `question`: Natural language question
- `context`: Simulated user context (project, recent work)
- `kg_query`: The semantic query to run
- `expected_nodes`: Node IDs that SHOULD be retrieved
- `baseline_answer`: What a model says without KG
- `kg_answer`: What a model says with KG retrieval
- `golden_answer`: Human-verified correct answer
- `judge_criteria`: What the LLM judge evaluates

## CI Integration

### PR Checks (fast, <2min)
- Performance benchmarks (latency gates)
- Embedding coverage check
- Schema validation

### Nightly (comprehensive, ~10min)
- Full quality benchmark suite
- Drift detection
- Health metrics
- Results logged to `benchmarks/results/YYYY-MM-DD.json`

### Weekly (expensive, ~30min)
- LLM-judged quality comparison
- Cross-model matrix (Haiku/Sonnet/Opus × baseline/+KG)
- Trend analysis vs previous weeks

## Directory Structure

```
src/benchmarks/
├── README.md           # This file
├── cases/              # Test case definitions
│   ├── decision-recall.ts
│   ├── pattern-discovery.ts
│   ├── guideline-adherence.ts
│   ├── dead-end-avoidance.ts
│   ├── bug-recognition.ts
│   └── org-awareness.ts
├── drift/              # Drift detection
│   ├── coherence.ts
│   ├── coverage.ts
│   └── decay.ts
├── health/             # Graph health metrics
│   └── metrics.ts
├── perf/               # Performance benchmarks
│   └── latency.ts
├── lib/                # Shared utilities
│   ├── kg-client.ts    # MCP client wrapper
│   ├── llm-client.ts   # Anthropic API + batch
│   └── reporter.ts     # Results formatting
├── runner.ts           # Main orchestrator
└── results/            # Output (gitignored except baselines)
    ├── .gitkeep
    └── baseline.json   # Reference baseline (committed)
```

## Usage

```bash
# Run all benchmarks
bun run bench

# Run specific suite
bun run bench:perf      # Performance only
bun run bench:drift     # Drift detection only
bun run bench:health    # Health metrics only

# Save the current results as the baseline
bun run bench:baseline

# Quick smoke check
bun run bench:smoke
```

## Baseline Management

1. **Establish baseline**: Run full suite on known-good state
2. **Commit baseline**: `cp results/latest.json results/baseline.json && git add`
3. **Compare**: CI compares each run against baseline
4. **Update**: When intentional changes improve metrics, update baseline

## Alerts

| Condition | Severity | Action |
|-----------|----------|--------|
| Quality win rate <60% | CRITICAL | Block deploy, investigate |
| Embedding coverage <90% | HIGH | Fix embedding pipeline |
| P99 latency >5s | HIGH | Investigate slow queries |
| Orphan nodes >10% | MEDIUM | Run relation discovery |
| No sessions >7d | LOW | Check if KG is being used |
