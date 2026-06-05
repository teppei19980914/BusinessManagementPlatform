/**
 * 外部データ移行インポート (ADR-0034) — テナント管理者向け
 *
 * 他PMツール/CSV からの「初回データ移行」を行うウィザード画面。
 *   - 新規作成のみ (重複確認なし)。更新は各「○○一覧」から。
 *   - 対象6エンティティ: 顧客 / プロジェクト / WBS / リスク・課題 / ナレッジ / 振り返り。
 *
 * 認可: admin role 必須 (/settings/tenant 系と整合)。
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { MigrationWizardClient } from './migration-wizard-client';

export const dynamic = 'force-dynamic';

export default async function MigrationImportPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);
  if (!isTenantAdmin(session.user)) redirect('/settings');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">外部データ移行</h1>
        <p className="text-sm text-gray-600">
          この機能は他サービスで蓄積したナレッジなどを本テナントに一括インポートするための機能です。したがって、提供機能としては<strong>データの一括作成のみ</strong>であり、既存データの一括更新はサポートしていません。なお、一括更新はプロジェクト詳細画面の「○○一覧」から行ってください。
        </p>
      </header>

      <div className="rounded border-l-4 border-info bg-info/5 p-4 text-sm">
        <p className="mb-2 font-semibold">取り込みの手順（はじめての方向け）</p>
        <ol className="ml-4 list-decimal space-y-1.5 text-xs">
          <li>後述の「テンプレCSVをダウンロード（任意）」から該当のボタンをクリックし、CSVテンプレートをダウンロードします。</li>
          <li>ダウンロードした CSV を開き、該当する列に値を入力していきます。</li>
          <li>「次へ：マッピング」をクリックし、マッピング画面でたすきばの項目名と CSV 列の紐づけを行います。</li>
          <li>「次へ：プレビューを確認」をクリックし、取り込まれる件数やエラーの有無を確認します。</li>
          <li>取り込まれる件数が一致し、エラーが表示されていないことを確認し、「この内容で取り込む」をクリックします。</li>
        </ol>
      </div>

      <MigrationWizardClient />
    </div>
  );
}
