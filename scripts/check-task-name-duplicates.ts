/**
 * 2026-05-25: tasks テーブル内で同一 (project_id, parent_task_id, name) を持つ
 *   アクティブ (deleted_at IS NULL) タスクを検出する read-only スクリプト。
 *
 * 用途:
 *   migration `20260525_tasks_unique_parent_name` を本番適用する前の事前チェック。
 *   重複がある場合は app 層 (タスク編集 UI) で名称変更 or 親変更して解消する。
 *
 * 実行: pnpm tsx scripts/check-task-name-duplicates.ts
 */

import { prisma } from '../src/lib/db';

type DuplicateGroup = {
  projectId: string;
  parentTaskId: string | null;
  name: string;
  count: bigint;
  ids: string[];
};

async function main(): Promise<void> {
  console.log('[check-task-name-duplicates] 検査開始...');

  // Postgres の生 SQL で集約 (COALESCE で root レベルを区別)
  const rows = await prisma.$queryRaw<DuplicateGroup[]>`
    SELECT
      project_id AS "projectId",
      parent_task_id AS "parentTaskId",
      name,
      COUNT(*) AS count,
      ARRAY_AGG(id::text ORDER BY created_at) AS ids
    FROM tasks
    WHERE deleted_at IS NULL
    GROUP BY project_id, parent_task_id, name
    HAVING COUNT(*) > 1
    ORDER BY project_id, parent_task_id NULLS FIRST, name
  `;

  if (rows.length === 0) {
    console.log('[check-task-name-duplicates] ✅ 重複なし。migration 適用可能です。');
    return;
  }

  console.error(`[check-task-name-duplicates] ❌ 重複が ${rows.length} 組見つかりました:`);
  for (const r of rows) {
    console.error(
      `  project=${r.projectId}, parent=${r.parentTaskId ?? '<root>'}, name="${r.name}", count=${r.count}`,
    );
    console.error(`    ids: ${r.ids.join(', ')}`);
  }
  console.error(
    '\n対応: タスク編集 UI で名称を変更するか、親 WP を変更して解消してください。',
  );
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('[check-task-name-duplicates] 実行エラー:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
