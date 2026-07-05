/**
 * テナントバナー サービス (ADR-0037)。
 *
 * 役割:
 *   - 表示側: getActiveTenantBanner — 指定テナントの「今表示すべき帯」を 1 件取得 (layout が利用)
 *   - 管理側 (tenant_admin): listTenantBanners / getTenantBanner / createTenantBanner /
 *     updateTenantBanner / setTenantBannerEnabled / deleteTenantBanner
 *
 * 設計方針 (ADR-0037):
 *   - **テナントスコープ**: 全操作で tenantId を WHERE 条件に含め、他テナントのデータへのアクセスを防止。
 *   - **1 本制約 (テナント内)**: 同一テナント内で enabled なバナー同士の表示期間が重複することを禁止。
 *     SystemBanner の 1 本制約とは独立 (グローバルとテナントは別カウント)。
 *   - **取り下げ (enabled=false) と物理削除の 2 系統**: SystemBanner と同設計。
 *   - **表示優先度**: layout.tsx が SystemBanner と本バナーを重みソートして上から表示する。
 *     同一緊急度では SystemBanner が優先される (severity weight: high=3, medium=2, low=1)。
 */

import { prisma } from '@/lib/db';
import type { BannerSeverity } from '@/lib/validators/system-banner';

/** 重複期間で作成/編集しようとしたときに throw されるエラーコード (API が 409 に変換)。 */
export const TENANT_BANNER_OVERLAP_ERROR = 'TENANT_BANNER_OVERLAP';

/** テナントバナーの DTO。日時は ISO 文字列で UI / API に渡す。 */
export type TenantBannerDTO = {
  id: string;
  tenantId: string;
  message: string;
  severity: BannerSeverity;
  startAt: string;
  endAt: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type TenantBannerRow = {
  id: string;
  tenantId: string;
  message: string;
  severity: string;
  startAt: Date;
  endAt: Date;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(b: TenantBannerRow): TenantBannerDTO {
  return {
    id: b.id,
    tenantId: b.tenantId,
    message: b.message,
    severity: b.severity as BannerSeverity,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    enabled: b.enabled,
    createdBy: b.createdBy,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/**
 * 指定テナントで今この瞬間に表示すべきバナーを 1 件返す (なければ null)。
 * 条件: 同一 tenantId かつ enabled かつ start_at <= now < end_at。
 * テナント境界を WHERE で厳格に絞るため、他テナントのバナーは絶対に返さない。
 */
export async function getActiveTenantBanner(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantBannerDTO | null> {
  const row = await prisma.tenantBanner.findFirst({
    where: { tenantId, enabled: true, startAt: { lte: now }, endAt: { gt: now } },
    orderBy: { startAt: 'desc' },
  });
  return row ? toDTO(row) : null;
}

/** 指定テナントの全バナーを表示期間の新しい順で取得する (管理画面の履歴一覧)。 */
export async function listTenantBanners(tenantId: string): Promise<TenantBannerDTO[]> {
  const rows = await prisma.tenantBanner.findMany({
    where: { tenantId },
    orderBy: { startAt: 'desc' },
  });
  return rows.map(toDTO);
}

/** 1 件取得 (編集/複製の prefill 用)。テナント所有権を WHERE で検証する。 */
export async function getTenantBanner(
  id: string,
  tenantId: string,
): Promise<TenantBannerDTO | null> {
  const row = await prisma.tenantBanner.findFirst({ where: { id, tenantId } });
  return row ? toDTO(row) : null;
}

/**
 * 同一テナント内で enabled なバナーと表示期間が重複していないことを保証する (1 本制約)。
 * 他テナントのバナーは WHERE tenantId で除外するため、テナント間干渉は発生しない。
 */
async function assertNoOverlap(
  tenantId: string,
  startAt: Date,
  endAt: Date,
  excludeId?: string,
): Promise<void> {
  const conflict = await prisma.tenantBanner.findFirst({
    where: {
      tenantId,
      enabled: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    },
    select: { id: true },
  });
  if (conflict) throw new Error(TENANT_BANNER_OVERLAP_ERROR);
}

export type CreateTenantBannerData = {
  message: string;
  severity: BannerSeverity;
  startAt: Date;
  endAt: Date;
  enabled: boolean;
};

/** バナーを作成する。enabled な場合は同テナント内の重複期間を弾く。 */
export async function createTenantBanner(
  data: CreateTenantBannerData,
  tenantId: string,
  createdBy: string,
): Promise<TenantBannerDTO> {
  if (data.enabled) {
    await assertNoOverlap(tenantId, data.startAt, data.endAt);
  }
  const row = await prisma.tenantBanner.create({
    data: {
      tenantId,
      message: data.message,
      severity: data.severity,
      startAt: data.startAt,
      endAt: data.endAt,
      enabled: data.enabled,
      createdBy,
    },
  });
  return toDTO(row);
}

export type UpdateTenantBannerData = Partial<CreateTenantBannerData>;

/**
 * バナーを編集する。テナント所有権を確認し、既存値とマージして検証する。
 * 対象が存在しない (または他テナント) なら 'NOT_FOUND' を throw。
 */
export async function updateTenantBanner(
  id: string,
  data: UpdateTenantBannerData,
  tenantId: string,
): Promise<TenantBannerDTO> {
  const existing = await prisma.tenantBanner.findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('NOT_FOUND');

  const startAt = data.startAt ?? existing.startAt;
  const endAt = data.endAt ?? existing.endAt;
  const enabled = data.enabled ?? existing.enabled;

  if (startAt >= endAt) throw new Error('INVALID_PERIOD');
  if (enabled) {
    await assertNoOverlap(tenantId, startAt, endAt, id);
  }

  const row = await prisma.tenantBanner.update({
    where: { id },
    data: {
      ...(data.message !== undefined ? { message: data.message } : {}),
      ...(data.severity !== undefined ? { severity: data.severity } : {}),
      ...(data.startAt !== undefined ? { startAt: data.startAt } : {}),
      ...(data.endAt !== undefined ? { endAt: data.endAt } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    },
  });
  return toDTO(row);
}

/** 取り下げ / 再開。updateTenantBanner に委譲する薄いラッパ。 */
export async function setTenantBannerEnabled(
  id: string,
  enabled: boolean,
  tenantId: string,
): Promise<TenantBannerDTO> {
  return updateTenantBanner(id, { enabled }, tenantId);
}

/** バナーを物理削除する。テナント所有権を WHERE で検証してから削除。 */
export async function deleteTenantBanner(id: string, tenantId: string): Promise<void> {
  const existing = await prisma.tenantBanner.findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('NOT_FOUND');
  await prisma.tenantBanner.delete({ where: { id } });
}
