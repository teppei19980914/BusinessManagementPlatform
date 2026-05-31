import { describe, it, expect } from 'vitest';
import { resolveAttachmentHref } from './attachment-href';

describe('resolveAttachmentHref', () => {
  it('supabase 本体型は /api/attachments/{id}/download を返す (相対パス 404 を回避)', () => {
    expect(
      resolveAttachmentHref({
        id: 'ecf1c237-0471-469e-9b9d-16e56aed08ed',
        // Storage Object Key (先頭スラッシュ無し)。そのまま href にすると相対解決で 404 になる値。
        url: 'tenants/087ea5e6/risk/29833884/ecf1c237-billing-detail-2026-05 (1).csv',
        storageProvider: 'supabase',
      }),
    ).toBe('/api/attachments/ecf1c237-0471-469e-9b9d-16e56aed08ed/download');
  });

  it('url 型 (旧 URL 参照) は入力された完全 URL をそのまま返す', () => {
    expect(
      resolveAttachmentHref({
        id: 'a1',
        url: 'https://example.com/spec.pdf',
        storageProvider: 'url',
      }),
    ).toBe('https://example.com/spec.pdf');
  });

  it('storageProvider が未知/未設定値でも url 型として完全 URL を返す (fail-safe)', () => {
    expect(
      resolveAttachmentHref({
        id: 'a2',
        url: 'https://example.com/x.png',
        storageProvider: '',
      }),
    ).toBe('https://example.com/x.png');
  });
});
