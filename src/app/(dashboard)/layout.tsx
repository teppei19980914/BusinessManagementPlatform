import { requireAuthForLayout } from '@/lib/page-auth';
// perf/dashboard-layout-parallel-ssr (2026-06-01): session を先に取得し
//   requireAuthForLayout (= tokenVersion 検証 DB lookup) と Banner state 取得を Promise.all で
//   並列化するため getCachedAuth を import する。getCachedAuth は React.cache でラップ済なので、
//   requireAuthForLayout 内の getCachedAuth 再呼出は cache hit (重複 JWT 復号なし)。
import { getCachedAuth } from '@/lib/auth-cached';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';
// feat/app-header-footer-unification (2026-05-24): DashboardHeader を AppHeader に統合。
// 同一コンポーネントを (public) / (auth) でも user=null で再利用し「同じ役割は同じ UI」を担保。
import { AppHeader } from '@/components/app-header';
// feat/collapsed-nav-screen-title (2026-06-05): ナビ折りたたみ幅 (xl: 未満) で現在の画面名を表示。
import { CollapsedNavScreenTitle } from '@/components/collapsed-nav-screen-title';
import { LoadingProvider } from '@/components/loading-overlay';
// 2026-04-30 (Task 2): リクエスト成功/失敗を画面下部の帯で通知する共通基盤
import { ToastProvider } from '@/components/toast-provider';
// Q5(3) (2026-05-14): 縮退モード起動時に dashboard 全体で表示する小バナー
// perf/dashboard-layout-parallel-ssr (2026-06-01): layout は Banner active 判定のみ必要なので
//   軽量版 getDegradedModeBannerState を使う (countNullEmbeddings を含まない / settings/tenant は
//   引き続き詳細版 getDegradedModeState を利用)。
import { getDegradedModeBannerState } from '@/services/degraded-mode.service';
import { DegradedModeBanner } from '@/components/degraded-mode-banner';
// ADR-0036: 全ユーザ共通のシステム周知バナー (画面上部の帯メッセージ)。
//   feat/app-header-footer-unification (2026-05-24) で廃止した常時バナーの再導入。
import { getActiveBanner } from '@/services/system-banner.service';
import { SystemBannerBar } from '@/components/system-banner-bar';
// PR #373 / chat-semantic-search: 全ページ右下のチャット意味検索 FAB
import { ChatSemanticSearchFab } from '@/components/chat-semantic-search';
// G2-e-3 (2026-05-31): 初回ログイン時のオンボーディングモーダル (自動表示コントローラ)
import { WelcomeOwlAutoOpen } from '@/components/onboarding/welcome-owl-modal';
import type { SystemRole } from '@/config/master-data';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // perf/dashboard-layout-parallel-ssr (2026-06-01): SSR 並列化。
  //   旧実装は requireAuthForLayout → getDegradedModeState を逐次 await していたため、
  //   各 DB ラウンドトリップ (~150ms region latency) が直列に積み上がっていた。
  //
  //   新実装は session (= JWT 復号結果) を先に取得 → tenantId が分かったら
  //   tokenVersion 検証 (requireAuthForLayout) と Banner state 取得を Promise.all で並列実行する。
  //   requireAuthForLayout 内部の getCachedAuth は React.cache 経由なので
  //   ここでの呼出と重複しても JWT 復号は 1 回だけ走る。
  //
  // fix/session-clearance (2026-05-20): tokenVersion 検証付きヘルパに切替。
  //   旧 `auth()` は JWT 署名検証のみで通すため、explicit-signout で increment された
  //   tokenVersion を検出できず、旧 cookie 残留時に「他人の tenantId で listProjects 等が
  //   走り、画面に出てしまう」事故が起きうる。本ヘルパで DB 照合 → redirect で防ぐ。
  const session = await getCachedAuth();
  if (!session) redirect(LOGIN_ROUTE);

  // Q5(3): 縮退モード状態を取得し banner で表示する。
  //   - 取得失敗は許容 (バナー表示は best-effort、画面遷移を妨げない)
  //   - admin / general 双方に共通で表示 (内容は role で出し分けない、リンク先のみ admin/一般で差別)
  const [user, degradedMode, activeBanner] = await Promise.all([
    requireAuthForLayout(),
    getDegradedModeBannerState(session.user.tenantId).catch(() => null),
    // ADR-0036: 全テナント共通の周知バナー。取得失敗は best-effort で握りつぶす (画面遷移を妨げない)。
    getActiveBanner().catch(() => null),
  ]);

  // feat/app-header-footer-unification (2026-05-24): AnnouncementBanner を削除。
  //   「画面上の表示項目を極力減らし UX を向上に寄せる」方針 (= header auto-hide / footer 削減と同じ系)。
  //   お知らせは footer の `/announcements` リンクおよび AccountMenu からアクセス可能なため
  //   画面上部の常時バナーは廃止。critical severity の周知が必要になった場合は DegradedModeBanner
  //   を流用するか、別途検討する。

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
          {/* ADR-0036: システム周知バナー (運営者が出す全ユーザ共通の帯)。
              表示判定はサーバ、×破棄のセッション維持は client (SystemBannerBar) で行う。 */}
          <SystemBannerBar banner={activeBanner} />
          {/*
            max-w-7xl は意図的に外している: 画面左右に大きな余白が残ったまま
            一覧テーブルに横スクロールが出るとユーザビリティが下がるため、
            画面いっぱいまで広げて収まるデータを増やし、それでも溢れる分だけ
            テーブル側の overflow-x-auto でスクロールさせる運用。
          */}
          <main className="px-4 py-6 sm:px-6 lg:px-8">
            {/* feat/collapsed-nav-screen-title: ナビ折りたたみ幅 (xl: 未満) のみ画面名を表示。
                全画面で <main> 先頭に置き、UI 配置を統一する。 */}
            <CollapsedNavScreenTitle />
            {children}
          </main>
        </div>
        <ChatSemanticSearchFab />
        {/* G2-e-3: 初回ログイン (たすきば未利用) ユーザにウェルカム案内を 1 回だけ自動表示。
            super_admin 除外・当セッション once ガードは本コンポーネント内で判定。 */}
        <WelcomeOwlAutoOpen />
      </ToastProvider>
    </LoadingProvider>
  );
}
