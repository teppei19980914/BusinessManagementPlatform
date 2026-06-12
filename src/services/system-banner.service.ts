/**
 * システム周知バナー サービス (ADR-0036)。
 *
 * 役割:
 *   - 表示側: getActiveBanner — 全テナント共通で「今表示すべき帯」を 1 件取得 (layout が利用)
 *   - 管理側 (super_admin): listBanners / getBanner / createBanner / updateBanner /
 *     setBannerEnabled / deleteBanner
 *
 * 設計方針 (ADR-0036):
 *   - **グローバル**: tenantId を持たない (運営者の運用周知。全テナントの全ユーザに同一表示)。
 *   - **1 本制約**: enabled なバナー同士の表示期間が重複することを禁止 (createBanner /
 *     updateBanner で assertNoOverlap)。ある時点で表示される帯は最大 1 本。
 *   - **取り下げ (enabled=false) と物理削除の 2 系統**: 取り下げは履歴に残し、物理削除は誤作成の後始末。
 */

import { prisma } from '@/lib/db';
import type { BannerSeverity } from '@/lib/validators/system-banner';

/** 重複期間で作成/編集しようとしたときに throw されるエラーコード (API が 409 に変換)。 */
export const BANNER_OVERLAP_ERROR = 'BANNER_OVERLAP';

/** バナーの DTO。日時は ISO 文字列で UI / API に渡す。 */
export type SystemBannerDTO = {
  id: string;
  message: string;
  severity: BannerSeverity;
  startAt: string;
  endAt: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type SystemBannerRow = {
  id: string;
  message: string;
  severity: string;
  startAt: Date;
  endAt: Date;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(b: SystemBannerRow): SystemBannerDTO {
  return {
    id: b.id,
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
 * 今この瞬間に表示すべきバナーを 1 件返す (なければ null)。
 * 条件: enabled かつ start_at <= now < end_at。1 本制約があるため通常 0 or 1 件だが、
 * 念のため start_at の新しい順で 1 件に絞る。
 */
export async function getActiveBanner(now: Date = new Date()): Promise<SystemBannerDTO | null> {
  const row = await prisma.systemBanner.findFirst({
    where: { enabled: true, startAt: { lte: now }, endAt: { gt: now } },
    orderBy: { startAt: 'desc' },
  });
  return row ? toDTO(row) : null;
}

/** 全バナーを表示期間の新しい順で取得する (管理画面の履歴一覧)。 */
export async function listBanners(): Promise<SystemBannerDTO[]> {
  const rows = await prisma.systemBanner.findMany({ orderBy: { startAt: 'desc' } });
  return rows.map(toDTO);
}

/** 1 件取得 (編集/複製の prefill 用)。 */
export async function getBanner(id: string): Promise<SystemBannerDTO | null> {
  const row = await prisma.systemBanner.findUnique({ where: { id } });
  return row ? toDTO(row) : null;
}

/**
 * enabled なバナーと表示期間が重複していないことを保証する (1 本制約)。
 * 期間の重複条件: existing.start_at < newEnd かつ existing.end_at > newStart。
 * disabled (取り下げ済み) や、期間が完全に過去/未来で重ならないものは枠を空ける。
 */
async function assertNoOverlap(startAt: Date, endAt: Date, excludeId?: string): Promise<void> {
  const conflict = await prisma.systemBanner.findFirst({
    where: {
      enabled: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startAt: { lt: endAt },
      endAt: { gt: startAt },
    },
    select: { id: true },
  });
  if (conflict) throw new Error(BANNER_OVERLAP_ERROR);
}

export type CreateBannerData = {
  message: string;
  severity: BannerSeverity;
  startAt: Date;
  endAt: Date;
  enabled: boolean;
};

/** バナーを作成する。enabled な場合は重複期間を弾く。 */
export async function createBanner(
  data: CreateBannerData,
  createdBy: string,
): Promise<SystemBannerDTO> {
  if (data.enabled) {
    await assertNoOverlap(data.startAt, data.endAt);
  }
  const row = await prisma.systemBanner.create({
    data: {
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

export type UpdateBannerData = Partial<CreateBannerData>;

/**
 * バナーを編集する。既存値とマージし、start_at < end_at と (有効化されるなら) 重複期間を検証する。
 * 対象が存在しなければ 'NOT_FOUND' を throw。
 */
export async function updateBanner(id: string, data: UpdateBannerData): Promise<SystemBannerDTO> {
  const existing = await prisma.systemBanner.findUnique({ where: { id } });
  if (!existing) throw new Error('NOT_FOUND');

  const startAt = data.startAt ?? existing.startAt;
  const endAt = data.endAt ?? existing.endAt;
  const enabled = data.enabled ?? existing.enabled;

  if (startAt >= endAt) throw new Error('INVALID_PERIOD');
  if (enabled) {
    await assertNoOverlap(startAt, endAt, id);
  }

  const row = await prisma.systemBanner.update({
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

/**
 * 取り下げ (enabled=false) / 再開 (enabled=true)。再開時は重複期間を弾く。
 * updateBanner に委譲する薄いラッパ (API から意図を明示するため用意)。
 */
export async function setBannerEnabled(id: string, enabled: boolean): Promise<SystemBannerDTO> {
  return updateBanner(id, { enabled });
}

/** バナーを物理削除する (誤作成の後始末)。 */
export async function deleteBanner(id: string): Promise<void> {
  await prisma.systemBanner.delete({ where: { id } });
}
