/**
 * /admin/super/banners (ADR-0036)
 *
 * システム周知バナーの一覧 (履歴) 画面。super_admin 専用 (親 layout でガード)。
 * 全テナントの全ユーザの画面上部に表示する帯メッセージを管理する。表示中は同時 1 本まで。
 */

import Link from 'next/link';
import { listBanners } from '@/services/system-banner.service';
import { BannersListClient } from './banners-list-client';

export default async function SuperAdminBannersPage() {
  const banners = await listBanners();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">周知バナー</h1>
        <Link
          href="/admin/super/banners/new"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          + 新規バナー
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        全テナントの全ユーザの画面上部に表示する帯メッセージです。指定した期間 (開始〜終了) の間だけ表示され、
        緊急度に応じて色が変わります (高=赤 / 中=黄 / 低=青)。<strong>表示中の帯は同時に 1 本まで</strong>のため、
        期間が重なるバナーは作成できません。過去のバナーは履歴として残り、「複製」で再利用できます。
      </p>
      <BannersListClient banners={banners} />
    </div>
  );
}
