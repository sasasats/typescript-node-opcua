import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    onConsoleLog(log, type) {
      if (log.includes('PublishResponse') || log.includes('requestHandle !== requestId')) {
        return false;
      }
    },
  },
});
