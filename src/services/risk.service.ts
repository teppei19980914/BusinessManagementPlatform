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
import { afterSafe } from '@/lib/after-safe';
import { assertAssigneeTenant } from '@/lib/assignee-validation';
import { generateAndPersistEntityEmbedding, generateAndPersistBatchEmbeddings } from './embedding.service';
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
  /** PR feat/asset-multi-project-linking: 「作成元プロジェクト」(audit / 起源表示用)。
   *  作成元 project が削除された後は null。検索/紐付け判定は linkedProjectIds を使うこと。 */
  projectId: string | null;
  /** 紐付け済プロジェクトの id 一覧 (M:N)。ここに含まれる project でアクセス権が発生する。 */
  linkedProjectIds: string[];
  /** PR feat/asset-multi-linking-ui (Phase 2): UI 表示用の紐付け済プロジェクト詳細
   *  (id + 表示名 + 削除状態)。ダイアログ「紐付けプロジェクト」セクションで使用。
   *  feat/crud-permission-redesign (2026-05-20): 「全リスク/全課題」横断ビューで非 ProjectMember には
   *  紐付け先プロジェクト名を秘匿するため、`name` を `string | null` に変更。
   *  null の場合 UI 側で「非公開のプロジェクト」プレースホルダ表示し、詳細リンクは無効化する。 */
  linkedProjects: { id: string; name: string | null; deleted: boolean }[];
  type: string;
  title: string;
  content: string;
  // feat/risk-issue-4-section (2026-05-26): 発生事象 (issue) / 考えられる事象 (risk) 列
  occurrence: string | null;
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
  // 2026-06-02: 一覧で作成者/更新者を表示するため名前解決 (listRisks / listAllRisksForViewer 経路で非null)。
  createdByName?: string | null;
  updatedByName?: string | null;
  /** PR #165: プロジェクト「リスク/課題一覧」での一括編集対象判定。viewer が作成者本人なら true。
   * undefined の場合は viewerUserId を渡さなかった内部呼び出し経路 (cascade 削除確認等)。
   * feat/asset-assignee-expansion (2026-05-26): 後方互換のため残置。新規 UI は viewerCanEdit を使う。 */
  viewerIsCreator?: boolean;
  /** feat/asset-assignee-expansion (2026-05-26): viewer が編集可能 (作成者 OR 担当者)。
   * UI の readOnly 判定 / 一括選択ロジックは本フラグを使う。
   * undefined の場合は viewerUserId を渡さなかった内部呼び出し経路。 */
  viewerCanEdit?: boolean;
};

function toRiskDTO(r: {
  id: string;
  projectId: string | null;
  type: string;
  title: string;
  content: string;
  occurrence: string | null;
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
  riskIssueProjects?: {
    projectId: string;
    project?: { id: string; name: string; deletedAt: Date | null };
  }[];
}): RiskDTO {
  const links = r.riskIssueProjects ?? [];
  return {
    id: r.id,
    projectId: r.projectId,
    linkedProjectIds: links.map((rp) => rp.projectId),
    linkedProjects: links
      .filter((rp) => rp.project != null)
      .map((rp) => ({
        id: rp.project!.id,
        name: rp.project!.name,
        deleted: rp.project!.deletedAt != null,
      })),
    type: r.type,
    title: r.title,
    content: r.content,
    occurrence: r.occurrence,
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

/**
 * feat/crud-permission-redesign (2026-05-20): linkedProjects[].name の per-link `isMember` gate を
 * 横断ビュー (`listAllRisksForViewer`) だけでなくプロジェクト内 list/get でも適用するための共通ヘルパ。
 *
 *   - viewer が紐付け先プロジェクトのメンバー: そのリンクの name/deleted を真値で返す
 *   - viewer が非メンバー: name=null / deleted=false で機微情報を秘匿 (admin は全公開)
 *
 * `toRiskDTO` の linkedProjects は無条件で name を返す素 DTO なので、各呼出元で post-process する。
 * RiskIssue/Retrospective 両方で同じパターンが必要なため独立 helper として export 候補だが、当面 service 内に閉じる。
 */
function gateLinkedProjectsName(
  links: { id: string; name: string | null; deleted: boolean }[],
  memberProjectIds: Set<string>,
  isAdmin: boolean,
): { id: string; name: string | null; deleted: boolean }[] {
  return links.map((l) => ({
    id: l.id,
    name: isAdmin || memberProjectIds.has(l.id) ? l.name : null,
    deleted: isAdmin ? l.deleted : false,
  }));
}

export async function listRisks(
  projectId: string,
  viewerUserId: string,
  viewerSystemRole: string,
  viewerTenantId: string,
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

  // PR feat/asset-multi-project-linking: 「このプロジェクトに紐付いている」リスク/課題を返す。
  //   作成元 (createdInProject = riskIssue.projectId) ではなく M:N 中間テーブル (RiskIssueProject)
  //   経由で判定。これにより A 作成 → B 紐付け の risk が B の一覧にも出る。
  // 2026-05-09 feedback Phase 2-3: severity-1 テナント越境対策。
  //   RiskIssue テーブルは tenantId 列を持つため where に直接指定し越境を遮断。
  //   旧仕様は projectId 直叩きで他テナントの risk が読まれる脆弱性があった。
  const risks = await prisma.riskIssue.findMany({
    where: {
      deletedAt: null,
      tenantId: viewerTenantId,
      ...visibilityWhere,
      riskIssueProjects: { some: { projectId } },
    },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
      // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
      //   linkedProjects DTO で表示するため、N+1 を避けるため include 経由で 1 クエリに統合。
      riskIssueProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  // feat/crud-permission-redesign (2026-05-20): linkedProjects[].name を per-link gate。
  //   project X のリスクタブで、X 以外の紐付け先プロジェクト名を非メンバーには秘匿する (severity-1 横展開漏洩修正)。
  const memberships = isAdmin
    ? []
    : (await prisma.projectMember.findMany({
        where: { userId: viewerUserId },
        select: { projectId: true },
      })) ?? [];
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  // 2026-06-02: 一覧表示用に作成者/更新者名をバルク取得 (氏名のみ select、N+1 回避)。
  //   tenantId フィルタを明示し自テナントの User のみ解決 = 越境した createdBy/updatedBy は
  //   null フォールバックされ氏名漏えいしない (User は 1 ユーザ 1 テナント、@@unique([tenantId,email]))。
  const audUserIds = Array.from(new Set(risks.flatMap((r) => [r.createdBy, r.updatedBy])));
  const audUsers = audUserIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: audUserIds }, tenantId: viewerTenantId }, select: { id: true, name: true } })
    : [];
  const audUserNameById = new Map(audUsers.map((u) => [u.id, u.name]));

  // PR #165 + feat/asset-assignee-expansion (2026-05-26): viewerIsCreator は後方互換のため残置、
  //   新規 UI 経路は viewerCanEdit (作成者 OR 担当者) を使う。
  return risks.map((r) => {
    const dto = toRiskDTO(r);
    const isCreator = r.reporterId === viewerUserId;
    const isAssignee = r.assigneeId === viewerUserId;
    return {
      ...dto,
      createdByName: audUserNameById.get(r.createdBy) ?? null,
      updatedByName: audUserNameById.get(r.updatedBy) ?? null,
      linkedProjects: gateLinkedProjectsName(dto.linkedProjects, memberProjectIds, isAdmin),
      viewerIsCreator: isCreator,
      viewerCanEdit: isCreator || isAssignee,
    };
  });
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
  viewerTenantId: string,
): Promise<AllRiskDTO[]> {
  const isAdmin = viewerSystemRole === 'admin';

  // perf/phase-5 (2026-06-01): memberships と risks findMany は独立なので Promise.all 並列化。
  //   セキュリティ invariant 不変:
  //     - tenantId = viewerTenantId (severity-1 越境防止) 保持
  //     - visibility='public' (draft 非表示) 保持
  //     - deletedAt: null 保持
  //     - memberProjectIds による per-link projectName マスキング (severity-1 個人情報漏洩防止) 保持
  //
  // ユーザが所属するプロジェクト ID 集合を先に取得 (非メンバー判定に使う)
  // admin の場合はこの後の判定で常に isMember=true として扱う
  //
  // 2026-04-25 (feat/account-lock-and-ui-consistency): admin であっても draft は
  // 「全○○」横断ビューには出さない (要件: 全○○ には公開範囲='public' のみ表示)。
  // admin が draft を管理削除したい場合はプロジェクト個別画面の○○一覧から行う。
  // isAdmin は projectName / 担当者名のマスキング解除にのみ使う (フィルタには使わない)。
  // 2026-05-09 feedback: テナント越境防止。`tenantId = viewerTenantId` で自テナントのみ
  //   返す (シードデータは MANAGEMENT_TENANT_ID 所属、super_admin が同テナントの場合のみ見える)。
  //   ※ super_admin の `isSampleData` bypass はテナントフィルタにより不要化したため削除。
  const [memberships, risks] = await Promise.all([
    isAdmin
      ? Promise.resolve(
          [] as Array<{ projectId: string }>,
        )
      : prisma.projectMember.findMany({
          where: { userId: viewerUserId },
          select: { projectId: true },
        }),
    prisma.riskIssue.findMany({
      where: {
        deletedAt: null,
        visibility: 'public',
        tenantId: viewerTenantId,
      },
      include: {
        reporter: { select: { name: true } },
        assignee: { select: { name: true } },
        project: { select: { id: true, name: true, deletedAt: true } },
        // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
        //   linkedProjects DTO で表示するため、N+1 を避けるため include 経由で 1 クエリに統合。
        riskIssueProjects: {
          select: {
            projectId: true,
            project: { select: { id: true, name: true, deletedAt: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));

  // createdBy / updatedBy は scalar カラムで User リレーションが張られていないため、
  // 関連ユーザ名をバルクで 1 クエリ取得して map 引きする (N+1 回避)。
  // 2026-05-12: 意図的な cross-tenant lookup。userIds は事前にテナント検証済の risks から
  //   抽出。氏名のみ select で機微情報は含まない。
  const userIds = Array.from(new Set(risks.flatMap((r) => [r.createdBy, r.updatedBy])));
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userNameById = new Map(users.map((u) => [u.id, u.name]));

  return risks.map((r) => {
    // PR feat/asset-multi-project-linking: 紐付け済プロジェクトのいずれかのメンバーなら member 扱い
    const linkedProjectIds = r.riskIssueProjects?.map((rp) => rp.projectId) ?? [];
    const isMember = isAdmin || linkedProjectIds.some((pid) => memberProjectIds.has(pid));
    const projectDeleted = r.project?.deletedAt != null;
    // feat/crud-permission-redesign (2026-05-20): per-link で「自分がメンバーであるプロジェクト」のみ
    //   name を返す。それ以外は null にし UI 側で「非公開のプロジェクト」表示。
    //   toRiskDTO の linkedProjects を gateLinkedProjectsName で post-process する。
    const dto = toRiskDTO(r);
    return {
      ...dto,
      linkedProjects: gateLinkedProjectsName(dto.linkedProjects, memberProjectIds, isAdmin),
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
  viewerTenantId?: string,
): Promise<RiskDTO | null> {
  // 2026-05-09 feedback Phase 2-3: viewerTenantId が指定された場合のみ where に追加。
  //   内部呼び出し (cascade 削除等) では認可をスキップする既存設計を維持しつつ、
  //   通常の API 経路では viewerTenantId 必須化により越境を遮断する。
  const tenantWhere = viewerTenantId !== undefined ? { tenantId: viewerTenantId } : {};
  const r = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null, ...tenantWhere },
    include: {
      reporter: { select: { name: true } },
      assignee: { select: { name: true } },
      // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
      //   linkedProjects DTO で表示するため、N+1 を避けるため include 経由で 1 クエリに統合。
      riskIssueProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
  });
  if (!r) return null;

  // 認可オフの内部呼び出し (viewerUserId 未指定) はそのまま返す (cascade 削除確認等)。
  if (viewerUserId === undefined) return toRiskDTO(r);

  // draft 認可: public は全員参照可、draft は作成者本人 or admin のみ
  const isCreator = r.reporterId === viewerUserId;
  const isAdmin = viewerSystemRole === 'admin';
  if (r.visibility !== 'public' && !isCreator && !isAdmin) return null;

  // feat/crud-permission-redesign (2026-05-20): linkedProjects[].name を per-link gate。
  //   個別 GET で他プロジェクト名を非メンバーに露出させないため (severity-1 横展開漏洩修正)。
  const memberships = isAdmin
    ? []
    : (await prisma.projectMember.findMany({
        where: { userId: viewerUserId },
        select: { projectId: true },
      })) ?? [];
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));
  const dto = toRiskDTO(r);
  return {
    ...dto,
    linkedProjects: gateLinkedProjectsName(dto.linkedProjects, memberProjectIds, isAdmin),
  };
}

export async function createRisk(
  projectId: string,
  input: CreateRiskInput,
  userId: string,
  tenantId: string,
): Promise<RiskDTO> {
  // feat/asset-assignee-expansion (2026-05-26) severity-1 越境防御:
  //   担当者として他テナントのユーザを指定する攻撃を service 層で reject する。
  //   validator は uuid 形式のみ確認のため、tenant 越境は本層で防ぐ必要がある。
  await assertAssigneeTenant(input.assigneeId, tenantId);
  const r = await prisma.riskIssue.create({
    data: {
      // ★severity-1 (fix/tenant-id-default-removal): tenantId を明示。schema の
      //   `@default(dbgenerated("'00000000-...-001'::uuid"))` への暗黙依存を解消し、
      //   未指定時は DB エラーで loud fail させる (= Default テナント silent 混入を遮断)。
      tenantId,
      // PR feat/asset-multi-project-linking: projectId は **作成元** プロジェクト (audit)。
      //   検索はすべて riskIssueProjects (M:N) 経由になるため、ここで初期紐付けも作成する。
      projectId,
      riskIssueProjects: { create: [{ projectId }] },
      type: input.type,
      title: input.title,
      content: input.content,
      // feat/risk-issue-4-section (2026-05-26): 発生事象 (issue) / 考えられる事象 (risk)
      occurrence: input.occurrence,
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
      // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
      //   linkedProjects DTO で表示するため、N+1 を避けるため include 経由で 1 クエリに統合。
      riskIssueProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
  });

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding を生成 + 保存 (fail-safe)
  // PR #357 (2026-05-14): visibility='draft' (公開範囲: 自分のみ) は提案エンジン側で
  //   filter 除外されるため、embedding を生成せず Voyage API 呼出 (= 課金) を発生させない。
  // (2026-05-15) RiskIssue は提案エンジンが `state='resolved'` のみ候補化するため、
  //   さらに state='resolved' でないものは embedding 生成しない (= 解消するまで Voyage 課金回避)。
  //   通常 createRisk は state='open' で起票されるためここでは生成されないが、import 経由など
  //   で resolved 状態のレコードが直接作成された場合は initial embedding を生成する。
  // PR-9 perf (2026-05-29 / ADR-0026): embedding 生成を `after()` で非同期化。
  //   (createRisk は通常 state='open' で起票され embedding 不要のため、ここは import 経由で
  //   resolved 状態が直接作成されたレアケースのみ走る。それでも latency 改善のため async 化。)
  if (r.visibility === 'public' && r.state === 'resolved') {
    afterSafe(
      generateAndPersistEntityEmbedding({
        table: 'risks_issues',
        rowId: r.id,
        tenantId,
        userId,
        text: composeRiskText({
          title: input.title,
          content: input.content,
          // feat/risk-issue-4-section (2026-05-26): occurrence も検索対象に含める
          occurrence: input.occurrence ?? null,
          cause: input.cause ?? null,
          responsePolicy: input.responsePolicy ?? null,
          responseDetail: input.responseDetail ?? null,
        }),
        featureUnit: 'risk-issue-embedding',
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[risk.create] async embedding failed (monthly backfill will retry)', err);
      }),
    );
  }

  return toRiskDTO(r);
}

/**
 * PR #5-c: RiskIssue の embedding 生成用 text 合成 helper。
 *
 * 意味検索の主たるシグナルとなる text フィールドを合成。impact / likelihood / priority
 * 等の列挙値はベクトル化に貢献しないため除外。result / lessonLearned は事後追記される
 * 性質のため、create 時点では空 → 別途 update 時に embedding 再生成される。
 */
/**
 * PR-X5 (2026-05-07): script (seed embedding 生成 / backfill) からも参照できるよう export 化。
 *   service 本体での呼出も同関数を継続利用するため、関数 signature / 実装は無変更。
 */
export function composeRiskText(fields: {
  title: string;
  content: string;
  // feat/risk-issue-4-section (2026-05-26): occurrence (発生事象 / 考えられる事象) も
  //   検索対象テキストに含める。type で issue/risk のラベルは違っても DB 列は同じ。
  occurrence?: string | null;
  cause: string | null;
  responsePolicy: string | null;
  responseDetail: string | null;
}): string {
  return [
    fields.title,
    fields.occurrence ?? '',
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
  // 2026-05-09 (PR D / #20): 既存 text を含めて取得し、実値変更時のみ embedding を再生成。
  // 2026-05-09 feedback Phase 2-3: 越境編集を遮断するため where に tenantId を併記。
  //   tenantId 引数は元々 embedding 用だが、本 PR で同時に認可境界として再利用する
  //   (= viewer の tenantId と一致する riskIssue のみ編集可能)。
  const existing = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null, tenantId },
    select: {
      reporterId: true,
      // feat/asset-assignee-expansion (2026-05-26): 認可拡張で assignee も編集可能化
      assigneeId: true,
      title: true,
      content: true,
      // feat/risk-issue-4-section (2026-05-26): occurrence の差分判定 + embedding 再生成用
      occurrence: true,
      cause: true,
      responsePolicy: true,
      responseDetail: true,
      // PR #357 (2026-05-14): visibility 遷移 (draft ↔ public) で embedding 生成判定
      visibility: true,
      // (2026-05-15) state 遷移 (open → resolved 等) で embedding 生成判定
      state: true,
    },
  });
  if (!existing) throw new Error('NOT_FOUND');
  // feat/asset-assignee-expansion (2026-05-26): 「作成者 (reporterId) OR 担当者 (assigneeId)」の
  //   いずれかと一致すれば編集可。引継ぎ後の担当者が内容更新できるよう拡張。
  //   admin の他人編集禁止は維持 (= 削除のみ admin 介入可能、編集は本人系のみ)。
  if (existing.reporterId !== userId && existing.assigneeId !== userId) {
    throw new Error('FORBIDDEN');
  }

  // feat/asset-assignee-expansion (2026-05-26) severity-1 越境防御:
  //   担当者変更時に「他テナントのユーザを指定」する攻撃を service 層で reject する。
  await assertAssigneeTenant(input.assigneeId, tenantId);

  // 2026-05-11 defense-in-depth: 「全メンバー」(public) 化する更新で、
  //   title が input でも DB でも空の場合は拒否 (個人情報がうっかり公開化されるのを防ぐ)。
  //   通常 validator (updateRiskSchema) が title=='' を弾くが、API 直叩きで
  //   `{ visibility: 'public' }` のみ送られて DB の既存 title が空のケースを救う。
  if (input.visibility === 'public') {
    const effectiveTitle = input.title !== undefined ? input.title : existing.title;
    if (!effectiveTitle || effectiveTitle.trim().length === 0) {
      throw new Error('PUBLIC_REQUIRES_TITLE');
    }
  }

  // PR #5-c + PR D (2026-05-09 / #20): text フィールドが「実値として変わったか」を比較で判定。
  // feat/risk-issue-4-section (2026-05-26): occurrence も判定対象に追加
  const textFieldsChanging =
    (input.title !== undefined && input.title !== existing.title) ||
    (input.content !== undefined && input.content !== existing.content) ||
    (input.occurrence !== undefined && input.occurrence !== existing.occurrence) ||
    (input.cause !== undefined && input.cause !== existing.cause) ||
    (input.responsePolicy !== undefined && input.responsePolicy !== existing.responsePolicy) ||
    (input.responseDetail !== undefined && input.responseDetail !== existing.responseDetail);

  const data: Record<string, unknown> = { updatedBy: userId };

  if (input.title !== undefined) data.title = input.title;
  if (input.content !== undefined) data.content = input.content;
  // feat/risk-issue-4-section (2026-05-26): occurrence の更新を反映
  if (input.occurrence !== undefined) data.occurrence = input.occurrence;
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
      // PR feat/asset-multi-linking-ui (Phase 2): 紐付け先 project の name + deletedAt を含める。
      //   linkedProjects DTO で表示するため、N+1 を避けるため include 経由で 1 クエリに統合。
      riskIssueProjects: {
        select: {
          projectId: true,
          project: { select: { id: true, name: true, deletedAt: true } },
        },
      },
    },
  });

  // PR #5-c + PR #357 (2026-05-14) + (2026-05-15): embedding 生成判定マトリクス。
  //   RiskIssue は提案エンジンが `visibility='public' AND state='resolved'` で候補化するため、
  //   両条件を同時に満たすときのみ embedding を生成する。state='open' / 'in_progress' /
  //   'monitoring' の段階では提案に乗らないため Voyage API を呼ばない (= 課金回避)。
  //
  //   生成パターン:
  //     - 新しい visibility が draft           → 生成しない
  //     - 新しい state が 'resolved' でない    → 生成しない
  //     - state が新たに 'resolved' に遷移     → 生成 (text 変更不要、初回 embedding 化)
  //     - 既に resolved のまま text 変更       → 再生成
  //     - 既に resolved + visibility が draft → public 化 → 生成 (初回公開化)
  //     - state='resolved' → 'open' 等への退行 → 生成しない (既存 embedding 保持)
  const willBeDraft = (input.visibility ?? existing.visibility) === 'draft';
  const wasResolved = existing.state === 'resolved';
  const willBeResolved = (input.state ?? existing.state) === 'resolved';
  const wasDraft = existing.visibility === 'draft';
  const becameResolved = !wasResolved && willBeResolved; // state: 解消への遷移
  const becameVisible = wasDraft && !willBeDraft; // visibility: draft → public への遷移
  const stayedEligible = !wasDraft && !willBeDraft && wasResolved && willBeResolved;
  const shouldGenerateEmbedding =
    !willBeDraft &&
    willBeResolved &&
    (becameResolved || becameVisible || (stayedEligible && textFieldsChanging));

  if (shouldGenerateEmbedding) {
    // PR-9 perf (2026-05-29 / ADR-0026): embedding 再生成を `after()` で非同期化。
    afterSafe(
      generateAndPersistEntityEmbedding({
        table: 'risks_issues',
        rowId: riskId,
        tenantId,
        userId,
        text: composeRiskText({
          title: r.title,
          content: r.content,
          occurrence: r.occurrence,
          cause: r.cause,
          responsePolicy: r.responsePolicy,
          responseDetail: r.responseDetail,
        }),
        featureUnit: 'risk-issue-embedding',
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[risk.update] async embedding failed (monthly backfill will retry)', err);
      }),
    );
  }

  return toRiskDTO(r);
}

/**
 * プロジェクト「リスク/課題一覧」からの **一括 visibility 更新** (UI_PATTERNS §35, 2026-05-24)。
 *
 * 履歴:
 *   - PR #161 (2026-04-) cross-list bulk update (state+assigneeId+deadline 複合) として導入
 *   - PR #165 (2026-04-) cross-list → project-scoped に移し替え
 *   - feat/all-list-section-unification (2026-05-24): UI_PATTERNS §35 に従い、
 *     5 一覧画面 (リスク/課題/ナレッジ/振り返り/メモ) の一括編集を visibility-only に統一。
 *     state+assigneeId+deadline 複合 patch は撤廃 (per-row 編集 dialog で行う)。
 *
 * 設計判断 (Knowledge / Retrospective の bulkUpdate*VisibilityFromList と同設計):
 *   - **scope は projectId に限定**: where に projectId を加え、他プロジェクトのレコードを
 *     ids に混ぜても触れない。M:N (riskIssueProjects) 経由で判定。
 *   - 編集権限は単発 update と同じ「**reporter (作成者) 本人のみ**」。
 *     viewer 自身が作成していないレコードは silently skip し、結果に skippedNotOwned カウントを返す。
 *   - admin であっても他人のレコードは更新しない (admin の管理操作は削除に限定する既存方針と一致)。
 *   - 2026-05-12 severity-1 防御: tenantId / reporterId を where に明示。
 *
 * @returns updatedIds: 実際に更新した ID 配列 / skippedNotOwned: 作成者違いで skip した数 /
 *          skippedNotFound: 存在しない or 既に削除済 or 別プロジェクトの数
 */
export async function bulkUpdateRisksVisibilityFromList(
  projectId: string,
  ids: string[],
  visibility: 'draft' | 'public',
  viewerUserId: string,
  viewerTenantId: string,
): Promise<{ updatedIds: string[]; skippedNotOwned: number; skippedNotFound: number; embeddingsGenerated: number }> {
  if (ids.length === 0) return { updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0, embeddingsGenerated: 0 };

  // PR feat/project-list-section-unification (2026-05-24, embedding 追補):
  //   draft→public 遷移 + state='resolved' の行のみ embedding 対象になるため、
  //   text フィールド + visibility + state を select に含める。
  const targets = await prisma.riskIssue.findMany({
    where: {
      id: { in: ids },
      deletedAt: null,
      tenantId: viewerTenantId,
      riskIssueProjects: { some: { projectId } },
    },
    select: {
      id: true,
      reporterId: true,
      // feat/asset-assignee-expansion (2026-05-26): 担当者も bulk 対象に
      assigneeId: true,
      visibility: true,
      state: true,
      title: true,
      content: true,
      // feat/risk-issue-4-section (2026-05-26): bulk visibility 更新時の embedding 再生成にも occurrence を含める
      occurrence: true,
      cause: true,
      responsePolicy: true,
      responseDetail: true,
    },
  });
  const skippedNotFound = ids.length - targets.length;
  // feat/asset-assignee-expansion (2026-05-26): 作成者 OR 担当者を bulk 対象に拡張。
  //   単発 updateRisk と認可ロジックを揃え、引継ぎ後の担当者が UI から bulk 操作可能に。
  const owned = targets.filter(
    (t) => t.reporterId === viewerUserId || t.assigneeId === viewerUserId,
  );
  const skippedNotOwned = targets.length - owned.length;
  const ownedIds = owned.map((t) => t.id);

  if (ownedIds.length === 0) {
    return { updatedIds: [], skippedNotOwned, skippedNotFound, embeddingsGenerated: 0 };
  }

  // feat/asset-assignee-expansion (2026-05-26): updateMany where も「作成者 OR 担当者」で
  //   二重防御 (== ownedIds の DB レイヤ再検証、悪意ある id 注入を弾く)。
  await prisma.riskIssue.updateMany({
    where: {
      id: { in: ownedIds },
      tenantId: viewerTenantId,
      OR: [
        { reporterId: viewerUserId },
        { assigneeId: viewerUserId },
      ],
    },
    data: { visibility, updatedBy: viewerUserId },
  });

  // PR feat/project-list-section-unification (2026-05-24): 一括 visibility 変更に伴う embedding
  //   再生成 (コスト最適化版)。単発 updateRisk と整合する判定マトリクス:
  //     - visibility='draft' (公開取り下げ)  → 生成しない (提案エンジン対象外)
  //     - visibility='public' へ昇格
  //         AND wasDraft (= draft→public 遷移)
  //         AND state='resolved' (RiskIssue は public + resolved のみ提案候補)
  //       → 対象行を batch で 1 ApiCallLog 集約して生成 (feedback_bulk_llm_call_unit 準拠)
  //   public→public のままや draft 維持時は API 呼出ゼロ (= Voyage 課金回避)。
  let embeddingsGenerated = 0;
  if (visibility === 'public') {
    const eligibleForEmbedding = owned.filter(
      (t) => t.visibility === 'draft' && t.state === 'resolved',
    );
    if (eligibleForEmbedding.length > 0) {
      const items = eligibleForEmbedding.map((t) => ({
        table: 'risks_issues' as const,
        rowId: t.id,
        text: composeRiskText({
          title: t.title,
          content: t.content,
          occurrence: t.occurrence,
          cause: t.cause,
          responsePolicy: t.responsePolicy,
          responseDetail: t.responseDetail,
        }),
      }));
      // PR-9 perf (2026-05-29 / ADR-0026): batch embedding 生成を `after()` で非同期化。
      embeddingsGenerated = items.length;
      afterSafe(
        generateAndPersistBatchEmbeddings({
          items,
          tenantId: viewerTenantId,
          userId: viewerUserId,
          featureUnit: 'risk-issue-embedding',
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[risk.bulk] async embedding failed (monthly backfill will retry)', err);
        }),
      );
    }
  }

  return { updatedIds: ownedIds, skippedNotOwned, skippedNotFound, embeddingsGenerated };
}

/**
 * リスク/課題を論理削除する。
 *
 * 認可 (feat/crud-permission-redesign, 2026-05-20 改訂、
 *       feat/asset-assignee-expansion (2026-05-26) で「担当者」を追加):
 *   - context='project' (○○一覧経由): **作成者 (reporterId) OR 担当者 (assigneeId)** 本人のみ削除可。
 *     admin も他人作成は削除不可。
 *   - context='global' (全○○経由): admin のみ削除可。
 *
 * @throws {Error} 'NOT_FOUND' — リスク/課題が存在しない or 既に削除済み
 * @throws {Error} 'FORBIDDEN' — context に応じた条件を満たさない
 */
export async function deleteRisk(
  riskId: string,
  userId: string,
  systemRole: string,
  viewerTenantId: string,
  context: 'project' | 'global',
): Promise<void> {
  // 2026-05-09 feedback Phase 2-3: 越境削除を遮断するため where に tenantId 必須化。
  const existing = await prisma.riskIssue.findFirst({
    where: { id: riskId, deletedAt: null, tenantId: viewerTenantId },
    // feat/asset-assignee-expansion (2026-05-26): assigneeId も認可判定対象
    select: { reporterId: true, assigneeId: true, type: true },
  });
  if (!existing) throw new Error('NOT_FOUND');
  // feat/asset-assignee-expansion (2026-05-26): 「作成者 OR 担当者」を編集権限相当に拡張
  const isCreatorOrAssignee =
    existing.reporterId === userId || existing.assigneeId === userId;
  const isAdmin = systemRole === 'admin';
  if (context === 'project') {
    if (!isCreatorOrAssignee) throw new Error('FORBIDDEN');
  } else {
    if (!isAdmin) throw new Error('FORBIDDEN');
  }

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
      // 2026-05-12 severity-1 防御: tenantId 明示
      where: { tenantId: viewerTenantId, entityType: 'risk', entityId: riskId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.comment.updateMany({
      where: { tenantId: viewerTenantId, entityType: commentEntityType, entityId: riskId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);

  // ADR-0025 (2026-05-29): Beginner プラン超過状態からの DELETE で容量キャッシュを即時更新。
  //   循環参照回避のため dynamic import。fail-safe で throw しない。
  const { maybeRecalcAfterBeginnerDelete } = await import('@/services/tenant-storage.service');
  await maybeRecalcAfterBeginnerDelete(viewerTenantId);
}

/**
 * PR feat/asset-multi-project-linking (2026-05-09 / Phase 1):
 *   別プロジェクトの「参考」タブで提示されたリスク/課題を、自プロジェクトに紐付ける。
 *
 * 認可: 呼出元 API が「対象プロジェクトのメンバー (member/pm_tl)」であることを既に検証している前提
 *   (Knowledge の linkKnowledgeToProject と同方針)。viewer は API 層で除外。
 *
 * @returns added=true なら新規紐付け、false なら既存 (idempotent)
 * @throws {Error} 'NOT_FOUND' リスク/課題が存在しない or 論理削除済 / 'PROJECT_NOT_FOUND' 紐付け先 project 無効
 */
export async function linkRiskToProject(
  riskId: string,
  projectId: string,
): Promise<{ added: boolean }> {
  const [risk, project] = await Promise.all([
    prisma.riskIssue.findFirst({
      where: { id: riskId, deletedAt: null },
      select: { id: true, tenantId: true, visibility: true },
    }),
    prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, tenantId: true },
    }),
  ]);
  if (!risk) throw new Error('NOT_FOUND');
  if (!project) throw new Error('PROJECT_NOT_FOUND');
  // テナント越境を防ぐ (一般的な認可境界)
  if (risk.tenantId !== project.tenantId) throw new Error('TENANT_MISMATCH');
  // 「参考」タブから紐付ける = visibility=public のリスクのみ。draft は他者から不可視のため。
  // 一方、自テナント内であれば admin が draft を意図的に紐付けるユースケースは想定し許容
  // (UI 側で draft を提示しないことで実質的に保護)。

  // upsert 風の挙動: 既存なら何もしない (idempotent)
  const existing = await prisma.riskIssueProject.findUnique({
    where: { riskIssueId_projectId: { riskIssueId: riskId, projectId } },
    select: { id: true },
  });
  if (existing) return { added: false };

  await prisma.riskIssueProject.create({
    data: { riskIssueId: riskId, projectId },
  });
  return { added: true };
}

/**
 * リスク/課題から指定プロジェクトの紐付けを解除する。本体は削除しない (orphan 化を許容)。
 *
 * 「画面上から削除しないことを選択」した場合の運用に該当。
 * 本体の物理削除は deleteProjectCascade(cascadeRisks=true) または deleteRisk() のみで発生する。
 *
 * @returns removed=true なら解除した、false なら元から紐付いていなかった
 */
export async function unlinkRiskFromProject(
  riskId: string,
  projectId: string,
  viewerTenantId: string,
): Promise<{ removed: boolean }> {
  // 2026-05-09 feedback Phase 2-3: 越境紐付け解除を遮断するため、対象 risk の tenant 一致を verify。
  //   不一致時は removed=false で silent fallback (情報漏洩防止)。
  const owned = await prisma.riskIssue.findFirst({
    where: { id: riskId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) return { removed: false };
  const existing = await prisma.riskIssueProject.findUnique({
    where: { riskIssueId_projectId: { riskIssueId: riskId, projectId } },
    select: { id: true },
  });
  if (!existing) return { removed: false };

  await prisma.riskIssueProject.delete({ where: { id: existing.id } });
  return { removed: true };
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
