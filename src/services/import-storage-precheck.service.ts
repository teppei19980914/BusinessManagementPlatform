/**
 * インポート時の DB 容量事前判定サービス (4 巡目フルスキャン / 2026-05-28)
 *
 * 役割:
 *   3 経路すべての CSV インポート (external-import / sync-import / ZIP import) で、
 *   取込前に「現在の DB 使用量 + 取込予測増分」を計算し、プラン別の判定結果を返す:
 *
 *   - **Beginner プラン**: 50MB 無料枠超過なら **取込ブロック** (apply 拒否、preview で警告表示)
 *   - **Expert / Pro プラン**: L1 (1GB) / L2 (10GB) 到達なら **警告表示** (取込は継続可)
 *   - **全プラン共通**: L3 (50GB) ハードキャップは `assertStorageLimitInTx` (post-check) で enforce
 *
 * 設計判断:
 *   - 行数 × 平均バイト数 で「ざっくり推定」する。完璧な精度は不要 (post-check が真の防衛線)
 *   - エンティティ別の平均サイズは [`AVG_BYTES_PER_ROW`](#) で集約 (Knowledge=3KB / RiskIssue=2KB 等)
 *   - Voyage embedding ベクトル (768 dim × 4 byte = 3KB) も含めて計算 (visibility=draft はカウントしない)
 *
 * 関連:
 *   - ADR-0020 §2.4 (4 層防御閾値) — L1 / L2 / L3 の値はここから参照
 *   - ADR-0020 §X (Beginner 50MB block) — 本 PR で追記予定
 *   - ADR-0019 (Beginner = 無料試用) との整合: CSV embedding は無料、DB 容量超過時の課金は事前ブロック
 *   - feedback_unjust_billing_risk_cron.md — 「ユーザ起動 vs システム起動」の課金原則
 *   - feedback_tenant_isolation.md — 他テナント影響絶対不許容 (R3)
 */

import { prisma } from '@/lib/db';
import {
  DB_CAPACITY_FREE_TIER_BYTES,
  DB_CAPACITY_L1_USER_WARNING_BYTES,
  DB_CAPACITY_L2_ADMIN_ALERT_BYTES,
  DB_CAPACITY_L3_HARD_CAP_BYTES,
  calculateOverageJpy,
} from '@/config/db-capacity-pricing';

/**
 * 行平均バイト数の推定値 (DB 行 + embedding ベクトルを含む、SI bytes)。
 *
 * 算出根拠:
 *   - DB 行サイズ: title / 各 textarea / tags / metadata / index / WAL overhead を含む
 *     ローカル `pg_column_size` 平均で実測 (2026-05-28 ベース)
 *   - Embedding ベクトル: Voyage voyage-3 = 1024 dim × 4 byte = 4096 byte ≈ 4 KB
 *     visibility=draft の行は embedding 生成しないため別計算が必要だが、ここでは
 *     「上限警告のための保守的見積もり」として全行 embedding 込みで計算する。
 *
 * 値の更新タイミング:
 *   pg_database_size / 実測サンプリングと乖離が `DB_DRIFT_WARNING_RATIO` を超えたら見直し。
 */
export const AVG_BYTES_PER_IMPORTED_ROW = {
  /** Knowledge: title + background + content + result + tags 3 種 + embedding (= ~7KB) */
  knowledge: 7 * 1024,
  /** RiskIssue: title + content + cause + responsePolicy + embedding (= ~6KB) */
  risksIssues: 6 * 1024,
  /** Retrospective: KPT 4 セクション + embedding (= ~8KB) */
  retrospective: 8 * 1024,
  /** Memo: title + content + embedding (= ~5KB、user-scoped) */
  memo: 5 * 1024,
  /** Task (WBS): name + 期間 + 工数 + 階層 metadata、embedding なし (= ~1KB) */
  task: 1 * 1024,
} as const;

/** インポート対象エンティティ識別子。 */
export type ImportEntityType = keyof typeof AVG_BYTES_PER_IMPORTED_ROW;

/** プラン識別子 (ADR-0019)。 */
export type PlanCode = 'beginner' | 'expert' | 'pro';

/**
 * 警告 / ブロック レベル (4 巡目フルスキャン)。
 *
 * - `none`: 取込後も 50MB 無料枠内
 * - `beginner-block`: Beginner プランで 50MB 無料枠超過 → apply 拒否
 * - `l1` / `l2`: Expert/Pro で警告レベル到達 (取込は継続可)
 * - `l3-block`: 50GB ハードキャップ予測超過 → apply 拒否 (全プラン共通)
 */
export type ImportStorageLevel =
  | 'none'
  | 'beginner-block'
  | 'l1-warning'
  | 'l2-warning'
  | 'l3-block';

/**
 * `precheckImportStorage()` の戻り値。
 *
 * UI 表示にすべて必要な情報を含む (preview / wizard / dialog いずれでも render 可能)。
 */
export type ImportStoragePrecheckResult = {
  /** 取込前の DB 使用量 (キャッシュ値 = `Tenant.storageBytesUsed`) */
  currentBytes: number;
  /** 取込で増える見込み (= rows × 平均行サイズ) */
  estimatedAddedBytes: number;
  /** 取込後の予測値 (= currentBytes + estimatedAddedBytes) */
  estimatedPostImportBytes: number;
  /** 無料枠 (50MB) */
  freeQuotaBytes: number;
  /** L3 ハードキャップ (50GB) */
  hardCapBytes: number;
  /** 判定レベル */
  level: ImportStorageLevel;
  /** apply をブロックすべきか (= preview 警告のみ vs 拒否) */
  isBlocker: boolean;
  /** ブロック / 警告 コード (UI / api error code 用) */
  code:
    | 'OK'
    | 'BEGINNER_FREE_QUOTA_EXCEEDED'
    | 'L1_WARNING'
    | 'L2_WARNING'
    | 'L3_HARD_CAP_EXCEEDED';
  /** ユーザ向けメッセージ (日本語) */
  message: string;
  /** 取込後に発生し得る当月従量課金 (¥、Expert/Pro 向け表示用) */
  expectedOverageJpy: number;
};

/**
 * 行数 × エンティティ別平均サイズ で取込増分バイト数を見積もる。
 *
 * @example
 * ```ts
 * const added = estimateAddedBytes([
 *   { entity: 'knowledge', rowCount: 50 },
 *   { entity: 'risksIssues', rowCount: 20 },
 * ]); // → 50*7KB + 20*6KB = 470KB
 * ```
 */
export function estimateAddedBytes(
  parts: ReadonlyArray<{ entity: ImportEntityType; rowCount: number }>,
): number {
  return parts.reduce(
    (sum, p) => sum + p.rowCount * AVG_BYTES_PER_IMPORTED_ROW[p.entity],
    0,
  );
}

/**
 * インポート時の DB 容量事前判定。
 *
 * フロー:
 *   1. テナントの現在使用量 (`storageBytesUsed`) を取得
 *   2. 取込後の予測値 = 現在値 + estimatedAddedBytes を計算
 *   3. 予測値を ADR-0020 4 層防御閾値 (50MB / 1GB / 10GB / 50GB) と Beginner プラン仕様で照合
 *   4. ブロック判定 + 警告メッセージ + 予測超過料金を返す
 *
 * 判定マトリクス (ADR-0020 §X / 本 PR で確立):
 *
 *   | 予測使用量 | Beginner | Expert / Pro |
 *   |---|---|---|
 *   | < 50MB | OK | OK |
 *   | 50MB - 1GB | **BLOCK** | OK (¥0 ~ ¥50/月) |
 *   | 1GB - 10GB | **BLOCK** | **L1 warning** (¥50 ~ ¥500/月) |
 *   | 10GB - 50GB | **BLOCK** | **L2 warning** (¥500 ~ ¥2,500/月) |
 *   | ≥ 50GB | **BLOCK** | **BLOCK (L3 hard cap)** |
 *
 * Beginner プランは 50MB 超過の時点で全てブロック (= 無料試用契約の保全)。
 * Expert/Pro は L1/L2 では continue 可、L3 でブロック (= apply での post-check と整合)。
 */
export async function precheckImportStorage(args: {
  tenantId: string;
  plan: PlanCode;
  estimatedAddedBytes: number;
}): Promise<ImportStoragePrecheckResult> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: args.tenantId, deletedAt: null },
    select: { storageBytesUsed: true },
  });
  const currentBytes = tenant ? Number(tenant.storageBytesUsed) : 0;
  const estimatedPostImportBytes = currentBytes + args.estimatedAddedBytes;

  // L3 (50GB) ハードキャップは全プラン共通でブロック
  if (estimatedPostImportBytes >= DB_CAPACITY_L3_HARD_CAP_BYTES) {
    return {
      currentBytes,
      estimatedAddedBytes: args.estimatedAddedBytes,
      estimatedPostImportBytes,
      freeQuotaBytes: DB_CAPACITY_FREE_TIER_BYTES,
      hardCapBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
      level: 'l3-block',
      isBlocker: true,
      code: 'L3_HARD_CAP_EXCEEDED',
      message:
        '取込後の DB 容量予測 (' +
        formatBytes(estimatedPostImportBytes) +
        ') がハードキャップ (50GB) を超えます。' +
        '既存データを削除してから再度お試しください。',
      expectedOverageJpy: 0,
    };
  }

  // Beginner プランは 50MB 無料枠を超えたら一律ブロック (本 PR で確立)
  if (args.plan === 'beginner' && estimatedPostImportBytes > DB_CAPACITY_FREE_TIER_BYTES) {
    return {
      currentBytes,
      estimatedAddedBytes: args.estimatedAddedBytes,
      estimatedPostImportBytes,
      freeQuotaBytes: DB_CAPACITY_FREE_TIER_BYTES,
      hardCapBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
      level: 'beginner-block',
      isBlocker: true,
      code: 'BEGINNER_FREE_QUOTA_EXCEEDED',
      message:
        '取込後の DB 容量予測 (' +
        formatBytes(estimatedPostImportBytes) +
        ') が Beginner プランの無料枠 (50MB) を超えます。' +
        '取込件数を減らすか、Expert / Pro プランへアップグレードしてください。',
      expectedOverageJpy: 0,
    };
  }

  // Expert / Pro: L2 / L1 警告 (取込は継続可、従量課金額を提示)
  const expectedOverageJpy = calculateOverageJpy(BigInt(estimatedPostImportBytes));

  if (estimatedPostImportBytes >= DB_CAPACITY_L2_ADMIN_ALERT_BYTES) {
    return {
      currentBytes,
      estimatedAddedBytes: args.estimatedAddedBytes,
      estimatedPostImportBytes,
      freeQuotaBytes: DB_CAPACITY_FREE_TIER_BYTES,
      hardCapBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
      level: 'l2-warning',
      isBlocker: false,
      code: 'L2_WARNING',
      message:
        '取込後の DB 容量予測 (' +
        formatBytes(estimatedPostImportBytes) +
        ') が L2 閾値 (10GB) を超え、当月従量課金 約 ¥' +
        expectedOverageJpy.toLocaleString() +
        ' が発生する見込みです。続行しますか?',
      expectedOverageJpy,
    };
  }
  if (estimatedPostImportBytes >= DB_CAPACITY_L1_USER_WARNING_BYTES) {
    return {
      currentBytes,
      estimatedAddedBytes: args.estimatedAddedBytes,
      estimatedPostImportBytes,
      freeQuotaBytes: DB_CAPACITY_FREE_TIER_BYTES,
      hardCapBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
      level: 'l1-warning',
      isBlocker: false,
      code: 'L1_WARNING',
      message:
        '取込後の DB 容量予測 (' +
        formatBytes(estimatedPostImportBytes) +
        ') が L1 閾値 (1GB) を超え、当月従量課金 約 ¥' +
        expectedOverageJpy.toLocaleString() +
        ' が発生する見込みです。',
      expectedOverageJpy,
    };
  }
  if (estimatedPostImportBytes > DB_CAPACITY_FREE_TIER_BYTES) {
    // 50MB - 1GB: 警告 level ではないが従量課金は発生
    return {
      currentBytes,
      estimatedAddedBytes: args.estimatedAddedBytes,
      estimatedPostImportBytes,
      freeQuotaBytes: DB_CAPACITY_FREE_TIER_BYTES,
      hardCapBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
      level: 'none',
      isBlocker: false,
      code: 'OK',
      message:
        '取込後の DB 容量予測: ' +
        formatBytes(estimatedPostImportBytes) +
        ' (無料枠 50MB 超過、当月従量課金 約 ¥' +
        expectedOverageJpy.toLocaleString() +
        ' が発生する見込みです)',
      expectedOverageJpy,
    };
  }

  return {
    currentBytes,
    estimatedAddedBytes: args.estimatedAddedBytes,
    estimatedPostImportBytes,
    freeQuotaBytes: DB_CAPACITY_FREE_TIER_BYTES,
    hardCapBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
    level: 'none',
    isBlocker: false,
    code: 'OK',
    message:
      '取込後の DB 容量予測: ' +
      formatBytes(estimatedPostImportBytes) +
      ' (無料枠 50MB 内、追加課金なし)',
    expectedOverageJpy: 0,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(2) + ' GB';
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
  return bytes + ' bytes';
}

/**
 * Route layer から 1 行で呼べる wrapper。
 *
 * 役割:
 *   - tenantId からプランを引き、`precheckImportStorage` を実行
 *   - apply フェーズでは blocker を 403 Response にマッピング
 *   - dry-run フェーズでは precheck を Response に同梱できるよう生データを返す
 *
 * @example
 * ```ts
 * // sync-import route 内
 * const precheck = await runImportStoragePrecheck({
 *   tenantId: user.tenantId,
 *   entity: 'knowledge',
 *   newRowCount: csvRows.filter(r => !r.id).length,
 * });
 * if (precheck.isBlocker) {
 *   return NextResponse.json(precheck.errorBody, { status: 403 });
 * }
 * // dry-run: include precheck in response
 * // apply: proceed with applyXxxSyncImport
 * ```
 */
export async function runImportStoragePrecheck(args: {
  tenantId: string;
  entity: ImportEntityType;
  newRowCount: number;
  /** 外部から bytes 直接指定したい場合 (ZIP import 等)。指定時は entity / newRowCount は無視 */
  estimatedAddedBytesOverride?: number;
}): Promise<{
  /** 計算結果 (UI に同梱可能) */
  precheck: ImportStoragePrecheckResult | null;
  /** ブロック判定 */
  isBlocker: boolean;
  /** ブロック時の API error body (= 403 Response の body にそのまま使える) */
  errorBody: { error: { code: string; message: string } } | null;
}> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: args.tenantId, deletedAt: null },
    select: { plan: true },
  });
  if (!tenant) {
    // テナント不在は他層で 401/404 になっているはず。defensive にスキップ。
    return { precheck: null, isBlocker: false, errorBody: null };
  }
  const planCode = (['beginner', 'expert', 'pro'] as const).includes(
    tenant.plan as PlanCode,
  )
    ? (tenant.plan as PlanCode)
    : 'beginner'; // 不明 plan は最も厳しい Beginner で fall-back (= 誤って課金されるリスクを最小化)
  const estimatedAddedBytes =
    args.estimatedAddedBytesOverride ??
    estimateAddedBytes([{ entity: args.entity, rowCount: args.newRowCount }]);
  const precheck = await precheckImportStorage({
    tenantId: args.tenantId,
    plan: planCode,
    estimatedAddedBytes,
  });
  return {
    precheck,
    isBlocker: precheck.isBlocker,
    errorBody: precheck.isBlocker
      ? { error: { code: precheck.code, message: precheck.message } }
      : null,
  };
}
