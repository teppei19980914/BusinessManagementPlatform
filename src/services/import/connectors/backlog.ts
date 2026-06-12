/**
 * 外部移行インポート — Backlog (Nulab) コネクタ (ADR-0034 / IMPORT_CONNECTORS.md §2)
 *
 * 公式: developer.nulab.com/docs/backlog / API v2 (2026-06 再確認済)
 *
 * 現行仕様の要点:
 *   - 認証: API キー方式 (`?apiKey=` クエリ)。OAuth2 不要。
 *   - ベースURL: `https://{space}.backlog.com` / `.jp` / `.backlogtool.com` の 3 系統 →
 *     **フルベースURLをユーザ入力** (推測禁止)。
 *   - 課題一覧: GET /api/v2/issues (projectId[], count≤100, offset)、総数 GET /api/v2/issues/count。
 *   - 親子: parentIssueId (子→親の単方向)。サブタスクは有料プラン限定・実質 2 階層
 *     (subtaskingEnabled=false は全フラット)。
 *   - レート: 課題一覧/count は Search 枠 (≈150/分)。429 + X-RateLimit-* (http.ts が順守)。
 *   - ID はプロジェクト固有 → issueType/status は名称ベースで master-data へ正規化 (取り込み経路)。
 *
 * 統一方針: 出力は CsvEntitySource[]。WBS は parentIssueId のグラフを wbs-rows でレベル列に直列化し、
 * 既存 buildBatchFromCsv に流す (手動CSV経路と挙動一致)。
 */

import { fetchJson, collectByOffset, type HttpClientOptions } from './http';
import { wbsNodesToCsvRows, WBS_ROW_COLUMN_MAP } from './wbs-rows';
import type { SourceWbsNode } from '../wbs-hierarchy';
import type { CsvEntitySource } from '../csv-to-batch';
import type {
  ConnectorAuth,
  ConnectorMapping,
  DiscoveredField,
  DiscoveredSchema,
  DiscoveredSource,
  MigrationConnector,
} from './types';

const COUNT = 100;

// ---------------------------------------------------------------------------
// Backlog レスポンス最小型
// ---------------------------------------------------------------------------

export interface BacklogIssue {
  id: number;
  summary: string;
  description?: string | null;
  issueType?: { id: number; name: string } | null;
  parentIssueId?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  estimatedHours?: number | null;
}

export interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
}

export interface BacklogIssueType {
  id: number;
  name: string;
}

export interface BacklogTransformInput {
  project: BacklogProject;
  issues: BacklogIssue[];
  /** WBS として扱う issueType.id の集合。含まれないものはリスク・課題へ。 */
  wbsIssueTypeIds: number[];
  /** ウィザードで指定された顧客名 (任意)。指定時は顧客を作り project に紐づける。 */
  customerName?: string | null;
}

// ---------------------------------------------------------------------------
// 純関数: Backlog → CsvEntitySource[]
// ---------------------------------------------------------------------------

/**
 * Backlog のプロジェクト + 課題を CsvEntitySource[] に変換する (純関数)。
 * WBS 階層変換の警告は warnings で返す (previewMigrationFromSources に渡す)。
 */
export function backlogToCsvSources(input: BacklogTransformInput): {
  sources: CsvEntitySource[];
  warnings: string[];
} {
  const wbsTypeIds = new Set(input.wbsIssueTypeIds);
  const customerName = input.customerName?.trim() || '';
  const projectName = input.project.name;
  const sources: CsvEntitySource[] = [];
  const warnings: string[] = [];

  // 顧客 (任意)
  if (customerName) {
    sources.push({
      entity: 'customer',
      rows: [{ name: customerName }],
      columnMap: { name: 'name' },
    });
  }

  // プロジェクト
  sources.push({
    entity: 'project',
    rows: [{ name: projectName, customerName }],
    columnMap: { name: 'name', customerName: 'customerName' },
  });

  // 課題を WBS / リスク課題 に振り分け
  const wbsNodes: SourceWbsNode[] = [];
  const riskRows: Record<string, string>[] = [];

  for (const issue of input.issues) {
    const isWbs = issue.issueType != null && wbsTypeIds.has(issue.issueType.id);
    if (isWbs) {
      wbsNodes.push({
        sourceId: String(issue.id),
        parentSourceId: issue.parentIssueId != null ? String(issue.parentIssueId) : null,
        name: issue.summary,
        plannedStartDate: issue.startDate ?? null,
        plannedEndDate: issue.dueDate ?? null,
        plannedEffort: issue.estimatedHours ?? null,
      });
    } else {
      riskRows.push({
        projectName,
        type: 'issue', // Backlog の課題は既定で「課題」。impact/likelihood は対応概念なし→既定値
        title: issue.summary,
        content: issue.description ?? '',
        deadline: issue.dueDate ?? '',
      });
    }
  }

  if (wbsNodes.length > 0) {
    const { rows, warnings: w } = wbsNodesToCsvRows(wbsNodes, projectName);
    sources.push({ entity: 'wbs', rows, columnMap: WBS_ROW_COLUMN_MAP });
    warnings.push(...w);
  }

  if (riskRows.length > 0) {
    sources.push({
      entity: 'risk',
      rows: riskRows,
      columnMap: {
        projectName: 'projectName',
        type: 'type',
        title: 'title',
        content: 'content',
        deadline: 'deadline',
      },
    });
  }

  return { sources, warnings };
}

// ---------------------------------------------------------------------------
// HTTP: discover / fetch
// ---------------------------------------------------------------------------

/** ベースURL末尾スラッシュを除去。 */
function trimBase(baseUrl: string | undefined): string {
  return (baseUrl ?? '').replace(/\/+$/, '');
}

interface BacklogProjectFull extends BacklogProject {
  subtaskingEnabled?: boolean;
}

/**
 * discover: プロジェクト一覧と各 issueType を返す (ユーザが「どの issueType を WBS にするか」指定するため)。
 * fields にはプロジェクトの issueType を `issueType:<id>` キーで載せる。
 */
export async function backlogDiscover(auth: ConnectorAuth, http: HttpClientOptions = {}): Promise<DiscoveredSchema> {
  const base = trimBase(auth.baseUrl);
  const warnings: string[] = [];
  if (!base) {
    return { source: 'backlog', sources: [], warnings: ['ベースURL (例: https://xxx.backlog.com) を入力してください。'] };
  }

  const projects = await fetchJson<BacklogProjectFull[]>(
    { url: `${base}/api/v2/projects`, query: { apiKey: auth.token } },
    http,
  );

  const sources: DiscoveredSource[] = [];
  for (const p of projects) {
    const issueTypes = await fetchJson<BacklogIssueType[]>(
      { url: `${base}/api/v2/projects/${p.id}/issueTypes`, query: { apiKey: auth.token } },
      http,
    );
    const fields: DiscoveredField[] = issueTypes.map((t) => ({
      key: `issueType:${t.id}`,
      label: `課題種別: ${t.name}`,
      type: 'select',
    }));
    if (p.subtaskingEnabled === false) {
      warnings.push(`プロジェクト「${p.name}」はサブタスクが無効のため、課題はすべて最上位として取り込まれます。`);
    }
    sources.push({ id: String(p.id), name: p.name, fields });
  }
  return { source: 'backlog', sources, warnings };
}

interface BacklogCountResult {
  count: number;
}

/** 1 プロジェクトの全課題を offset ページングで取得。 */
async function fetchAllIssues(
  base: string,
  apiKey: string,
  projectId: number,
  http: HttpClientOptions,
): Promise<BacklogIssue[]> {
  const countRes = await fetchJson<BacklogCountResult>(
    { url: `${base}/api/v2/issues/count`, query: { apiKey, 'projectId[]': projectId } },
    http,
  );
  const total = countRes.count;
  return collectByOffset<BacklogIssue>(
    async (offset) => {
      const items = await fetchJson<BacklogIssue[]>(
        {
          url: `${base}/api/v2/issues`,
          query: { apiKey, 'projectId[]': projectId, count: COUNT, offset },
        },
        http,
      );
      return { items, total };
    },
    COUNT,
  );
}

/**
 * fetchSources: マッピング (sourceId=projectId、options.wbsIssueTypeIds、fixedMap.customerName) に従い取得・正規化。
 * Backlog はフィールド固定のため、columnMap よりも options/fixedMap が主。
 */
export async function backlogFetchSources(
  auth: ConnectorAuth,
  mapping: ConnectorMapping,
  http: HttpClientOptions = {},
): Promise<{ sources: CsvEntitySource[]; warnings: string[] }> {
  const base = trimBase(auth.baseUrl);
  const allSources: CsvEntitySource[] = [];
  const warnings: string[] = [];

  // プロジェクト一覧を 1 回取得して projectId → name 解決に使う
  const projects = await fetchJson<BacklogProject[]>(
    { url: `${base}/api/v2/projects`, query: { apiKey: auth.token } },
    http,
  );
  const byId = new Map(projects.map((p) => [String(p.id), p]));

  for (const m of mapping.mappings) {
    const project = byId.get(m.sourceId);
    if (!project) {
      warnings.push(`プロジェクト (ID: ${m.sourceId}) が見つかりませんでした。`);
      continue;
    }
    const wbsIssueTypeIds = (m.options?.wbsIssueTypeIds as number[] | undefined) ?? [];
    const customerName = m.fixedMap?.customerName ?? null;
    const issues = await fetchAllIssues(base, auth.token, project.id, http);
    const { sources, warnings: w } = backlogToCsvSources({ project, issues, wbsIssueTypeIds, customerName });
    allSources.push(...sources);
    warnings.push(...w);
  }
  return { sources: allSources, warnings };
}

export const backlogConnector: MigrationConnector = {
  source: 'backlog',
  discover: (auth) => backlogDiscover(auth),
  fetchSources: async (auth, mapping) => (await backlogFetchSources(auth, mapping)).sources,
};
