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
import { generateAndPersistEntityEmbedding } from './embedding.service';
import type { CreateRetrospectiveInput } from '@/lib/validators/retrospective';

export type RetroDTO = {
  id: string;
  /** PR feat/asset-multi-project-linking: 「作成元プロジェクト」(audit / 起源表示用)。
   *  作成元 project が削除された後は null。検索/紐付け判定は linkedProjectIds を使うこと。 */
  projectId: string | null;
  /** 紐付け済プロジェクトの id 一覧 (M:N)。 */
  linkedProjectIds: string[];
  /** PR feat/asset-multi-linking-ui (Phase 2): UI 表示用の紐付け済プロジェクト詳細。 */
  linkedProjects: { id: string; name: string; deleted: boolean }[];
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
  viewerTenantId: string,
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
  // 2026-05-09 feedback: テナント越境防止のため tenantId フィルタを追加。
  //   旧 super_admin bypass (`isSampleData`) はテナント制御に集約したため削除。
  const retros = await prisma.retrospective.findMany({
    where: {
      deletedAt: null,
      visibility: 'public',
      tenantId: viewerTenantId,
    },
    include: {
      project: { select: { id: true, name: true, deletedAt: true } },
      // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
      retrospectiveProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
    orderBy: { conductedDate: 'desc' },
  });

  // createdBy / updatedBy のユーザ名を解決 (PR #199: コメントは別経路 /api/comments で取得)
  // 2026-05-12: 意図的な cross-tenant lookup。userIds は事前にテナント検証済の retros から
  //   抽出されるが、createdBy / updatedBy は過去に他テナント所属だった元 user の可能性 (退職後の
  //   テナント移動など) があり得るため tenantId フィルタは掛けない。氏名のみ select で機微情報なし。
  const userIds = [...new Set([
    ...retros.map((r) => r.createdBy),
    ...retros.map((r) => r.updatedBy),
  ])];
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  return retros.map((r) => {
    // PR feat/asset-multi-project-linking: 紐付け済プロジェクトのいずれかのメンバーなら isMember 扱い
    const linkedProjectIds = r.retrospectiveProjects.map((rp) => rp.projectId);
    const linkedProjects = r.retrospectiveProjects
      .filter((rp) => rp.project != null)
      .map((rp) => ({
        id: rp.project!.id,
        name: rp.project!.name,
        deleted: rp.project!.deletedAt != null,
      }));
    const isMember = isAdmin || linkedProjectIds.some((pid) => memberProjectIds.has(pid));
    const projectDeleted = r.project?.deletedAt != null;
    return {
      id: r.id,
      projectId: r.projectId,
      linkedProjectIds,
      linkedProjects,
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
  viewerUserId: string,
  viewerSystemRole: string,
  viewerTenantId: string,
): Promise<RetroDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  // 2026-05-01 (PR fix/visibility-auth-matrix): 「自分の draft は一覧に表示する」方針に変更。
  //   旧仕様 (2026-04-24): 非 admin は draft 一切除外 → 自分の起票を視認できず混乱した。
  //   新仕様: public + 自分の draft + (admin は他人の draft も) を表示。
  //   一覧 UI 側で「下書き」バッジを付与する (DEVELOPER_GUIDE §5.51)。
  const visibilityWhere = isAdmin
    ? {}
    : { OR: [{ visibility: 'public' }, { visibility: 'draft', createdBy: viewerUserId }] };

  // PR #199: コメントは polymorphic comments テーブル経由 (/api/comments) で取得するため
  //   include: { comments: ... } は不要。retro 本体だけ load する。
  // PR feat/asset-multi-project-linking: 「このプロジェクトに紐付いている」振り返りを返す。
  // 2026-05-09 feedback Phase 2-4: severity-1 越境対策。tenantId を where に必須化。
  const retros = await prisma.retrospective.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      ...visibilityWhere,
      retrospectiveProjects: { some: { projectId } },
    },
    include: {
      // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
      retrospectiveProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
    orderBy: { conductedDate: 'desc' },
  });

  return retros.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    linkedProjectIds: r.retrospectiveProjects.map((rp) => rp.projectId),
    linkedProjects: r.retrospectiveProjects
      .filter((rp) => rp.project != null)
      .map((rp) => ({
        id: rp.project!.id,
        name: rp.project!.name,
        deleted: rp.project!.deletedAt != null,
      })),
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
  tenantId: string,
): Promise<RetroDTO> {
  const r = await prisma.retrospective.create({
    data: {
      // PR feat/asset-multi-project-linking: projectId は **作成元** プロジェクト (audit)。
      //   検索はすべて retrospectiveProjects (M:N) 経由になるため、初期紐付けも作成する。
      projectId,
      retrospectiveProjects: { create: [{ projectId }] },
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

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding を生成 + 保存 (fail-safe)
  // PR #357 (2026-05-14): visibility='draft' (公開範囲: 自分のみ) は提案エンジン側で
  //   filter 除外されるため、embedding を生成せず Voyage API 呼出 (= 課金) を発生させない。
  if (r.visibility !== 'draft') {
    await generateAndPersistEntityEmbedding({
      table: 'retrospectives',
      rowId: r.id,
      tenantId,
      userId,
      text: composeRetrospectiveText({
        planSummary: input.planSummary,
        actualSummary: input.actualSummary,
        goodPoints: input.goodPoints,
        problems: input.problems,
        improvements: input.improvements,
        knowledgeToShare: input.knowledgeToShare ?? null,
      }),
      featureUnit: 'retrospective-embedding',
    });
  }

  return {
    id: r.id,
    projectId: r.projectId,
    linkedProjectIds: [projectId], // create 直後の紐付けは作成元のみ
    // create 直後は project info を取得していないため空配列。UI 側は再フェッチで反映する想定
    linkedProjects: [],
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

/**
 * PR #5-c: Retrospective の embedding 生成用 text 合成 helper。
 *
 * 振り返りの主要な意味を担う text フィールドを合成。estimateGapFactors / scheduleGapFactors /
 * qualityIssues / riskResponseEvaluation は補足項目で省略 (signal/noise 比を最適化)。
 */
/**
 * PR-X5 (2026-05-07): script (seed embedding 生成 / backfill) からも参照できるよう export 化。
 *   service 本体での呼出も同関数を継続利用するため、関数 signature / 実装は無変更。
 */
export function composeRetrospectiveText(fields: {
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  improvements: string;
  knowledgeToShare: string | null;
}): string {
  return [
    fields.planSummary,
    fields.actualSummary,
    fields.goodPoints,
    fields.problems,
    fields.improvements,
    fields.knowledgeToShare ?? '',
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}

export async function confirmRetrospective(
  retroId: string,
  userId: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-4: 越境状態確定を遮断するため findFirst で先に所有確認。
  const owned = await prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

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
  tenantId: string,
): Promise<void> {
  // 2026-05-09 (PR D / #20): 既存 text を含めて取得し、実値変更時のみ embedding を再生成。
  // 2026-05-09 feedback Phase 2-4: 越境編集を遮断するため where に tenantId 併記。
  //   既存 tenantId 引数 (元 embedding 用) を viewer 認可境界として再利用。
  const existing = await prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null, tenantId },
    select: {
      createdBy: true,
      planSummary: true,
      actualSummary: true,
      goodPoints: true,
      problems: true,
      improvements: true,
      knowledgeToShare: true,
      // PR #357 (2026-05-14): visibility 遷移 (draft ↔ public) で embedding 生成判定
      visibility: true,
    },
  });
  if (!existing) throw new Error('NOT_FOUND');
  if (existing.createdBy !== userId) throw new Error('FORBIDDEN');

  // PR #5-c + PR D (2026-05-09 / #20): text フィールドが「実値として変わったか」を比較で判定。
  const textFieldsChanging =
    (input.planSummary !== undefined && input.planSummary !== existing.planSummary) ||
    (input.actualSummary !== undefined && input.actualSummary !== existing.actualSummary) ||
    (input.goodPoints !== undefined && input.goodPoints !== existing.goodPoints) ||
    (input.problems !== undefined && input.problems !== existing.problems) ||
    (input.improvements !== undefined && input.improvements !== existing.improvements) ||
    (input.knowledgeToShare !== undefined && input.knowledgeToShare !== existing.knowledgeToShare);

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

  const r = await prisma.retrospective.update({ where: { id: retroId }, data });

  // PR #5-c + PR #357 (2026-05-14): embedding 生成判定マトリクス:
  //   - 新しい visibility が draft → 生成しない (公開範囲: 自分のみは提案候補外)
  //   - draft → public            → 生成 (text 変更不要、初回 embedding 化)
  //   - public → public           → text 変更時のみ生成
  //   - public → draft            → 生成しない (既存 embedding は保持)
  const wasDraft = existing.visibility === 'draft';
  const willBeDraft = (input.visibility ?? existing.visibility) === 'draft';
  const becameVisible = wasDraft && !willBeDraft;
  const stayedVisible = !wasDraft && !willBeDraft;
  const shouldGenerateEmbedding =
    !willBeDraft && (becameVisible || (stayedVisible && textFieldsChanging));

  if (shouldGenerateEmbedding) {
    await generateAndPersistEntityEmbedding({
      table: 'retrospectives',
      rowId: retroId,
      tenantId,
      userId,
      text: composeRetrospectiveText({
        planSummary: r.planSummary,
        actualSummary: r.actualSummary,
        goodPoints: r.goodPoints,
        problems: r.problems,
        improvements: r.improvements,
        knowledgeToShare: r.knowledgeToShare,
      }),
      featureUnit: 'retrospective-embedding',
    });
  }
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
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-4: 越境削除を遮断するため where に tenantId 必須化。
  const existing = await prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null, tenantId: viewerTenantId },
    select: { createdBy: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  const isCreator = existing.createdBy === userId;
  const isAdmin = systemRole === 'admin';
  if (!isCreator && !isAdmin) throw new Error('FORBIDDEN');

  const now = new Date();
  // PR fix/visibility-auth-matrix (2026-05-01): Comment も cascade soft-delete (§5.51)
  await prisma.$transaction([
    prisma.retrospective.update({
      where: { id: retroId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    prisma.attachment.updateMany({
      // 2026-05-12 severity-1 防御: tenantId 明示
      where: { tenantId: viewerTenantId, entityType: 'retrospective', entityId: retroId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.comment.updateMany({
      where: { tenantId: viewerTenantId, entityType: 'retrospective', entityId: retroId, deletedAt: null },
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
  viewerTenantId: string,
): Promise<{ updatedIds: string[]; skippedNotOwned: number; skippedNotFound: number }> {
  if (ids.length === 0) return { updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 };

  // PR #165: where に projectId 追加 (他プロジェクトの行が ids に混ざってもサーバ側で除外)
  // PR feat/asset-multi-project-linking: scope は M:N (retrospectiveProjects) 経由で判定する。
  // 2026-05-09 feedback Phase 2-4: 越境一括更新を遮断するため tenantId 併記。
  const targets = await prisma.retrospective.findMany({
    where: {
      id: { in: ids },
      deletedAt: null,
      tenantId: viewerTenantId,
      retrospectiveProjects: { some: { projectId } },
    },
    select: { id: true, createdBy: true },
  });
  const skippedNotFound = ids.length - targets.length;
  const ownedIds = targets.filter((t) => t.createdBy === viewerUserId).map((t) => t.id);
  const skippedNotOwned = targets.length - ownedIds.length;

  if (ownedIds.length === 0) {
    return { updatedIds: [], skippedNotOwned, skippedNotFound };
  }

  await prisma.retrospective.updateMany({
    // 2026-05-12 severity-1 防御: tenantId / createdBy 明示
    where: { id: { in: ownedIds }, tenantId: viewerTenantId, createdBy: viewerUserId },
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
  viewerTenantId?: string,
): Promise<{
  id: string;
  projectId: string | null;
  /** PR feat/asset-multi-project-linking: 紐付け済プロジェクトの id 一覧 (M:N) */
  linkedProjectIds: string[];
  createdBy: string;
  visibility: string;
} | null> {
  // 2026-05-09 feedback Phase 2-4: viewerTenantId が指定された場合のみ where に追加。
  //   内部呼び出し (cascade 削除等) は認可スキップ経路を維持。
  const tenantWhere = viewerTenantId !== undefined ? { tenantId: viewerTenantId } : {};
  const raw = await prisma.retrospective.findFirst({
    where: { id: retroId, deletedAt: null, ...tenantWhere },
    select: {
      id: true,
      projectId: true,
      createdBy: true,
      visibility: true,
      // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
      retrospectiveProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
  });
  if (!raw) return null;
  const r = {
    id: raw.id,
    projectId: raw.projectId,
    linkedProjectIds: raw.retrospectiveProjects.map((rp) => rp.projectId),
    createdBy: raw.createdBy,
    visibility: raw.visibility,
  };
  if (viewerUserId === undefined) return r;

  if (r.visibility === 'public') return r;
  const isCreator = r.createdBy === viewerUserId;
  const isAdmin = viewerSystemRole === 'admin';
  if (isCreator || isAdmin) return r;
  return null;
}

/**
 * PR feat/asset-multi-project-linking (2026-05-09 / Phase 1):
 *   別プロジェクトの「参考」タブから振り返りを自プロジェクトに紐付ける。
 *
 * 認可: API 層で「対象プロジェクトのメンバー」を確認済の前提 (linkRiskToProject と同方針)。
 *
 * @returns added=true 新規紐付け / false 既存 (idempotent)
 */
export async function linkRetrospectiveToProject(
  retroId: string,
  projectId: string,
): Promise<{ added: boolean }> {
  const [retro, project] = await Promise.all([
    prisma.retrospective.findFirst({
      where: { id: retroId, deletedAt: null },
      select: { id: true, tenantId: true },
    }),
    prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, tenantId: true },
    }),
  ]);
  if (!retro) throw new Error('NOT_FOUND');
  if (!project) throw new Error('PROJECT_NOT_FOUND');
  if (retro.tenantId !== project.tenantId) throw new Error('TENANT_MISMATCH');

  const existing = await prisma.retrospectiveProject.findUnique({
    where: { retrospectiveId_projectId: { retrospectiveId: retroId, projectId } },
    select: { id: true },
  });
  if (existing) return { added: false };

  await prisma.retrospectiveProject.create({
    data: { retrospectiveId: retroId, projectId },
  });
  return { added: true };
}

/**
 * 振り返りから指定プロジェクトの紐付けを解除する。本体は削除しない (orphan 化を許容)。
 */
export async function unlinkRetrospectiveFromProject(
  retroId: string,
  projectId: string,
  viewerTenantId: string,
): Promise<{ removed: boolean }> {
  // 2026-05-09 feedback Phase 2-4: 越境紐付け解除を遮断するため、対象 retro の tenant 一致を verify。
  const owned = await prisma.retrospective.findFirst({
    where: { id: retroId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) return { removed: false };

  const existing = await prisma.retrospectiveProject.findUnique({
    where: { retrospectiveId_projectId: { retrospectiveId: retroId, projectId } },
    select: { id: true },
  });
  if (!existing) return { removed: false };
  await prisma.retrospectiveProject.delete({ where: { id: existing.id } });
  return { removed: true };
}

// PR #199: addComment は削除。polymorphic comments テーブルへ移行 (`/api/comments`)。
