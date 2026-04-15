import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { enableMfa } from '@/services/mfa.service';
import { z } from 'zod/v4';

const schema = z.object({ code: z.string().length(6) });

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: '6桁のコードを入力してください' } },
      { status: 400 },
    );
  }

  const result = await enableMfa(user.id, parsed.data.code);
  if (!result.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: result.error } },
      { status: 400 },
    );
  }

  return NextResponse.json({ data: { success: true } });
}
