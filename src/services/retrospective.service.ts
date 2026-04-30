/**
 * 振り返りサービス
 *
 * 役割:
 *   プロジェクト完了後の振り返り (KPT 風: 計画/実績総括 + 良かった点 / 課題 / 次回以前事項)
 *   とコメントを CRUD する。次案件のナレッジ抽出元となる重要エンティティ。
 *
 * 設計判断:
 *   - 公開範囲 (visibility) は draft / public の 2 値 (PR #60 で追加)
 *     - draft  : 作成者 + admin のみ閲覧可
 *     - public : 全ログインユーザが閲覧可 → 「全振り返り」横断画面に表示
 *   - 論理削除 (deletedAt) を採用。過去案件の知見を後続に引き継ぐため物理削除しない。
 *   - problems / improvements は pg_trgm GIN インデックス付き (PR #65)。
 *     新プロジェクトの purpose / scope / background と類似度マッチして「過去の失敗」を
 *     早期に提示する用途 (suggestion.service.ts 経由)。
 *   - **コメントは PR #199 で polymorphic な `comments` テーブル (entityType='retrospective')
 *     に統合**。本サービスはコメント関連 API/DTO を持たず、UI から直接 `/api/comments`
 *     を呼ぶ。旧 `retrospective_comments` テーブルは migration で `comments` に移行済。
 *
 * 認可 (2026-04-24 改修):
 *   - 参照: 非 admin は visibility='public' のみ一覧表示、draft は他人のものは存在しない扱い。
 *           admin は 全一覧 + 個別参照とも draft 含め全件閲覧可。
 *   - 編集: **作成者 (createdBy) 本人のみ**。admin であっても他人の振り返りは編集不可
 *           (管理業務は削除のみに限定する方針)。
 *   - 削除: 作成者本人 OR admin。admin は 全振り返り からの管理削除を想定。
 *   - 作成: 呼出元 API ルートで ProjectMember チェック済 (admin も非メンバーなら不可)。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: retrospectives) / コメント機能節 (PR #199)
 *   - DESIGN.md §16 (全文検索 / pg_trgm)
 *   - DESIGN.md §23 (核心機能: 過去振り返りの提案)
 */

import { prisma } from '@/lib/db';
import type { CreateRetrospectiveInput } from '@/lib/validators/retrospective';

export type RetroDTO = {
  id: string;
  projectId: string;
  conductedDate: string;
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  improvements: string;
  state: string;
  // PR #60: 公開範囲 (draft / public)
  visibility: string;
  /** 2026-04-24: UI 側で「自分が作成者か」を判定するために DTO に含める */
  createdBy: string;
  createdAt: string;
  // PR #199: コメントは polymorphic comments テーブルへ移管。本 DTO には含めない。
  //   UI 側は edit dialog 内の <CommentSection> が /api/comments?entityType=retrospective
  //   経由で直接取得する。
};

/**
 * 「全振り返り」ビュー用 DTO。
 * 閲覧ユーザが紐づくプロジェクトの ProjectMember か否かで情報量を切り替える。
 * 非メンバー: projectName マスク / canAccessProject=false。
 */
export type AllRetroDTO = RetroDTO & {
  projectName: string | null;
  /** プロジェクトが論理削除済みか (admin のみ識別可、非 admin には false として秘匿) */
  projectDeleted: boolean;
  canAccessProject: boolean;
  /** Req 4: 全振り返り画面で表示する追加フィールド (planSummary/actualSummary/improvements は既に RetroDTO 経由で含まれる) */
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
  // PR #165: 全振り返り画面は read-only に戻したので viewerIsCreator は不要 (project list 側で持つ)
};

/**
 * 全プロジェクトの振り返りを取得する (認可: ログインユーザなら誰でも可)。
 * 非メンバーの場合は projectName / コメント投稿者氏名をマスクする。
 */
export async function listAllRetrospectivesForViewer(
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<AllRetroDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  const memberships = isAdmin
    ? []
    : await prisma.projectMember.findMany({
      where: { userId: viewerUserId },
      select: { projectId: true },
    });
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  // 2026-04-25 (feat/account-lock-and-ui-consistency): admin であっても draft は
  // 「全○○」横断ビューには出さない (要件: 全○○ には公開範囲='public' のみ表示)。
  // admin が draft を管理削除したい場合はプロジェクト個別画面から行う。
  // PR #165: viewerIsCreator は project-list 側に移したので、本関数では viewerUserId を memberships 取得のみで使用。
  const retros = await prisma.retrospective.findMany({
    where: { deletedAt: null, visibility: 'public' },
    include: {
      project: { select: { id: true, name: true, deletedAt: true } },
    },
    orderBy: { conductedDate: 'desc' },
  });

  // createdBy / updatedBy のユーザ名を解決 (PR #199: コメントは別経路 /api/comments で取得)
  const userIds = [...new Set([
    ...retros.map((r) => r.createdBy),
    ...retros.map((r) => r.updatedBy),
  ])];
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  return retros.map((r) => {
    const isMember = isAdmin || memberProjectIds.has(r.projectId);
    const projectDeleted = r.project?.deletedAt != null;
    return {
      id: r.id,
      projectId: r.projectId,
      projectName: isMember ? r.project?.name ?? null : null,
      projectDeleted: isAdmin ? projectDeleted : false,
      canAccessProject: isMember && !projectDeleted,
      conductedDate: r.conductedDate.toISOString().split('T')[0],
      planSummary: r.planSummary,
      actualSummary: r.actualSummary,
      goodPoints: r.goodPoints,
      problems: r.problems,
      improvements: r.improvements,
      state: r.state,
      visibility: r.visibility,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      // fix/cross-list-non-member-columns (2026-04-27): 横断ビューの行自体が
      // visibility='public' で公開されている以上、関係者の氏名は表示してナレッジ共有を促進する。
      // プロジェクト名は機微情報扱いを維持 (上記 projectName 行で isMember gate 残置)。
      createdByName: userMap.get(r.createdBy) ?? null,
      updatedByName: userMap.get(r.updatedBy) ?? null,
    };
  });
}

export async function listRetrospectives(
  projectId: string,
  _viewerUserId: string,
  viewerSystemRole: string,
): Promise<RetroDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  // 2026-04-24: 非 admin は一覧に draft を一切含めない (自分の draft も除外)。
  // draft の個別参照は getRetrospective が作成者本人/admin のみ許可する。
  const visibilityWhere = isAdmin ? {} : { visibility: 'public' };

  // PR #199: コメントは polymorphic comments テーブル経由 (/api/comments) で取得するため
  //   include: { comments: ... } は不要。retro 本体だけ load する。
  const retros = await prisma.retrospective.findMany({
    where: { projectId, deletedAt: null, ...visibilityWhere },
    orderBy: { conductedDate: 'desc' },
  });

  return retros.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    conductedDate: r.conductedDate.toISOString().split('T')[0],
    planSummary: r.planSummary,
    actualSummary: r.actualSummary,
    goodPoints: r.goodPoints,
    problems: r.problems,
    improvements: r.improvements,
    state: r.state,
    visibility: r.visibility,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createRetrospective(
  projectId: string,
  input: CreateRetrospectiveInput,
  userId: string,
): Promise<RetroDTO> {
  const r = await prisma.retrospective.create({
    data: {
      projectId,
      conductedDate: new Date(input.conductedDate),
      planSummary: input.planSummary,
      actualSummary: input.actualSummary,
      goodPoints: input.goodPoints,
      problems: input.problems,
      estimateGapFactors: input.estimateGapFactors,
      scheduleGapFactors: input.scheduleGapFactors,
      qualityIssues: input.qualityIssues,
      riskResponseEvaluation: input.riskResponseEvaluation,
      improvements: input.improvements,
      knowledgeToShare: input.knowledgeToShare,
      visibility: input.visibility ?? 'draft',
      createdBy: userId,
      updatedBy: userId,
    },
  });
  return {
    id: r.id,
    projectId: r.projectId,
    conductedDate: r.conductedDate.toISOString().split('T')[0],
    planSummary: r.planSummary,
    actualSummary: r.actualSummary,
    goodPoints: r.goodPoints,
    problems: r.problems,
    improvements: r.improvements,
    state: r.state,
    visibility: r.visibility,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function confirmRetrospective(retroId: string, userId: string): Promise<void> {
  await prisma.retrospective.update({
    where: { id: retroId },
    data: { state: 'confirmed', updatedBy: userId },
  });
}

/**
 * 振り返りを更新する。
 *
 * 2026-04-24: **作成者 (createdBy) 本人のみ許可**。admin であっても他人の振り返りは
 * 編集不可 (管理業務は削除のみ)。
 *
 * @throws {Error} 'NOT_FOUND' — 振り返りが存在しない or 論理削除済み
 * @throws {Error} 'FORBIDDEN' — 呼出ユーザが作成者ではない
 */
export async function updateRetrospective(
  retroId: string,
  input: {
    conductedDate?: string;
    planSummary?: string;
    actualSummary?: string;
    goodPoints?: string;
    problems?: string;
    improvements?: string;
    estimateGapFactors?: string | null;
    scheduleGapFactors?: string | null;
    qualityIssues?: string | null;
    riskResponseEvaluation?: string | null;
    knowledgeToShare?: string | null;
    /** 'draft' | 'confirmed' 等。確定操作から同一 PATCH で受け付けるため許容 */
    state?: string;
    /** PR #60: 公開範囲 (draft / public) */
    visibility?: string;
  },
  userId: string,
): Promise<void> {
  const existing = await prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null },
    select: { createdBy: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  if (existing.createdBy !== userId) throw new Error('FORBIDDEN');

  const data: Record<string, unknown> = { updatedBy: userId };
  if (input.conductedDate !== undefined) data.conductedDate = new Date(input.conductedDate);
  if (input.planSummary !== undefined) data.planSummary = input.planSummary;
  if (input.actualSummary !== undefined) data.actualSummary = input.actualSummary;
  if (input.goodPoints !== undefined) data.goodPoints = input.goodPoints;
  if (input.problems !== undefined) data.problems = input.problems;
  if (input.improvements !== undefined) data.improvements = input.improvements;
  if (input.estimateGapFactors !== undefined) data.estimateGapFactors = input.estimateGapFactors;
  if (input.scheduleGapFactors !== undefined) data.scheduleGapFactors = input.scheduleGapFactors;
  if (input.qualityIssues !== undefined) data.qualityIssues = input.qualityIssues;
  if (input.riskResponseEvaluation !== undefined) data.riskResponseEvaluation = input.riskResponseEvaluation;
  if (input.knowledgeToShare !== undefined) data.knowledgeToShare = input.knowledgeToShare;
  if (input.state !== undefined) data.state = input.state;
  if (input.visibility !== undefined) data.visibility = input.visibility;

  await prisma.retrospective.update({ where: { id: retroId }, data });
}

/**
 * 振り返りを論理削除する (deletedAt をセット)。
 *
 * 2026-04-24: 作成者本人 OR admin のみ許可。admin は「全振り返り」画面からの
 * 管理削除を想定。
 *
 * @throws {Error} 'NOT_FOUND' — 振り返りが存在しない or 既に削除済み
 * @throws {Error} 'FORBIDDEN' — 作成者でなく admin でもない
 */
export async function deleteRetrospective(
  retroId: string,
  userId: string,
  systemRole: string,
): Promise<void> {
  const existing = await prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null },
    select: { createdBy: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  const isCreator = existing.createdBy === userId;
  const isAdmin = systemRole === 'admin';
  if (!isCreator && !isAdmin) throw new Error('FORBIDDEN');

  const now = new Date();
  await prisma.$transaction([
    prisma.retrospective.update({
      where: { id: retroId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    prisma.attachment.updateMany({
      where: { entityType: 'retrospective', entityId: retroId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);
}

/**
 * プロジェクト「振り返り一覧」からの **visibility 一括更新** (PR #165 で project-scoped 化、
 * 元実装は PR #162 cross-list 用)。
 * PR #161 (Risk/Issue) と同じ二重防御パターン: where に projectId 追加 + per-row createdBy 判定 + silent skip。
 * admin であっても他人のレコードは更新しない (delete のみ admin 特権の既存方針と整合)。
 */
export async function bulkUpdateRetrospectivesVisibilityFromList(
  projectId: string,
  ids: string[],
  visibility: 'draft' | 'public',
  viewerUserId: string,
): Promise<{ updatedIds: string[]; skippedNotOwned: number; skippedNotFound: number }> {
  if (ids.length === 0) return { updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 };

  // PR #165: where に projectId 追加 (他プロジェクトの行が ids に混ざってもサーバ側で除外)
  const targets = await prisma.retrospective.findMany({
    where: { id: { in: ids }, projectId, deletedAt: null },
    select: { id: true, createdBy: true },
  });
  const skippedNotFound = ids.length - targets.length;
  const ownedIds = targets.filter((t) => t.createdBy === viewerUserId).map((t) => t.id);
  const skippedNotOwned = targets.length - ownedIds.length;

  if (ownedIds.length === 0) {
    return { updatedIds: [], skippedNotOwned, skippedNotFound };
  }

  await prisma.retrospective.updateMany({
    where: { id: { in: ownedIds } },
    data: { visibility, updatedBy: viewerUserId },
  });

  return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound };
}

/**
 * 単一振り返り取得 (権限チェック用)。
 *
 * 2026-04-24: viewerUserId / viewerSystemRole 渡した場合は visibility 判定を行い、
 * 他人の draft を閲覧しようとすると null を返す (公開範囲 draft は作成者/admin のみ)。
 * 未指定の場合は API route 層で ownerId/projectId を確認する用途として生行を返す。
 */
export async function getRetrospective(
  retroId: string,
  viewerUserId?: string,
  viewerSystemRole?: string,
): Promise<{ id: string; projectId: string; createdBy: string; visibility: string } | null> {
  const r = await prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null },
    select: { id: true, projectId: true, createdBy: true, visibility: true },
  });
  if (!r) return null;
  if (viewerUserId === undefined) return r;

  if (r.visibility === 'public') return r;
  const isCreator = r.createdBy === viewerUserId;
  const isAdmin = viewerSystemRole === 'admin';
  if (isCreator || isAdmin) return r;
  return null;
}

// PR #199: addComment は削除。polymorphic comments テーブルへ移行 (`/api/comments`)。
