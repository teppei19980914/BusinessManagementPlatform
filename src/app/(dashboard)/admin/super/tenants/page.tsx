/**
 * /admin/super/tenants (PR-X2 / 2026-05-07)
 *
 * 全テナント一覧。tenantSeq 昇順で表示。各行から詳細画面に遷移可能。
 */

import Link from 'next/link';
import { listAllTenants } from '@/services/super-admin.service';

export default async function SuperAdminTenantsListPage() {
  const tenants = await listAllTenants();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">全テナント一覧</h1>
        {/* P-G (2026-05-08): 新規テナント払い出し導線 */}
        <Link
          href="/admin/super/tenants/new"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          + 新規テナント払い出し
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        管理テナント (運営内部) は表示しません。tenantSeq 昇順で表示。
      </p>

      {tenants.length === 0 ? (
        <p className="rounded border p-8 text-center text-muted-foreground">
          顧客テナントはまだ登録されていません。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">#</th>
                <th className="p-2">テナント名</th>
                <th className="p-2">プラン</th>
                <th className="p-2 text-right">今月 API 呼出</th>
                <th className="p-2 text-right">今月 API 費用</th>
                <th className="p-2 text-right">ユーザ数</th>
                <th className="p-2">作成日</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-b hover:bg-muted/30">
                  <td className="p-2">{t.tenantSeq ?? '-'}</td>
                  <td className="p-2">
                    <Link href={`/admin/super/tenants/${t.id}`} className="text-info hover:underline">
                      {t.name}
                    </Link>
                  </td>
                  <td className="p-2 capitalize">{t.plan}</td>
                  <td className="p-2 text-right">{t.currentMonthApiCallCount.toLocaleString()}</td>
                  <td className="p-2 text-right">¥{t.currentMonthApiCostJpy.toLocaleString()}</td>
                  <td className="p-2 text-right">{t.activeUserCount}</td>
                  <td className="p-2">{t.createdAt.toISOString().split('T')[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
