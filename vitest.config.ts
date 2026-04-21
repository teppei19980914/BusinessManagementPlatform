import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      // PR #83:
      //   - text         : Actions ログ / ローカル実行時にテキスト表として出力
      //   - lcov         : 外部ツール (IDE / Coveralls 等) 連携用
      //   - json         : davelosert/vitest-coverage-report-action の「変更行カバレッジ」用
      //   - json-summary : 同 action の PR コメント要約用 (必須)
      reporter: ['text', 'lcov', 'json', 'json-summary'],
      include: ['src/lib/**', 'src/services/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
