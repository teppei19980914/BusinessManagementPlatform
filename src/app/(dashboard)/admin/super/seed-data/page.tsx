/**
 * /admin/super/seed-data (feat/starter-data-import / 2026-06-05)
 *
 * super_admin 向け「スターターデータ キュレーション」画面。
 * スターターデータの取込元 = 管理テナント (MANAGEMENT_TENANT_ID) の Project / Knowledge を一覧し、
 * `isSampleData` (= 各テナントの取込対象に含めるか) を画面から付け外しする。
 *
 * 認可: layout.tsx (super_admin guard) で担保。本ページ自体は再チェック不要。
 * データ取得: server component で service 直接読み (= SSR で完結)。切替は client から PATCH。
 */

import { listManagementSeedCandidates } from '@/services/sample-curation.service';
import { SeedDataCurationClient } from './seed-data-client';

export const dynamic = 'force-dynamic';

export default async function SeedDataCurationPage() {
  const candidates = await listManagementSeedCandidates();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">スターターデータ キュレーション</h1>
      <p className="text-sm text-muted-foreground">
        各テナントが「スターターデータ取込」で複製する見本データ (管理テナントの Project / Knowledge) を管理します。
        既存サンプルの<strong>内容は通常の編集画面から編集</strong>でき、ここでは
        <strong>どれをサンプル (取込対象) にするか</strong>を切替えます。
        課題/リスク・振り返りはサンプルプロジェクト配下に作成すると自動的に取込対象になります。
      </p>
      <SeedDataCurationClient initialCandidates={candidates} />
    </div>
  );
}
