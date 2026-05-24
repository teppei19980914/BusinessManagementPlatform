import { requireAuthForLayout } from '@/lib/page-auth';
// feat/app-header-footer-unification (2026-05-24): DashboardHeader を AppHeader に統合。
// 同一コンポーネントを (public) / (auth) でも user=null で再利用し「同じ役割は同じ UI」を担保。
import { AppHeader } from '@/components/app-header';
import { LoadingProvider } from '@/components/loading-overlay';
// 2026-04-30 (Task 2): リクエスト成功/失敗を画面下部の帯で通知する共通基盤
import { ToastProvider } from '@/components/toast-provider';
// Q5(3) (2026-05-14): 縮退モード起動時に dashboard 全体で表示する小バナー
import { getDegradedModeState } from '@/services/degraded-mode.service';
import { DegradedModeBanner } from '@/components/degraded-mode-banner';
// PR #373 / chat-semantic-search: 全ページ右下のチャット意味検索 FAB
import { ChatSemanticSearchFab } from '@/components/chat-semantic-search';
// feat/app-version-changelog-footer (2026-05-23): 最新お知らせを画面上部にバナー表示
import { AnnouncementBanner } from '@/components/announcement-banner';
import { loadAnnouncementMetas } from '@/lib/announcements';
import type { SystemRole } from '@/config/master-data';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // fix/session-clearance (2026-05-20): tokenVersion 検証付きヘルパに切替。
  //   旧 `auth()` は JWT 署名検証のみで通すため、explicit-signout で increment された
  //   tokenVersion を検出できず、旧 cookie 残留時に「他人の tenantId で listProjects 等が
  //   走り、画面に出てしまう」事故が起きうる。本ヘルパで DB 照合 → redirect で防ぐ。
  const user = await requireAuthForLayout();

  // Q5(3): 縮退モード状態を取得し banner で表示する。
  //   - 取得失敗は許容 (バナー表示は best-effort、画面遷移を妨げない)
  //   - admin / general 双方に共通で表示 (内容は role で出し分けない、リンク先のみ admin/一般で差別)
  const degradedMode = await getDegradedModeState(user.tenantId).catch(
    () => null,
  );

  // feat/app-version-changelog-footer (2026-05-23): 最新 1 件のお知らせを取得しバナー表示。
  //   markdown 真値 (docs/public/announcements/*.md) からの読み出しで DB 負荷ゼロ。
  //   ユーザは dismiss すると同じ slug が再表示されない (localStorage 管理)。
  const latestAnnouncement = loadAnnouncementMetas()[0] ?? null;

  return (
    <LoadingProvider>
      <ToastProvider>
        <div className="min-h-screen bg-muted">
          <AppHeader user={user} />
          {degradedMode?.active && (
            <DegradedModeBanner
              reason={degradedMode.reason}
              systemRole={user.systemRole as SystemRole}
            />
          )}
          <AnnouncementBanner announcement={latestAnnouncement} />
          {/*
            max-w-7xl は意図的に外している: 画面左右に大きな余白が残ったまま
            一覧テーブルに横スクロールが出るとユーザビリティが下がるため、
            画面いっぱいまで広げて収まるデータを増やし、それでも溢れる分だけ
            テーブル側の overflow-x-auto でスクロールさせる運用。
          */}
          <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
        <ChatSemanticSearchFab />
      </ToastProvider>
    </LoadingProvider>
  );
}
