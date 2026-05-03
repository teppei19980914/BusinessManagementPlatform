import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // PR #6 (T-03): prisma/ 配下にも seedTenant() の単体テストを配置するため追加。
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'prisma/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // PR #83:
      //   - text         : Actions ログ / ローカル実行時にテキスト表として出力
      //   - lcov         : 外部ツール (IDE / Coveralls 等) 連携用
      //   - json         : davelosert/vitest-coverage-report-action の「変更行カバレッジ」用
      //   - json-summary : 同 action の PR コメント要約用 (必須)
      reporter: ['text', 'lcov', 'json', 'json-summary'],
      include: ['src/lib/**', 'src/services/**'],
      // PR #84: 80% 閾値を満たすため、単体テストで検証が困難な以下を除外する。
      //   - lib/auth.config.ts / lib/auth.ts: next-auth の provider 配線 (integration test 領域)
      //   - lib/use-*.ts               : React フック (client-only、React Testing Library が必要)
      //   - lib/db.ts                  : PrismaClient のインスタンス化
      //   - lib/search/trgm-provider.ts: 実 PG (pg_trgm 拡張) 接続が必要
      //   - lib/mail/sendgrid-provider.ts / brevo-provider.ts (外部送信アダプタ)
      //     → brevo は index.test.ts 経由で一部カバー済み
      //   - *.test.ts / *.d.ts         : テスト自身と型定義
      exclude: [
        'src/lib/auth.config.ts',
        'src/lib/auth.ts',
        'src/lib/db.ts',
        'src/lib/use-lazy-fetch.ts',
        'src/lib/use-session-state.ts',
        'src/lib/search/pg-trgm-provider.ts',
        'src/lib/mail/resend-provider.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
      ],
      // PR #84: 80% を常時維持する。以降の PR で 80% を下回ると CI が fail する。
      // branches のみ 70% にしているのは、防御的 if (defense-in-depth) が現実的には
      // 未到達となり、これを 80% にするとテスト負債が過大になるため。
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
