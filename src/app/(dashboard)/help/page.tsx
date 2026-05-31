import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { prisma } from '@/lib/db';
import type { ViewerRoles } from '@/config/faq-content';
import { HelpClient } from './help-client';

/**
 * ヘルプ・FAQ 画面 (PR I / 2026-05-09 / #2).
 *
 * 目的:
 *   「使い方ガイド」(/guide) を読んだ後でも残る「個別の困りごと」を解消する。
 *   一般 FAQ + テナント管理者専用の生成 AI 説明セクション (条件表示) で構成。
 *
 * 設計判断:
 *   - 「テナント管理者向け」セクションは admin / super_admin のみ表示
 *     (一般メンバーには課金や AI モデル詳細は不要なノイズ)
 *   - 各 FAQ は accordion (<details>) で「初期は閉じる」+「クリック展開」で目線移動を最小化
 *   - 関連リンクは Q ごとに付与し、ガイド本体や設定画面に1 クリックで戻れる
 */
export default async function HelpPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  const role = session.user.systemRole;
  const isTenantAdmin = role === 'admin' || role === 'super_admin';

  // G1-c (2026-05-31): FAQ アコーディオンの開示 4 段フィルタ用に viewer ロールを構築する。
  //   help/chat route と同じく ProjectMember から PM/PL・member 以上を解決
  //   (削除済プロジェクト / 他テナントは除外)。これにより /help でも owl と同じ
  //   getFaqEntriesForRole / canViewerSee で権限に応じた FAQ を出し分けできる。
  const memberships = await prisma.projectMember.findMany({
    where: {
      userId: session.user.id,
      project: { deletedAt: null, tenantId: session.user.tenantId },
    },
    select: { projectRole: true },
  });
  const roleSet = new Set(memberships.map((m) => m.projectRole));
  const viewer: ViewerRoles = {
    isTenantAdmin,
    hasAnyProjectPmRole: roleSet.has('pm_tl'),
    hasAnyProjectMembership: roleSet.has('pm_tl') || roleSet.has('member'),
  };

  return <HelpClient isTenantAdmin={isTenantAdmin} viewer={viewer} />;
}
