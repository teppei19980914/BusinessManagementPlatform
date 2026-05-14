/**
 * ナレッジサービス (本プロダクトの中核資産)
 *
 * 役割:
 *   過去プロジェクトで得た「調査・検証・障害対応・教訓」等の知見を蓄積し、
 *   次案件の見積もり/計画に再利用できる形で提供する。本プロダクトのコンセプト
 *   「運営するほど次のプロジェクトがうまくいく」を実現する中心エンティティ。
 *
 * 設計判断:
 *   - 公開範囲 (visibility) は draft / public の 2 値 (PR #60 で project/company を public に統合)
 *     - draft  : 作成者 + admin のみ閲覧可
 *     - public : 全ログインユーザが閲覧可
 *   - 多対多のプロジェクト紐付け (knowledge_projects) を持つが、紐付けゼロでも独立ナレッジとして成立
 *   - タグは 3 種類: techTags (技術) / processTags (工程) / businessDomainTags (業務ドメイン)
 *     → 提案型サービス (suggestion.service.ts) で類似度マッチングに使用
 *   - 全文検索のため knowledges.title / content に pg_trgm GIN インデックスを設置済 (PR #65)
 *
 * 認可 (2026-04-24 改修):
 *   - 参照: 非 admin は visibility='public' のみ一覧表示、draft は他人のものは存在しない扱い。
 *           admin は 全一覧 + 個別参照とも draft 含め全件閲覧可。
 *   - 編集: **作成者 (createdBy) 本人のみ**。admin であっても他人のナレッジは編集不可。
 *   - 削除: 作成者本人 OR admin。admin は 全ナレッジ からの管理削除を想定。
 *   - 作成: 呼出元 API ルートで ProjectMember チェック済 (admin も非メンバーなら不可)。
 *           ただしプロジェクト紐付けなしの全社ナレッジ作成は POST /api/knowledge で
 *           認証ユーザ全員に許可する (個人資産的な用途)。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: knowledges / knowledge_projects)
 *   - DESIGN.md §16 (全文検索設計 / pg_trgm)
 *   - DESIGN.md §23 (核心機能: 提案型サービス)
 *   - SPECIFICATION.md (ナレッジ一覧・編集・全ナレッジ画面)
 */

import { prisma } from '@/lib/db';
import { generateAndPersistEntityEmbedding } from './embedding.service';
import type { Prisma } from '@/generated/prisma/client';
import type { CreateKnowledgeInput } from '@/lib/validators/knowledge';

export type KnowledgeDTO = {
  id: string;
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
  reusability: string | null;
  techTags: string[];
  devMethod: string | null;
  processTags: string[];
  businessDomainTags: string[];
  visibility: string;
  createdBy: string;
  creatorName?: string;
  createdAt: string;
  updatedAt: string;
  projectIds?: string[];
};

function toKnowledgeDTO(k: {
  id: string;
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
  reusability: string | null;
  techTags: Prisma.JsonValue;
  devMethod: string | null;
  processTags: Prisma.JsonValue;
  businessDomainTags: Prisma.JsonValue;
  visibility: string;
  createdBy: string;
  creator?: { name: string };
  createdAt: Date;
  updatedAt: Date;
  knowledgeProjects?: { projectId: string }[];
}): KnowledgeDTO {
  return {
    id: k.id,
    title: k.title,
    knowledgeType: k.knowledgeType,
    background: k.background,
    content: k.content,
    result: k.result,
    conclusion: k.conclusion,
    recommendation: k.recommendation,
    reusability: k.reusability,
    techTags: (k.techTags as string[]) || [],
    devMethod: k.devMethod,
    processTags: (k.processTags as string[]) || [],
    businessDomainTags: (k.businessDomainTags as string[]) || [],
    visibility: k.visibility,
    createdBy: k.createdBy,
    creatorName: k.creator?.name,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
    projectIds: k.knowledgeProjects?.map((kp) => kp.projectId),
  };
}

export type ListKnowledgeParams = {
  keyword?: string;
  knowledgeType?: string;
  visibility?: string;
  page?: number;
  limit?: number;
};

/**
 * ナレッジ一覧（公開範囲制御付き、PR #60 で 2 値体系に刷新）
 * - public: 全ログインユーザ閲覧可
 * - draft : 作成者 + admin のみ閲覧可
 */
export async function listKnowledge(
  params: ListKnowledgeParams,
  userId: string,
  systemRole: string,
  viewerTenantId: string,
): Promise<{ data: KnowledgeDTO[]; total: number }> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || 20, 100);
  const skip = (page - 1) * limit;

  // 2026-05-09 feedback Phase 2-4: severity-1 テナント越境対策。
  //   Knowledge は schema 上 tenantId 列を持つため where に直接フィルタ追加。
  const conditions: Prisma.KnowledgeWhereInput[] = [
    { deletedAt: null },
    { tenantId: viewerTenantId },
  ];

  // 2026-05-08: シードナレッジ (isSampleData=true) は全ナレッジ画面で非表示。
  //   super_admin role は bypass (= シードデータ管理のため表示+編集可)。
  //   Project.isSampleData (PR-X5) と同じ運用パターン。
  if (systemRole !== 'super_admin') {
    conditions.push({ isSampleData: false });
  }

  if (systemRole !== 'admin' && systemRole !== 'super_admin') {
    conditions.push({
      OR: [
        { visibility: 'public' },
        { visibility: 'draft', createdBy: userId },
      ],
    });
  }

  if (params.knowledgeType) {
    conditions.push({ knowledgeType: params.knowledgeType });
  }
  // ユーザ指定の visibility filter (例: 「下書きだけ表示」)。上記の権限フィルタと AND で合成され、
  // 非 admin が draft 指定時は「自分の draft のみ」になる (権限フィルタが効くため)。
  if (params.visibility) {
    conditions.push({ visibility: params.visibility });
  }
  if (params.keyword) {
    conditions.push({
      OR: [
        { title: { contains: params.keyword, mode: 'insensitive' as const } },
        { content: { contains: params.keyword, mode: 'insensitive' as const } },
      ],
    });
  }

  const where: Prisma.KnowledgeWhereInput = { AND: conditions };

  const [knowledges, total] = await Promise.all([
    prisma.knowledge.findMany({
      where,
      include: {
        creator: { select: { name: true } },
        knowledgeProjects: { select: { projectId: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.knowledge.count({ where }),
  ]);

  return { data: knowledges.map(toKnowledgeDTO), total };
}

/**
 * 全ナレッジ横断ビュー用の拡張 DTO。
 * プロジェクトリンク情報と更新者氏名を追加し、非メンバー向けのマスキングに対応。
 * 複数プロジェクトに紐付いたナレッジは「最初の紐付け先」を主プロジェクトとして扱う。
 */
export type AllKnowledgeDTO = KnowledgeDTO & {
  primaryProjectId: string | null;
  projectName: string | null;
  projectDeleted: boolean;
  canAccessProject: boolean;
  linkedProjectCount: number;
  updatedByName: string | null;
  // PR #165: 全ナレッジ画面は read-only に戻したので viewerIsCreator は不要 (project list 側で持つ)
};

/**
 * 全プロジェクト横断のナレッジを取得する (認可: ログインユーザなら誰でも可)。
 * 既存の公開範囲 (visibility) 制御は listKnowledge と同じ。
 * 非メンバー向けには主プロジェクト名・作成者氏名等をマスクする。
 */
export async function listAllKnowledgeForViewer(
  viewerUserId: string,
  viewerSystemRole: string,
  viewerTenantId: string,
): Promise<AllKnowledgeDTO[]> {
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
  // admin が draft を管理削除したい場合はプロジェクト個別画面 (/projects/[id]/knowledge) から行う。
  // isAdmin は projectName / 作成者氏名のマスキング解除にのみ使う (フィルタには使わない)。
  // 2026-05-09 feedback: テナント越境防止。tenantId フィルタに集約 (super_admin の
  //   `isSampleData` bypass は MANAGEMENT_TENANT_ID 所属で自然に表示されるため削除)。
  const where: Prisma.KnowledgeWhereInput = {
    deletedAt: null,
    visibility: 'public',
    tenantId: viewerTenantId,
  };

  const knowledges = await prisma.knowledge.findMany({
    where,
    include: {
      creator: { select: { name: true } },
      updater: { select: { name: true } },
      knowledgeProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return knowledges.map((k) => {
    const primary = k.knowledgeProjects[0];
    const primaryProjectId = primary?.projectId ?? null;
    const primaryProject = primary?.project ?? null;
    const isMember = primaryProjectId
      ? isAdmin || memberProjectIds.has(primaryProjectId)
      : isAdmin;
    const projectDeleted = primaryProject?.deletedAt != null;

    return {
      ...toKnowledgeDTO(k),
      primaryProjectId,
      projectName: isMember ? primaryProject?.name ?? null : null,
      projectDeleted: isAdmin ? projectDeleted : false,
      canAccessProject: isMember && !projectDeleted && primaryProjectId != null,
      linkedProjectCount: k.knowledgeProjects.length,
      // fix/cross-list-non-member-columns (PR #157, 2026-04-27): 横断「全ナレッジ」は visibility='public'
      // のものだけ表示しているため、作成者・更新者の氏名は公開してナレッジ共有を促進する。
      // projectName は機微情報扱いを維持 (上記 isMember gate)。
      updatedByName: k.updater?.name ?? null,
      creatorName: k.creator?.name,
      // PR #165: viewerIsCreator は全ナレッジでは不要 (read-only)、project list 側 KnowledgeDTO で個別判定。
    };
  });
}

/**
 * プロジェクトに紐づくナレッジのみを取得する (プロジェクト詳細「ナレッジ一覧」タブ用)。
 *
 * 既存 listKnowledge は全ナレッジ (visibility 制御のみ) を返すのに対し、
 * 本関数は knowledgeProjects 中間テーブル経由で projectId 一致のもののみ返す。
 *
 * 2026-05-11 改修: 公開範囲ラベルを「自分のみ / 全メンバー」に統一した際に visibility
 *   フィルタの不整合を発見し修正。
 *   旧仕様: プロジェクトメンバーは draft を含む全ナレッジを閲覧可。
 *   新仕様: Risk / Retrospective と同様、非 admin は public + 自分の draft のみ閲覧可。
 *   - 「自分のみ」(draft) を選んだ作成者の意図と一致 (= 他人には見せない)
 *   - admin はプロジェクト全 draft 閲覧可 (情報資産管理の責務)
 *   - getKnowledge (単独取得) と同じ認可ロジックでリスト/詳細の整合性を担保
 *
 * 認可前提: 呼び出し側 (API ルート) で checkProjectPermission('knowledge:read') を通過済み。
 */
export async function listKnowledgeByProject(
  projectId: string,
  viewerTenantId: string,
  viewerUserId?: string,
  viewerSystemRole?: string,
): Promise<KnowledgeDTO[]> {
  // 2026-05-09 feedback Phase 2-4: 越境一覧を遮断するため tenantId 必須化。
  // 2026-05-11: 公開範囲 (visibility) フィルタ追加。
  //   viewerUserId 未指定の内部呼び出し (cascade 削除等) は従来どおり全件返す。
  //   admin / super_admin はテナント内 draft も含めて全件閲覧可。
  const isAdmin = viewerSystemRole === 'admin' || viewerSystemRole === 'super_admin';
  const visibilityWhere =
    viewerUserId === undefined || isAdmin
      ? {}
      : { OR: [{ visibility: 'public' }, { visibility: 'draft', createdBy: viewerUserId }] };

  const knowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      ...visibilityWhere,
      knowledgeProjects: { some: { projectId } },
    },
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return knowledges.map(toKnowledgeDTO);
}

/**
 * 単一ナレッジを取得する。
 *
 * 2026-04-24: draft は作成者 + admin のみ参照可。他人の draft は null を返す
 * (情報漏洩防止)。viewerUserId / viewerSystemRole を省略した内部呼び出しは
 * 公開範囲によらず生行を返す (cascade 削除等の運用確認用)。
 */
export async function getKnowledge(
  knowledgeId: string,
  viewerUserId?: string,
  viewerSystemRole?: string,
  viewerTenantId?: string,
): Promise<KnowledgeDTO | null> {
  // 2026-05-09 feedback Phase 2-4: viewerTenantId が指定された場合のみ where に追加。
  //   内部呼び出し (cascade 削除等) は認可スキップ経路を維持しつつ、API 経路では必須。
  const tenantWhere = viewerTenantId !== undefined ? { tenantId: viewerTenantId } : {};
  const k = await prisma.knowledge.findFirst({
    where: { id: knowledgeId, deletedAt: null, ...tenantWhere },
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
  });
  if (!k) return null;

  if (viewerUserId === undefined) return toKnowledgeDTO(k);

  if (k.visibility === 'public') return toKnowledgeDTO(k);

  const isCreator = k.createdBy === viewerUserId;
  const isAdmin = viewerSystemRole === 'admin';
  if (isCreator || isAdmin) return toKnowledgeDTO(k);
  return null;
}

export async function createKnowledge(
  input: CreateKnowledgeInput,
  userId: string,
  tenantId: string,
): Promise<KnowledgeDTO> {
  // 2026-05-09 feedback Phase 2-4: data.tenantId を明示し schema DB DEFAULT 暗黙依存を解消。
  const k = await prisma.knowledge.create({
    data: {
      tenantId,
      title: input.title,
      knowledgeType: input.knowledgeType,
      background: input.background,
      content: input.content,
      result: input.result,
      conclusion: input.conclusion,
      recommendation: input.recommendation,
      reusability: input.reusability,
      techTags: (input.techTags || []) as Prisma.InputJsonValue,
      devMethod: input.devMethod,
      processTags: (input.processTags || []) as Prisma.InputJsonValue,
      businessDomainTags: (input.businessDomainTags || []) as Prisma.InputJsonValue,
      visibility: input.visibility,
      createdBy: userId,
      updatedBy: userId,
      knowledgeProjects: input.projectIds?.length
        ? { create: input.projectIds.map((pid) => ({ projectId: pid })) }
        : undefined,
    },
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
  });

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding を生成 + 保存。
  //   失敗時はサイレントにスキップ (本体保存は成功、suggestion engine は 2 軸縮退モード)。
  // PR #357 (2026-05-14): visibility='draft' (公開範囲: 自分のみ) は提案エンジン側で
  //   filter 除外されるため、embedding を生成せず Voyage API 呼出 (= 課金) も発生させない。
  if (k.visibility !== 'draft') {
    await generateAndPersistEntityEmbedding({
      table: 'knowledges',
      rowId: k.id,
      tenantId,
      userId,
      text: composeKnowledgeText({
        title: input.title,
        background: input.background,
        content: input.content,
        result: input.result,
        conclusion: input.conclusion ?? null,
        recommendation: input.recommendation ?? null,
      }),
      featureUnit: 'knowledge-embedding',
    });
  }

  return toKnowledgeDTO(k);
}

/**
 * PR #5-c: Knowledge の embedding 生成用 text 合成 helper。
 *
 * 意味検索の質を高めるため、Knowledge の主要な意味を担う text フィールドを改行結合して
 * Voyage AI に渡す。null フィールドは除外。
 */
/**
 * PR-X5 (2026-05-07): script (seed embedding 生成 / backfill) からも参照できるよう export 化。
 *   service 本体での呼出も同関数を継続利用するため、関数 signature / 実装は無変更。
 */
export function composeKnowledgeText(fields: {
  title: string;
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
}): string {
  return [
    fields.title,
    fields.background,
    fields.content,
    fields.result,
    fields.conclusion ?? '',
    fields.recommendation ?? '',
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * ナレッジを更新する。
 *
 * 2026-04-24: **作成者 (createdBy) 本人のみ許可**。admin であっても他人のナレッジは
 * 編集不可 (管理業務は削除のみ)。
 *
 * @throws {Error} 'NOT_FOUND' — ナレッジが存在しない or 論理削除済み
 * @throws {Error} 'FORBIDDEN' — 呼出ユーザが作成者ではない
 */
export async function updateKnowledge(
  knowledgeId: string,
  input: Partial<CreateKnowledgeInput>,
  userId: string,
  tenantId: string,
): Promise<KnowledgeDTO> {
  // 2026-05-09 (PR D / #20): 既存 text を含めて取得し、入力 text が「実際に変わったか」を判定。
  //   旧実装は `input.title !== undefined` だけで「フォームが title を送ってきた = 変更あり」
  //   とみなし、UI が常に全フィールドを送る場合に embedding が無駄に再生成されていた。
  //   defense-in-depth: フォームが部分更新を送ってきても、内容が同一なら LLM 課金を回避。
  // 2026-05-09 feedback Phase 2-4: 越境編集を遮断するため where に tenantId 併記。
  //   既存 tenantId 引数 (元 embedding 用) を viewer 認可境界として再利用。
  const existing = await prisma.knowledge.findFirst({
    where: { id: knowledgeId, deletedAt: null, tenantId },
    select: {
      createdBy: true,
      title: true,
      background: true,
      content: true,
      result: true,
      conclusion: true,
      recommendation: true,
      // PR #357 (2026-05-14): visibility 遷移 (draft ↔ public) で embedding 生成判定
      visibility: true,
    },
  });
  if (!existing) throw new Error('NOT_FOUND');
  if (existing.createdBy !== userId) throw new Error('FORBIDDEN');

  // 2026-05-11 defense-in-depth: 「全メンバー」(public) 化する更新で、
  //   title が input でも DB でも空の場合は拒否。
  //   通常 validator (updateKnowledgeSchema) が title=='' を弾くが、API 直叩きで
  //   `{ visibility: 'public' }` のみ送られて DB の既存 title が空のケースを救う。
  if (input.visibility === 'public') {
    const effectiveTitle = input.title !== undefined ? input.title : existing.title;
    if (!effectiveTitle || effectiveTitle.trim().length === 0) {
      throw new Error('PUBLIC_REQUIRES_TITLE');
    }
  }

  // PR #5-c + PR D (2026-05-09 / #20): text フィールドが「実値として変わったか」を比較で判定。
  //   未指定 (undefined) または既存値と同一なら trigger しない (LLM 課金回避)。
  const textFieldsChanging =
    (input.title !== undefined && input.title !== existing.title) ||
    (input.background !== undefined && input.background !== existing.background) ||
    (input.content !== undefined && input.content !== existing.content) ||
    (input.result !== undefined && input.result !== existing.result) ||
    (input.conclusion !== undefined && input.conclusion !== existing.conclusion) ||
    (input.recommendation !== undefined && input.recommendation !== existing.recommendation);

  const data: Prisma.KnowledgeUpdateInput = { updater: { connect: { id: userId } } };

  if (input.title !== undefined) data.title = input.title;
  if (input.knowledgeType !== undefined) data.knowledgeType = input.knowledgeType;
  if (input.background !== undefined) data.background = input.background;
  if (input.content !== undefined) data.content = input.content;
  if (input.result !== undefined) data.result = input.result;
  if (input.conclusion !== undefined) data.conclusion = input.conclusion;
  if (input.recommendation !== undefined) data.recommendation = input.recommendation;
  if (input.reusability !== undefined) data.reusability = input.reusability;
  if (input.techTags !== undefined) data.techTags = input.techTags as Prisma.InputJsonValue;
  if (input.devMethod !== undefined) data.devMethod = input.devMethod;
  if (input.processTags !== undefined) data.processTags = input.processTags as Prisma.InputJsonValue;
  if (input.businessDomainTags !== undefined)
    data.businessDomainTags = input.businessDomainTags as Prisma.InputJsonValue;
  if (input.visibility !== undefined) data.visibility = input.visibility;

  const k = await prisma.knowledge.update({
    where: { id: knowledgeId },
    data,
    include: {
      creator: { select: { name: true } },
      knowledgeProjects: { select: { projectId: true } },
    },
  });

  // PR #5-c + PR #357 (2026-05-14): embedding 生成判定マトリクス:
  //   - 新しい visibility が draft     → 生成しない (公開範囲: 自分のみは提案候補外)
  //   - draft → public                → 生成 (text 変更不要、初回 embedding 化)
  //   - public → public              → text 変更時のみ生成
  //   - public → draft               → 生成しない (既存 embedding は保持)
  const wasDraft = existing.visibility === 'draft';
  const willBeDraft = (input.visibility ?? existing.visibility) === 'draft';
  const becameVisible = wasDraft && !willBeDraft; // draft → public
  const stayedVisible = !wasDraft && !willBeDraft; // public → public
  const shouldGenerateEmbedding =
    !willBeDraft && (becameVisible || (stayedVisible && textFieldsChanging));

  if (shouldGenerateEmbedding) {
    await generateAndPersistEntityEmbedding({
      table: 'knowledges',
      rowId: knowledgeId,
      tenantId,
      userId,
      text: composeKnowledgeText({
        title: k.title,
        background: k.background,
        content: k.content,
        result: k.result,
        conclusion: k.conclusion,
        recommendation: k.recommendation,
      }),
      featureUnit: 'knowledge-embedding',
    });
  }

  return toKnowledgeDTO(k);
}

/**
 * ナレッジを論理削除する。
 *
 * 2026-04-24: 作成者本人 OR admin のみ許可。admin は「全ナレッジ」画面からの
 * 管理削除を想定。
 *
 * @throws {Error} 'NOT_FOUND' — ナレッジが存在しない or 既に削除済み
 * @throws {Error} 'FORBIDDEN' — 作成者でなく admin でもない
 */
export async function deleteKnowledge(
  knowledgeId: string,
  userId: string,
  systemRole: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2-4: 越境削除を遮断するため where に tenantId 必須化。
  const existing = await prisma.knowledge.findFirst({
    where: { id: knowledgeId, deletedAt: null, tenantId: viewerTenantId },
    select: { createdBy: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  const isCreator = existing.createdBy === userId;
  const isAdmin = systemRole === 'admin';
  if (!isCreator && !isAdmin) throw new Error('FORBIDDEN');

  // PR #89: 紐づく Attachment も同時に論理削除 (孤児データ防止)
  // PR fix/visibility-auth-matrix (2026-05-01): Comment も cascade soft-delete (§5.51)
  const now = new Date();
  await prisma.$transaction([
    prisma.knowledge.update({
      where: { id: knowledgeId },
      data: { deletedAt: now, updater: { connect: { id: userId } } },
    }),
    prisma.attachment.updateMany({
      // 2026-05-12 severity-1 防御: tenantId 明示
      where: { tenantId: viewerTenantId, entityType: 'knowledge', entityId: knowledgeId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.comment.updateMany({
      where: { tenantId: viewerTenantId, entityType: 'knowledge', entityId: knowledgeId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);
}

/**
 * プロジェクト「ナレッジ一覧」からの **visibility 一括更新** (PR #165 で project-scoped 化、
 * 元実装は PR #162 cross-list 用)。
 * Knowledge は多対多 (knowledgeProjects 中間テーブル) でプロジェクトに紐付くので、
 * **where に `knowledgeProjects: { some: { projectId } }` を加え、当該プロジェクトに
 * 紐付いているナレッジのみを対象にする**。
 * PR #161 (Risk/Issue) と同じ二重防御: per-row createdBy 判定 + silent skip。
 * admin であっても他人のナレッジは更新しない。
 */
export async function bulkUpdateKnowledgeVisibilityFromList(
  projectId: string,
  ids: string[],
  visibility: 'draft' | 'public',
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

  // PR #165: project-scoped。当該プロジェクトに紐付くナレッジのみ対象 (多対多 中間テーブル経由)
  // 2026-05-09 feedback Phase 2-4: 越境一括更新を遮断するため tenantId フィルタを併記。
  // 2026-05-11: title を取得して、'public' 化時に空タイトルをスキップ判定に使う。
  const targets = await prisma.knowledge.findMany({
    where: {
      id: { in: ids },
      deletedAt: null,
      tenantId: viewerTenantId,
      knowledgeProjects: { some: { projectId } },
    },
    select: { id: true, createdBy: true, title: true },
  });
  const skippedNotFound = ids.length - targets.length;
  const owned = targets.filter((t) => t.createdBy === viewerUserId);
  const skippedNotOwned = targets.length - owned.length;

  // 2026-05-11: 「自分のみ」(draft) で作られたタイトル空のナレッジを一括で「全メンバー」(public)
  //   に昇格させようとした場合、サーバ側 validator のルール (public はタイトル必須) と
  //   整合するように silent skip する。逆方向 (public → draft) は制約緩和なので無条件で許可。
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

  // updateMany は relation connect 構文を受け付けないため scalar `updatedBy` を直接セットする
  // (単発 updateKnowledge の `updater: { connect }` 経路とは別経路、§5.21 と同方針)
  // 2026-05-12 severity-1 防御: tenantId / createdBy 明示
  await prisma.knowledge.updateMany({
    where: { id: { in: ownedIds }, tenantId: viewerTenantId, createdBy: viewerUserId },
    data: { visibility, updatedBy: viewerUserId },
  });

  return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound, skippedEmptyTitle };
}
