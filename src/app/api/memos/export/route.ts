/**
 * GET /api/memos/export — メモ 4 列 CSV (T-22 Phase 22d)
 *
 * 認可: 認証済ユーザのみ (自分のメモのみ)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { exportMemosSync } from '@/services/memo-sync-import.service';

// _req 未使用だが、Next.js Route Handler の signature として明示
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function GET(_req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const csv = await exportMemosSync(user.id);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="memos_sync_${user.id}.csv"`,
    },
  });
}
