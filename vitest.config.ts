import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Date handling in the lambdas mixes UTC and local time - keep tests deterministic
    env: {
      TZ: 'UTC',
    },
  },
});
