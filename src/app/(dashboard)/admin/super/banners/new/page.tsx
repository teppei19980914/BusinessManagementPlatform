/**
 * /admin/super/banners/new (ADR-0036)
 *
 * 周知バナーの新規作成画面。super_admin 専用 (親 layout でガード)。
 * `?from=<id>` 付きで開くと、そのバナーの内容・緊急度を複製して prefill する
 * (複製は新しい id を持つため、過去に×で閉じたユーザにも再表示される)。
 */

import { getBanner } from '@/services/system-banner.service';
import { BannerForm, type BannerFormInitial } from '../banner-form';

export default async function SuperAdminBannerNewPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;

  let initial: BannerFormInitial | undefined;
  if (from) {
    const source = await getBanner(from);
    if (source) {
      // 複製: メッセージ・緊急度・期間をコピーし、有効状態は既定 (true) で新規作成扱い。
      initial = {
        message: source.message,
        severity: source.severity,
        startAt: source.startAt,
        endAt: source.endAt,
        enabled: true,
      };
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{from && initial ? '周知バナーを複製して作成' : '周知バナーを新規作成'}</h1>
      <p className="text-sm text-muted-foreground">
        全テナントの全ユーザの画面上部に表示する帯メッセージを作成します。表示中の帯は同時に 1 本までのため、
        既存の有効なバナーと表示期間が重なる場合は作成できません。
      </p>
      <BannerForm mode="create" initial={initial} />
    </div>
  );
}
