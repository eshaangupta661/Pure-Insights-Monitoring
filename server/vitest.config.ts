import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several files each build the full warehouse in an in-memory DuckDB (up to DUCKDB_MEMORY_LIMIT
    // each). Running files one at a time keeps peak memory low on small CI runners and laptops,
    // where parallel files failed with allocation errors; the suite still takes ~12 s.
    fileParallelism: false,
  },
});
