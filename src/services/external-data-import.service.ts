/**
 * 外部データ移行サービス (Phase 1 / 2026-05-08)
 *
 * 役割:
 *   外部システム (社内 wiki / 旧 PM ツール等) から **CSV** でアップロードされたデータを、
 *   自テナントの Knowledge / RiskIssue として一括取り込みする。
 *
 *   Excel (.xlsx) サポート保留の理由:
 *     - 当初 xlsx (SheetJS) を使用予定だったが、HIGH severity 脆弱性 + パッチ未提供のため不採用
 *     - exceljs / @sheet/core 等の代替を検討するが、Phase 1 MVP では CSV のみで提供
 *     - Excel ユーザは Excel → CSV エクスポート で本機能を利用可能 (Excel 標準機能)
 *     - Excel 直接対応は Phase 1.1 として別 PR で対応
 *
 *   P-D (data-import.service) との違い:
 *     - P-D は本サービス自身の P-C エクスポート ZIP を取込 (テナント間移行 / バックアップ復元)
 *     - 本サービスは外部システムからの移行 (新規ユーザの初期データ投入)
 *     - 本サービスはユーザがカラムマッピングを指定する 2 段階フロー (preview → apply)
 *
 * 認可境界:
 *   呼出側で「テナント管理者 (admin) が自テナント」を確認した前提。
 *
 * フロー (2 段階):
 *   1. previewImport(): CSV パース → バリデーション → コスト試算 → DB 保存 (TTL 24h)
 *      - Voyage は呼ばない (= 課金なし、件数 × 単価で見積のみ)
 *      - エラー行は CSV で返却可能な形式で蓄積
 *   2. applyImport(): previewId から検証済データ取り出し → embedding 生成 + 取込
 *      - Voyage 全件即時生成 (= ここで初めて課金)
 *      - Beginner プランは月次上限超過チェック、Expert/Pro は予算上限チェック
 *
 * 対象エンティティ (Phase 1):
 *   - Knowledge (社内ナレッジ)
 *   - RiskIssue (過去課題 / リスク、type=risk と type=issue 両方)
 *   - 対象外: Customer, Project, Member, Memo (= P-D / 招待フロー / 既存 UI でカバー)
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md Phase 1
 *   - API: src/app/api/tenants/me/external-import/preview/route.ts
 *         src/app/api/tenants/me/external-import/apply/route.ts
 *         src/app/api/tenants/me/external-import/template/route.ts
 *   - UI: src/app/(dashboard)/settings/tenant/external-import/*
 */

import { randomUUID } from 'crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { prisma } from '@/lib/db';
// PR #357 (2026-05-14): 旧 generateAndPersistEntityEmbedding (= N 件で N ApiCallLog) を
//   バッチ版 generateAndPersistBatchEmbeddings (= 1 ApiCallLog) に置換してコスト最適化。
import { generateAndPersistBatchEmbeddings } from '@/services/embedding.service';
import type { EmbeddingSearchTable } from '@/services/embedding.service';
import { composeKnowledgeText } from '@/services/knowledge.service';
// PR-3 (2026-05-15): 取込後の容量超過を検知してロールバックする
import {
  assertStorageLimitInTx,
  StorageLimitExceededError,
} from '@/services/storage-guard.service';
import type { Prisma } from '@/generated/prisma/client';

const PREVIEW_TTL_HOURS = 24;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_TOTAL_ROWS = 5000; // Knowledge + RiskIssue 合計

// ================================================================
// 公開型
// ================================================================

export type ExternalImportEntity = 'knowledge' | 'risksIssues';

export type FieldMapping = Record<string, string>; // CSV カラム名 → 本サービスフィールド名 (or 'skip')

export type EntityMapping = {
  entity: ExternalImportEntity;
  /** カラムマッピング (key=CSV列名 / value=フィールド名 or 'skip') */
  fieldMapping: FieldMapping;
  /** RiskIssue で全行を 1 プロジェクトに所属させる場合のプロジェクト ID */
  defaultProjectId?: string;
};

export type PreviewInput = {
  tenantId: string;
  userId: string;
  /** CSV ファイルのバイナリ */
  fileBuffer: Buffer;
  /**
   * mappings は entity ごとに 1 つずつ。CSV は 1 ファイル = 1 entity 扱い
   *   (= Knowledge と RiskIssue を同じ CSV に混在させない)。
   * 複数 entity を取り込む場合は別ファイルで個別アップロードを想定。
   */
  mappings: EntityMapping[];
};

export type PreviewError = {
  entity: ExternalImportEntity;
  row: number; // 1-indexed
  field?: string;
  reason: string;
};

export type CostEstimate = {
  voyageCalls: number;
  plan: 'beginner' | 'expert' | 'pro';
  /** 当インポートで発生する見込課金 (Beginner=0、Expert=¥10×N、Pro=¥30×N) */
  estimatedJpy: number;
  /** 当月既消費 (¥) */
  currentMonthJpy: number;
  /** インポート後の予測当月課金 (¥) */
  projectedMonthJpy: number;
  /** 月次予算上限 (null=無制限) */
  budgetCapJpy: number | null;
  /** Beginner 上限 (= beginnerMonthlyCallLimit) */
  beginnerCallLimit: number | null;
  /** 当月既呼出 */
  currentMonthCallCount: number;
  /** 警告コード (null=問題なし、apply 不可なら apply 拒否) */
  warningCode:
    | null
    | 'BEGINNER_CALL_LIMIT_EXCEEDED'
    | 'BUDGET_CAP_EXCEEDED'
    | 'TOO_MANY_ROWS';
  warningMessage: string | null;
};

export type PreviewResult =
  | {
      ok: true;
      previewId: string;
      summary: {
        knowledge: { totalRows: number; validRows: number; errorRows: number };
        risksIssues: { totalRows: number; validRows: number; errorRows: number };
      };
      errors: PreviewError[];
      costEstimate: CostEstimate;
      expiresAt: string; // ISO
    }
  | {
      ok: false;
      error:
        | 'INVALID_FILE'
        | 'INVALID_FORMAT'
        | 'FILE_TOO_LARGE'
        | 'TOO_MANY_ROWS'
        | 'TENANT_NOT_FOUND'
        | 'UNSUPPORTED_ENTITY';
      message: string;
    };

export type ApplyResult =
  | {
      ok: true;
      summary: {
        knowledgeCreated: number;
        risksIssuesCreated: number;
        embeddingGenerated: number;
        embeddingFailed: number;
        /**
         * PR #358 (2026-05-14): visibility='draft' (公開範囲: 自分のみ) のため
         * embedding 生成・課金対象外とした件数。Knowledge + RiskIssue の合算。
         * PR #357 案D との整合性 (= draft は提案エンジンの検索対象外なので embedding 不要)。
         */
        embeddingSkippedDraft: number;
        totalCostJpy: number;
      };
    }
  | {
      ok: false;
      error:
        | 'PREVIEW_NOT_FOUND'
        | 'PREVIEW_EXPIRED'
        | 'PREVIEW_NOT_OWNED' // 別ユーザの preview を他人が apply しようとした
        | 'BEGINNER_CALL_LIMIT'
        | 'BUDGET_CAP_EXCEEDED'
        // PR-3 (2026-05-15): 取込後の容量が Storage プラン上限超過 → 全件ロールバック
        | 'STORAGE_LIMIT_EXCEEDED';
      message: string;
    };

// ================================================================
// 公開関数: previewImport
// ================================================================

export async function previewImport(input: PreviewInput): Promise<PreviewResult> {
  if (input.fileBuffer.length === 0) {
    return { ok: false, error: 'INVALID_FILE', message: 'ファイルが空です' };
  }
  if (input.fileBuffer.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: 'FILE_TOO_LARGE',
      message: `アップロードサイズが上限 (${MAX_FILE_BYTES / 1024 / 1024} MB) を超えています`,
    };
  }

  // テナント取得
  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
  });
  if (!tenant) {
    return { ok: false, error: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' };
  }

  // CSV パース (UTF-8 BOM 自動除去 + ヘッダ行をオブジェクトキーに使用)
  let rows: Record<string, unknown>[];
  try {
    rows = parseCsv(input.fileBuffer, {
      columns: true, // 1 行目をヘッダとして使う
      skip_empty_lines: true,
      bom: true, // UTF-8 BOM を自動除去
      trim: false, // 各セルの trim はバリデーション側で実施
    }) as Record<string, unknown>[];
  } catch (e) {
    return {
      ok: false,
      error: 'INVALID_FORMAT',
      message: `CSV として読み込めませんでした: ${e instanceof Error ? e.message : '不明なエラー'}`,
    };
  }

  const errors: PreviewError[] = [];
  const validKnowledge: ParsedKnowledge[] = [];
  const validRisksIssues: ParsedRiskIssue[] = [];
  let knowledgeTotalRows = 0;
  let riskIssueTotalRows = 0;

  for (const mapping of input.mappings) {
    if (mapping.entity === 'knowledge') {
      knowledgeTotalRows += rows.length;
      const r = parseKnowledgeRows(rows, mapping.fieldMapping);
      validKnowledge.push(...r.valid);
      errors.push(...r.errors);
    } else if (mapping.entity === 'risksIssues') {
      riskIssueTotalRows += rows.length;
      const r = parseRiskIssueRows(rows, mapping.fieldMapping, mapping.defaultProjectId);
      validRisksIssues.push(...r.valid);
      errors.push(...r.errors);
    } else {
      return {
        ok: false,
        error: 'UNSUPPORTED_ENTITY',
        message: `エンティティ "${String(mapping.entity)}" は対象外です`,
      };
    }
  }

  // 合計行数チェック
  const totalValid = validKnowledge.length + validRisksIssues.length;
  if (totalValid > MAX_TOTAL_ROWS) {
    return {
      ok: false,
      error: 'TOO_MANY_ROWS',
      message: `1 回のインポート上限 (${MAX_TOTAL_ROWS} 行) を超えています。ファイルを分割してください。`,
    };
  }

  // RiskIssue の defaultProjectId 検証 (テナント内に存在するか)
  const projectIds = new Set(validRisksIssues.map((r) => r.projectId).filter(Boolean));
  if (projectIds.size > 0) {
    const validProjects = await prisma.project.findMany({
      where: { id: { in: [...projectIds] }, tenantId: tenant.id, deletedAt: null },
      select: { id: true },
    });
    const validProjectIds = new Set(validProjects.map((p) => p.id));
    // 不一致 projectId を検出してエラーに
    const invalid = validRisksIssues.filter((r) => !validProjectIds.has(r.projectId));
    for (const r of invalid) {
      errors.push({
        entity: 'risksIssues',
        row: r.sourceRow,
        field: 'projectId',
        reason: `指定されたプロジェクト (${r.projectId}) はこのテナントに存在しません`,
      });
    }
    // valid からも除外
    const cleaned = validRisksIssues.filter((r) => validProjectIds.has(r.projectId));
    validRisksIssues.length = 0;
    validRisksIssues.push(...cleaned);
  }

  // コスト試算
  const voyageCalls = validKnowledge.length + validRisksIssues.length;
  const costEstimate = computeCostEstimate({
    plan: tenant.plan as 'beginner' | 'expert' | 'pro',
    voyageCalls,
    currentMonthCallCount: tenant.currentMonthApiCallCount,
    currentMonthCostJpy: tenant.currentMonthApiCostJpy,
    monthlyBudgetCapJpy: tenant.monthlyBudgetCapJpy,
    beginnerCallLimit: tenant.beginnerMonthlyCallLimit,
    pricePerCallHaiku: tenant.pricePerCallHaiku,
    pricePerCallSonnet: tenant.pricePerCallSonnet,
  });

  // preview 保存 (TTL 24h)
  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_HOURS * 60 * 60 * 1000);
  const summary = {
    knowledge: {
      totalRows: knowledgeTotalRows,
      validRows: validKnowledge.length,
      errorRows: errors.filter((e) => e.entity === 'knowledge').length,
    },
    risksIssues: {
      totalRows: riskIssueTotalRows,
      validRows: validRisksIssues.length,
      errorRows: errors.filter((e) => e.entity === 'risksIssues').length,
    },
  };

  await prisma.tenantImportPreview.create({
    data: {
      id: previewId,
      tenantId: tenant.id,
      createdByUserId: input.userId,
      parsedJson: {
        knowledge: validKnowledge,
        risksIssues: validRisksIssues,
      } as Prisma.InputJsonValue,
      costEstimate: costEstimate as unknown as Prisma.InputJsonValue,
      summary: summary as unknown as Prisma.InputJsonValue,
      expiresAt,
    },
  });

  return {
    ok: true,
    previewId,
    summary,
    errors,
    costEstimate,
    expiresAt: expiresAt.toISOString(),
  };
}

// ================================================================
// 公開関数: applyImport
// ================================================================

export async function applyImport(input: {
  tenantId: string;
  userId: string;
  previewId: string;
}): Promise<ApplyResult> {
  // preview 取得
  const preview = await prisma.tenantImportPreview.findUnique({
    where: { id: input.previewId },
  });
  if (!preview) {
    return { ok: false, error: 'PREVIEW_NOT_FOUND', message: 'プレビューが見つかりません' };
  }
  if (preview.tenantId !== input.tenantId) {
    // 他テナントの previewId を盗用してアクセスしようとしたケース → 同じ NOT_FOUND を返す
    return { ok: false, error: 'PREVIEW_NOT_FOUND', message: 'プレビューが見つかりません' };
  }
  if (preview.createdByUserId !== input.userId) {
    return {
      ok: false,
      error: 'PREVIEW_NOT_OWNED',
      message: 'このプレビューは別の管理者が作成したため実行できません。再度プレビューを作成してください。',
    };
  }
  if (preview.expiresAt < new Date()) {
    return {
      ok: false,
      error: 'PREVIEW_EXPIRED',
      message: 'プレビューの有効期限 (24 時間) を過ぎました。再度プレビューを作成してください。',
    };
  }

  // 取得時点のテナント状態を再評価 (preview 時から状況が変わっている可能性)
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { id: input.tenantId, deletedAt: null },
  });
  const parsed = preview.parsedJson as unknown as {
    knowledge: ParsedKnowledge[];
    risksIssues: ParsedRiskIssue[];
  };
  const voyageCalls = parsed.knowledge.length + parsed.risksIssues.length;

  // 二重防御: apply 直前で再度コストチェック
  const reEstimate = computeCostEstimate({
    plan: tenant.plan as 'beginner' | 'expert' | 'pro',
    voyageCalls,
    currentMonthCallCount: tenant.currentMonthApiCallCount,
    currentMonthCostJpy: tenant.currentMonthApiCostJpy,
    monthlyBudgetCapJpy: tenant.monthlyBudgetCapJpy,
    beginnerCallLimit: tenant.beginnerMonthlyCallLimit,
    pricePerCallHaiku: tenant.pricePerCallHaiku,
    pricePerCallSonnet: tenant.pricePerCallSonnet,
  });
  if (reEstimate.warningCode === 'BEGINNER_CALL_LIMIT_EXCEEDED') {
    return {
      ok: false,
      error: 'BEGINNER_CALL_LIMIT',
      message: reEstimate.warningMessage ?? 'Beginner プランの月次上限を超えるためインポートできません',
    };
  }
  if (reEstimate.warningCode === 'BUDGET_CAP_EXCEEDED') {
    return {
      ok: false,
      error: 'BUDGET_CAP_EXCEEDED',
      message: reEstimate.warningMessage ?? '月次予算上限を超えるためインポートできません',
    };
  }

  // ============ トランザクションで取込 (PR-3: ストレージ Post-check + ロールバック) ============
  // embedding 生成は外部 API 呼出を含むため transaction 外で実施 (内側だと長時間 lock)
  // 戦略: transaction 内で全件 INSERT → ストレージ上限チェック → コミット後に embedding を順次生成
  const knowledgeIdMap = new Map<number, string>(); // sourceRow → new id
  const riskIssueIdMap = new Map<number, string>();

  try {
    await prisma.$transaction(
    async (tx) => {
      for (const k of parsed.knowledge) {
        const newId = randomUUID();
        await tx.knowledge.create({
          data: {
            id: newId,
            tenantId: input.tenantId,
            title: k.title,
            knowledgeType: k.knowledgeType,
            background: k.background,
            content: k.content,
            result: k.result,
            conclusion: k.conclusion ?? null,
            recommendation: k.recommendation ?? null,
            reusability: k.reusability ?? null,
            techTags: (k.techTags ?? []) as Prisma.InputJsonValue,
            devMethod: k.devMethod ?? null,
            processTags: (k.processTags ?? []) as Prisma.InputJsonValue,
            businessDomainTags: (k.businessDomainTags ?? []) as Prisma.InputJsonValue,
            visibility: k.visibility ?? 'company',
            createdBy: input.userId,
            updatedBy: input.userId,
          },
        });
        knowledgeIdMap.set(k.sourceRow, newId);
      }
      for (const r of parsed.risksIssues) {
        const newId = randomUUID();
        await tx.riskIssue.create({
          data: {
            id: newId,
            tenantId: input.tenantId,
            projectId: r.projectId,
            type: r.type,
            title: r.title,
            content: r.content,
            cause: r.cause ?? null,
            impact: r.impact,
            likelihood: r.likelihood ?? null,
            priority: r.priority,
            responsePolicy: r.responsePolicy ?? null,
            responseDetail: r.responseDetail ?? null,
            reporterId: input.userId,
            assigneeId: null,
            deadline: r.deadline ? new Date(r.deadline) : null,
            state: r.state ?? 'open',
            result: null,
            lessonLearned: r.lessonLearned ?? null,
            visibility: r.visibility ?? 'draft',
            riskNature: r.type === 'risk' ? (r.riskNature ?? 'threat') : null,
            createdBy: input.userId,
            updatedBy: input.userId,
          },
        });
        riskIssueIdMap.set(r.sourceRow, newId);
      }

      // preview を即時削除 (apply 完了 = もう使わないため、TTL 待たず削除)
      await tx.tenantImportPreview.delete({ where: { id: input.previewId } });

      // PR-3 (2026-05-15): ストレージ上限 Post-check。超過時は throw で全件ロールバック。
      await assertStorageLimitInTx(tx, input.tenantId);
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  } catch (error) {
    if (error instanceof StorageLimitExceededError) {
      return {
        ok: false,
        error: 'STORAGE_LIMIT_EXCEEDED',
        message: `取込データの合計容量がストレージ上限 (${Math.floor(error.limitBytes / (1024 * 1024))} MB) を超えるためインポートを中止しました。データを削除するか、Storage プランをアップグレードしてください。`,
      };
    }
    throw error;
  }

  // ============ embedding 生成 (PR #357 / 2026-05-14: 1 ApiCallLog に集約) ============
  //
  //  旧仕様: ループで N 件 = N 回の Voyage 呼出 = N 件の ApiCallLog
  //  新仕様: Knowledge + RiskIssue を 1 バッチにまとめて 1 ApiCallLog のみ作成。
  //          ユーザ要件 (PR #357): 「DB 登録の API 呼出回数 = 画面表示 = 実 API 呼出回数を統一」
  //          内部で Voyage の token 上限超過時は MAX_BATCH_SIZE で分割するが、
  //          withMeteredLLM のラップは 1 回のみのため Tenant counter +1, ApiCallLog 1 件で確定。
  //
  // PR #358 (2026-05-14): visibility='draft' (公開範囲: 自分のみ) は提案エンジン側で
  //   filter 除外されるため、embedding を生成せず Voyage API 課金も発生させない (案D 整合)。
  //   skip 件数は embeddingSkippedDraft として summary に含め、wizard 画面で
  //   「下書き分: N 件 (課金対象外)」と表示する。
  const batchItems: Array<{ table: EmbeddingSearchTable; rowId: string; text: string }> = [];
  let embeddingSkippedDraft = 0;

  for (const k of parsed.knowledge) {
    const newId = knowledgeIdMap.get(k.sourceRow);
    if (!newId) continue;
    // PR #358: visibility='draft' は embedding 生成しない (PR #357 案D との整合性)
    if ((k.visibility ?? 'company') === 'draft') {
      embeddingSkippedDraft += 1;
      continue;
    }
    batchItems.push({
      table: 'knowledges',
      rowId: newId,
      text: composeKnowledgeText({
        title: k.title,
        background: k.background,
        content: k.content,
        result: k.result,
        conclusion: k.conclusion ?? null,
        recommendation: k.recommendation ?? null,
      }),
    });
  }

  for (const r of parsed.risksIssues) {
    const newId = riskIssueIdMap.get(r.sourceRow);
    if (!newId) continue;
    // PR #358: visibility='draft' は embedding 生成しない (RiskIssue デフォルトが 'draft' のため重要)
    if ((r.visibility ?? 'draft') === 'draft') {
      embeddingSkippedDraft += 1;
      continue;
    }
    batchItems.push({
      table: 'risks_issues',
      rowId: newId,
      text: `${r.title}\n${r.content}\n${r.cause ?? ''}\n${r.lessonLearned ?? ''}`.trim(),
    });
  }

  let embeddingGenerated = 0;
  let embeddingFailed = 0;
  let totalCostJpy = 0;

  if (batchItems.length > 0) {
    const batchResult = await generateAndPersistBatchEmbeddings({
      items: batchItems,
      tenantId: input.tenantId,
      userId: input.userId,
      featureUnit: 'external-import-embedding',
    });
    embeddingGenerated = batchResult.generated;
    embeddingFailed = batchResult.failed;
    totalCostJpy = batchResult.costJpy;
  }

  return {
    ok: true,
    summary: {
      knowledgeCreated: knowledgeIdMap.size,
      risksIssuesCreated: riskIssueIdMap.size,
      embeddingGenerated,
      embeddingFailed,
      embeddingSkippedDraft,
      totalCostJpy,
    },
  };
}

// ================================================================
// 公開関数: 期限切れ preview を削除 (cron から呼ばれる)
// ================================================================

export async function deleteExpiredPreviews(now: Date = new Date()): Promise<number> {
  const result = await prisma.tenantImportPreview.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return result.count;
}

// ================================================================
// 内部型: パース結果
// ================================================================

type ParsedKnowledge = {
  sourceRow: number;
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  conclusion?: string | null;
  recommendation?: string | null;
  reusability?: string | null;
  techTags?: string[];
  devMethod?: string | null;
  processTags?: string[];
  businessDomainTags?: string[];
  visibility?: string;
};

type ParsedRiskIssue = {
  sourceRow: number;
  type: 'risk' | 'issue';
  title: string;
  content: string;
  cause?: string | null;
  impact: 'low' | 'medium' | 'high';
  likelihood?: 'low' | 'medium' | 'high' | null;
  priority: 'low' | 'medium' | 'high';
  responsePolicy?: string | null;
  responseDetail?: string | null;
  deadline?: string | null; // YYYY-MM-DD
  state?: string;
  lessonLearned?: string | null;
  visibility?: string;
  riskNature?: 'threat' | 'opportunity' | null;
  projectId: string;
};

// ================================================================
// 内部: パース + バリデーション
// ================================================================

const VALID_KNOWLEDGE_TYPES = new Set(['failure', 'success', 'lesson', 'template', 'general']);
const VALID_REUSABILITY = new Set(['high', 'medium', 'low']);
const VALID_DEV_METHODS = new Set(['waterfall', 'agile', 'hybrid']);
const VALID_VISIBILITY_KNOWLEDGE = new Set(['draft', 'project', 'company']);
const VALID_VISIBILITY_RISK = new Set(['draft', 'public']);
const VALID_RISK_TYPES = new Set(['risk', 'issue']);
const VALID_LEVELS = new Set(['low', 'medium', 'high']);
const VALID_RISK_NATURES = new Set(['threat', 'opportunity']);

function parseKnowledgeRows(
  rows: Record<string, unknown>[],
  fieldMapping: FieldMapping,
): { valid: ParsedKnowledge[]; errors: PreviewError[] } {
  const valid: ParsedKnowledge[] = [];
  const errors: PreviewError[] = [];

  // 逆引き: フィールド名 → CSV 列名
  const reverse = invertMapping(fieldMapping);

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // 1-indexed + ヘッダ行 1
    const get = (field: string): unknown => {
      const csvCol = reverse[field];
      if (!csvCol) return undefined;
      return row[csvCol];
    };

    const rowErrors: PreviewError[] = [];
    const requireString = (field: string, max?: number): string | null => {
      const v = get(field);
      if (v == null || String(v).trim() === '') {
        rowErrors.push({
          entity: 'knowledge',
          row: rowNum,
          field,
          reason: `${field} は必須です`,
        });
        return null;
      }
      const s = String(v).trim();
      if (max && s.length > max) {
        rowErrors.push({
          entity: 'knowledge',
          row: rowNum,
          field,
          reason: `${field} は ${max} 文字以下にしてください (現在 ${s.length} 文字)`,
        });
        return null;
      }
      return s;
    };

    const title = requireString('title', 150);
    const knowledgeTypeRaw = get('knowledgeType');
    const knowledgeType =
      knowledgeTypeRaw == null || String(knowledgeTypeRaw).trim() === ''
        ? 'general' // 任意 → デフォルト general
        : String(knowledgeTypeRaw).trim();
    if (knowledgeType && !VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
      rowErrors.push({
        entity: 'knowledge',
        row: rowNum,
        field: 'knowledgeType',
        reason: `knowledgeType は ${[...VALID_KNOWLEDGE_TYPES].join('/')} のいずれか`,
      });
    }
    const background = requireString('background');
    const content = requireString('content');
    const result = requireString('result');

    // 任意フィールド
    const conclusion = optionalString(get('conclusion'));
    const recommendation = optionalString(get('recommendation'));
    const reusability = optionalEnum(get('reusability'), VALID_REUSABILITY);
    const techTags = optionalTagArray(get('techTags'));
    const devMethod = optionalEnum(get('devMethod'), VALID_DEV_METHODS);
    const processTags = optionalTagArray(get('processTags'));
    const businessDomainTags = optionalTagArray(get('businessDomainTags'));
    const visibility = optionalEnum(get('visibility'), VALID_VISIBILITY_KNOWLEDGE) ?? 'company';

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    valid.push({
      sourceRow: rowNum,
      title: title!,
      knowledgeType,
      background: background!,
      content: content!,
      result: result!,
      conclusion,
      recommendation,
      reusability,
      techTags,
      devMethod,
      processTags,
      businessDomainTags,
      visibility,
    });
  });

  return { valid, errors };
}

function parseRiskIssueRows(
  rows: Record<string, unknown>[],
  fieldMapping: FieldMapping,
  defaultProjectId: string | undefined,
): { valid: ParsedRiskIssue[]; errors: PreviewError[] } {
  const valid: ParsedRiskIssue[] = [];
  const errors: PreviewError[] = [];

  const reverse = invertMapping(fieldMapping);

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const get = (field: string): unknown => {
      const csvCol = reverse[field];
      if (!csvCol) return undefined;
      return row[csvCol];
    };

    const rowErrors: PreviewError[] = [];

    const title = (() => {
      const v = get('title');
      if (v == null || String(v).trim() === '') {
        rowErrors.push({ entity: 'risksIssues', row: rowNum, field: 'title', reason: 'title は必須' });
        return null;
      }
      const s = String(v).trim();
      if (s.length > 100) {
        rowErrors.push({
          entity: 'risksIssues',
          row: rowNum,
          field: 'title',
          reason: `title は 100 文字以下にしてください (現在 ${s.length} 文字)`,
        });
        return null;
      }
      return s;
    })();

    const content = (() => {
      const v = get('content');
      if (v == null || String(v).trim() === '') {
        rowErrors.push({
          entity: 'risksIssues',
          row: rowNum,
          field: 'content',
          reason: 'content は必須',
        });
        return null;
      }
      return String(v).trim();
    })();

    const typeRaw = get('type');
    const type = String(typeRaw ?? '').trim().toLowerCase();
    if (!VALID_RISK_TYPES.has(type)) {
      rowErrors.push({
        entity: 'risksIssues',
        row: rowNum,
        field: 'type',
        reason: `type は risk/issue のいずれか`,
      });
    }

    const impact = String(get('impact') ?? '').trim().toLowerCase();
    if (!VALID_LEVELS.has(impact)) {
      rowErrors.push({
        entity: 'risksIssues',
        row: rowNum,
        field: 'impact',
        reason: `impact は low/medium/high`,
      });
    }

    const priority = String(get('priority') ?? '').trim().toLowerCase();
    if (!VALID_LEVELS.has(priority)) {
      rowErrors.push({
        entity: 'risksIssues',
        row: rowNum,
        field: 'priority',
        reason: `priority は low/medium/high`,
      });
    }

    // projectId: 列マッピングがあればそちらを使う、なければ defaultProjectId
    let projectId: string | null = null;
    const projectIdRaw = get('projectId');
    if (projectIdRaw != null && String(projectIdRaw).trim() !== '') {
      projectId = String(projectIdRaw).trim();
    } else if (defaultProjectId) {
      projectId = defaultProjectId;
    } else {
      rowErrors.push({
        entity: 'risksIssues',
        row: rowNum,
        field: 'projectId',
        reason: 'projectId が指定されていません (画面でデフォルト所属プロジェクトを選ぶか、列マッピングしてください)',
      });
    }

    const cause = optionalString(get('cause'));
    const likelihood = optionalEnum(get('likelihood'), VALID_LEVELS) as
      | 'low' | 'medium' | 'high' | null;
    const responsePolicy = optionalString(get('responsePolicy'));
    const responseDetail = optionalString(get('responseDetail'));
    const deadline = optionalDateString(get('deadline'), 'risksIssues', rowNum, rowErrors);
    const state = optionalString(get('state')) ?? 'open';
    const lessonLearned = optionalString(get('lessonLearned'));
    const visibility = optionalEnum(get('visibility'), VALID_VISIBILITY_RISK) ?? 'draft';
    const riskNature = optionalEnum(get('riskNature'), VALID_RISK_NATURES) as
      | 'threat' | 'opportunity' | null;

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    valid.push({
      sourceRow: rowNum,
      type: type as 'risk' | 'issue',
      title: title!,
      content: content!,
      cause,
      impact: impact as 'low' | 'medium' | 'high',
      likelihood,
      priority: priority as 'low' | 'medium' | 'high',
      responsePolicy,
      responseDetail,
      deadline,
      state,
      lessonLearned,
      visibility,
      riskNature,
      projectId: projectId!,
    });
  });

  return { valid, errors };
}

// ================================================================
// 内部: コスト試算
// ================================================================

function computeCostEstimate(args: {
  plan: 'beginner' | 'expert' | 'pro';
  voyageCalls: number;
  currentMonthCallCount: number;
  currentMonthCostJpy: number;
  monthlyBudgetCapJpy: number | null;
  beginnerCallLimit: number;
  pricePerCallHaiku: number;
  pricePerCallSonnet: number;
}): CostEstimate {
  const unitPrice =
    args.plan === 'pro'
      ? args.pricePerCallSonnet
      : args.plan === 'expert'
        ? args.pricePerCallHaiku
        : 0;
  const estimatedJpy = args.voyageCalls * unitPrice;
  const projectedMonthJpy = args.currentMonthCostJpy + estimatedJpy;
  const projectedMonthCallCount = args.currentMonthCallCount + args.voyageCalls;

  let warningCode: CostEstimate['warningCode'] = null;
  let warningMessage: string | null = null;

  if (args.plan === 'beginner') {
    if (projectedMonthCallCount > args.beginnerCallLimit) {
      warningCode = 'BEGINNER_CALL_LIMIT_EXCEEDED';
      warningMessage = `Beginner プランは月 ${args.beginnerCallLimit} 回までの API 呼出制限があります。本インポートは ${args.voyageCalls} 回の生成 AI 呼出 (embedding) が発生し、当月既呼出 (${args.currentMonthCallCount} 回) との合計が ${projectedMonthCallCount} 回となるため上限を超過します。\n\n対処:\n- 翌月まで待つ\n- インポート件数を ${Math.max(0, args.beginnerCallLimit - args.currentMonthCallCount)} 件以下に減らす\n- Expert / Pro プランにアップグレード`;
    }
  } else {
    if (args.monthlyBudgetCapJpy !== null && projectedMonthJpy > args.monthlyBudgetCapJpy) {
      warningCode = 'BUDGET_CAP_EXCEEDED';
      warningMessage = `本インポートで合計 ¥${estimatedJpy.toLocaleString()} の生成 AI 利用料が発生します。当月既消費 ¥${args.currentMonthCostJpy.toLocaleString()} と合算で ¥${projectedMonthJpy.toLocaleString()} となり、設定済の月次予算上限 ¥${args.monthlyBudgetCapJpy.toLocaleString()} を超過するためインポートできません。\n\n対処:\n- インポート件数を減らす\n- 月次予算上限をテナント設定画面から引き上げる`;
    }
  }

  return {
    voyageCalls: args.voyageCalls,
    plan: args.plan,
    estimatedJpy,
    currentMonthJpy: args.currentMonthCostJpy,
    projectedMonthJpy,
    budgetCapJpy: args.monthlyBudgetCapJpy,
    beginnerCallLimit: args.plan === 'beginner' ? args.beginnerCallLimit : null,
    currentMonthCallCount: args.currentMonthCallCount,
    warningCode,
    warningMessage,
  };
}

// ================================================================
// 内部: ヘルパ
// ================================================================

function invertMapping(fieldMapping: FieldMapping): Record<string, string> {
  // value=フィールド名 / key=CSV列名 → value=CSV列名 / key=フィールド名 に転換 ('skip' は除外)
  const result: Record<string, string> = {};
  for (const [csvCol, field] of Object.entries(fieldMapping)) {
    if (field && field !== 'skip') {
      result[field] = csvCol;
    }
  }
  return result;
}

function optionalString(v: unknown): string | null {
  if (v == null || String(v).trim() === '') return null;
  return String(v).trim();
}

function optionalEnum(v: unknown, valid: Set<string>): string | null {
  const s = optionalString(v);
  if (s == null) return null;
  const lower = s.toLowerCase();
  return valid.has(lower) ? lower : null;
}

/** カンマ区切り (半角/全角) を JSON 配列に変換 */
function optionalTagArray(v: unknown): string[] {
  const s = optionalString(v);
  if (s == null) return [];
  return s
    .split(/[,、]/) // 半角カンマ + 全角読点
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function optionalDateString(
  v: unknown,
  entity: ExternalImportEntity,
  rowNum: number,
  errors: PreviewError[],
): string | null {
  const s = optionalString(v);
  if (s == null) return null;
  // YYYY-MM-DD or YYYY/MM/DD を許容
  const normalized = s.replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    errors.push({
      entity,
      row: rowNum,
      field: 'deadline',
      reason: `日付形式が不正です。YYYY-MM-DD または YYYY/MM/DD で記入してください (受信値: ${s})`,
    });
    return null;
  }
  return normalized;
}
