import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `bun run build` emits compiled tests into dist/; running them again fails.
    exclude: [...configDefaults.exclude, 'dist/**'],
    setupFiles: ['./test/setup-env.ts'],
    // Integration suites share one provisioned database (standard env target,
    // no per-suite databases) — files must not run concurrently.
    fileParallelism: false,
    // beforeAll hooks connect + wipe + seed against the REMOTE staging
    // instance in CI; the 10s default trips under WAN latency/contention.
    hookTimeout: 120_000,
    // Same reason for test bodies: a test that opens a connection (~2s) and
    // runs a dozen statements (~100ms each) against the remote instance
    // exceeds the 5s default without anything being wrong. Genuine hangs
    // still fail, just later; latency-sensitive assertions measure their own
    // elapsed time rather than relying on this limit.
    testTimeout: 30_000,
  },
});
