/**
 * 外部データ移行ウィザード (Phase 1 / 2026-05-08)
 *
 * テナント管理者が外部システム (社内 wiki / Excel / 旧 PM ツール等) からの初回データ移行を
 * 4 ステップで完了させるウィザード画面。
 *
 * 認可:
 *   admin role 必須 (= /settings/tenant 系の認可と整合)
 *
 * フロー:
 *   1. ファイル選択 + エンティティ選択 + (RiskIssue の) デフォルトプロジェクト
 *   2. カラムマッピング (CSV 列 → 本サービスフィールド)
 *   3. dry-run プレビュー (件数 + エラー + コスト見積)
 *   4. 取込結果
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { prisma } from '@/lib/db';
import { ExternalImportWizard } from './wizard-client';

export const dynamic = 'force-dynamic';

export default async function ExternalImportPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);
  if (!isTenantAdmin(session.user)) redirect('/settings');

  // ウィザード Step 1 で「全行を 1 プロジェクトに所属させる」UI 用のテナント内プロジェクト一覧
  const projects = await prisma.project.findMany({
    where: { tenantId: session.user.tenantId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { createdAt: 'desc' },
  });

  return <ExternalImportWizard projects={projects} />;
}
