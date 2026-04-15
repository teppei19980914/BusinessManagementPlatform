import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { generateMfaSecret } from '@/services/mfa.service';
import * as QRCode from 'qrcode';

export async function POST() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { secret, otpauthUri } = await generateMfaSecret(user.id);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

  return NextResponse.json({
    data: { secret, qrCodeDataUrl },
  });
}
