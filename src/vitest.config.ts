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
  },
});
