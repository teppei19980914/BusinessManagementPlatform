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
 *
 * 2026-05-09 feedback: テナント越境防止のため `viewerTenantId` でフィルタ。
 *   ユーザは自テナント内でしかメモを作成できないため通常 no-op だが、テナント間で
 *   userId が衝突した場合のフェイルセーフとして必須 (defense-in-depth)。
 */
export async function listMyMemos(
  viewerUserId: string,
  viewerTenantId: string,
): Promise<MemoDTO[]> {
  const rows = await prisma.memo.findMany({
    where: { deletedAt: null, userId: viewerUserId, tenantId: viewerTenantId },
    include: { author: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((m) => toDTO(m, viewerUserId));
}

/**
 * 「全メモ」画面 (/all-memos) 用 — visibility='public' のメモを自テナント内で全件返す。
 * 自分の公開メモも含む (自分のメモでも「公開範囲=全メモに公開」に設定したものは同テナント全員が閲覧対象)。
 * この画面は read-only。編集/削除は個別の /memos 画面側で行う。
 *
 * 2026-05-09 feedback: テナント越境防止のため `viewerTenantId` でフィルタ。
 *   旧実装はテナントフィルタ無しで他テナントの公開メモが見えてしまっていた (重大バグ)。
 */
export async function listPublicMemos(
  viewerUserId: string,
  viewerTenantId: string,
): Promise<MemoDTO[]> {
  const rows = await prisma.memo.findMany({
    where: { deletedAt: null, visibility: 'public', tenantId: viewerTenantId },
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
  viewerTenantId: string,
): Promise<MemoDTO | null> {
  // 2026-05-09 feedback Phase 2-4: 越境取得を遮断するため where に tenantId 必須化。
  const m = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null, tenantId: viewerTenantId },
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
  tenantId: string,
): Promise<MemoDTO> {
  // 2026-05-09 feedback Phase 2-4: data.tenantId を明示し schema DB DEFAULT 暗黙依存を解消。
  const created = await prisma.memo.create({
    data: {
      tenantId,
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
  viewerTenantId: string,
): Promise<MemoDTO | null> {
  // 2026-05-09 feedback Phase 2-4: 越境編集を遮断するため where に tenantId 必須化。
  // 2026-05-11: visibility 連動の title 必須チェックのため title も取得 (defense-in-depth)。
  const existing = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null, tenantId: viewerTenantId },
    select: { userId: true, title: true },
  });
  if (!existing) return null;
  if (existing.userId !== userId) return null; // 他人のメモは編集不可

  // 2026-05-11 defense-in-depth: 「全メンバー」(public) 化する更新で、
  //   title が input でも DB でも空になる場合は拒否。
  //   通常 validator (updateMemoSchema) が title=='' を弾くが、API 直叩きで
  //   `{ visibility: 'public' }` のみ送られて DB の既存 title が空のケースを救う。
  if (input.visibility === 'public') {
    const effectiveTitle = input.title !== undefined ? input.title : existing.title;
    if (!effectiveTitle || effectiveTitle.trim().length === 0) {
      throw new Error('PUBLIC_REQUIRES_TITLE');
    }
  }

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

/**
 * 個人「メモ一覧」(/memos) からの **visibility 一括更新** (PR #165 で /memos に移し替え、
 * 元実装は PR #162 /all-memos cross-list 用)。
 * Memo は project に紐付かない個人ノートなので scope は **viewerUserId 自身のメモのみ**。
 * Memo は visibility 値域が `private` / `public`。
 * 編集権限は元から作成者本人のみ (admin 特権なし) なので per-row userId 判定で同じ。
 */
export async function bulkUpdateMemosVisibilityFromList(
  ids: string[],
  visibility: 'private' | 'public',
  viewerUserId: string,
  viewerTenantId: string,
): Promise<{
  updatedIds: string[];
  skippedNotOwned: number;
  skippedNotFound: number;
  /** 2026-05-11: 「全メンバー」公開を試みた行のうち、タイトル空のためスキップした件数 */
  skippedEmptyTitle: number;
}> {
  if (ids.length === 0) {
    return { updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0, skippedEmptyTitle: 0 };
  }

  // 2026-05-09 feedback Phase 2-4: 越境一括更新を遮断するため tenantId 併記。
  // 2026-05-11: title を取得して、'public' 化時に空タイトルをスキップ判定に使う。
  const targets = await prisma.memo.findMany({
    where: { id: { in: ids }, deletedAt: null, tenantId: viewerTenantId },
    select: { id: true, userId: true, title: true },
  });
  const skippedNotFound = ids.length - targets.length;
  const owned = targets.filter((t) => t.userId === viewerUserId);
  const skippedNotOwned = targets.length - owned.length;

  // 2026-05-11: 「自分のみ」(private) で作られたタイトル空のメモを一括で「全メンバー」(public)
  //   に昇格させようとした場合、サーバ側 validator のルール (public はタイトル必須) と
  //   整合するように silent skip する。逆方向 (public → private) は制約緩和なので無条件で許可。
  let eligible = owned;
  let skippedEmptyTitle = 0;
  if (visibility === 'public') {
    const beforeCount = eligible.length;
    eligible = eligible.filter((t) => t.title.trim().length > 0);
    skippedEmptyTitle = beforeCount - eligible.length;
  }
  const ownedIds = eligible.map((t) => t.id);

  if (ownedIds.length === 0) {
    return { updatedIds: [], skippedNotOwned, skippedNotFound, skippedEmptyTitle };
  }

  await prisma.memo.updateMany({
    // 2026-05-12 severity-1 防御: ownedIds は事前 findMany で tenantId 検証済みだが、
    //   updateMany にも tenantId を併記し「全 query で tenantId 必須」原則を徹底
    where: { id: { in: ownedIds }, tenantId: viewerTenantId, userId: viewerUserId },
    data: { visibility },
  });

  return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound, skippedEmptyTitle };
}

export async function deleteMemo(
  memoId: string,
  userId: string,
  viewerTenantId: string,
): Promise<boolean> {
  // 2026-05-09 feedback Phase 2-4: 越境削除を遮断するため where に tenantId 必須化。
  const existing = await prisma.memo.findFirst({
    where: { id: memoId, deletedAt: null, tenantId: viewerTenantId },
    select: { userId: true },
  });
  if (!existing) return false;
  if (existing.userId !== userId) return false;

  // PR #89: 紐づく Attachment も同時に論理削除 (UI アクセス不可の孤児データ防止)
  const now = new Date();
  await prisma.$transaction([
    prisma.memo.update({
      where: { id: memoId },
      data: { deletedAt: now },
    }),
    prisma.attachment.updateMany({
      // 2026-05-12 severity-1 防御: tenantId 明示
      where: { tenantId: viewerTenantId, entityType: 'memo', entityId: memoId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);
  return true;
}
