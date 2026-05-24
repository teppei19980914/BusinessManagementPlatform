/**
 * 認証ページ (login / signup / mfa / reset-password / setup-password) 共通レイアウト
 * (feat/app-header-footer-unification / 2026-05-24)。
 *
 * 設計方針:
 *   - 旧実装は (auth) 配下に layout.tsx が無く、ヘッダ無しで表示されていた
 *   - 全画面共通の AppHeader (user=null) を配置し、(dashboard) / (public) と同じロゴ・高さ・配色・
 *     auto-hide 挙動を共有する。「同じ役割は同じ UI」原則の徹底
 *   - 認証フロー中 (= ここに来るユーザ) は session が無いか mfaVerified=false の中間状態。
 *     AccountMenu を出すと「ログアウト」など整合しない導線が露出するため、常に user=null を渡す
 *   - middleware は PUBLIC_PATHS で /login, /signup 等を通過させる側で担保 (本 layout は素通し)
 *   - AppFooter は root layout で出力済 → 重複描画しない
 *
 * MFA ページの扱い:
 *   セッションは存在するが mfaVerified=false。AccountMenu を出すとログアウト等が露出し
 *   フローが乱れるため、本 layout では一律 user=null として扱う設計判断
 *   (詳細は会話ログ 2026-05-24 「認識合わせ」セッション)。
 */

import { AppHeader } from '@/components/app-header';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <AppHeader user={null} />
      <main>{children}</main>
    </div>
  );
}
