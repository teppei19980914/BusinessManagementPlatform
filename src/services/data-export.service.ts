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
    select: { id: true, name: true, slug: true },
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
 */
function stripUserPII(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    systemRole: user.systemRole,
    isActive: user.isActive,
    themePreference: user.themePreference,
    timezone: user.timezone,
    locale: user.locale,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
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

/** RFC 4180 互換の CSV エスケープ */
function csvEscape(value: unknown): string {
  if (value == null) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = ['﻿' + headers.join(',')]; // UTF-8 BOM (Excel 日本語対応)
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\r\n');
}

function buildProjectsCsv(projects: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      'id', 'name', 'customerId', 'purpose', 'background', 'scope', 'outOfScope',
      'devMethod', 'contractType', 'businessDomainTags', 'techStackTags', 'processTags',
      'plannedStartDate', 'plannedEndDate', 'status', 'notes',
      'createdBy', 'updatedBy', 'createdAt', 'updatedAt',
    ],
    projects,
  );
}

function buildKnowledgeCsv(knowledge: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      'id', 'title', 'knowledgeType', 'background', 'content', 'result',
      'conclusion', 'recommendation', 'reusability', 'techTags', 'devMethod',
      'processTags', 'businessDomainTags', 'visibility', 'createdBy', 'updatedBy',
      'createdAt', 'updatedAt',
    ],
    knowledge,
  );
}

function buildRisksIssuesCsv(risksIssues: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      'id', 'projectId', 'type', 'title', 'content', 'cause', 'responsePolicy',
      'responseDetail', 'state', 'priority', 'reportedBy', 'assigneeId',
      'reportedAt', 'resolvedAt', 'createdAt', 'updatedAt',
    ],
    risksIssues,
  );
}

function buildRetrospectivesCsv(retrospectives: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      'id', 'projectId', 'conductedDate', 'goodPoints', 'problems', 'improvements',
      'visibility', 'createdBy', 'createdAt', 'updatedAt',
    ],
    retrospectives,
  );
}

function buildMemosCsv(memos: Array<Record<string, unknown>>): string {
  return buildCsv(
    [
      'id', 'title', 'content', 'visibility', 'createdBy', 'createdAt', 'updatedAt',
    ],
    memos,
  );
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
