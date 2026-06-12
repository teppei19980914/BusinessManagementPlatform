/**
 * 外部データ API 連携インポート ウィザード (ADR-0034 / ② API 連携)
 *
 * テナント管理者が Notion / Backlog / kintone / Pleasanter / Google スプレッドシート から
 * API で直接つないでデータを移行する画面。手動CSV (migration-import) と取り込み基盤を共有する。
 *
 * 認可: admin role 必須 (= /settings/tenant 系と整合)。
 * 認証情報 (トークン) はサーバに保存しない。各ステップでユーザが入力し、取得処理直後に破棄する。
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { ApiImportWizard } from './api-import-wizard-client';

export const dynamic = 'force-dynamic';

export default async function ApiImportPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);
  if (!isTenantAdmin(session.user)) redirect('/settings');

  return <ApiImportWizard />;
}
