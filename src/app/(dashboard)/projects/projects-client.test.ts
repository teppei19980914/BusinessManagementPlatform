import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * perf/phase-5 (2026-06-01) 回帰テスト:
 *   /projects 一覧の project 名 Link は default prefetch=true だと表示中の全プロジェクトの
 *   layout + page RSC が裏で取得され (1 件 = 2 fetch × 表示件数)、不要な数十 KB の帯域・
 *   サーバ負荷を生む。本テストは「将来 prefetch=false を外す PR を CI で防ぐ」回帰ガード。
 *
 *   同パターン:
 *     - PR #478 (F): 全○○ 系一覧 (retrospectives/risks/knowledge/my-tasks/customer-detail)
 *     - PR #479 (4-B): AppHeader nav (FlatNavLink + GroupMenu)
 *     - 本 PR (5-A): /projects テーブル行 + モバイル card view
 */
describe('ProjectsClient prefetch invariant (perf/phase-5 5-A)', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/app/(dashboard)/projects/projects-client.tsx'),
    'utf-8',
  );

  it('一覧テーブル行の Link href=`/projects/${project.id}` には prefetch={false} が付与されている', () => {
    // テーブル行 (desktop) の Link 周辺ブロックを抽出して prefetch={false} の存在を検証
    const tableLinkBlock = source.match(
      /<Link[\s\S]{0,400}?href=\{`\/projects\/\$\{project\.id\}`\}[\s\S]{0,200}?className="font-medium/,
    );
    expect(tableLinkBlock).not.toBeNull();
    expect(tableLinkBlock![0]).toMatch(/prefetch=\{false\}/);
  });

  it('モバイル card view の Link (role="listitem") にも prefetch={false} が付与されている', () => {
    const mobileLinkBlock = source.match(
      /<Link[\s\S]{0,400}?href=\{`\/projects\/\$\{project\.id\}`\}[\s\S]{0,300}?role="listitem"/,
    );
    expect(mobileLinkBlock).not.toBeNull();
    expect(mobileLinkBlock![0]).toMatch(/prefetch=\{false\}/);
  });
});
