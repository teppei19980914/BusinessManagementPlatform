/**
 * メモサービス (PR #70)
 *
 * 方針:
 *   - 個人メモ (Memo) はプロジェクトに紐付かない個人のノート置き場
 *   - visibility='private' (既定): 作成者のみ閲覧可、admin も含め他者不可視
 *   - visibility='public': 全ログインユーザが「全メモ」画面で閲覧可
 *   - 編集/削除は常に作成者本人のみ (admin 特権なし)
 *   - タグは持たせない (業務知見判断は人間ベース、PR #70 要件)
 */

import { prisma } from '@/lib/db';
import type { CreateMemoInput, UpdateMemoInput } from '@/lib/validators/memo';

export type MemoDTO = {
  id: string;
  userId: string;
  authorName: string | null;
  title: string;
  content: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
  /** 閲覧者が本人かどうか (UI で編集ボタン等の出し分け用) */
  isMine: boolean;
};

function toDTO(
  m: {
    id: string;
    userId: string;
    title: string;
    content: string;
    visibility: string;
    createdAt: Date;
    updatedAt: Date;
    author?: { name: string } | null;
  },
  viewerUserId: string,
): MemoDTO {
  return {
    id: m.id,
    userId: m.userId,
    authorName: m.author?.name ?? null,
    title: m.title,
    content: m.content,
    visibility: m.visibility,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    isMine: m.userId === viewerUserId,
  };
}

/**
 * 「メモ」画面 (/memos) 用 — 閲覧ユーザ自身のメモのみ返す (PR #71)。
 * private / public 問わず、自分が作成した全件。ここは編集/削除可能な個人管理画面。
 */
export async function listMyMemos(viewerUserId: string): Promise<MemoDTO[]> {
  const rows = await prisma.memo.findMany({
    where: { deletedAt: null, userId: viewerUserId },
    include: { author: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((m) => toDTO(m, viewerUserId));
}

/**
 * 「全メモ」画面 (/all-memos) 用 — visibility='public' のメモを全件返す (PR #71)。
 * 自分の公開メモも含む (自分のメモでも「公開範囲=全メモに公開」に設定したものは全員が閲覧対象)。
 * この画面は read-only。編集/削除は個別の /memos 画面側で行う。
 */
export async function listPublicMemos(viewerUserId: string): Promise<MemoDTO[]> {
  const rows = await prisma.memo.findMany({
    where: { deletedAt: null, visibility: 'public' },
    include: { author: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((m) => toDTO(m, viewerUserId));
}

/**
 * 単一メモ取得 (権限チェック込み)。
 * 本人 or (public かつ自分以外) のみ取得可。private な他人のメモはアクセス不可。
 */
export async function getMemoForViewer(
  memoId: string,
  viewerUserId: string,
): Promise<MemoDTO | null> {
  const m = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null },
    include: { author: { select: { name: true } } },
  });
  if (!m) return null;
  if (m.userId !== viewerUserId && m.visibility !== 'public') {
    return null; // 非公開な他人のメモは「存在しない」扱い (情報漏洩防止)
  }
  return toDTO(m, viewerUserId);
}

export async function createMemo(
  input: CreateMemoInput,
  userId: string,
): Promise<MemoDTO> {
  const created = await prisma.memo.create({
    data: {
      userId,
      title: input.title,
      content: input.content,
      visibility: input.visibility ?? 'private',
    },
    include: { author: { select: { name: true } } },
  });
  return toDTO(created, userId);
}

/**
 * 更新 (作成者のみ)。呼び出し側で認可済み前提だが、二重防御として userId 一致を確認。
 */
export async function updateMemo(
  memoId: string,
  input: UpdateMemoInput,
  userId: string,
): Promise<MemoDTO | null> {
  const existing = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null },
    select: { userId: true },
  });
  if (!existing) return null;
  if (existing.userId !== userId) return null; // 他人のメモは編集不可

  const updated = await prisma.memo.update({
    where: { id: memoId },
    data: {
      title: input.title,
      content: input.content,
      visibility: input.visibility,
    },
    include: { author: { select: { name: true } } },
  });
  return toDTO(updated, userId);
}

export async function deleteMemo(memoId: string, userId: string): Promise<boolean> {
  const existing = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null },
    select: { userId: true },
  });
  if (!existing) return false;
  if (existing.userId !== userId) return false;

  await prisma.memo.update({
    where: { id: memoId },
    data: { deletedAt: new Date() },
  });
  return true;
}
