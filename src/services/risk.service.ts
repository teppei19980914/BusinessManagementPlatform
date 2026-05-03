/**
 * リスク・課題サービス
 *
 * 役割:
 *   プロジェクト運営中に発生する「リスク」(risk: 将来発生し得る事象) と
 *   「課題」(issue: 既に発生した事象) を統一テーブル risks_issues で管理する。
 *   2 種類は type 列で区別し、UI/権限/バリデーションは共通化している。
 *
 * 設計判断:
 *   - 統一テーブル: 90% の項目が共通 (タイトル / 内容 / 影響度 / 状態 / 担当 / 期限) のため
 *     1 テーブルで管理。risk のみ likelihood / risk_nature を持ち、issue は null 許容。
 *   - 公開範囲 (visibility): draft / public の 2 値
 *   - 脅威/好機分類 (riskNature, PR #60): risk の場合のみ threat / opportunity を持つ
 *     PMBOK 第 7 版の「機会 (opportunity)」概念に対応するため
 *   - 論理削除 (deletedAt) を採用。クローズ後も振り返りで参照するため
 *   - title / content に pg_trgm GIN インデックス (PR #65)
 *     → type='issue' かつ state='resolved' を「過去課題」として新案件に提案
 *
 * 認可 (2026-04-24 改修):
 *   - 参照: 非 admin は visibility='public' のみ一覧表示、draft は他人のものは存在しない扱い。
 *           admin は 全一覧 + 個別参照とも draft 含め全件閲覧可。
 *   - 編集: **作成者 (reporterId) 本人のみ**。admin であっても他人のリスク/課題は編集不可
 *           (管理業務は削除のみに限定する方針)。
 *   - 削除: 作成者本人 OR admin。admin は 全リスク/全課題 からの管理削除を想定。
 *   - 作成: 呼出元 API ルートで ProjectMember チェック済 (admin も非メンバーなら不可)。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: risks_issues)
 *   - DESIGN.md §8 (権限制御 — risk アクション)
 *   - DESIGN.md §23 (核心機能: 過去課題の提案)
 *   - SPECIFICATION.md (リスク・課題管理画面 / 全リスク・全課題画面)
 */

import { prisma } from '@/lib/db';
import { generateAndPersistEntityEmbedding } from './embedding.service';
// Prisma types used for Decimal handling in toRiskDTO
import type { CreateRiskInput } from '@/lib/validators/risk';
import type { Priority } from '@/types';

/**
 * PR-γ / 項目 2 + 7: priority を impact × likelihood から自動算出する。
 *
 * UI / API 経由で priority を直接指定することはできない (常に本関数で算出)。
 * 'medium' は 'high' 寄り扱い (高側に寄せる安全側評価)。
 *
 * リスク (type='risk'): impact=影響度 / likelihood=発生可能性 — 発生確率重視
 *   high/high → high, low/high → medium, high/low → low, low/low → minimal
 *
 * 課題 (type='issue'): impact=重要度 / likelihood=緊急度 — 重要度重視
 *   high/high → high, high/low → medium, low/high → low, low/low → minimal
 */
export function computePriority(
  type: string,
  impact: string,
  likelihood: string,
): Priority {
  const isHigh = (v: string): boolean => v === 'high' || v === 'medium';
  const iHigh = isHigh(impact);
  const lHigh = isHigh(likelihood);

  if (type === 'risk') {
    if (iHigh && lHigh) return 'high';
    if (!iHigh && lHigh) return 'medium';
    if (iHigh && !lHigh) return 'low';
    return 'minimal';
  }
  // issue: 重要度 (impact) を緊急度 (likelihood) より重視
  if (iHigh && lHigh) return 'high';
  if (iHigh && !lHigh) return 'medium';
  if (!iHigh && lHigh) return 'low';
  return 'minimal';
}

export type RiskDTO = {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  cause: string | null;
  impact: string;
  likelihood: string | null;
  priority: string;
  responsePolicy: string | null;
  responseDetail: string | null;
  reporterId: string;
  reporterName?: string;
  assigneeId: string | null;
  assigneeName?: string | null;
  deadline: string | null;
  state: string;
  result: string | null;
  lessonLearned: string | null;
  // PR #60
  visibility: string;
  riskNature: string | null;
  createdAt: string;
  updatedAt: string;
  /** PR #165: プロジェクト「リスク/課題一覧」での一括編集対象判定。viewer が作成者本人なら true。
   * undefined の場合は viewerUserId を渡さなかった内部呼び出し経路 (cascade 削除確認等)。 */
  viewerIsCreator?: boolean;
};

function toRiskDTO(r: {
  id: string;
  projectId: string;
  type: string;
  title: string;
  content: string;
  cause: string | null;
  impact: string;
  likelihood: string | null;
  priority: string;
  responsePolicy: string | null;
  responseDetail: string | null;
  reporterId: string;
  reporter?: { name: string };
  assigneeId: string | null;
  assignee?: { name: string } | null;
  deadline: Date | null;
  state: string;
  result: string | null;
  lessonLearned: string | null;
  visibility: string;
  riskNature: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RiskDTO {
  return {
    id: r.id,
    projectId: r.projectId,
    type: r.type,
    title: r.title,
    content: r.content,
    cause: r.cause,
    impact: r.impact,
    likelihood: r.likelihood,
    priority: r.priority,
    responsePolicy: r.responsePolicy,
    responseDetail: r.responseDetail,
    reporterId: r.reporterId,
    reporterName: r.reporter?.name,
    assigneeId: r.assigneeId,
    assigneeName: r.assignee?.name,
    deadline: r.deadline?.toISOString().split('T')[0] ?? null,
    state: r.state,
    result: r.result,
    lessonLearned: r.lessonLearned,
    visibility: r.visibility,
    riskNature: r.riskNature,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listRisks(
  projectId: string,
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<RiskDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  // 2026-05-01 (PR fix/visibility-auth-matrix): 「自分の draft は一覧に表示する」方針に変更。
  //   旧仕様 (2026-04-24): 非 admin は draft 一切除外 → 自分の起票を視認できず Toast 成功
  //   なのに一覧未反映で混乱する UX バグの根本原因 (DEVELOPER_GUIDE §5.51 参照)。
  //   新仕様: public は全員 + 自分の draft + (admin の場合は他人の draft も) を表示。
  //   一覧 UI 側で「下書き」バッジを付け、視認の混乱を防ぐ。
  const visibilityWhere = isAdmin
    ? {}
    : { OR: [{ visibility: 'public' }, { visibility: 'draft', reporterId: viewerUserId }] };

  const risks = await prisma.riskIssue.findMany({
    where: { projectId, deletedAt: null, ...visibilityWhere },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  // PR #165: プロジェクト「リスク/課題一覧」での一括編集対象判定。viewerIsCreator を DTO に乗せる。
  return risks.map((r) => ({ ...toRiskDTO(r), viewerIsCreator: r.reporterId === viewerUserId }));
}

/**
 * 「全リスク/課題」ビュー用 DTO。
 * 閲覧ユーザが紐づくプロジェクトの ProjectMember か否かで情報量を切り替える:
 *   - メンバー: projectName 見える + canAccessProject=true (詳細リンク表示)
 *   - 非メンバー: projectName / 顧客情報を一律マスク + canAccessProject=false
 * 担当者名 / 起票者名も「非メンバーには氏名非公開」とする (顧客情報に準ずる機微情報)
 */
export type AllRiskDTO = Omit<RiskDTO, 'assigneeName' | 'reporterName' | 'viewerIsCreator'> & {
  projectName: string | null;
  /** プロジェクトが論理削除済みか (admin のみ識別可、非 admin には null として秘匿) */
  projectDeleted: boolean;
  canAccessProject: boolean;
  reporterName: string | null;
  assigneeName: string | null;
  /** 作成者氏名 (非メンバーにはマスク) */
  createdByName: string | null;
  /** 更新者氏名 (非メンバーにはマスク) */
  updatedByName: string | null;
  // PR #165: 全○○一覧は read-only に戻し、viewerIsCreator は不要 (project list で持つ)
};

/**
 * 全プロジェクトのリスク/課題を取得する (認可: ログインユーザなら誰でも可)。
 * 非メンバーの場合は projectName / 顧客名 / 担当者氏名をマスクする。
 * システム管理者 (systemRole='admin') は全プロジェクトのメンバー相当として
 * マスキング対象外 (projectName / 氏名すべて閲覧可 + 編集/削除権限あり)。
 */
export async function listAllRisksForViewer(
  viewerUserId: string,
  viewerSystemRole: string,
): Promise<AllRiskDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';
  // ユーザが所属するプロジェクト ID 集合を先に取得 (非メンバー判定に使う)
  // admin の場合はこの後の判定で常に isMember=true として扱う
  const memberships = isAdmin
    ? []
    : await prisma.projectMember.findMany({
      where: { userId: viewerUserId },
      select: { projectId: true },
    });
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  // 2026-04-25 (feat/account-lock-and-ui-consistency): admin であっても draft は
  // 「全○○」横断ビューには出さない (要件: 全○○ には公開範囲='public' のみ表示)。
  // admin が draft を管理削除したい場合はプロジェクト個別画面の○○一覧から行う。
  // isAdmin は projectName / 担当者名のマスキング解除にのみ使う (フィルタには使わない)。
  const risks = await prisma.riskIssue.findMany({
    where: { deletedAt: null, visibility: 'public' },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
      project: { select: { id: true, name: true, deletedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // createdBy / updatedBy は scalar カラムで User リレーションが張られていないため、
  // 関連ユーザ名をバルクで 1 クエリ取得して map 引きする (N+1 回避)。
  const userIds = Array.from(new Set(risks.flatMap((r) => [r.createdBy, r.updatedBy])));
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userNameById = new Map(users.map((u) => [u.id, u.name]));

  return risks.map((r) => {
    const isMember = isAdmin || memberProjectIds.has(r.projectId);
    const projectDeleted = r.project?.deletedAt != null;
    return {
      ...toRiskDTO(r),
      projectName: isMember ? r.project?.name ?? null : null,
      projectDeleted: isAdmin ? projectDeleted : false, // admin 以外には削除状態を秘匿
      // 孤児プロジェクト (deleted) への詳細リンクは admin 以外は許可しない
      canAccessProject: isMember && !projectDeleted,
      // fix/cross-list-non-member-columns (PR #157, 2026-04-27 ユーザ要望):
      //   旧仕様 (PR #55): 非メンバーには氏名を null にして 顧客情報相当の機微扱い。
      //   新仕様: 「全リスク/全課題」は visibility='public' のものだけ表示する横断ビューであり、
      //   行自体が公開されている以上、担当者・起票者・作成者・更新者の氏名は公開して
      //   アサイン状況を把握できる方がナレッジ共有上有用。プロジェクト名は引き続き
      //   非メンバーにマスクする (案件名は機微情報扱いを維持)。
      reporterName: r.reporter?.name ?? null,
      assigneeName: r.assignee?.name ?? null,
      createdByName: userNameById.get(r.createdBy) ?? null,
      updatedByName: userNameById.get(r.updatedBy) ?? null,
    };
  });
}

/**
 * 単一リスク/課題を取得する。
 *
 * 2026-04-24: draft は **作成者本人 + admin のみ** 参照可。他人の draft は null を返す
 * (情報漏洩を避けるため「存在しない」と同等に扱う、NOT_FOUND と区別しない)。
 * viewerUserId / viewerSystemRole を省略した場合は認可判定をスキップし生データを返す
 * (サーバ内部で cascade 削除の対象確認等に使う、人間の UI 経由には使わないこと)。
 */
export async function getRisk(
  riskId: string,
  viewerUserId?: string,
  viewerSystemRole?: string,
): Promise<RiskDTO | null> {
  const r = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });
  if (!r) return null;

  // 認可オフの内部呼び出し (viewerUserId 未指定) はそのまま返す
  if (viewerUserId === undefined) return toRiskDTO(r);

  if (r.visibility === 'public') return toRiskDTO(r);

  // draft: 作成者本人 or admin のみ参照可
  const isCreator = r.reporterId === viewerUserId;
  const isAdmin = viewerSystemRole === 'admin';
  if (isCreator || isAdmin) return toRiskDTO(r);

  return null;
}

export async function createRisk(
  projectId: string,
  input: CreateRiskInput,
  userId: string,
  tenantId: string,
): Promise<RiskDTO> {
  const r = await prisma.riskIssue.create({
    data: {
      projectId,
      type: input.type,
      title: input.title,
      content: input.content,
      cause: input.cause,
      impact: input.impact,
      likelihood: input.likelihood,
      // PR-γ / 項目 2/7: priority は impact × likelihood から service 層で自動算出。
      // UI から直接指定不可 (input.priority は無視)。
      priority: computePriority(input.type, input.impact, input.likelihood ?? 'low'),
      responsePolicy: input.responsePolicy,
      responseDetail: input.responseDetail,
      reporterId: userId,
      assigneeId: input.assigneeId,
      deadline: input.deadline ? new Date(input.deadline) : undefined,
      visibility: input.visibility ?? 'draft',
      riskNature: input.type === 'risk' ? input.riskNature : null,
      createdBy: userId,
      updatedBy: userId,
    },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding を生成 + 保存 (fail-safe)
  await generateAndPersistEntityEmbedding({
    table: 'risks_issues',
    rowId: r.id,
    tenantId,
    userId,
    text: composeRiskText({
      title: input.title,
      content: input.content,
      cause: input.cause ?? null,
      responsePolicy: input.responsePolicy ?? null,
      responseDetail: input.responseDetail ?? null,
    }),
    featureUnit: 'risk-issue-embedding',
  });

  return toRiskDTO(r);
}

/**
 * PR #5-c: RiskIssue の embedding 生成用 text 合成 helper。
 *
 * 意味検索の主たるシグナルとなる text フィールドを合成。impact / likelihood / priority
 * 等の列挙値はベクトル化に貢献しないため除外。result / lessonLearned は事後追記される
 * 性質のため、create 時点では空 → 別途 update 時に embedding 再生成される。
 */
function composeRiskText(fields: {
  title: string;
  content: string;
  cause: string | null;
  responsePolicy: string | null;
  responseDetail: string | null;
}): string {
  return [
    fields.title,
    fields.content,
    fields.cause ?? '',
    fields.responsePolicy ?? '',
    fields.responseDetail ?? '',
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * リスク/課題を更新する。
 *
 * 2026-04-24: **作成者 (reporterId) 本人のみ許可**。admin であっても他人のリスク/課題は
 * 編集不可 (管理業務は削除のみに限定する方針)。該当なしは FORBIDDEN を投げる。
 *
 * @throws {Error} 'NOT_FOUND' — リスク/課題が存在しない or 論理削除済み
 * @throws {Error} 'FORBIDDEN' — 呼出ユーザが作成者ではない
 */
export async function updateRisk(
  riskId: string,
  input: Partial<CreateRiskInput> & {
    state?: string;
    // null は明示クリア用 (validator schema で .nullable() 済、§5.12)
    result?: string | null;
    lessonLearned?: string | null;
  },
  userId: string,
  tenantId: string,
): Promise<RiskDTO> {
  const existing = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null },
    select: { reporterId: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  if (existing.reporterId !== userId) throw new Error('FORBIDDEN');

  // PR #5-c: text フィールドのいずれかが更新対象かを先に判定
  const textFieldsChanging =
    input.title !== undefined ||
    input.content !== undefined ||
    input.cause !== undefined ||
    input.responsePolicy !== undefined ||
    input.responseDetail !== undefined;

  const data: Record<string, unknown> = { updatedBy: userId };

  if (input.title !== undefined) data.title = input.title;
  if (input.content !== undefined) data.content = input.content;
  if (input.cause !== undefined) data.cause = input.cause;
  // PR-γ: impact / likelihood が変わるたびに priority を再計算する。
  // priority は **input から直接受け取らず**、常に (impact, likelihood, type) から算出。
  if (input.impact !== undefined) data.impact = input.impact;
  if (input.likelihood !== undefined) data.likelihood = input.likelihood;
  if (input.impact !== undefined || input.likelihood !== undefined) {
    // 既存値とマージして再計算
    const existingForPriority = await prisma.riskIssue.findUniqueOrThrow({
      where: { id: riskId },
      select: { type: true, impact: true, likelihood: true },
    });
    const newImpact = (input.impact ?? existingForPriority.impact) as string;
    const newLikelihood = (input.likelihood ?? existingForPriority.likelihood ?? 'low') as string;
    data.priority = computePriority(existingForPriority.type, newImpact, newLikelihood);
  }
  if (input.responsePolicy !== undefined) data.responsePolicy = input.responsePolicy;
  if (input.responseDetail !== undefined) data.responseDetail = input.responseDetail;
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
  // null は明示的にクリア (担当者削除と同様)、`new Date(null)` で 1970 epoch に化けるのを防ぐ
  if (input.deadline !== undefined) data.deadline = input.deadline === null ? null : new Date(input.deadline);
  if (input.state !== undefined) data.state = input.state;
  if (input.result !== undefined) data.result = input.result;
  if (input.lessonLearned !== undefined) data.lessonLearned = input.lessonLearned;
  if (input.visibility !== undefined) data.visibility = input.visibility;
  if (input.riskNature !== undefined) data.riskNature = input.riskNature;

  const r = await prisma.riskIssue.update({
    where: { id: riskId },
    data,
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });

  // PR #5-c: text 変更時のみ embedding を再生成
  if (textFieldsChanging) {
    await generateAndPersistEntityEmbedding({
      table: 'risks_issues',
      rowId: riskId,
      tenantId,
      userId,
      text: composeRiskText({
        title: r.title,
        content: r.content,
        cause: r.cause,
        responsePolicy: r.responsePolicy,
        responseDetail: r.responseDetail,
      }),
      featureUnit: 'risk-issue-embedding',
    });
  }

  return toRiskDTO(r);
}

/**
 * プロジェクト「リスク/課題一覧」からの **一括更新** (PR #165 / refactor/bulk-update-to-project-list で
 * cross-list から project-scoped に移し替え。元実装は PR #161 / feat/cross-list-bulk-update)。
 *
 * 設計判断:
 *   - **scope は projectId に限定**: where に projectId を加え、他プロジェクトのレコードを
 *     ids に混ぜても触れない (PR #165 で cross-list 廃止に伴い導入)。
 *   - 編集権限は単発 update と同じ「**reporter (作成者) 本人のみ**」(2026-04-24 の方針を踏襲)。
 *     viewer 自身が作成していないレコードは silently skip し、結果に skippedNotOwned カウントを返す。
 *     行が混在しても update は **reporter 本人分だけが反映** されるため、誤更新の事故が起きない。
 *   - admin であっても他人のレコードは更新しない (admin の管理操作は削除に限定する既存方針と一致)。
 *   - 全件更新の事故防止: 呼出側 (API 層) で「フィルター 1 つ以上の適用」を必須化する。
 *   - patch は state / assigneeId / deadline の 3 項目に限定 (自由文の一括置換は UX が壊れやすい)。
 *
 * @returns updatedIds: 実際に更新した ID 配列 / skippedNotOwned: 作成者違いで skip した数 /
 *          skippedNotFound: 存在しない or 既に削除済 or 別プロジェクトの数
 */
export async function bulkUpdateRisksFromList(
  projectId: string,
  ids: string[],
  patch: {
    state?: string;
    assigneeId?: string | null;
    deadline?: string | null;
  },
  viewerUserId: string,
): Promise<{ updatedIds: string[]; skippedNotOwned: number; skippedNotFound: number }> {
  if (ids.length === 0) return { updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 };

  // 一度のクエリで対象を取得し、所有権を行ごとに判定 (N+1 回避)
  // PR #165: where に projectId を加え、他プロジェクトのレコードは skippedNotFound 扱いにする
  const targets = await prisma.riskIssue.findMany({
    where: { id: { in: ids }, projectId, deletedAt: null },
    select: { id: true, reporterId: true },
  });
  const found = new Set(targets.map((t) => t.id));
  const skippedNotFound = ids.length - found.size;
  const ownedIds = targets.filter((t) => t.reporterId === viewerUserId).map((t) => t.id);
  const skippedNotOwned = targets.length - ownedIds.length;

  if (ownedIds.length === 0) {
    return { updatedIds: [], skippedNotOwned, skippedNotFound };
  }

  // updateRisk と同じく、undefined のキーは patch しない (false 値や null との区別を維持)
  const data: Record<string, unknown> = { updatedBy: viewerUserId };
  if (patch.state !== undefined) data.state = patch.state;
  if (patch.assigneeId !== undefined) data.assigneeId = patch.assigneeId;
  if (patch.deadline !== undefined) {
    // null 明示クリアは保持、`new Date(null)` (1970 epoch) を防ぐ (updateRisk §5.12 と同方針)
    data.deadline = patch.deadline === null ? null : new Date(patch.deadline);
  }

  await prisma.riskIssue.updateMany({
    where: { id: { in: ownedIds } },
    data,
  });

  return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound };
}

/**
 * リスク/課題を論理削除する。
 *
 * 2026-04-24: 作成者本人 OR admin のみ許可。admin は「全リスク / 全課題」画面から
 * 管理削除できるユースケースを想定。
 *
 * @throws {Error} 'NOT_FOUND' — リスク/課題が存在しない or 既に削除済み
 * @throws {Error} 'FORBIDDEN' — 作成者でなく admin でもない
 */
export async function deleteRisk(
  riskId: string,
  userId: string,
  systemRole: string,
): Promise<void> {
  const existing = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null },
    select: { reporterId: true, type: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  const isCreator = existing.reporterId === userId;
  const isAdmin = systemRole === 'admin';
  if (!isCreator && !isAdmin) throw new Error('FORBIDDEN');

  // PR #89: 紐づく Attachment も論理削除 (UI からアクセス不可になる孤児データ防止)
  // PR fix/visibility-auth-matrix (2026-05-01): Comment も cascade soft-delete。
  //   コメントの認可は投稿者本人のみ (admin 不可) に絞ったため、entity 削除時に
  //   一括クリアしないと「削除済 entity に紐づく宙ぶらりんコメント」が UI から
  //   操作不能の孤児になる (DEVELOPER_GUIDE §5.51)。
  const now = new Date();
  // entityType は entity の type 列を見る (risk / issue は同 model だが別 type)
  const commentEntityType = existing.type === 'risk' ? 'risk' : 'issue';
  await prisma.$transaction([
    prisma.riskIssue.update({
      where: { id: riskId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    prisma.attachment.updateMany({
      where: { entityType: 'risk', entityId: riskId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.comment.updateMany({
      where: { entityType: commentEntityType, entityId: riskId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);
}

const IMPACT_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高' };
const STATE_LABELS: Record<string, string> = { open: '未対応', in_progress: '対応中', monitoring: '監視中', resolved: '解消' };

export function risksToCSV(risks: RiskDTO[]): string {
  const headers = ['種別', '件名', '影響度', '優先度', '状態', '担当者', '期限', '起票日'];
  const rows = risks.map((r) => [
    r.type === 'risk' ? 'リスク' : '課題',
    `"${r.title.replace(/"/g, '""')}"`,
    IMPACT_LABELS[r.impact] || r.impact,
    IMPACT_LABELS[r.priority] || r.priority,
    STATE_LABELS[r.state] || r.state,
    r.assigneeName || '',
    r.deadline || '',
    r.createdAt.split('T')[0],
  ]);
  const bom = '\uFEFF';
  return bom + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}
