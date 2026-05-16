/**
 * GET /api/admin/super/cron-history (PR feat/cron-execution-log / 2026-05-18)
 *
 * 役割:
 *   `cron_execution_logs` の直近実行履歴を super_admin 向けに返す。
 *   timeout 検知 (= status='running' のまま 30 秒以上経過) を含む。
 *
 * 認可: super_admin のみ。
 *
 * クエリ:
 *   - `limit` (default 100, max 500): 取得件数
 *   - `cronName` (optional): cron 名で絞り込み
 *   - `status` (optional): 'running' | 'success' | 'failure' で絞り込み
 *
 * レスポンス:
 *   ```
 *   {
 *     data: {
 *       entries: Array<{
 *         id, cronName, startedAt, completedAt, durationMs, status,
 *         errorMessage, invokerIp, description, isStaleRunning
 *       }>
 *     }
 *   }
 *   ```
 *
 *   `isStaleRunning = status==='running' && startedAt < now - 30s` で UI が timeout 疑いを警告色表示する。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { fetchCronHistoryView } from '@/services/cron-history.service';
import { getCronDescription } from '@/config/cron-jobs';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const url = new URL(req.url);
  const limit = Math.min(
    Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100,
    500,
  );

  const { summary, history } = await fetchCronHistoryView(limit);
  const enriched = history.map((e) => ({
    ...e,
    description: getCronDescription(e.cronName),
  }));

  return NextResponse.json({ data: { summary, entries: enriched } });
}
