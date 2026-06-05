/**
 * プロジェクトサービス (本プロダクトのトップエンティティ)
 *
 * 役割:
 *   プロジェクトを CRUD し、状態遷移 (企画中 → 見積中 → 計画中 → 実行中 → 完了 →
 *   振り返り完了 → クローズ) を管理する。リスク・タスク・見積もり・振り返りなど、
 *   ほぼすべての業務エンティティが Project を親に持つ。
 *
 * 設計判断:
 *   - 論理削除 (deletedAt) を採用。クローズ後も振り返り・ナレッジ参照のため残す。
 *   - ステータスは新規作成/編集フォームから任意に選択可能 (2026-06-03)。createProject /
 *     updateProject が直接 status を set する。一方向の状態遷移制限 (canTransition) は課さない。
 *     旧 state-machine 経路 (changeProjectStatus / /api/projects/[id]/status) は dormant として残置
 *     (state-machine.ts と既存テストは温存)。新 UI からは呼び出されない。
 *   - businessDomainTags / techStackTags / processTags はいずれも JSONB 配列。
 *     提案型サービス (suggestion.service.ts) で過去ナレッジ/課題とのマッチングに使用。
 *   - createdBy / updatedBy は監査の最低限。詳細な変更履歴は audit_logs に別途記録。
 *
 * 認可:
 *   呼び出し元 API ルート (/api/projects/...) で checkProjectPermission または
 *   requireAdmin を実施済みの前提。本サービスは membership / role の判定を行わない。
 *
 * 関連ドキュメント:
 *   - DESIGN.md §5 (テーブル定義: projects)
 *   - DESIGN.md §6 (プロジェクト状態遷移設計)
 *   - DESIGN.md §8 (権限制御)
 *   - DESIGN.md §23 (核心機能: 提案型サービスでのタグ参照)
 */

import { prisma } from '@/lib/db';
import { canTransition } from './state-machine';
import {
  callAnthropicForAutoTagsInner,
  type AutoTagAxes,
} from './auto-tag.service';
import { persistEmbedding } from './embedding.service';
import { recordError } from './error-log.service';
// PR-9 perf (2026-05-29 / ADR-0026): embedding 永続化 (DB UPDATE) を `after()` で非同期化。
//   ※ Project の LLM 呼出 (extractTagsAndEmbedForProject) は auto-tag を同期的に必要とするため
//     ここで await する必要があるが、結果の embedding を DB へ書く UPDATE は遅延可。
//     Knowledge/Risk/Retro/Memo と同等の async パターンで応答時間を削減する。
import { afterSafe } from '@/lib/after-safe';
import { withMeteredLLM } from '@/lib/llm/metered';
import { voyageEmbed } from '@/lib/llm/voyage-client';
import { EMBEDDING_DIMENSIONS } from '@/config/llm';
import type { Prisma } from '@/generated/prisma/client';
import type { ProjectStatus } from '@/types';

/**
 * PR (2026-05-15): プロジェクト作成・更新の API 課金単位識別子。
 * 旧仕様では auto-tag-extract + project-embedding の 2 回 ApiCallLog が記録されていたが、
 * 「1 業務操作 = 1 ApiCallLog」ルール (KDD_PATTERNS.md) と整合させるため統合。
 * 旧 featureUnit (auto-tag-extract / project-embedding) は単独実行・backfill 経路の互換のため残置。
 */
const PROJECT_UPSERT_FEATURE_UNIT = 'project-upsert';

/**
 * Voyage embedding 入力 text の最大文字数 (embedding.service.ts と同値、循環参照回避のため再定義)。
 */
const PROJECT_EMBEDDING_MAX_CHARS = 8000;

export type ProjectDTO = {
  id: string;
  name: string;
  // PR #111-2: customerId が真の所有項目。customerName は customer.name の派生値
  // (UI 表示用に常に include してセットする)。
  customerId: string;
  customerName: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope: string | null;
  devMethod: string;
  // PR-β / 項目 14: 契約形態 (新設、既存プロジェクトは null)
  contractType: string | null;
  businessDomainTags: string[];
  techStackTags: string[];
  processTags: string[];
  plannedStartDate: string;
  plannedEndDate: string;
  // 2026-06-02: 実績日 (担当者が進捗編集時に入力する任意項目)。未入力時は null。
  actualStartDate: string | null;
  actualEndDate: string | null;
  status: string;
  notes: string | null;
  createdBy: string;
  // 2026-06-02: 一覧で作成者/更新者を表示するため名前解決 (list 経路のみ非null)。
  createdByName: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
};

// 一覧/詳細で prisma から取得する行の形 (include: { customer: { select: { name } } } 前提)
type ProjectRowWithCustomer = {
  id: string;
  name: string;
  customerId: string;
  customer: { name: string };
  purpose: string;
  background: string;
  scope: string;
  outOfScope: string | null;
  devMethod: string;
  contractType: string | null;
  businessDomainTags: Prisma.JsonValue;
  techStackTags: Prisma.JsonValue;
  processTags: Prisma.JsonValue;
  plannedStartDate: Date;
  plannedEndDate: Date;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
  status: string;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

function toProjectDTO(p: ProjectRowWithCustomer): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    customerId: p.customerId,
    customerName: p.customer.name,
    purpose: p.purpose,
    background: p.background,
    scope: p.scope,
    outOfScope: p.outOfScope,
    devMethod: p.devMethod,
    contractType: p.contractType,
    businessDomainTags: (p.businessDomainTags as string[]) || [],
    techStackTags: (p.techStackTags as string[]) || [],
    processTags: (p.processTags as string[]) || [],
    plannedStartDate: p.plannedStartDate.toISOString().split('T')[0],
    plannedEndDate: p.plannedEndDate.toISOString().split('T')[0],
    actualStartDate: p.actualStartDate ? p.actualStartDate.toISOString().split('T')[0] : null,
    actualEndDate: p.actualEndDate ? p.actualEndDate.toISOString().split('T')[0] : null,
    status: p.status,
    notes: p.notes,
    createdBy: p.createdBy,
    createdByName: null,
    updatedByName: null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export type ListProjectsParams = {
  keyword?: string;
  customerName?: string;
  // PR #111-2: 顧客詳細画面から「この顧客の active Project」一覧を取るために追加
  customerId?: string;
  status?: string;
  page?: number;
  limit?: number;
};

export async function listProjects(
  params: ListProjectsParams,
  userId: string,
  systemRole: string,
  tenantId: string,
): Promise<{ data: ProjectDTO[]; total: number }> {
  const page = params.page || 1;
  const limit = Math.min(params.limit || 20, 100);
  const skip = (page - 1) * limit;

  // 2026-05-09 feedback: テナント越境防止。`tenantId` フィルタにより自テナントのみ
  //   返す (シードプロジェクトは MANAGEMENT_TENANT_ID 所属、super_admin が同テナントの
  //   場合のみ閲覧/編集可)。旧 `isSampleData` bypass はテナントフィルタに集約。
  const where: Prisma.ProjectWhereInput = { deletedAt: null, tenantId };

  // 一般ユーザは自分がメンバーのプロジェクトのみ
  if (systemRole !== 'admin' && systemRole !== 'super_admin') {
    where.members = { some: { userId } };
  }

  if (params.status) {
    where.status = params.status;
  }
  // PR #111-2: customerName フィルタは customer.name の relation filter に変換する。
  // 呼び出し元 (API layer) のクエリパラメータ名は既存互換のため維持する。
  if (params.customerName) {
    where.customer = { name: { contains: params.customerName, mode: 'insensitive' } };
  }
  // PR #111-2: 顧客詳細画面用の customerId 直接フィルタ
  if (params.customerId) {
    where.customerId = params.customerId;
  }
  if (params.keyword) {
    where.OR = [
      { name: { contains: params.keyword, mode: 'insensitive' } },
      { customer: { name: { contains: params.keyword, mode: 'insensitive' } } },
      { purpose: { contains: params.keyword, mode: 'insensitive' } },
    ];
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      include: { customer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.project.count({ where }),
  ]);

  // 2026-06-02: 一覧表示用に作成者/更新者名をバルク取得 (氏名のみ select、N+1 回避)。
  //   tenantId フィルタを明示し自テナントの User のみ解決 = 越境した createdBy/updatedBy は
  //   null フォールバックされ氏名漏えいしない (User は 1 ユーザ 1 テナント、@@unique([tenantId,email]))。
  const userIds = Array.from(new Set(projects.flatMap((p) => [p.createdBy, p.updatedBy])));
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds }, tenantId }, select: { id: true, name: true } })
    : [];
  const userNameById = new Map(users.map((u) => [u.id, u.name]));
  const data = projects.map((p) => ({
    ...toProjectDTO(p),
    createdByName: userNameById.get(p.createdBy) ?? null,
    updatedByName: userNameById.get(p.updatedBy) ?? null,
  }));
  return { data, total };
}

// null は明示クリア用 (validator schema で .nullable() 済、§5.12)
export type CreateProjectInput = {
  name: string;
  customerId: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope?: string | null;
  devMethod: string;
  // PR-β / 項目 14: 契約形態 (新設、null 許容)
  contractType?: string | null;
  businessDomainTags?: string[];
  techStackTags?: string[];
  processTags?: string[];
  plannedStartDate: string;
  plannedEndDate: string;
  // 2026-06-02: 実績日 (任意)。'YYYY-MM-DD' or null/undefined。
  actualStartDate?: string | null;
  actualEndDate?: string | null;
  notes?: string | null;
  // 2026-06-03: ステータス (任意)。新規作成/編集フォームから選択。未指定時は createProject で 'planning' 補完。
  status?: string;
};

export async function createProject(
  input: CreateProjectInput,
  userId: string,
  tenantId: string,
): Promise<ProjectDTO> {
  // (2026-05-15) auto-tag 抽出 + embedding 生成を 1 ApiCallLog に集約する。
  //   旧仕様: extractAutoTags + generateEmbedding が独立 withMeteredLLM (= 2 件 ApiCallLog)。
  //   新仕様: extractTagsAndEmbedForProject が 1 withMeteredLLM 内で両方実行。
  //   失敗時 (rate_limited / llm_error 等) はサイレントに userInput 単独で続行 (fail-safe)。
  const llm = await extractTagsAndEmbedForProject({
    purpose: input.purpose,
    background: input.background,
    scope: input.scope,
    tenantId,
    userId,
  });
  const mergedTags = mergeTags(
    {
      businessDomainTags: input.businessDomainTags ?? [],
      techStackTags: input.techStackTags ?? [],
      processTags: input.processTags ?? [],
    },
    llm.tags,
  );

  // 2026-05-09 feedback Phase 2: data.tenantId を明示し、schema DB DEFAULT への暗黙依存を解消。
  //   v1 (単一テナント) では DB DEFAULT で同値だが、マルチテナント環境では明示が必須。
  const project = await prisma.project.create({
    data: {
      tenantId,
      name: input.name,
      customerId: input.customerId,
      purpose: input.purpose,
      background: input.background,
      scope: input.scope,
      outOfScope: input.outOfScope,
      devMethod: input.devMethod,
      contractType: input.contractType ?? null,
      businessDomainTags: mergedTags.businessDomainTags as Prisma.InputJsonValue,
      techStackTags: mergedTags.techStackTags as Prisma.InputJsonValue,
      processTags: mergedTags.processTags as Prisma.InputJsonValue,
      plannedStartDate: new Date(input.plannedStartDate),
      plannedEndDate: new Date(input.plannedEndDate),
      actualStartDate: input.actualStartDate ? new Date(input.actualStartDate) : null,
      actualEndDate: input.actualEndDate ? new Date(input.actualEndDate) : null,
      notes: input.notes,
      // 2026-06-03: 新規作成フォームで選択されたステータス。未指定時は 'planning'。
      status: input.status ?? 'planning',
      createdBy: userId,
      updatedBy: userId,
    },
    include: { customer: { select: { name: true } } },
  });

  // (2026-05-15) embedding は LLM 呼出時に取得済。project.id が確定したここで DB に書く。
  // PR-9 perf (2026-05-29 / ADR-0026): embedding 永続化 (raw SQL UPDATE) を `after()` で非同期化。
  if (llm.embedding != null) {
    const embedding = llm.embedding;
    afterSafe(
      persistProjectEmbedding(project.id, tenantId, embedding, userId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[project.create] async embedding persist failed (monthly backfill will retry)', err);
      }),
    );
  }

  return toProjectDTO(project);
}

export async function getProject(
  projectId: string,
  viewerTenantId: string,
  systemRole?: string,
): Promise<ProjectDTO | null> {
  // 2026-05-09 feedback Phase 2: severity-1 テナント越境対策。
  //   project は tenantId 列を直接持つため where に tenantId を必須化。
  //   旧仕様は projectId 直叩きで他テナントの project 詳細が読める脆弱性があった。
  //   super_admin (MANAGEMENT_TENANT_ID 所属) は引数 viewerTenantId が MANAGEMENT_TENANT_ID
  //   になるため、シード prj (MANAGEMENT_TENANT 所属) を自然に閲覧可。
  //
  // PR-X5: サンプルプロジェクト (isSampleData=true) は通常ユーザに対して 404 化する。
  //   super_admin の場合は MANAGEMENT_TENANT 内のシード prj を管理する必要があるので bypass。
  const where: Prisma.ProjectWhereInput =
    systemRole === 'super_admin'
      ? { id: projectId, tenantId: viewerTenantId, deletedAt: null }
      : { id: projectId, tenantId: viewerTenantId, deletedAt: null, isSampleData: false };
  const project = await prisma.project.findFirst({
    where,
    include: { customer: { select: { name: true } } },
  });
  return project ? toProjectDTO(project) : null;
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
  userId: string,
  tenantId: string,
): Promise<ProjectDTO> {
  // PR #3-b (T-03 Phase 1) + PR D (2026-05-09 / #20):
  //   purpose / background / scope の **実値変更** 時のみ自動タグ抽出 + embedding を行う。
  //   未指定 (undefined) または既存値と同一なら LLM 課金を発生させない。
  //   そのため現行 row 取得を `textFieldsChanging` の判定よりも前に持ってくる。
  // 2026-05-09 feedback Phase 2: 越境編集を遮断するため findFirst + tenantId 検証に変更。
  //   越境時は current=null となり、textFieldsChanging が false 評価され、後続の update も
  //   findFirst の不一致で arena が空になる。NOT_FOUND エラーは throw しないが、
  //   下流の prisma.project.update (where: { id }) は越境を直接弾けないため、
  //   念のため where 検証された行のみ続行する設計。
  const current = await prisma.project.findFirst({
    where: { id: projectId, tenantId },
    select: {
      purpose: true,
      background: true,
      scope: true,
      businessDomainTags: true,
      techStackTags: true,
      processTags: true,
    },
  });
  // 越境または存在しない場合は NOT_FOUND を throw (route 側で 404 に変換される前提)
  if (!current) throw new Error('NOT_FOUND');
  const textFieldsChanging = (
    (input.purpose !== undefined && input.purpose !== current.purpose) ||
    (input.background !== undefined && input.background !== current.background) ||
    (input.scope !== undefined && input.scope !== current.scope)
  );

  let mergedAutoTags: AutoTagAxes | null = null;
  // PR #5 (T-03 Phase 2): text 変更時は embedding も再生成する。
  // (2026-05-15) auto-tag + embedding を 1 ApiCallLog に集約 (extractTagsAndEmbedForProject)。
  let resolvedPurpose: string | null = null;
  let resolvedBackground: string | null = null;
  let resolvedScope: string | null = null;
  let embeddingFromLlm: number[] | null = null;
  if (textFieldsChanging) {
    resolvedPurpose = input.purpose ?? current.purpose;
    resolvedBackground = input.background ?? current.background;
    resolvedScope = input.scope ?? current.scope;
    const llm = await extractTagsAndEmbedForProject({
      purpose: resolvedPurpose,
      background: resolvedBackground,
      scope: resolvedScope,
      tenantId,
      userId,
    });
    if (llm.tags != null) {
      // ユーザがタグも同時に更新している場合はそれを優先、更新していない軸は
      // DB 現行値 (= 過去の手動入力 + 過去の auto-extract) を継承して merge する。
      mergedAutoTags = mergeTags(
        {
          businessDomainTags:
            input.businessDomainTags ??
            ((current.businessDomainTags as string[] | null) ?? []),
          techStackTags:
            input.techStackTags ??
            ((current.techStackTags as string[] | null) ?? []),
          processTags:
            input.processTags ?? ((current.processTags as string[] | null) ?? []),
        },
        llm.tags,
      );
    }
    embeddingFromLlm = llm.embedding;
  }

  const data: Prisma.ProjectUpdateInput = { updatedBy: userId };

  if (input.name !== undefined) data.name = input.name;
  // PR #111-2: customerId 変更時は relation の connect() 経由で切り替える。
  if (input.customerId !== undefined) {
    data.customer = { connect: { id: input.customerId } };
  }
  if (input.purpose !== undefined) data.purpose = input.purpose;
  if (input.background !== undefined) data.background = input.background;
  if (input.scope !== undefined) data.scope = input.scope;
  if (input.outOfScope !== undefined) data.outOfScope = input.outOfScope;
  if (input.devMethod !== undefined) data.devMethod = input.devMethod;
  if (input.contractType !== undefined) data.contractType = input.contractType;

  // PR #3-b: auto-tag 成功時は merge 結果で上書き、失敗時は input をそのまま反映 (fail-safe)。
  if (mergedAutoTags != null) {
    data.businessDomainTags = mergedAutoTags.businessDomainTags as Prisma.InputJsonValue;
    data.techStackTags = mergedAutoTags.techStackTags as Prisma.InputJsonValue;
    data.processTags = mergedAutoTags.processTags as Prisma.InputJsonValue;
  } else {
    if (input.businessDomainTags !== undefined)
      data.businessDomainTags = input.businessDomainTags as Prisma.InputJsonValue;
    if (input.techStackTags !== undefined)
      data.techStackTags = input.techStackTags as Prisma.InputJsonValue;
    if (input.processTags !== undefined)
      data.processTags = input.processTags as Prisma.InputJsonValue;
  }

  if (input.plannedStartDate !== undefined)
    data.plannedStartDate = new Date(input.plannedStartDate);
  if (input.plannedEndDate !== undefined)
    data.plannedEndDate = new Date(input.plannedEndDate);
  if (input.actualStartDate !== undefined)
    data.actualStartDate = input.actualStartDate ? new Date(input.actualStartDate) : null;
  if (input.actualEndDate !== undefined)
    data.actualEndDate = input.actualEndDate ? new Date(input.actualEndDate) : null;
  if (input.notes !== undefined) data.notes = input.notes;
  // 2026-06-03: ステータスを編集フォームから直接更新可能に (状態遷移の一方向制限は課さない)。
  //   旧仕様では status は changeProjectStatus() 経由のみだったが、任意ステータス選択の
  //   ユーザ要望により updateProject からも直接 set する。監査ログは PATCH route が before/after 記録。
  if (input.status !== undefined) data.status = input.status;

  const project = await prisma.project.update({
    where: { id: projectId },
    data,
    include: { customer: { select: { name: true } } },
  });

  // (2026-05-15) text 変更時のみ embedding を再永続化。LLM 呼出は上で実施済。
  //   text 変更なし = 既存 embedding 流用 (= LLM 課金回避)。
  // PR-9 perf (2026-05-29 / ADR-0026): embedding 永続化を `after()` で非同期化。
  if (textFieldsChanging && embeddingFromLlm != null) {
    const embedding = embeddingFromLlm;
    afterSafe(
      persistProjectEmbedding(projectId, tenantId, embedding, userId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[project.update] async embedding persist failed (monthly backfill will retry)', err);
      }),
    );
  }

  return toProjectDTO(project);
}

/**
 * PR #5 (T-03 Phase 2): Project の content_embedding を生成 + 保存する helper。
 *
 * createProject / updateProject 両方から呼ばれる。失敗時はサイレントに
 * `system_error_logs` に warn 記録のみ行い、本体 INSERT/UPDATE はロールバックさせない
 * (= fail-safe、embedding NULL のまま運用継続を許容)。
 *
 * 入力 text は purpose / background / scope を改行で結合した形にする。これは
 * Voyage embedding が比較的長文も扱えるため、3 軸を統合して 1 ベクトルで意味検索する設計。
 */
/**
 * PR-X5 (2026-05-07): script (seed embedding 生成 / backfill) からも参照できるよう
 *   inline 化されていた text 組立を独立関数に切り出し + export。
 *   service 本体の generateAndPersistProjectEmbedding はこの関数を呼び出すよう改修するが、
 *   組立ロジック (purpose / background / scope を改行 2 つで結合) は無変更。
 */
export function composeProjectText(fields: {
  purpose: string;
  background: string;
  scope: string;
}): string {
  return [
    fields.purpose.trim(),
    fields.background.trim(),
    fields.scope.trim(),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * (1 業務操作 = 1 ApiCallLog 集約 / 2026-05-15)
 *
 * プロジェクトの新規作成・更新における **auto-tag 抽出 + embedding 生成** を
 * `withMeteredLLM` 1 ラップに集約する。旧仕様では `extractAutoTags()` と
 * `generateEmbedding()` がそれぞれ別の `withMeteredLLM` を呼んでいたため、
 * 1 プロジェクト作成あたり ApiCallLog 2 件 + Tenant.currentMonthApiCallCount +2 +
 * costJpy 2 倍 という不整合があった (Beginner 100 回上限が実質 50 件で枯渇)。
 *
 * 新仕様:
 *   - 1 業務操作 (= 1 プロジェクト作成 / 更新) で `withMeteredLLM` を 1 度だけラップ
 *   - callback 内で Anthropic (auto-tag) + Voyage (embedding) を順次呼出
 *   - ApiCallLog 1 件 / Tenant counter +1 / costJpy 1 回分のみ
 *   - 内部 API のどちらかが失敗してももう一方が成功すれば「業務として成功」扱いで課金
 *   - 両方失敗時は throw → withMeteredLLM が `llm_error` で **課金なし** に戻す
 *
 * fail-safe:
 *   - tags が null (LLM 出力の JSON 検証失敗) → 既存タグを維持
 *   - embedding が null (Voyage 失敗 or text 空) → content_embedding NULL のまま継続
 *   - persistEmbedding 失敗 (DB 書き込み) → log のみ、本体 INSERT/UPDATE は rollback しない
 *
 * @returns 抽出された自動タグ (失敗 / 縮退時は null) + 生成された embedding (失敗 / 縮退時は null)。
 *   embedding は caller が `persistProjectEmbedding()` で DB に永続化する責務を持つ
 *   (新規作成時は project.id が決まる前に LLM を呼ぶケースに対応するため caller 責務に分離)。
 */
export async function extractTagsAndEmbedForProject(args: {
  purpose: string;
  background: string;
  scope: string;
  tenantId: string;
  userId: string;
}): Promise<{ tags: AutoTagAxes | null; embedding: number[] | null }> {
  const embeddingText = composeProjectText({
    purpose: args.purpose,
    background: args.background,
    scope: args.scope,
  });
  const willCallEmbedding = embeddingText.trim().length > 0;

  // (2026-05-15) 3 フィールドすべて空文字 (or 空白のみ) のときは LLM を一切呼ばない。
  //   - Anthropic auto-tag: 空入力に対して空タグ JSON を返すだけで、ユーザ価値ゼロ + 1 件課金
  //   - Voyage embedding: そもそも text 空なので呼べない (`willCallEmbedding=false`)
  //   早期 return することで `withMeteredLLM` 自体を呼ばず、ApiCallLog / Tenant counter
  //   双方の増分を発生させない (= ユーザに完全に課金しない)。
  const hasAnyContent =
    args.purpose.trim().length > 0 ||
    args.background.trim().length > 0 ||
    args.scope.trim().length > 0;
  if (!hasAnyContent) {
    return { tags: null, embedding: null };
  }

  const truncatedEmbeddingText =
    embeddingText.length > PROJECT_EMBEDDING_MAX_CHARS
      ? embeddingText.slice(0, PROJECT_EMBEDDING_MAX_CHARS)
      : embeddingText;

  const result = await withMeteredLLM(
    {
      featureUnit: PROJECT_UPSERT_FEATURE_UNIT,
      tenantId: args.tenantId,
      userId: args.userId,
    },
    async ({ modelName, requestId }) => {
      let tags: AutoTagAxes | null = null;
      let llmInputTokens: number | undefined;
      let llmOutputTokens: number | undefined;
      let anthropicSucceeded = false;
      try {
        const inner = await callAnthropicForAutoTagsInner({
          purpose: args.purpose,
          background: args.background,
          scope: args.scope,
          modelName,
        });
        tags = inner.tags;
        llmInputTokens = inner.llmInputTokens;
        llmOutputTokens = inner.llmOutputTokens;
        anthropicSucceeded = true;
      } catch (error) {
        await recordError({
          severity: 'warn',
          source: 'server',
          message:
            error instanceof Error
              ? error.message
              : 'auto-tag inner LLM call failed',
          stack: error instanceof Error ? error.stack : undefined,
          userId: args.userId,
          context: {
            kind: 'project_auto_tag_failure',
            tenantId: args.tenantId,
          },
        });
      }

      let embedding: number[] | null = null;
      let embeddingTokens: number | undefined;
      let voyageSucceeded = false;
      if (willCallEmbedding) {
        try {
          const v = await voyageEmbed({
            texts: [truncatedEmbeddingText],
            inputType: 'document',
          });
          const first = v.embeddings[0];
          if (first != null && first.length === EMBEDDING_DIMENSIONS) {
            embedding = first;
            embeddingTokens = v.totalTokens;
            voyageSucceeded = true;
          } else {
            throw new Error(
              `Voyage embedding dimensions mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${first?.length ?? 'n/a'}`,
            );
          }
        } catch (error) {
          await recordError({
            severity: 'warn',
            source: 'server',
            message:
              error instanceof Error
                ? error.message
                : 'voyage embedding inner call failed',
            stack: error instanceof Error ? error.stack : undefined,
            userId: args.userId,
            context: {
              kind: 'project_embedding_failure',
              tenantId: args.tenantId,
            },
          });
        }
      }

      // 業務として何も達成できなかったケースは throw → withMeteredLLM が llm_error
      // に変換し、Tenant counter / ApiCallLog は記録しない (= ユーザに請求しない)。
      // (willCallEmbedding=false なら voyageSucceeded=false なので
      //  anthropic 失敗 = 全 inner 失敗で throw 条件成立する)
      if (!anthropicSucceeded && !voyageSucceeded) {
        throw new Error('project upsert LLM batch had no successful inner call');
      }

      return {
        result: { tags, embedding },
        usage: { llmInputTokens, llmOutputTokens, embeddingTokens },
        requestId,
      };
    },
  );

  if (!result.ok) {
    // 縮退 / 失敗時はサイレントに log のみ。本体 INSERT/UPDATE は続行。
    await recordError({
      severity: 'warn',
      source: 'server',
      message: `project upsert LLM degraded/failed: ${result.reason}`,
      userId: args.userId,
      context: {
        kind: 'project_upsert_llm_failure',
        tenantId: args.tenantId,
        reason: result.reason,
      },
    });
    return { tags: null, embedding: null };
  }

  return {
    tags: result.result.tags,
    embedding: result.result.embedding,
  };
}

/**
 * (2026-05-15) Project の embedding を DB に永続化する。
 * `extractTagsAndEmbedForProject()` が返した embedding を、project.id が確定したタイミングで
 * 呼び出す。書き込み失敗は warn ログのみで本体トランザクションには伝播させない (fail-safe)。
 */
export async function persistProjectEmbedding(
  projectId: string,
  tenantId: string,
  embedding: number[],
  userId: string,
): Promise<void> {
  try {
    await persistEmbedding('projects', projectId, tenantId, embedding);
  } catch (error) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId,
      context: {
        kind: 'project_embedding_persist_failure',
        projectId,
        tenantId,
      },
    });
  }
}

/**
 * PR #3-b (T-03 Phase 1): 3 軸タグの集約型 + 重複除去マージ helper。
 * createProject / updateProject 両方から呼ばれる。AutoTagAxes 型は auto-tag.service.ts で集中管理。
 */
function mergeTags(
  user: AutoTagAxes,
  auto: AutoTagAxes | null,
): AutoTagAxes {
  return {
    businessDomainTags: dedupUnion(user.businessDomainTags, auto?.businessDomainTags ?? []),
    techStackTags: dedupUnion(user.techStackTags, auto?.techStackTags ?? []),
    processTags: dedupUnion(user.processTags, auto?.processTags ?? []),
  };
}

/**
 * 2 配列を順序保持で union (重複除去)。
 * - 順序は [...user, ...auto] でユーザ入力を先頭に
 * - case-sensitive 比較 (タグの表記揺れも別タグとして許容: "EC" と "ec" は別物)
 * - 空文字や全角空白のみは除外
 */
function dedupUnion(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...a, ...b]) {
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * プロジェクトの状態遷移を実行する。
 *
 * 重要: このサービスは status を直接更新する**唯一の経路**。updateProject() では
 * status を更新しないため、状態遷移は必ず本関数を経由する。
 *
 * 遷移ルールは src/services/state-machine.ts の `canTransition` で集約管理:
 *   - 逆戻り禁止: 「実行中 → 計画中」のような後退は許可しない
 *   - 飛び級禁止: 必ず順序通りに進める (planning → estimating → scheduling → executing → ...)
 *
 * エラー:
 *   - NOT_FOUND: プロジェクトが存在しない or 論理削除済み
 *   - STATE_CONFLICT:<reason>: 遷移ルール違反 (理由付き)
 *
 * 認可: 呼び出し元 API ルートで checkProjectPermission('project:change_status') 実施済の前提。
 */
export async function changeProjectStatus(
  projectId: string,
  newStatus: ProjectStatus,
  userId: string,
  viewerTenantId: string,
): Promise<ProjectDTO> {
  // 2026-05-09 feedback Phase 2: 越境状態変更を遮断するため where に tenantId を追加。
  const project = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId, deletedAt: null },
  });

  if (!project) throw new Error('NOT_FOUND');

  // 状態遷移ルールの単一の真実 = state-machine.ts に委譲。
  // 業務ルール変更時は state-machine.ts 1 箇所を編集すればよい。
  const currentStatus = project.status as ProjectStatus;
  const transition = canTransition(currentStatus, newStatus);

  if (!transition.allowed) {
    // API ルート側で 409 STATE_CONFLICT に変換される。エラーメッセージは
    // 'STATE_CONFLICT:' プレフィックスで判別可能。
    throw new Error(`STATE_CONFLICT:${transition.reason}`);
  }

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { status: newStatus, updatedBy: userId },
    include: { customer: { select: { name: true } } },
  });

  return toProjectDTO(updated);
}

export async function deleteProject(
  projectId: string,
  userId: string,
  viewerTenantId: string,
): Promise<void> {
  // 2026-05-09 feedback Phase 2: 越境論理削除を遮断するため、最初に project の tenant 検証。
  //   不一致時は NOT_FOUND を throw (route 側で 404 に変換される前提)。
  const owned = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId, deletedAt: null },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  // PR #89: プロジェクト scoped の Attachment (project / task / estimate) も同時に論理削除。
  // 子 risk / retro / knowledge の attachment は各 delete*Service 側で削除済 (個別削除パス)、
  // もしくは cascade で削除する (deleteProjectCascade)。
  // 論理削除パスでは親プロジェクトが消えても子 entity は残るが、UI の一覧ビューは
  // deletedAt フィルタにより該当プロジェクトの attachment を表示しなくなる。
  const now = new Date();
  const [tasks, estimates] = await Promise.all([
    prisma.task.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true },
    }),
    prisma.estimate.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true },
    }),
  ]);

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: now, updatedBy: userId },
    }),
    // 2026-05-12 severity-1 防御: 全 attachment.updateMany に tenantId 明示
    prisma.attachment.updateMany({
      where: { tenantId: viewerTenantId, entityType: 'project', entityId: projectId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.attachment.updateMany({
      where: {
        tenantId: viewerTenantId,
        entityType: 'task',
        entityId: { in: tasks.map((t) => t.id) },
        deletedAt: null,
      },
      data: { deletedAt: now },
    }),
    prisma.attachment.updateMany({
      where: {
        tenantId: viewerTenantId,
        entityType: 'estimate',
        entityId: { in: estimates.map((e) => e.id) },
        deletedAt: null,
      },
      data: { deletedAt: now },
    }),
  ]);

  // ADR-0025 (2026-05-29): Beginner プラン超過状態からの DELETE で容量キャッシュを即時更新。
  //   プロジェクト削除は task / estimate / attachment cascade で大きな容量解放の可能性。
  const { maybeRecalcAfterBeginnerDelete } = await import('@/services/tenant-storage.service');
  await maybeRecalcAfterBeginnerDelete(viewerTenantId);
}

/**
 * プロジェクトと紐づく全データをカスケード物理削除する (2026-04-18 / PR #89 で細粒度化)。
 *
 * 強制削除対象 (options に関係なく常に物理削除):
 *   - Project 自身
 *   - Task + TaskProgressLog (WBS / ガント)
 *   - Estimate (見積)
 *   - ProjectMember
 *   - Attachment: project / task / estimate 配下 + 削除対象となる risk / retro / knowledge 配下
 *
 * 条件付き削除 (PR #89 の細粒度確認ダイアログから渡すフラグ):
 *   - cascadeRisks      : RiskIssue (type='risk') を物理削除するか
 *   - cascadeIssues     : RiskIssue (type='issue') を物理削除するか
 *   - cascadeRetros     : Retrospective + RetrospectiveComment を物理削除するか
 *   - cascadeKnowledge  : Knowledge を物理削除 (N:M 考慮)、または紐付けのみ解除
 *
 * フラグが false の場合:
 *   - 該当エンティティ本体は残す (全○○ ビューから引き続き参照可能)
 *   - Attachment も残す (全○○ 画面で添付 URL が見える)
 *   - ただし project_id は「存在しないプロジェクト」を参照した孤児状態
 *     → 全○○ ビュー側で projectDeleted / projectName マスクする既存処理で対応 (PR #52)
 */
export async function deleteProjectCascade(
  projectId: string,
  viewerTenantId: string,
  options: {
    cascadeRisks?: boolean;
    cascadeIssues?: boolean;
    cascadeRetros?: boolean;
    cascadeKnowledge?: boolean;
  } = {},
): Promise<{
  risks: number;
  issues: number;
  retrospectives: number;
  knowledgeDeleted: number;
  knowledgeUnlinked: number;
  attachmentsDeleted: number;
}> {
  // 2026-05-09 feedback Phase 2: 越境カスケード削除は最も破壊的な severity-1 攻撃経路。
  //   project の tenant 一致を verify しないと他テナントの全データを物理削除可能。
  const owned = await prisma.project.findFirst({
    where: { id: projectId, tenantId: viewerTenantId },
    select: { id: true },
  });
  if (!owned) throw new Error('NOT_FOUND');

  const {
    cascadeRisks = false,
    cascadeIssues = false,
    cascadeRetros = false,
    cascadeKnowledge = false,
  } = options;

  let risksCount = 0;
  let issuesCount = 0;
  let retrosCount = 0;
  let knowledgeDeleted = 0;
  let knowledgeUnlinked = 0;
  let attachmentsDeleted = 0;

  // 強制削除候補の ID を先に取得 (後で attachment 削除にも使う)
  const [tasks, estimates] = await Promise.all([
    prisma.task.findMany({ where: { projectId }, select: { id: true } }),
    prisma.estimate.findMany({ where: { projectId }, select: { id: true } }),
  ]);
  const taskIds = tasks.map((t) => t.id);
  const estimateIds = estimates.map((e) => e.id);

  // PR feat/asset-multi-project-linking (2026-05-09):
  //   リスク/課題/振り返り も Knowledge 同型の「最後の紐付けが消えた時のみ物理削除」モデルに統一。
  //   このプロジェクトに紐付いている asset を取得し、紐付け数 > 1 なら unlink のみ、=1 なら物理削除。
  //   cascadeXxx=true の選択でも他プロジェクトが参照中なら本体は残す (ユーザ要件)。

  // ---------- 条件付き: リスク (type='risk') ----------
  if (cascadeRisks) {
    const linkedRisks = await prisma.riskIssueProject.findMany({
      where: { projectId, riskIssue: { type: 'risk' } },
      select: { riskIssueId: true },
    });
    for (const { riskIssueId } of linkedRisks) {
      const linkCount = await prisma.riskIssueProject.count({ where: { riskIssueId } });
      if (linkCount <= 1) {
        // 他に紐付け無し → 本体 + attachment + comment を物理削除
        // 2026-05-12 severity-1 防御: tenantId 明示
        const attRes = await prisma.attachment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'risk', entityId: riskIssueId },
        });
        attachmentsDeleted += attRes.count;
        await prisma.comment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'risk', entityId: riskIssueId },
        });
        await prisma.riskIssueProject.deleteMany({ where: { riskIssueId } });
        await prisma.riskIssue.delete({ where: { id: riskIssueId } });
        risksCount++;
      } else {
        // 他プロジェクトが参照中 → 紐付けのみ解除し本体は残す
        await prisma.riskIssueProject.delete({
          where: { riskIssueId_projectId: { riskIssueId, projectId } },
        });
      }
    }
  }

  // ---------- 条件付き: 課題 (type='issue') ----------
  if (cascadeIssues) {
    const linkedIssues = await prisma.riskIssueProject.findMany({
      where: { projectId, riskIssue: { type: 'issue' } },
      select: { riskIssueId: true },
    });
    for (const { riskIssueId } of linkedIssues) {
      const linkCount = await prisma.riskIssueProject.count({ where: { riskIssueId } });
      if (linkCount <= 1) {
        // 2026-05-12 severity-1 防御: tenantId 明示
        const attRes = await prisma.attachment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'risk', entityId: riskIssueId },
        });
        attachmentsDeleted += attRes.count;
        await prisma.comment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'issue', entityId: riskIssueId },
        });
        await prisma.riskIssueProject.deleteMany({ where: { riskIssueId } });
        await prisma.riskIssue.delete({ where: { id: riskIssueId } });
        issuesCount++;
      } else {
        await prisma.riskIssueProject.delete({
          where: { riskIssueId_projectId: { riskIssueId, projectId } },
        });
      }
    }
  }

  // ---------- 条件付き: 振り返り ----------
  if (cascadeRetros) {
    const linkedRetros = await prisma.retrospectiveProject.findMany({
      where: { projectId },
      select: { retrospectiveId: true },
    });
    for (const { retrospectiveId } of linkedRetros) {
      const linkCount = await prisma.retrospectiveProject.count({
        where: { retrospectiveId },
      });
      if (linkCount <= 1) {
        // 2026-05-12 severity-1 防御: tenantId 明示
        const attRes = await prisma.attachment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'retrospective', entityId: retrospectiveId },
        });
        attachmentsDeleted += attRes.count;
        await prisma.comment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'retrospective', entityId: retrospectiveId },
        });
        await prisma.retrospectiveProject.deleteMany({ where: { retrospectiveId } });
        await prisma.retrospective.delete({ where: { id: retrospectiveId } });
        retrosCount++;
      } else {
        await prisma.retrospectiveProject.delete({
          where: { retrospectiveId_projectId: { retrospectiveId, projectId } },
        });
      }
    }
  }

  // ---------- 条件付き: ナレッジ ----------
  if (cascadeKnowledge) {
    const linkedKnowledge = await prisma.knowledgeProject.findMany({
      where: { projectId },
      select: { knowledgeId: true },
    });
    const knowledgeIds = linkedKnowledge.map((l) => l.knowledgeId);
    for (const kId of knowledgeIds) {
      const linkCount = await prisma.knowledgeProject.count({
        where: { knowledgeId: kId },
      });
      if (linkCount <= 1) {
        // 他に紐付けがない → 本体 + attachment + comment を物理削除
        // 2026-05-12: 多層防御として全 deleteMany に tenantId を明示。
        //   line 686-690 で project.tenantId == viewerTenantId は検証済みだが、
        //   個別 deleteMany に明示することで「全 query に tenantId」原則を徹底し、
        //   将来の data corruption / 連番 ID 化への耐性を獲得する。
        const attRes = await prisma.attachment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'knowledge', entityId: kId },
        });
        attachmentsDeleted += attRes.count;
        // PR fix/visibility-auth-matrix: comments も cascade 物理削除 (§5.51)
        await prisma.comment.deleteMany({
          where: { tenantId: viewerTenantId, entityType: 'knowledge', entityId: kId },
        });
        await prisma.knowledgeProject.deleteMany({ where: { knowledgeId: kId } });
        await prisma.knowledge.delete({ where: { id: kId } });
        knowledgeDeleted++;
      } else {
        // 他プロジェクトとも共有 → 紐付けのみ解除 (本体・attachment は残す)
        await prisma.knowledgeProject.delete({
          where: { knowledgeId_projectId: { knowledgeId: kId, projectId } },
        });
        knowledgeUnlinked++;
      }
    }
  }

  // ---------- 強制削除: Task / Estimate / ProjectMember / Project + Attachments ----------
  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-D2): 段階別 transaction (案 B)
  //   旧実装は全 deleteMany が独立 await で、途中で例外 (DB 切断 / lambda 強制終了) が起きると
  //   partial cascade (Task は消えたが Estimate は残った、Attachment 孤児等) が残るリスクがあった。
  //   強制削除セクション全体を interactive transaction で囲い、全 deleteMany + project.delete を
  //   atomic 化。timeout 30s で大規模 project でも対応 (Prisma default 5s)。
  //
  //   前段の knowledge/risk/retrospective cascade (line 870-991) は本 transaction に含めない設計:
  //     - 各 entity 削除は独立に冪等 (再実行時に既削除分は skip される)
  //     - 1 つの transaction に入れると lock 範囲が広すぎる + timeout リスク増
  //     - 冪等性を活用し、partial 失敗時は次回 deleteCustomerCascade で残りを完了する
  //
  // 2026-05-12: 多層防御として全 deleteMany に tenantId を明示。projectId 経由でも
  //   tenant は転写されているが、Attachment / Comment / TaskProgressLog のような
  //   tenantId 列を持つ entity は直接フィルタを併記する。
  await prisma.$transaction(async (tx) => {
    if (taskIds.length > 0) {
      // TaskProgressLog は task 経由で project に紐付くため task の親 projectId+tenantId で検証
      await tx.taskProgressLog.deleteMany({
        where: { taskId: { in: taskIds }, task: { project: { tenantId: viewerTenantId } } },
      });
      const attTaskRes = await tx.attachment.deleteMany({
        where: { tenantId: viewerTenantId, entityType: 'task', entityId: { in: taskIds } },
      });
      attachmentsDeleted += attTaskRes.count;
      // PR fix/visibility-auth-matrix: task comments も cascade 物理削除 (§5.51)
      await tx.comment.deleteMany({
        where: { tenantId: viewerTenantId, entityType: 'task', entityId: { in: taskIds } },
      });
    }
    if (estimateIds.length > 0) {
      const attEstRes = await tx.attachment.deleteMany({
        where: { tenantId: viewerTenantId, entityType: 'estimate', entityId: { in: estimateIds } },
      });
      attachmentsDeleted += attEstRes.count;
    }
    const attProjRes = await tx.attachment.deleteMany({
      where: { tenantId: viewerTenantId, entityType: 'project', entityId: projectId },
    });
    attachmentsDeleted += attProjRes.count;

    // Task / Estimate / ProjectMember は projectId 経由で tenant 転写済 (project は検証済)。
    // ProjectMember は tenantId 列を持たないため projectId 一致のみで十分。
    await tx.task.deleteMany({ where: { projectId, project: { tenantId: viewerTenantId } } });
    await tx.estimate.deleteMany({ where: { projectId, project: { tenantId: viewerTenantId } } });
    await tx.projectMember.deleteMany({ where: { projectId, project: { tenantId: viewerTenantId } } });
    // 2026-05-09 hotfix: SuggestionExplanation の FK (suggestion_explanations_project_id_fkey)
    //   が ON DELETE CASCADE 未指定のため、project.delete 前に明示削除しないと P2003 エラー。
    //   P-3 (2026-05-08) で SuggestionExplanation テーブルを追加したが、deleteProjectCascade
    //   に対応する cleanup を追加し忘れていた本番事象を修正 (KDD §5.X+6)。
    //   2026-05-12: 多層防御として tenantId 明示。
    await tx.suggestionExplanation.deleteMany({ where: { tenantId: viewerTenantId, projectId } });
    await tx.project.delete({ where: { id: projectId } });
  }, { timeout: 30_000 });

  // ADR-0025 (2026-05-29): Beginner プラン超過状態からの cascade DELETE で容量キャッシュを即時更新。
  //   cascade は最大規模の容量解放経路 (knowledge / risk / retro / task / attachment 全て削除)。
  //   transaction 後に呼ぶ (= isolation level race 回避)。fail-safe で throw しない。
  const { maybeRecalcAfterBeginnerDelete } = await import('@/services/tenant-storage.service');
  await maybeRecalcAfterBeginnerDelete(viewerTenantId);

  return {
    risks: risksCount,
    issues: issuesCount,
    retrospectives: retrosCount,
    knowledgeDeleted,
    knowledgeUnlinked,
    attachmentsDeleted,
  };
}
