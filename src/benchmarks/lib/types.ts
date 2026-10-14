export interface TestCase {
  id: string;
  category: QualityCategory;
  question: string;
  context: TestContext;
  kgQuery: string;
  expectedNodeIds: string[];
  goldenAnswer: string;
  judgeCriteria: string[];
}

export type QualityCategory =
  | 'decision-recall'
  | 'pattern-discovery'
  | 'guideline-adherence'
  | 'dead-end-avoidance'
  | 'bug-recognition'
  | 'org-awareness';

export interface TestContext {
  project?: string;
  recentWork?: string;
  role?: string;
}

export interface TestResult {
  caseId: string;
  category: QualityCategory;
  baselineAnswer: string;
  kgAnswer: string;
  retrievedNodes: string[];
  expectedNodes: string[];
  recall: number;
  judgeScore?: JudgeScore;
  latencyMs: number;
  timestamp: string;
}

export interface JudgeScore {
  baselineScore: number;
  kgScore: number;
  winner: 'baseline' | 'kg' | 'tie';
  reasoning: string;
}

export interface DriftResult {
  metric: string;
  current: number;
  baseline: number;
  delta: number;
  deltaPercent: number;
  status: 'ok' | 'warning' | 'critical';
  threshold: { warning: number; critical: number };
  note?: string;
}

export interface HealthMetrics {
  nodeCount: number;
  nodesByType: Record<string, number>;
  nodesByProject: Record<string, number>;
  edgeCount: number;
  edgeDensity: number;
  orphanNodes: number;
  orphanPercent: number;
  embeddingCoverage: number;
  decayDistribution: {
    cold: number;
    cooling: number;
    warm: number;
    hot: number;
    active: number;
  };
  sessionActivity: {
    lastSession: string;
    sessionsLast7d: number;
    sessionsLast30d: number;
    totalSessions?: number;
  };
  timestamp: string;
}

export interface PerfResult {
  operation: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  status: 'ok' | 'warning' | 'critical';
}

export interface BenchmarkReport {
  version: string;
  timestamp: string;
  gitSha: string;
  gitBranch: string;
  environment: 'local' | 'ci' | 'staging' | 'prod';
  quality?: {
    results: TestResult[];
    summary: {
      totalCases: number;
      kgWins: number;
      baselineWins: number;
      ties: number;
      winRate: number;
      avgKgScore: number;
      avgBaselineScore: number;
      byCategory: Record<QualityCategory, CategorySummary>;
    };
  };
  drift?: {
    results: DriftResult[];
    overallStatus: 'ok' | 'warning' | 'critical';
  };
  health?: HealthMetrics;
  perf?: {
    results: PerfResult[];
    overallStatus: 'ok' | 'warning' | 'critical';
  };
}

export interface CategorySummary {
  cases: number;
  kgWins: number;
  baselineWins: number;
  ties: number;
  avgKgScore: number;
  avgBaselineScore: number;
}

export interface Baseline {
  version: string;
  timestamp: string;
  gitSha: string;
  coherenceMean: number;
  coherenceStdDev: number;
  embeddingCoverage: number;
  decayDistribution: HealthMetrics['decayDistribution'];
  perfP99: Record<string, number>;
}
