/**
 * 外部移行インポート — Backlog コネクタ (変換層) (ADR-0034 / IMPORT_CONNECTORS.md §2)
 *
 * 役割:
 *   Backlog API のレスポンス (プロジェクト + 課題一覧) を NormalizedBatch に変換する **純関数**。
 *   HTTP 取得・認証・ページングは汎用コネクタ基盤が担い、本モジュールは変換のみ (テスト容易)。
 *
 * 変換ルール:
 *   - issueType.id が wbsIssueTypeIds に含まれる課題 → WBS ノード (parentIssueId で階層化)。
 *     階層は最大 2 段 (Backlog のサブタスクは 1 段)。枝=WP/葉=ACT は wbs-hierarchy が構造判定。
 *   - それ以外の課題 → リスク・課題 (既定 type='issue')。
 *   - Backlog に顧客概念は無いため、ウィザードで指定された customerName があれば顧客を 1 件作り紐づける。
 *   - 日付 (startDate/dueDate) は Backlog が既に YYYY-MM-DD。最終正規化は取り込み経路の normalizeDate に委ねる。
 */

import { convertToWbsRows, type SourceWbsNode } from '../wbs-hierarchy';
import {
  emptyBatch,
  type NormalizedBatch,
  type NormalizedProject,
  type NormalizedRiskIssue,
} from '../normalized-batch';

/** Backlog 課題 (本変換が参照する最小フィールド)。出典: developer.nulab.com/docs/backlog/api/2/get-issue-list/ */
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

export interface BacklogTransformInput {
  project: BacklogProject;
  issues: BacklogIssue[];
  /** WBS として扱う issueType.id の集合。含まれないものはリスク・課題へ。 */
  wbsIssueTypeIds: number[];
  /** ウィザードで指定された顧客名 (任意)。指定時は顧客を作り project に紐づける。 */
  customerName?: string | null;
}

/**
 * Backlog のプロジェクト + 課題を NormalizedBatch に変換する。
 */
export function backlogToNormalizedBatch(input: BacklogTransformInput): NormalizedBatch {
  const batch = emptyBatch('backlog');
  const wbsTypeIds = new Set(input.wbsIssueTypeIds);

  const customerName = input.customerName?.trim() || null;
  if (customerName) {
    batch.customers.push({ sourceKey: customerName, name: customerName });
  }

  // 課題を WBS / リスク課題 に振り分け
  const wbsNodes: SourceWbsNode[] = [];
  const risks: NormalizedRiskIssue[] = [];

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
      risks.push({
        type: 'issue',
        title: issue.summary,
        content: issue.description ?? null,
        deadline: issue.dueDate ?? null,
        // impact/likelihood は Backlog に対応概念が無いため未指定 (取り込み経路で既定値)
        visibility: 'draft',
      });
    }
  }

  const wbsResult = convertToWbsRows(wbsNodes);
  batch.warnings.push(...wbsResult.warnings);

  const project: NormalizedProject = {
    sourceKey: input.project.projectKey || String(input.project.id),
    customerRef: customerName,
    name: input.project.name,
    wbs: wbsResult.rows,
    risks,
    knowledge: [],
    retros: [],
  };
  batch.projects.push(project);

  return batch;
}
