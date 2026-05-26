/**
 * GET /api/tenants/me/external-import/template?entity=knowledge|risksIssues
 *   (Phase 1 / 2026-05-08)
 *
 * 外部データ移行用の CSV テンプレートを返す。
 *   - 列名 = 本サービスのフィールド名 (= マッピング UI で「同名選択」だけで通る最短経路を提供)
 *   - 必須列にはサンプル値を入れた行 1 つを含める (列の用途を直感で理解させるため)
 *   - UTF-8 BOM 付き (Excel で文字化けしない)
 *
 * 認可: admin role 必須 (テナント管理者向け機能のため)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// fix/list-export-import-bugs (2026-05-26): 編集 dialog で扱う列のみに整合させる。
//   - Knowledge: 6 列 (旧 13 列 → 結論/推奨/再利用性/開発方式/3 種タグを撤去)
//   - RisksIssues: 13 列 (occurrence を追加 / priority/対応詳細/教訓を撤去)
//   英語ヘッダーは設計意図 (= 内部フィールド名と一致させマッピング UI で同名選択を最短化) のため維持。
//   担当者 (assigneeId/assigneeName) はサービス層が未対応のため Phase 1 では除外。
const KNOWLEDGE_COLUMNS = [
  'title',
  'knowledgeType',
  'background',
  'content',
  'result',
  'visibility',
];

const KNOWLEDGE_SAMPLE_ROW = [
  '失敗事例: テスト環境でのデータ消失',
  // 受付値: failure/success/lesson/template/general (Phase 1 サービス仕様)
  //   sync-import の研究/検証/インシデント等 (research/verification/incident...) とは別 vocab。
  'failure',
  'リリース前検証中、複数チーム共有のテスト DB を意図せず truncate した',
  '原因はマイグレーションスクリプトの WHERE 句不足で、影響範囲を限定する条件が漏れていたため',
  'チーム全体のテスト作業が 1 日停止。以降はローカル dry-run + CI 自動チェックを必須化',
  // 受付値: draft / project / company
  'company',
];

// fix/list-export-import-bugs (2026-05-26): 編集 dialog で扱う 12 列に整合させる。
//   旧 15 列から responseDetail / lessonLearned を撤去 (UI 撤去済)。
//   priority は service 層が require のため一旦温存 (今後 impact/likelihood から自動算出に統一予定)。
//   occurrence (発生事象) は service 未対応のため一旦含めない (Phase 2 で対応予定)。
const RISKS_ISSUES_COLUMNS = [
  'type',
  'title',
  'content',
  'cause',
  'impact',
  'likelihood',
  'priority',
  'responsePolicy',
  'deadline',
  'state',
  'visibility',
  'riskNature',
  'projectId',
];

const RISKS_ISSUES_SAMPLE_ROW = [
  'risk',
  '主要メンバーの離脱可能性',
  'PM 候補が他社からオファーを受けている噂あり、現プロジェクトの進行に影響大',
  '報酬条件 + 役割の限定、長時間労働',
  'high',
  'medium',
  'high',
  '本人と面談 + 役割の魅力度向上 + 補佐の育成',
  '2026-06-30',
  'open',
  'draft',
  'threat',
  '', // projectId (任意、未指定なら画面でデフォルト所属プロジェクトを選択)
];

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsv(headers: string[], sampleRow: string[]): string {
  const lines = [
    '﻿' + headers.map(csvEscape).join(','), // UTF-8 BOM
    sampleRow.map(csvEscape).join(','),
  ];
  return lines.join('\r\n');
}

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const entity = req.nextUrl.searchParams.get('entity');
  let csv: string;
  let filename: string;
  if (entity === 'knowledge') {
    csv = buildCsv(KNOWLEDGE_COLUMNS, KNOWLEDGE_SAMPLE_ROW);
    filename = 'tasukiba-import-template-knowledge.csv';
  } else if (entity === 'risksIssues') {
    csv = buildCsv(RISKS_ISSUES_COLUMNS, RISKS_ISSUES_SAMPLE_ROW);
    filename = 'tasukiba-import-template-risks-issues.csv';
  } else {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FORMAT',
          message: 'entity パラメータは knowledge または risksIssues',
        },
      },
      { status: 400 },
    );
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
