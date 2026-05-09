import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
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

  return <HelpClient isTenantAdmin={isTenantAdmin} />;
}
