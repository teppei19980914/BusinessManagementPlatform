/**
 * テナントデータ一括インポートサービス (P-D / 2026-05-08)
 *
 * 役割:
 *   P-C で出力された ZIP を受け取り、現テナントに **全件新規作成** で取り込む。
 *   既存データのマージや上書きは行わない (= 部分インポート/更新は既存 UI で対応)。
 *
 * 認可境界:
 *   呼出側で「テナント管理者 (admin) が自テナント」を確認した前提。
 *   本サービスは tenantId を受け取り、その tenantId スコープでデータを作成する。
 *
 * 入力フォーマット:
 *   P-C で出力した ZIP 構造のみ受付 (他フォーマットは INVALID_FORMAT で拒否)。
 *   - data/projects.json / tasks.json / ... users.json (15 種類)
 *   - metadata.json は読み込むがバリデーション情報のみで業務反映には使わない
 *
 * UUID 再採番:
 *   - エクスポート元の UUID は信用しない (= 異テナントの ID と衝突する可能性)。
 *   - 全エンティティの UUID を新規発行し、entity 種類ごとの Map<oldId, newId> を構築。
 *   - 各レコードの FK / 自己参照 / polymorphic entityId は Map 経由で書き換える。
 *
 * Beginner プラン席数チェック (P-2 と整合):
 *   - 現プラン beginner かつ 「現在の active 席数 + 新規作成される users 数 > beginnerMaxSeats (=5)」
 *     なら拒否 (BEGINNER_SEAT_LIMIT)。
 *   - 既存 email と一致するユーザは「マージ」扱い (= 既存ユーザに FK を再マップ) で
 *     新規作成しないため、席数増には寄与しない。
 *
 * 二重インポート防止:
 *   - Tenant.importInProgressAt に NOW() を SET してロック。
 *   - 30 分超 (IMPORT_LOCK_STALE_MINUTES) 経過したロックはクラッシュ残留扱いで自動失効。
 *
 * Embedding:
 *   - エクスポート時に除外されているため、インポート後の embedding 列は NULL。
 *   - 提案エンジン v2 の意味検索は再 embedding が必要 (運用 cron / 後続バッチで対応)。
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-D
 *   - 対称サービス: src/services/data-export.service.ts (P-C)
 *   - API: src/app/api/tenants/me/import/route.ts
 */

import JSZip from 'jszip';
import { randomUUID } from 'crypto';
import { hash as bcryptHash } from 'bcryptjs';
import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
// 取込後に peak 計測 + Beginner 無料枠 post-check を best-effort 実行する
//   2026-05-31: 50GB 累積ハードキャップ (StorageLimitExceededError) は撤去 (ADR-0030)
import {
  assertStorageLimitInTx,
  // ADR-0025 (2026-05-29): Beginner プラン超過時の専用エラー型
  BeginnerWriteGuardExceededError,
} from '@/services/storage-guard.service';

const IMPORT_LOCK_STALE_MINUTES = 30;
const BCRYPT_ROUNDS = 10;
/**
 * D-1 (PHASE2_THREAT_MODEL.md / 2026-05-08): ZIP 解凍後の合計サイズ上限。
 *
 * 50MB の ZIP 自体は middleware で弾けるが、極端な圧縮率の ZIP (= ZIP bomb) は
 * 解凍時にメモリ + DB を大量消費して DoS になりうる。本上限はその二重防御。
 *
 * 200MB は通常運用 (= 5,000 行 × 数 KB) の 10 倍以上の安全マージン。
 */
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

// ================================================================
// 公開型
// ================================================================

export type ImportErrorCode =
  | 'INVALID_ZIP' // ZIP として読めない / 破損
  | 'INVALID_FORMAT' // 必須ファイル不足 / JSON parse 不可
  | 'TENANT_NOT_FOUND'
  | 'IMPORT_IN_PROGRESS' // 二重インポート (in-flight ロック発火)
  | 'BEGINNER_SEAT_LIMIT' // Beginner 5 席超過
  | 'DECOMPRESSED_TOO_LARGE' // D-1: ZIP 解凍後サイズが上限超過 (= ZIP bomb 二重防御)
  // ADR-0025 (2026-05-29): Beginner プラン 50MB / 100MB 超過 → ZIP 取込ロールバック
  | 'BEGINNER_QUOTA_EXCEEDED';

export type DataImportResult =
  | { ok: true; summary: ImportSummary }
  | { ok: false; error: ImportErrorCode; message: string };

export type ImportSummary = {
  importedAt: string;
  tenantId: string;
  counts: {
    projects: number;
    tasks: number;
    estimates: number;
    projectMembers: number;
    knowledge: number;
    knowledgeProjects: number;
    risksIssues: number;
    retrospectives: number;
    memos: number;
    customers: number;
    stakeholders: number;
    comments: number;
    mentions: number;
    attachments: number;
    /** 新規作成された users の数 (= Beginner 席数判定で +1 されるユーザ) */
    usersCreated: number;
    /** Email 一致で既存ユーザに再マップされた数 (新規作成されない) */
    usersMerged: number;
  };
};

// ================================================================
// 公開関数
// ================================================================

/**
 * 指定テナントに ZIP の業務データを一括取り込みする。
 *
 * @param tenantId 対象テナント ID
 * @param zipBuffer P-C で出力した ZIP の Buffer
 * @param importerUserId 実行者 (= 管理者) の userId。FK fallback / 監査記録に使用
 */
export async function importTenantData(
  tenantId: string,
  zipBuffer: Buffer,
  importerUserId: string,
): Promise<DataImportResult> {
  // ---------- 1. テナント存在確認 ----------
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
  });
  if (!tenant) {
    return { ok: false, error: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' };
  }

  // ---------- 2. ZIP パース + 構造バリデーション ----------
  let parsed: ParsedExport;
  try {
    parsed = await parseZip(zipBuffer);
  } catch (e) {
    if (e instanceof Error && e.message === 'INVALID_FORMAT') {
      return {
        ok: false,
        error: 'INVALID_FORMAT',
        message: 'ZIP の構造が P-C エクスポート形式と一致しません。data/ 配下に必須 JSON ファイルが揃っているか確認してください。',
      };
    }
    if (e instanceof Error && e.message === 'DECOMPRESSED_TOO_LARGE') {
      return {
        ok: false,
        error: 'DECOMPRESSED_TOO_LARGE',
        message: `ZIP 解凍後の合計サイズが上限 (${MAX_DECOMPRESSED_BYTES / 1024 / 1024} MB) を超過しています。圧縮率の高い ZIP は展開時に大量のメモリを消費するため拒否されます。データを分割して再アップロードしてください。`,
      };
    }
    return {
      ok: false,
      error: 'INVALID_ZIP',
      message: 'ZIP として読み込めませんでした。ファイルが破損している可能性があります。',
    };
  }

  // ---------- 3. Beginner 席数事前チェック ----------
  const seatCheck = await checkBeginnerSeatLimit(tenant, parsed.users);
  if (!seatCheck.ok) {
    return { ok: false, error: 'BEGINNER_SEAT_LIMIT', message: seatCheck.message };
  }

  // ---------- 4. in-flight ロック取得 ----------
  const acquired = await acquireImportLock(tenantId);
  if (!acquired) {
    return {
      ok: false,
      error: 'IMPORT_IN_PROGRESS',
      message: '別のインポート処理が進行中です。完了後に再度お試しください。',
    };
  }

  // ---------- 5. 全件作成 (write tx) + ストレージ Post-check (best-effort、別 tx) ----------
  // 2026-05-31 (ADR-0030「データはたすきばの命」): 50GB 累積ハードキャップ撤去に伴い write tx と
  //   peak 計測を分離。write は単独コミットし、計測失敗で巻き戻さない (fail-open、日次 cron が補正)。
  //   Beginner 無料枠超過は pre-check (runImportStoragePrecheck) が事前ブロック。ここは保険の post-check。
  try {
    const summary = await prisma.$transaction(
      async (tx) => runImport(tx, tenantId, parsed, importerUserId),
      { timeout: 120_000, maxWait: 10_000 },
    );
    try {
      await prisma.$transaction(
        async (tx) => assertStorageLimitInTx(tx, tenantId),
        { timeout: 10_000 },
      );
    } catch (postErr) {
      // Beginner 無料枠超過は専用文言を返す (data は既にコミット済、precheck 取り逃しの保険)
      if (postErr instanceof BeginnerWriteGuardExceededError) {
        return {
          ok: false,
          error: 'BEGINNER_QUOTA_EXCEEDED',
          message:
            'Beginner プランの無料枠 (DB 50MB / Storage 100MB) を超えました。不要なデータを削除する、または Expert プランへアップグレードしてください。',
        };
      }
      // 計測失敗 (fail-open): storage-guard 内で記録済 + 日次 cron が補正するため握りつぶす。
    }
    return { ok: true, summary };
  } finally {
    // 例外時もロック解放 (失敗で残らないように try/finally で保証)
    await releaseImportLock(tenantId);
  }
}

// ================================================================
// 内部: ZIP パース
// ================================================================

type ParsedExport = {
  metadata?: Record<string, unknown>;
  projects: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  estimates: Record<string, unknown>[];
  projectMembers: Record<string, unknown>[];
  knowledge: Record<string, unknown>[];
  knowledgeProjects: Record<string, unknown>[];
  risksIssues: Record<string, unknown>[];
  retrospectives: Record<string, unknown>[];
  memos: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  stakeholders: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  mentions: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  users: Record<string, unknown>[];
};

const REQUIRED_DATA_FILES = [
  'projects',
  'tasks',
  'estimates',
  'project_members',
  'knowledge',
  'knowledge_projects',
  'risks_issues',
  'retrospectives',
  'memos',
  'customers',
  'stakeholders',
  'comments',
  'mentions',
  'attachments',
  'users',
] as const;

async function parseZip(zipBuffer: Buffer): Promise<ParsedExport> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    throw new Error('INVALID_ZIP');
  }

  // D-1 (PHASE2_THREAT_MODEL.md / 2026-05-08): ZIP 解凍前に合計の解凍後サイズを推定し、
  //   200MB を超えていれば ZIP bomb 疑いで拒否する (= 実際にメモリに展開する前に弾く)。
  //   `_data.uncompressedSize` は jszip 内部 API だが安定して提供されている。
  //   将来 jszip の API 変更に備え、`?? 0` で fallback して null safe。
  const totalUncompressed = Object.values(zip.files).reduce((sum, f) => {
    if (f.dir) return sum;
    const fileSize =
      (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    return sum + fileSize;
  }, 0);
  if (totalUncompressed > MAX_DECOMPRESSED_BYTES) {
    throw new Error('DECOMPRESSED_TOO_LARGE');
  }

  const result: Partial<Record<string, Record<string, unknown>[]>> = {};
  for (const name of REQUIRED_DATA_FILES) {
    const entry = zip.file(`data/${name}.json`);
    if (!entry) throw new Error('INVALID_FORMAT');
    const text = await entry.async('string');
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw new Error('INVALID_FORMAT');
    }
    if (!Array.isArray(parsedJson)) throw new Error('INVALID_FORMAT');
    result[name] = parsedJson as Record<string, unknown>[];
  }

  // metadata.json は任意 (バリデーションには使わない)
  const metadataEntry = zip.file('metadata.json');
  let metadata: Record<string, unknown> | undefined;
  if (metadataEntry) {
    try {
      metadata = JSON.parse(await metadataEntry.async('string')) as Record<string, unknown>;
    } catch {
      // metadata 破損は警告のみ (本体データが揃っていればインポート可)
    }
  }

  return {
    metadata,
    projects: result.projects!,
    tasks: result.tasks!,
    estimates: result.estimates!,
    projectMembers: result.project_members!,
    knowledge: result.knowledge!,
    knowledgeProjects: result.knowledge_projects!,
    risksIssues: result.risks_issues!,
    retrospectives: result.retrospectives!,
    memos: result.memos!,
    customers: result.customers!,
    stakeholders: result.stakeholders!,
    comments: result.comments!,
    mentions: result.mentions!,
    attachments: result.attachments!,
    users: result.users!,
  };
}

// ================================================================
// 内部: in-flight ロック
// ================================================================

async function acquireImportLock(tenantId: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - IMPORT_LOCK_STALE_MINUTES * 60 * 1000);
  // updateMany + WHERE で原子的に取得。既に有効なロックがあれば count=0 になる
  const result = await prisma.tenant.updateMany({
    where: {
      id: tenantId,
      deletedAt: null,
      OR: [{ importInProgressAt: null }, { importInProgressAt: { lt: staleThreshold } }],
    },
    data: { importInProgressAt: new Date() },
  });
  return result.count > 0;
}

async function releaseImportLock(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { importInProgressAt: null },
  });
}

// ================================================================
// 内部: Beginner 席数事前チェック
// ================================================================

async function checkBeginnerSeatLimit(
  tenant: { id: string; plan: string; beginnerMaxSeats: number },
  importedUsers: Record<string, unknown>[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (tenant.plan !== 'beginner') return { ok: true };

  const existingUsers = await prisma.user.findMany({
    where: { tenantId: tenant.id, deletedAt: null },
    select: { email: true, isActive: true },
  });
  const existingActive = existingUsers.filter((u) => u.isActive).length;
  const existingEmails = new Set(existingUsers.map((u) => u.email.toLowerCase()));

  // インポートされる users のうち「新規 email かつ active」のみが席数増の対象
  const newActiveImports = importedUsers.filter((u) => {
    const email = String(u.email ?? '').toLowerCase();
    if (!email) return false;
    if (existingEmails.has(email)) return false; // merge 扱い (既存に再マップ)
    return u.isActive !== false;
  });

  const projected = existingActive + newActiveImports.length;
  if (projected > tenant.beginnerMaxSeats) {
    return {
      ok: false,
      message: `Beginner プランは最大 ${tenant.beginnerMaxSeats} 席までです。インポート後の active 席数は ${projected} となるため上限を超過します。Expert / Pro プランへのアップグレード、または ZIP 内の users.json から不要なユーザを除外して再インポートしてください。`,
    };
  }
  return { ok: true };
}

// ================================================================
// 内部: メイン処理 (トランザクション内)
// ================================================================

type IdMaps = {
  user: Map<string, string>;
  customer: Map<string, string>;
  project: Map<string, string>;
  task: Map<string, string>;
  estimate: Map<string, string>;
  risk: Map<string, string>;
  knowledge: Map<string, string>;
  retrospective: Map<string, string>;
  stakeholder: Map<string, string>;
  memo: Map<string, string>;
  comment: Map<string, string>;
};

async function runImport(
  tx: Prisma.TransactionClient,
  tenantId: string,
  parsed: ParsedExport,
  importerUserId: string,
): Promise<ImportSummary> {
  const maps: IdMaps = {
    user: new Map(),
    customer: new Map(),
    project: new Map(),
    task: new Map(),
    estimate: new Map(),
    risk: new Map(),
    knowledge: new Map(),
    retrospective: new Map(),
    stakeholder: new Map(),
    memo: new Map(),
    comment: new Map(),
  };

  // ---------- 1. Users (FK 0) ----------
  // 既存 email と一致するユーザは「merge」: 新規作成せず、map[oldId] = 既存ユーザ ID にする。
  const existingUsers = await tx.user.findMany({
    where: { tenantId },
    select: { id: true, email: true },
  });
  const emailToExistingId = new Map<string, string>();
  for (const u of existingUsers) emailToExistingId.set(u.email.toLowerCase(), u.id);

  let usersCreated = 0;
  let usersMerged = 0;
  // bcrypt は遅いので、新規作成ユーザ全員に同じランダムハッシュを使う
  // (ログイン不可な値、forcePasswordChange=true で初回 reset を強制)。
  const placeholderHash = await bcryptHash(`import-placeholder-${randomUUID()}`, BCRYPT_ROUNDS);

  for (const u of parsed.users) {
    const oldId = String(u.id);
    if (!oldId) continue;
    const email = String(u.email ?? '').toLowerCase();
    if (!email) continue;

    const existingId = emailToExistingId.get(email);
    if (existingId) {
      maps.user.set(oldId, existingId);
      usersMerged += 1;
      continue;
    }

    const newId = randomUUID();
    await tx.user.create({
      data: {
        id: newId,
        tenantId,
        name: String(u.name ?? '').slice(0, 100),
        email: String(u.email),
        passwordHash: placeholderHash,
        // S-2 (PHASE2_THREAT_MODEL.md / 2026-05-08): ZIP 改ざんによる admin 昇格を防止するため
        //   ZIP 内の systemRole 値は信用せず、必ず 'general' で固定する。
        //   admin 権限が必要なユーザは、import 後に既存の admin 招待フローで個別昇格させる。
        systemRole: 'general',
        isActive: u.isActive !== false,
        themePreference:
          typeof u.themePreference === 'string' ? u.themePreference : 'light',
        // PR-1 (2026-05-15): timezone / locale はテナント単位に集約されたため User には設定しない。
        //   旧 ZIP 形式 (User.timezone / User.locale を含む) は黙って無視して取込を継続する。
        //   テナントの TZ/locale は既存テナント側設定を維持。
        forcePasswordChange: true, // インポートユーザは必ず初回パスワード変更
      },
    });
    maps.user.set(oldId, newId);
    usersCreated += 1;
  }

  /** user FK の解決: map にあれば new ID、なければ importer (admin) にフォールバック */
  const resolveUserFk = (oldId: unknown): string => {
    const key = oldId == null ? '' : String(oldId);
    return maps.user.get(key) ?? importerUserId;
  };
  /** nullable user FK: map になければ null (= 削除済みユーザ参照を救済しない) */
  const resolveUserFkNullable = (oldId: unknown): string | null => {
    if (oldId == null) return null;
    return maps.user.get(String(oldId)) ?? null;
  };

  // ---------- 2. Customers ----------
  for (const c of parsed.customers) {
    const oldId = String(c.id);
    const newId = randomUUID();
    await tx.customer.create({
      data: {
        id: newId,
        tenantId,
        name: String(c.name ?? '').slice(0, 100),
        department: stringOrNull(c.department),
        contactPerson: stringOrNull(c.contactPerson),
        contactEmail: stringOrNull(c.contactEmail),
        notes: stringOrNull(c.notes),
        createdBy: resolveUserFk(c.createdBy),
        updatedBy: resolveUserFk(c.updatedBy),
      },
    });
    maps.customer.set(oldId, newId);
  }

  // ---------- 3. Projects ----------
  for (const p of parsed.projects) {
    const oldId = String(p.id);
    const newId = randomUUID();
    const customerId = maps.customer.get(String(p.customerId));
    if (!customerId) continue; // dangling customer ref → skip
    await tx.project.create({
      data: {
        id: newId,
        tenantId,
        name: String(p.name ?? '').slice(0, 100),
        customerId,
        purpose: String(p.purpose ?? ''),
        background: String(p.background ?? ''),
        scope: String(p.scope ?? ''),
        outOfScope: stringOrNull(p.outOfScope),
        devMethod: String(p.devMethod ?? 'waterfall'),
        contractType: stringOrNull(p.contractType),
        businessDomainTags: jsonOrEmptyArray(p.businessDomainTags),
        techStackTags: jsonOrEmptyArray(p.techStackTags),
        processTags: jsonOrEmptyArray(p.processTags),
        plannedStartDate: dateOrNow(p.plannedStartDate),
        plannedEndDate: dateOrNow(p.plannedEndDate),
        status: String(p.status ?? 'planning'),
        notes: stringOrNull(p.notes),
        isSampleData: false, // インポート由来は本物データ扱い
        createdBy: resolveUserFk(p.createdBy),
        updatedBy: resolveUserFk(p.updatedBy),
      },
    });
    maps.project.set(oldId, newId);
  }

  // ---------- 4. Tasks (2-pass: 親優先で挿入) ----------
  // Pre-allocate 全 task の new ID をマップに先に登録 → DB INSERT 時に parentTaskId を解決可能に。
  for (const t of parsed.tasks) maps.task.set(String(t.id), randomUUID());
  // 親優先トポロジカル順序で INSERT
  const sortedTasks = sortTasksByParentDepth(parsed.tasks);
  for (const t of sortedTasks) {
    const oldId = String(t.id);
    const newId = maps.task.get(oldId)!;
    const projectId = maps.project.get(String(t.projectId));
    if (!projectId) continue;
    const parentTaskId = t.parentTaskId
      ? maps.task.get(String(t.parentTaskId)) ?? null
      : null;
    await tx.task.create({
      data: {
        id: newId,
        projectId,
        parentTaskId,
        type: String(t.type ?? 'activity'),
        wbsNumber: stringOrNull(t.wbsNumber),
        name: String(t.name ?? '').slice(0, 100),
        description: stringOrNull(t.description),
        category: String(t.category ?? ''),
        assigneeId: resolveUserFkNullable(t.assigneeId),
        plannedStartDate: dateOrNull(t.plannedStartDate),
        plannedEndDate: dateOrNull(t.plannedEndDate),
        actualStartDate: dateOrNull(t.actualStartDate),
        actualEndDate: dateOrNull(t.actualEndDate),
        plannedEffort: numericString(t.plannedEffort) ?? '0',
        priority: stringOrNull(t.priority) ?? 'medium',
        status: String(t.status ?? 'not_started'),
        progressRate: typeof t.progressRate === 'number' ? t.progressRate : 0,
        isMilestone: Boolean(t.isMilestone),
        notes: stringOrNull(t.notes),
        createdBy: resolveUserFk(t.createdBy),
        updatedBy: resolveUserFk(t.updatedBy),
      },
    });
  }

  // ---------- 5. Estimates ----------
  for (const e of parsed.estimates) {
    const projectId = maps.project.get(String(e.projectId));
    if (!projectId) continue;
    const newId = randomUUID();
    await tx.estimate.create({
      data: {
        id: newId,
        projectId,
        itemName: String(e.itemName ?? '').slice(0, 100),
        category: String(e.category ?? ''),
        devMethod: String(e.devMethod ?? 'waterfall'),
        estimatedEffort: numericString(e.estimatedEffort) ?? '0',
        effortUnit: String(e.effortUnit ?? 'hour'),
        rationale: String(e.rationale ?? ''),
        preconditions: stringOrNull(e.preconditions),
        isConfirmed: Boolean(e.isConfirmed),
        notes: stringOrNull(e.notes),
        createdBy: resolveUserFk(e.createdBy),
        updatedBy: resolveUserFk(e.updatedBy),
      },
    });
    maps.estimate.set(String(e.id), newId);
  }

  // ---------- 6. ProjectMembers ----------
  for (const pm of parsed.projectMembers) {
    const projectId = maps.project.get(String(pm.projectId));
    const userId = maps.user.get(String(pm.userId));
    if (!projectId || !userId) continue;
    // unique 制約 (projectId, userId) — 既存にある場合は skip
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (existing) continue;
    await tx.projectMember.create({
      data: {
        id: randomUUID(),
        projectId,
        userId,
        projectRole: String(pm.projectRole ?? 'member'),
        assignedBy: resolveUserFk(pm.assignedBy),
      },
    });
  }

  // ---------- 7. Knowledge ----------
  for (const k of parsed.knowledge) {
    const newId = randomUUID();
    await tx.knowledge.create({
      data: {
        id: newId,
        tenantId,
        title: String(k.title ?? '').slice(0, 150),
        knowledgeType: String(k.knowledgeType ?? 'general'),
        background: String(k.background ?? ''),
        content: String(k.content ?? ''),
        result: String(k.result ?? ''),
        conclusion: stringOrNull(k.conclusion),
        recommendation: stringOrNull(k.recommendation),
        reusability: stringOrNull(k.reusability),
        techTags: jsonOrEmptyArray(k.techTags),
        devMethod: stringOrNull(k.devMethod),
        processTags: jsonOrEmptyArray(k.processTags),
        businessDomainTags: jsonOrEmptyArray(k.businessDomainTags),
        visibility: String(k.visibility ?? 'draft'),
        // feat/asset-assignee-expansion (2026-05-26): 担当者を import round-trip 対応
        assigneeId: resolveUserFkNullable(k.assigneeId),
        createdBy: resolveUserFk(k.createdBy),
        updatedBy: resolveUserFk(k.updatedBy),
      },
    });
    maps.knowledge.set(String(k.id), newId);
  }

  // ---------- 8. KnowledgeProjects (中間テーブル) ----------
  for (const kp of parsed.knowledgeProjects) {
    const knowledgeId = maps.knowledge.get(String(kp.knowledgeId));
    const projectId = maps.project.get(String(kp.projectId));
    if (!knowledgeId || !projectId) continue;
    const existing = await tx.knowledgeProject.findUnique({
      where: { knowledgeId_projectId: { knowledgeId, projectId } },
    });
    if (existing) continue;
    await tx.knowledgeProject.create({
      data: { id: randomUUID(), knowledgeId, projectId },
    });
  }

  // ---------- 9. RisksIssues ----------
  for (const r of parsed.risksIssues) {
    const projectId = maps.project.get(String(r.projectId));
    if (!projectId) continue;
    const newId = randomUUID();
    await tx.riskIssue.create({
      data: {
        id: newId,
        tenantId,
        projectId,
        type: String(r.type ?? 'risk'),
        title: String(r.title ?? '').slice(0, 100),
        content: String(r.content ?? ''),
        // feat/risk-issue-4-section (2026-05-26): import 時の occurrence 反映 (旧 export には未含のため null fallback)
        occurrence: stringOrNull(r.occurrence),
        cause: stringOrNull(r.cause),
        impact: String(r.impact ?? 'medium'),
        likelihood: stringOrNull(r.likelihood),
        priority: String(r.priority ?? 'medium'),
        responsePolicy: stringOrNull(r.responsePolicy),
        responseDetail: stringOrNull(r.responseDetail),
        reporterId: resolveUserFk(r.reporterId),
        assigneeId: resolveUserFkNullable(r.assigneeId),
        deadline: dateOrNull(r.deadline),
        state: String(r.state ?? 'open'),
        result: stringOrNull(r.result),
        lessonLearned: stringOrNull(r.lessonLearned),
        visibility: String(r.visibility ?? 'draft'),
        riskNature: stringOrNull(r.riskNature),
        createdBy: resolveUserFk(r.createdBy),
        updatedBy: resolveUserFk(r.updatedBy),
      },
    });
    maps.risk.set(String(r.id), newId);
  }

  // ---------- 10. Retrospectives ----------
  for (const rt of parsed.retrospectives) {
    const projectId = maps.project.get(String(rt.projectId));
    if (!projectId) continue;
    const newId = randomUUID();
    await tx.retrospective.create({
      data: {
        id: newId,
        tenantId,
        projectId,
        conductedDate: dateOrNow(rt.conductedDate),
        planSummary: String(rt.planSummary ?? ''),
        actualSummary: String(rt.actualSummary ?? ''),
        goodPoints: String(rt.goodPoints ?? ''),
        problems: String(rt.problems ?? ''),
        estimateGapFactors: stringOrNull(rt.estimateGapFactors),
        scheduleGapFactors: stringOrNull(rt.scheduleGapFactors),
        qualityIssues: stringOrNull(rt.qualityIssues),
        riskResponseEvaluation: stringOrNull(rt.riskResponseEvaluation),
        improvements: String(rt.improvements ?? ''),
        knowledgeToShare: stringOrNull(rt.knowledgeToShare),
        state: String(rt.state ?? 'draft'),
        visibility: String(rt.visibility ?? 'draft'),
        // feat/asset-assignee-expansion (2026-05-26): 担当者を import round-trip 対応。
        //   旧 export ファイル (assigneeId カラム無) は undefined → resolveUserFkNullable で null になる。
        assigneeId: resolveUserFkNullable(rt.assigneeId),
        createdBy: resolveUserFk(rt.createdBy),
        updatedBy: resolveUserFk(rt.updatedBy),
      },
    });
    maps.retrospective.set(String(rt.id), newId);
  }

  // ---------- 11. Memos ----------
  for (const m of parsed.memos) {
    const userId = maps.user.get(String(m.userId));
    if (!userId) continue;
    const newId = randomUUID();
    await tx.memo.create({
      data: {
        id: newId,
        tenantId,
        userId,
        title: String(m.title ?? '').slice(0, 150),
        content: String(m.content ?? ''),
        visibility: String(m.visibility ?? 'private'),
        // feat/asset-assignee-expansion (2026-05-26): 担当者を import round-trip 対応
        assigneeId: resolveUserFkNullable(m.assigneeId),
      },
    });
    maps.memo.set(String(m.id), newId);
  }

  // ---------- 12. Stakeholders ----------
  for (const s of parsed.stakeholders) {
    const projectId = maps.project.get(String(s.projectId));
    if (!projectId) continue;
    const newId = randomUUID();
    await tx.stakeholder.create({
      data: {
        id: newId,
        tenantId,
        projectId,
        userId: resolveUserFkNullable(s.userId),
        name: String(s.name ?? '').slice(0, 100),
        organization: stringOrNull(s.organization),
        role: stringOrNull(s.role),
        contactInfo: stringOrNull(s.contactInfo),
        influence: typeof s.influence === 'number' ? s.influence : 3,
        interest: typeof s.interest === 'number' ? s.interest : 3,
        attitude: String(s.attitude ?? 'neutral'),
        currentEngagement: String(s.currentEngagement ?? 'neutral'),
        desiredEngagement: String(s.desiredEngagement ?? 'neutral'),
        priority: String(s.priority ?? 'medium'),
        personality: stringOrNull(s.personality),
        tags: jsonOrEmptyArray(s.tags),
        strategy: stringOrNull(s.strategy),
        createdBy: resolveUserFk(s.createdBy),
        updatedBy: resolveUserFk(s.updatedBy),
      },
    });
    maps.stakeholder.set(String(s.id), newId);
  }

  // ---------- 13. Comments (polymorphic entityId) ----------
  for (const c of parsed.comments) {
    const entityType = String(c.entityType ?? '');
    const entityId = remapPolymorphicEntityId(maps, entityType, String(c.entityId));
    if (!entityId) continue; // 親エンティティ未存在なら skip
    const userId = maps.user.get(String(c.userId));
    if (!userId) continue;
    const newId = randomUUID();
    await tx.comment.create({
      data: {
        id: newId,
        tenantId,
        entityType,
        entityId,
        userId,
        content: String(c.content ?? ''),
      },
    });
    maps.comment.set(String(c.id), newId);
  }

  // ---------- 14. Mentions ----------
  for (const m of parsed.mentions) {
    const commentId = maps.comment.get(String(m.commentId));
    if (!commentId) continue;
    await tx.mention.create({
      data: {
        id: randomUUID(),
        tenantId,
        commentId,
        kind: String(m.kind ?? 'user'),
        targetUserId: resolveUserFkNullable(m.targetUserId),
      },
    });
  }

  // ---------- 15. Attachments (polymorphic entityId) ----------
  for (const a of parsed.attachments) {
    const entityType = String(a.entityType ?? '');
    const entityId = remapPolymorphicEntityId(maps, entityType, String(a.entityId));
    if (!entityId) continue;
    await tx.attachment.create({
      data: {
        id: randomUUID(),
        tenantId,
        entityType,
        entityId,
        slot: String(a.slot ?? 'general'),
        displayName: String(a.displayName ?? '').slice(0, 200),
        url: String(a.url ?? '').slice(0, 2000),
        mimeHint: stringOrNull(a.mimeHint),
        addedBy: resolveUserFk(a.addedBy),
      },
    });
  }

  return {
    importedAt: new Date().toISOString(),
    tenantId,
    counts: {
      projects: maps.project.size,
      tasks: maps.task.size,
      estimates: maps.estimate.size,
      projectMembers: parsed.projectMembers.length, // 個別 skip 数を厳密追跡しない
      knowledge: maps.knowledge.size,
      knowledgeProjects: parsed.knowledgeProjects.length,
      risksIssues: maps.risk.size,
      retrospectives: maps.retrospective.size,
      memos: maps.memo.size,
      customers: maps.customer.size,
      stakeholders: maps.stakeholder.size,
      comments: maps.comment.size,
      mentions: parsed.mentions.length,
      attachments: parsed.attachments.length,
      usersCreated,
      usersMerged,
    },
  };
}

// ================================================================
// 内部: ヘルパ
// ================================================================

/** Comments / Attachments の polymorphic entityId を、entityType に応じた map で書き換える */
function remapPolymorphicEntityId(
  maps: IdMaps,
  entityType: string,
  entityId: string,
): string | null {
  const map = pickPolymorphicMap(maps, entityType);
  if (!map) return null;
  return map.get(entityId) ?? null;
}

function pickPolymorphicMap(maps: IdMaps, entityType: string): Map<string, string> | null {
  switch (entityType) {
    case 'project':
      return maps.project;
    case 'task':
      return maps.task;
    case 'estimate':
      return maps.estimate;
    case 'issue': // Comments で issue は risks_issues (type=issue) を指す
    case 'risk':
      return maps.risk;
    case 'retrospective':
      return maps.retrospective;
    case 'knowledge':
      return maps.knowledge;
    case 'customer':
      return maps.customer;
    case 'stakeholder':
      return maps.stakeholder;
    case 'memo':
      return maps.memo;
    default:
      return null;
  }
}

/** Task の parentTaskId 自己参照を解決するため、親優先 (= 浅い depth から) でソートする。 */
function sortTasksByParentDepth(tasks: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const t of tasks) byId.set(String(t.id), t);

  const depthCache = new Map<string, number>();
  const computeDepth = (id: string, visiting = new Set<string>()): number => {
    if (depthCache.has(id)) return depthCache.get(id)!;
    if (visiting.has(id)) return 0; // 循環防御 (異常データ)
    visiting.add(id);
    const t = byId.get(id);
    if (!t || t.parentTaskId == null) {
      depthCache.set(id, 0);
      return 0;
    }
    const parentDepth = computeDepth(String(t.parentTaskId), visiting);
    const d = parentDepth + 1;
    depthCache.set(id, d);
    return d;
  };

  return [...tasks].sort((a, b) => computeDepth(String(a.id)) - computeDepth(String(b.id)));
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') return String(v);
  return v;
}

function jsonOrEmptyArray(v: unknown): Prisma.InputJsonValue {
  if (v == null) return [] as unknown as Prisma.InputJsonValue;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed as Prisma.InputJsonValue;
    } catch {
      return [] as unknown as Prisma.InputJsonValue;
    }
  }
  return v as Prisma.InputJsonValue;
}

function dateOrNow(v: unknown): Date {
  if (v == null) return new Date();
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? new Date() : d;
}

function dateOrNull(v: unknown): Date | null {
  if (v == null) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}

/** Decimal カラム用: number / string を文字列に正規化 */
function numericString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'object' && v !== null && 'toString' in v) return String(v);
  return null;
}
