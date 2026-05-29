/**
 * routes.ts のユニットテスト
 *
 * 本テストは「PUBLIC_PATHS と実装の cron route 群との同期」を invariant として固定する役割を持つ。
 * 過去事例:
 *   - 2026-05-18 fix/cron-public-paths-and-stripe-disabled-guard:
 *       PR #394 (Vercel → Netlify 移行) で複数の cron route が PUBLIC_PATHS に未登録となり、
 *       外部 cron 呼出が /login へ 302 redirect される production 障害が発生。
 *   - 2026-05-29 fix on feat/beginner-quota-block-adr-0025:
 *       ADR-0021 で新規追加された /api/cron/attachment-embedding が PUBLIC_PATHS に
 *       未登録のままマージされ、ファイル添付の embedding 生成が完全停止していた既存バグ発覚。
 *
 * 本ガードがあれば、今後 src/app/api/cron/ 配下に route を追加した時点で必ず
 * PUBLIC_PATHS に追加することが強制される。
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PATHS } from './routes';

describe('PUBLIC_PATHS と /api/cron/* route の同期 (= middleware 通過設定)', () => {
  it('src/app/api/cron/ 配下の全 route ディレクトリが PUBLIC_PATHS に登録されている', () => {
    const cronDir = resolve(__dirname, '..', 'app', 'api', 'cron');
    const cronRouteNames = readdirSync(cronDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(cronRouteNames.length).toBeGreaterThan(0);

    const missingPaths: string[] = [];
    for (const name of cronRouteNames) {
      const expected = `/api/cron/${name}`;
      if (!PUBLIC_PATHS.includes(expected as (typeof PUBLIC_PATHS)[number])) {
        missingPaths.push(expected);
      }
    }

    expect(missingPaths, `次の cron route が PUBLIC_PATHS に未登録です (middleware が /login へ 302 redirect する production 障害になります): ${missingPaths.join(', ')}`)
      .toEqual([]);
  });
});
