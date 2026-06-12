/**
 * 外部移行インポート — テナント向け 2 段階フロー (ADR-0034)
 *
 *   previewMigration: NormalizedBatch を検証してプレビュー保存 (TTL 24h)。DB 書き込みなし。
 *   applyMigration   : previewId から検証済データを取り出し DB へ取込。完了後 preview を即削除
 *                      (二度押し冪等。2 回目は PREVIEW_NOT_FOUND)。
 *
 * 認可境界: 呼出側 (route) で admin + 自テナントを確認済の前提。本サービスは自分が作成した
 * preview のみ apply 可 (createdByUserId 照合)。
 *
 * 既存 external-data-import (Knowledge/Risk 専用) の 2 段階フローと同じ tenantImportPreview を
 * 流用しつつ、本サービスは 6 エンティティ + 依存解決の NormalizedBatch を扱う (ADR-0034)。
 */

import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import { parseCsvText } from '../task.service';
import {
  buildImportPreview,
  checkLinkWarnings,
  normalizeName,
  type ImportPreview,
  type ExistingDataIndex,
} from './batch-preview';
import { applyImportBatch, type ApplyImportResult } from './batch-apply.service';
import { buildBatchFromCsv, type CsvEntitySource, type CsvRow } from './csv-to-batch';
import type { NormalizedBatch, ImportEntityKind } from './normalized-batch';

const PREVIEW_TTL_HOURS = 24;
/** 1 回の取り込み上限 (全エンティティ合計)。external-data-import と同値。 */
const MAX_TOTAL_ROWS = 5000;

/**
 * 親解決 (顧客/プロジェクト) のための既存テナントデータ索引を DB から構築する。
 *   - 顧客: 物理削除のみ (deletedAt 列なし) → 全件対象
 *   - プロジェクト: 論理削除・サンプルは一覧非表示のため除外 (= ユーザが見える案件のみ)
 * 同名が複数ある場合は先勝ち (名前重複は許容仕様。ID は一意)。
 */
async function buildExistingIndex(tenantId: string): Promise<ExistingDataIndex> {
  const [custs, projs] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    prisma.project.findMany({
      where: { tenantId, deletedAt: null, isSampleData: false },
      select: { id: true, name: true },
    }),
  ]);
  const customers = new Map<string, string>();
  for (const c of custs) {
    const k = normalizeName(c.name);
    if (!customers.has(k)) customers.set(k, c.id);
  }
  const projects = new Map<string, string>();
  for (const p of projs) {
    const k = normalizeName(p.name);
    if (!projects.has(k)) projects.set(k, p.id);
  }
  return { customers, projects };
}

function totalRowCount(preview: ImportPreview): number {
  const s = preview.summary;
  return s.customers + s.projects + s.wbs + s.risks + s.knowledge + s.retrospectives;
}

export type PreviewMigrationResult =
  | { ok: true; previewId: string; preview: ImportPreview; expiresAt: string }
  | { ok: false; error: 'EMPTY' | 'TOO_MANY_ROWS'; message: string };

export async function previewMigration(params: {
  tenantId: string;
  userId: string;
  batch: NormalizedBatch;
}): Promise<PreviewMigrationResult> {
  const existing = await buildExistingIndex(params.tenantId);
  const preview = buildImportPreview(params.batch, existing);
  const total = totalRowCount(preview);

  // 取り込める件数が 0 でも「エラーがある」ならプレビューを返してエラーを画面表示する
  // (例: 全行レベル不正 → 0 件だが、原因のエラーを隠さない)。真に空のときだけ EMPTY。
  if (total === 0 && preview.errors.length === 0) {
    return {
      ok: false,
      error: 'EMPTY',
      message:
        '取り込めるデータ（行）が1件もありませんでした。CSVのヘッダ行の下にデータ行が入っているか、'
        + 'マッピング画面で各項目に「CSV列」が正しく割り当てられているか（名称など必須項目が空でないか）を確認してください。',
    };
  }
  if (total > MAX_TOTAL_ROWS) {
    return {
      ok: false,
      error: 'TOO_MANY_ROWS',
      message: `1 回の取り込み上限 (${MAX_TOTAL_ROWS} 件) を超えています。分割してください。`,
    };
  }

  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_HOURS * 60 * 60 * 1000);

  await prisma.tenantImportPreview.create({
    data: {
      id: previewId,
      tenantId: params.tenantId,
      createdByUserId: params.userId,
      parsedJson: preview as unknown as Prisma.InputJsonValue,
      // 取り込みは既定 visibility='draft' で embedding 対象外のため課金なし。互換のため空オブジェクト。
      costEstimate: {} as Prisma.InputJsonValue,
      summary: preview.summary as unknown as Prisma.InputJsonValue,
      expiresAt,
    },
  });

  return { ok: true, previewId, preview, expiresAt: expiresAt.toISOString() };
}

/** 手動CSV経路の入力 (1 エンティティ = 1 CSV テキスト + マッピング)。 */
export interface CsvSourceInput {
  entity: ImportEntityKind;
  csvText: string;
  columnMap: Record<string, string>;
  fixedMap?: Record<string, string>;
  /** 取り込み元 CSV のファイル名 (エラーメッセージ用)。 */
  fileName?: string;
}

/** CSV テキストをヘッダ付きの行オブジェクト配列に変換 (ロバストな既存パーサを流用)。 */
function csvTextToRows(csvText: string): CsvRow[] {
  const records = parseCsvText(csvText);
  if (records.length < 2) return [];
  const headers = records[0].map((h) => h.trim());
  return records.slice(1).map((rec) => {
    const obj: CsvRow = {};
    headers.forEach((h, i) => {
      obj[h] = rec[i] ?? '';
    });
    return obj;
  });
}

/**
 * 手動CSV経路のプレビュー。CSV テキスト + マッピングをサーバ側でパース・正規化してプレビューする。
 */
export async function previewMigrationFromCsv(params: {
  tenantId: string;
  userId: string;
  sources: CsvSourceInput[];
}): Promise<PreviewMigrationResult> {
  const csvSources: CsvEntitySource[] = params.sources.map((s) => ({
    entity: s.entity,
    rows: csvTextToRows(s.csvText),
    columnMap: s.columnMap,
    fixedMap: s.fixedMap,
    fileName: s.fileName,
  }));
  const batch = buildBatchFromCsv(csvSources);
  return previewMigration({ tenantId: params.tenantId, userId: params.userId, batch });
}

/**
 * API連携経路のプレビュー (ADR-0034)。
 * コネクタがサービスから取得・正規化した CsvEntitySource[] (フラット行 + 列マッピング) を、
 * 手動CSV経路と**同じ** buildBatchFromCsv → previewMigration に流す。
 * これにより検証・値解決・WBS階層・依存解決・上限/エラー処理が CSV 経路と完全に一致する
 * (= 経路ごとの挙動ドリフトが起きない)。コネクタ側で取得した認証情報はこの呼出より前に破棄済み。
 */
export async function previewMigrationFromSources(params: {
  tenantId: string;
  userId: string;
  sources: CsvEntitySource[];
  /** コネクタ段階で出た警告 (WBS 孤児/循環・日付変換・relation 切り捨て等)。プレビュー警告に合流。 */
  warnings?: string[];
}): Promise<PreviewMigrationResult> {
  const batch = buildBatchFromCsv(params.sources);
  if (params.warnings && params.warnings.length > 0) {
    batch.warnings.push(...params.warnings);
  }
  return previewMigration({ tenantId: params.tenantId, userId: params.userId, batch });
}

/**
 * CSV選択段階の軽量リンクチェック (DB 書き込みなし)。
 * プロジェクトの顧客 / WBS のプロジェクトが「既存データ + 取り込み CSV」で解決できるかを確認し、
 * 未解決を **警告** で返す (マッピング画面の既定値で補える前提。プレビューでは同条件がエラー)。
 */
export async function checkMigrationCsvLinks(params: {
  tenantId: string;
  sources: CsvSourceInput[];
}): Promise<{ warnings: string[] }> {
  const csvSources: CsvEntitySource[] = params.sources.map((s) => ({
    entity: s.entity,
    rows: csvTextToRows(s.csvText),
    columnMap: s.columnMap,
    fixedMap: s.fixedMap,
    fileName: s.fileName,
  }));
  const batch = buildBatchFromCsv(csvSources);
  const existing = await buildExistingIndex(params.tenantId);
  return { warnings: checkLinkWarnings(batch, existing) };
}

export type ApplyMigrationResult =
  | { ok: true; result: ApplyImportResult }
  | {
      ok: false;
      error: 'PREVIEW_NOT_FOUND' | 'PREVIEW_EXPIRED' | 'PREVIEW_NOT_OWNED' | 'HAS_ERRORS';
      message: string;
    };

export async function applyMigration(params: {
  tenantId: string;
  userId: string;
  previewId: string;
}): Promise<ApplyMigrationResult> {
  // previewId は UUID だが、越境防止のためクエリの where に tenantId を直付与して境界を強制する
  // (取得後の row.tenantId 照合という post-hoc 検証に依存しない。他テナントの previewId 盗用は
  //  そもそも 0 件 = NOT_FOUND に丸まる)。
  const row = await prisma.tenantImportPreview.findFirst({
    where: { id: params.previewId, tenantId: params.tenantId },
  });
  if (!row) {
    return { ok: false, error: 'PREVIEW_NOT_FOUND', message: 'プレビューが見つかりません' };
  }
  if (row.createdByUserId !== params.userId) {
    return {
      ok: false,
      error: 'PREVIEW_NOT_OWNED',
      message: 'このプレビューは別の管理者が作成したため実行できません。再度プレビューしてください。',
    };
  }
  if (row.expiresAt < new Date()) {
    return {
      ok: false,
      error: 'PREVIEW_EXPIRED',
      message: 'プレビューの有効期限 (24 時間) を過ぎました。再度プレビューしてください。',
    };
  }

  const preview = row.parsedJson as unknown as ImportPreview;
  if (preview.errors && preview.errors.length > 0) {
    return {
      ok: false,
      error: 'HAS_ERRORS',
      message: 'エラーが残っています。修正してから取り込んでください。',
    };
  }

  const result = await applyImportBatch({
    tenantId: params.tenantId,
    userId: params.userId,
    resolved: preview.resolved,
  });

  // 完了 = もう使わないため即削除 (二度押し冪等。2 回目は NOT_FOUND)
  await prisma.tenantImportPreview.delete({ where: { id: params.previewId } });

  return { ok: true, result };
}
