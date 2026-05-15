/**
 * /settings/tenant - テナント管理者プラン変更画面 (PR-X4 / 2026-05-07)
 *
 * 認可: テナント管理者 (admin) のみ。
 *   super_admin / general はリダイレクト。
 *
 * 表示内容:
 *   - 現在のプラン
 *   - プラン変更フォーム (Expert↔Pro 即時反映 / Beginner ダウングレード完全禁止、2026-05-14)
 *   - 月次予算上限設定
 *   - 当月使用量の概要
 *   - 予約済プラン変更の表示 + キャンセルボタン (legacy DB レコード対策の defensive UI)
 */

import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { LOGIN_ROUTE } from '@/config';
import { isTenantAdmin } from '@/lib/permissions';
import { getTenantSelfInfo } from '@/services/tenant-self.service';
import {
  getStorageInfo,
  updateStorageBytesUsedForTenant,
} from '@/services/tenant-storage.service';
import {
  reconcileTenantApiUsage,
  type ApiUsageReconcileResult,
} from '@/services/api-usage-recalc.service';
import { recordError } from '@/services/error-log.service';
// Q5(3) (2026-05-14): 縮退モード状態 + embedding 未生成件数 UI 可視化
import {
  getDegradedModeState,
  type DegradedModeState,
} from '@/services/degraded-mode.service';
// PR-S5 (2026-05-14): Stripe feature flag を Client Component に伝達
import { isStripeEnabled } from '@/lib/stripe';
import { TenantSettingsClient } from './tenant-settings-client';

export default async function TenantSettingsPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_ROUTE);

  // PR-X1 (2026-05-07): テナント管理者 (admin) のみアクセス可。
  // super_admin は管理テナント所属で本画面の対象外、general は権限なし。
  if (!isTenantAdmin(session.user)) redirect('/settings');

  // fix/admin-users-defensive-render 横展開 (2026-05-15): テナント管理者がよく見る画面
  //   のため、getTenantSelfInfo / getStorageInfo の throw が dashboard error.tsx に
  //   飛んで「ログインできない」体験を引き起こさないよう、try/catch で囲い、失敗時は
  //   インライン error UI + /settings リンクで操作可能 UI を維持する。
  //   詳細は admin/users/page.tsx 参照。
  //   TenantSettingsClient は initialInfo (non-null) に強く依存するため、admin/users
  //   のような「フォールバック値で描画継続」ではなく、project-detail と同様に
  //   インライン error 画面を直接描画する形を採る。
  let info: Awaited<ReturnType<typeof getTenantSelfInfo>> = null;
  let storageInfo: Awaited<ReturnType<typeof getStorageInfo>> = null;
  let apiReconcile: ApiUsageReconcileResult | null = null;
  let degradedMode: DegradedModeState | null = null;
  let dataLoadError = false;
  try {
    // 2026-05-14: getStorageInfo (キャッシュ値) を読む前に最新値で書き戻す。
    //   失敗は info / storageInfo の取得を妨げないよう Promise.allSettled で吸収。
    //   reconcileTenantApiUsage は ApiCallLog からの整合性検証用。
    await Promise.allSettled([
      updateStorageBytesUsedForTenant(session.user.tenantId),
    ]);
    info = await getTenantSelfInfo(session.user.tenantId);
    // Storage add-on (Phase 2 / 2026-05-08): Storage プラン選択セクション初期値
    storageInfo = await getStorageInfo(session.user.tenantId);
    apiReconcile = await reconcileTenantApiUsage(session.user.tenantId).catch(() => null);
    // Q5(3) (2026-05-14): 縮退モード状態 + embedding 未生成件数 (失敗は許容)
    degradedMode = await getDegradedModeState(session.user.tenantId).catch(() => null);
  } catch (error) {
    dataLoadError = true;
    await recordError({
      severity: 'error',
      source: 'server',
      message: '[/settings/tenant] failed to load tenant info or storage info',
      stack: error instanceof Error ? error.stack : String(error),
      userId: session.user.id,
      tenantId: session.user.tenantId,
      context: {
        path: '/settings/tenant',
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        tenantId: session.user.tenantId,
      },
    });
  }

  if (dataLoadError || !info) {
    // dashboard/error.tsx に飛ばすと「ログインできない」体験になるため、ここで
    // 操作可能な fallback UI を直接描画する (/settings へ戻るリンク付き)。
    return (
      <div className="space-y-4">
        <div className="rounded border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="font-semibold">⚠ テナント設定の読み込みに失敗しました</p>
          <p className="mt-1 text-muted-foreground">
            一時的な問題の可能性があります。ページを再読み込みするか、しばらくしてから再試行してください。
            問題が継続する場合は管理者にお問合せください。
          </p>
        </div>
        <Link
          href="/settings"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          設定画面へ戻る
        </Link>
      </div>
    );
  }

  // BigInt + Date を JSON-friendly な形に変換 (Server Component → Client Component の境界)
  const storageInitialInfo = storageInfo
    ? {
        ...storageInfo,
        graceStartedAt: storageInfo.graceStartedAt?.toISOString() ?? null,
        scheduledStorageAddonAt: storageInfo.scheduledStorageAddonAt?.toISOString() ?? null,
        storageBytesUsedAt: storageInfo.storageBytesUsedAt?.toISOString() ?? null,
      }
    : null;

  return (
    <TenantSettingsClient
      initialInfo={info}
      storageInitialInfo={storageInitialInfo}
      apiReconcile={apiReconcile}
      degradedMode={degradedMode}
      stripeEnabled={isStripeEnabled()}
    />
  );
}
