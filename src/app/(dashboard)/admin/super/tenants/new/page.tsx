/**
 * /admin/super/tenants/new (P-G / 2026-05-08)
 *
 * super_admin が新規テナントを手動で払い出す画面。
 * super_admin 認可は親 layout.tsx で実施済の前提。
 */

import { TenantCreateForm } from './tenant-create-form';

export default function SuperAdminTenantNewPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">新規テナント払い出し</h1>
      <p className="text-sm text-muted-foreground">
        顧客企業のテナントを発行します。請求先情報 + 初期管理者のメールアドレスを入力してください。
        作成後、初期管理者宛に検証メールが送信され、リンクからパスワード設定後にログイン可能になります。
      </p>
      <TenantCreateForm />
    </div>
  );
}
