/**
 * GET /api/projects/[projectId]/tasks/workload
 *
 * 2026-05-09 (PR H / #7): 担当者別 日次工数集計を返す。
 *
 * Activity (type='activity') の plannedEffort を planned 期間で按分し、
 * assignee × date でローリングして JSON 化する。
 *
 * 認可: task:read (プロジェクトメンバー or admin)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeDailyWorkload } from '@/services/task.service';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId } = await params;
  const forbidden = await checkProjectPermission(user, projectId, 'task:read');
  if (forbidden) return forbidden;

  const data = await getAssigneeDailyWorkload(projectId);
  return NextResponse.json({ data });
}
