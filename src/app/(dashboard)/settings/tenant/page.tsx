/**
 * /settings/tenant - テナント管理者プラン変更画面 (PR-X4 / 2026-05-07)
 *
 * 認可: テナント管理者 (admin) のみ。
 *   super_admin / general はリダイレクト。
 *
 * 表示内容:
 *   - 現在のプラン
 *   - プラン変更フォーム (アップグレード即時 / ダウングレード翌月予約)
 *   - 月次予算上限設定
 *   - 当月使用量の概要
 *   - 予約済プラン変更の表示 + キャンセルボタン
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { getTenantSelfInfo } from '@/services/tenant-self.service';
import { TenantSettingsClient } from './tenant-settings-client';

export default async function TenantSettingsPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  // PR-X1 (2026-05-07): テナント管理者 (admin) のみアクセス可。
  // super_admin は管理テナント所属で本画面の対象外、general は権限なし。
  if (!isTenantAdmin(session.user)) redirect('/settings');

  const info = await getTenantSelfInfo(session.user.tenantId);
  if (!info) redirect('/settings');

  return <TenantSettingsClient initialInfo={info} />;
}
