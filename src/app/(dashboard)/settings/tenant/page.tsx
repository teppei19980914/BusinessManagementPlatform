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
import { updateStorageBytesUsedForTenant } from '@/services/tenant-storage.service';
// ADR-0020 (2026-05-25): DB 容量従量課金セクション (R12)
import { DbCapacitySection } from './db-capacity-section';
// ADR-0021 (2026-05-26): ファイルストレージ従量課金セクション
import { FileStorageSection } from './file-storage-section';
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
// PR #425 (2026-05-22): Stripe 登録カード情報を画面表示 (テナント管理者が請求カードを視認するため)
import { getStripeCardSummary } from '@/services/stripe-billing.service';
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
  let apiReconcile: ApiUsageReconcileResult | null = null;
  let degradedMode: DegradedModeState | null = null;
  // PR #425 (2026-05-22): Stripe 登録カード情報 (brand/last4/exp) を画面表示するため取得。
  //   Stripe API 失敗 / カード未登録なら null (= UI 側でフォールバック表示)。
  //   isStripeEnabled が false なら呼出しない (Stripe 環境変数なしのローカル想定)。
  let cardSummary: Awaited<ReturnType<typeof getStripeCardSummary>> = null;
  let dataLoadError = false;
  try {
    // 2026-05-14: getStorageInfo (キャッシュ値) を読む前に最新値で書き戻す。
    //   失敗は info の取得を妨げないよう Promise.allSettled で吸収。
    //   reconcileTenantApiUsage は ApiCallLog からの整合性検証用。
    // fix/list-export-import-bugs (2026-05-26): ストレージプラン廃止に伴い getStorageInfo 削除。
    //   ストレージ使用量は DbCapacitySection / FileStorageSection (server component) が独立に取得する。
    //
    // perf/comprehensive-perf-2026-06-01 (G-2): SSR 並列化。
    //   旧実装は info → apiReconcile → degradedMode → cardSummary を逐次 await していたため
    //   4 つの DB / Stripe API round-trip がそのまま積み上がっていた (本番計測 6.26s)。
    //   write (updateStorageBytesUsedForTenant) は read より先に完了させる必要があるので
    //   先頭の Promise.allSettled は据え置き、その後の read 系を Promise.all で並列化する。
    //
    //   ★★★ 請求 invariant 不変宣言 ★★★
    //     - ApiCallLog SUM = 画面表示 = 請求金額 の真値経路は変更しない
    //     - reconcileTenantApiUsage の集計ロジック自体は不変 (並列化は呼出位置のみ)
    //     - getTenantSelfInfo の select 範囲も不変 (本 PR でフィールド射影縮小は行わない)
    //     - drift 検知 4 軸 (cost / count / display / audit) を破壊しないことを確認
    //
    //   失敗時の挙動:
    //     - getTenantSelfInfo の throw は Promise.all reject → 外側 catch → dataLoadError=true (= fallback UI)
    //     - その他 3 つ (apiReconcile / degradedMode / cardSummary) は .catch(() => null) 済み
    //     - isStripeEnabled() == false 時は Promise.resolve(null) で参加させ、条件分岐を保つ
    await Promise.allSettled([
      updateStorageBytesUsedForTenant(session.user.tenantId),
    ]);
    [info, apiReconcile, degradedMode, cardSummary] = await Promise.all([
      getTenantSelfInfo(session.user.tenantId),
      reconcileTenantApiUsage(session.user.tenantId).catch(() => null),
      // Q5(3) (2026-05-14): 縮退モード状態 + embedding 未生成件数 (失敗は許容)
      getDegradedModeState(session.user.tenantId).catch(() => null),
      // PR #425 (2026-05-22): Stripe 登録カード取得 (API 失敗時は null、表示しないだけで画面は維持)
      isStripeEnabled()
        ? getStripeCardSummary(session.user.tenantId).catch(() => null)
        : Promise.resolve(null),
    ]);
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

  // fix/list-export-import-bugs (2026-05-26): DbCapacitySection / FileStorageSection は
  //   async server component。client component の TenantSettingsClient 内で直接使えないため、
  //   ここで render し ReactNode として prop で渡す (使用量タブ内に配置)。
  //   ストレージプラン (storage_addon_plan) は ADR-0020/0021 で従量課金化されたため廃止。
  return (
    <TenantSettingsClient
      initialInfo={info}
      apiReconcile={apiReconcile}
      degradedMode={degradedMode}
      stripeEnabled={isStripeEnabled()}
      cardSummary={cardSummary}
      dbCapacitySection={<DbCapacitySection tenantId={session.user.tenantId} />}
      fileStorageSection={<FileStorageSection tenantId={session.user.tenantId} />}
    />
  );
}
