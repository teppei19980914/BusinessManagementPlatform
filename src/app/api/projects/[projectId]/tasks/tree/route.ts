/**
 * タスクのツリー構造 + フラット配列を 1 レスポンスで返す。
 * プロジェクト詳細画面の WBS タブ（tree 表示）と ガントタブ（flat 表示）の
 * クライアントサイド遅延ロード用。内部は listTasksWithTree を呼び出す
 * （1 回の DB クエリで両形式を返す）。
 *
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.2
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { listTasksWithTree } from '@/services/task.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:read');
  if (forbidden) return forbidden;

  const result = await listTasksWithTree(projectId);
  return NextResponse.json({ data: result });
}
