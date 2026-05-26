/**
 * POST /api/memos/export — メモ 4 列 CSV (T-22 Phase 22d)
 *
 * fix/list-export-import-bugs (2026-05-26):
 *   - GET → POST に変更し body で ids を受け取れるように (tasks /export と統一)
 *   - body.ids が指定されればその ID のみ export、未指定なら全件 (従来挙動)
 *
 * 認可: 認証済ユーザのみ (自分のメモのみ)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { exportMemosSync } from '@/services/memo-sync-import.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  let ids: string[] | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.ids) && body.ids.length > 0) {
      ids = body.ids.filter((x: unknown): x is string => typeof x === 'string');
    }
  } catch {
    // 空 body は許容 (= 全件)
  }

  const csv = await exportMemosSync(user.id, user.tenantId, ids);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="memos_sync_${user.id}.csv"`,
    },
  });
}
