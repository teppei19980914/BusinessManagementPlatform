/**
 * 見積もりサービス
 *
 * 役割:
 *   プロジェクトの工数見積もりを CRUD する。1 プロジェクトに複数の見積もり明細
 *   (作業項目 / 工数 / 単位 / 根拠) を持つ構造で、企画フェーズから実行フェーズへの
 *   移行 (見積もり確定) と、過去案件の見積もりナレッジ蓄積を支える。
 *
 * 設計判断:
 *   - 論理削除 (deletedAt) を採用。確定済み見積もりは履歴として後続案件の参考に
 *     使われるため物理削除しない。
 *   - estimatedEffort は DB 上 Decimal(10,2) だが UI で扱いやすくするため
 *     Number に変換して DTO に格納する (toEstimateDTO の責務)。
 *   - 工数単位 (人時 / 人日) はマスタ定数 (`EFFORT_UNITS`) を参照して保存する。
 *
 * 認可:
 *   呼び出し元の API ルート (src/app/api/projects/[projectId]/estimates/...)
 *   側で `checkProjectPermission('estimate:*')` を実施済みの前提。
 *   本サービスは認可チェックを再実行しない。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: estimates)
 *   - DESIGN.md §8 (権限制御 — estimate アクション)
 *   - SPECIFICATION.md (見積もり画面・確定フロー)
 */

import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { CreateEstimateInput } from '@/lib/validators/estimate';

export type EstimateDTO = {
  id: string;
  projectId: string;
  itemName: string;
  category: string;
  devMethod: string;
  estimatedEffort: number;
  effortUnit: string;
  rationale: string;
  preconditions: string | null;
  isConfirmed: boolean;
  notes: string | null;
  createdBy: string;
  // 2026-06-02: 一覧で作成者/更新者を表示するため名前解決 (list 経路のみ非null)。
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
};

function toEstimateDTO(e: {
  id: string;
  projectId: string;
  itemName: string;
  category: string;
  devMethod: string;
  estimatedEffort: Prisma.Decimal;
  effortUnit: string;
  rationale: string;
  preconditions: string | null;
  isConfirmed: boolean;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}): EstimateDTO {
  return {
    id: e.id,
    projectId: e.projectId,
    itemName: e.itemName,
    category: e.category,
    devMethod: e.devMethod,
    estimatedEffort: Number(e.estimatedEffort),
    effortUnit: e.effortUnit,
    rationale: e.rationale,
    preconditions: e.preconditions,
    isConfirmed: e.isConfirmed,
    notes: e.notes,
    createdBy: e.createdBy,
    createdByName: null,
    updatedByName: null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/**
 * 2026-05-09 feedback Phase 2-6: severity-1 テナント越境対策。
 *   Estimate は schema 上 tenantId 列を持たないため、`project: { tenantId: viewerTenantId }`
 *   の関連フィルタで自テナント限定する (Task と同じパターン)。
 *   契約金額 / 見積根拠の漏洩は致命的なため最優先対応。
 */
export async function listEstimates(
  projectId: string,
  viewerTenantId: string,
): Promise<EstimateDTO[]> {
  const estimates = await prisma.estimate.findMany({
    where: { projectId, deletedAt: null, project: { tenantId: viewerTenantId } },
    orderBy: { createdAt: 'asc' },
  });
  // 2026-06-02: 一覧表示用に作成者/更新者名をバルク取得 (氏名のみ select、N+1 回避)。
  //   tenantId フィルタを明示し自テナントの User のみ解決 = 越境した createdBy/updatedBy は
  //   null フォールバックされ氏名漏えいしない (User は 1 ユーザ 1 テナント、@@unique([tenantId,email]))。
  const userIds = Array.from(new Set(estimates.flatMap((e) => [e.createdBy, e.updatedBy])));
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds }, tenantId: viewerTenantId }, select: { id: true, name: true } })
    : [];
  const userNameById = new Map(users.map((u) => [u.id, u.name]));
  return estimates.map((e) => ({
    ...toEstimateDTO(e),
    createdByName: userNameById.get(e.createdBy) ?? null,
    updatedByName: userNameById.get(e.updatedBy) ?? null,
  }));
}

export async function getEstimate(
  estimateId: string,
  viewerTenantId: string,
): Promise<EstimateDTO | null> {
  // 2026-05-09 feedback Phase 2-6: 越境取得を遮断するため project tenant 検証。
  const e = await prisma.estimate.findFirst({
    where: { id: estimateId, deletedAt: null, project: { tenantId: viewerTenantId } },
  });
  return e ? toEstimateDTO(e) : null;
}

export async function createEstimate(
  projectId: string,
  input: CreateEstimateInput,
  userId: string,
  viewerTenantId: string,
): Promise<EstimateDTO> {
  // 2026-05-09 feedback Phase 2-6: 冒頭で project の tenant 一致を verify。
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!project) throw new Error('NOT_FOUND');

  const e = await prisma.estimate.create({
    data: {
      projectId,
      itemName: input.itemName,
      category: input.category,
      // 2026-06-02: 開発方式は UI 撤去済。未送信時は NOT NULL 列を満たすため 'other' で既定補完。
      devMethod: input.devMethod ?? 'other',
      estimatedEffort: input.estimatedEffort,
      effortUnit: input.effortUnit,
      // 2026-06-02: 見積根拠はフォーム撤去 (備考に置換)。未送信時は NOT NULL 列を満たすため '' で補完。
      rationale: input.rationale ?? '',
      preconditions: input.preconditions,
      notes: input.notes,
      createdBy: userId,
      updatedBy: userId,
    },
  });
  return toEstimateDTO(e);
}

export async function updateEstimate(
  estimateId: string,
  input: Partial<CreateEstimateInput>,
  userId: string,
  viewerTenantId: string,
): Promise<EstimateDTO> {
  // 2026-05-09 feedback Phase 2-6: 越境編集を遮断するため findFirst で先に所有確認。
  const owned = await prisma.estimate.findFirst({
    where: { id: estimateId, deletedAt: null, project: { tenantId: viewerTenantId } },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  const data: Record<string, unknown> = { updatedBy: userId };

  if (input.itemName !== undefined) data.itemName = input.itemName;
  if (input.category !== undefined) data.category = input.category;
  if (input.devMethod !== undefined) data.devMethod = input.devMethod;
  if (input.estimatedEffort !== undefined) data.estimatedEffort = input.estimatedEffort;
  if (input.effortUnit !== undefined) data.effortUnit = input.effortUnit;
  if (input.rationale !== undefined) data.rationale = input.rationale;
  if (input.preconditions !== undefined) data.preconditions = input.preconditions;
  if (input.notes !== undefined) data.notes = input.notes;

  const e = await prisma.estimate.update({
    where: { id: estimateId },
    data,
  });
  return toEstimateDTO(e);
}

export async function confirmEstimate(
  estimateId: string,
  userId: string,
  viewerTenantId: string,
): Promise<EstimateDTO> {
  // 2026-05-09 feedback Phase 2-6: 越境確定を遮断するため findFirst で先に所有確認。
  const owned = await prisma.estimate.findFirst({
    where: { id: estimateId, deletedAt: null, project: { tenantId: viewerTenantId } },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  const e = await prisma.estimate.update({
    where: { id: estimateId },
    data: { isConfirmed: true, updatedBy: userId },
  });
  return toEstimateDTO(e);
}

export async function deleteEstimate(
  estimateId: string,
  userId: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-6: 越境削除を遮断するため findFirst で先に所有確認。
  const owned = await prisma.estimate.findFirst({
    where: { id: estimateId, deletedAt: null, project: { tenantId: viewerTenantId } },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  // PR #89: 紐づく Attachment も同時に論理削除 (孤児データ防止)
  const now = new Date();
  await prisma.$transaction([
    prisma.estimate.update({
      where: { id: estimateId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    prisma.attachment.updateMany({
      // 2026-05-12 severity-1 防御: tenantId 明示 (cascade soft-delete でも越境遮断)
      where: { tenantId: viewerTenantId, entityType: 'estimate', entityId: estimateId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);
}
