/**
 * /admin/super/banners/[id]/edit (ADR-0036)
 *
 * 周知バナーの編集画面。super_admin 専用 (親 layout でガード)。
 */

import { notFound } from 'next/navigation';
import { getBanner } from '@/services/system-banner.service';
import { BannerForm } from '../../banner-form';

export default async function SuperAdminBannerEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const banner = await getBanner(id);
  if (!banner) notFound();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">周知バナーを編集</h1>
      <p className="text-sm text-muted-foreground">
        内容・緊急度・表示期間・有効/無効を変更できます。期間を変更して他の有効なバナーと重なる場合は保存できません。
      </p>
      <BannerForm
        mode="edit"
        bannerId={banner.id}
        initial={{
          message: banner.message,
          severity: banner.severity,
          startAt: banner.startAt,
          endAt: banner.endAt,
          enabled: banner.enabled,
        }}
      />
    </div>
  );
}
