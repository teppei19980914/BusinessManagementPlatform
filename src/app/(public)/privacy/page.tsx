/**
 * /privacy — プライバシーポリシーページ
 *
 * ⚠ 本ページは **ドラフト (法務監修待ち)** です。
 *
 * 個人情報保護法 + 個人データの第三者提供 (Anthropic / Voyage / Supabase / Brevo /
 * Stripe / Vercel) を考慮した正式な文書が必要です。
 *
 * 詳細: docs/operations/PUBLIC_LAUNCH_CHECKLIST.md §1.3 プライバシーポリシー
 */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'プライバシーポリシー - たすきば Knowledge Relay',
  description: 'たすきば Knowledge Relay のプライバシーポリシー',
  robots: { index: false, follow: false },
};

export default function PrivacyPage() {
  return (
    <article className="prose prose-sm max-w-none dark:prose-invert">
      <h1>プライバシーポリシー</h1>

      <div className="my-6 rounded-md border-l-4 border-l-warning bg-warning/10 p-4 text-sm">
        <p className="m-0 font-semibold">ドラフト版 - 法務監修待ち</p>
        <p className="m-0 mt-1">
          本ページは正式なプライバシーポリシーへの差し替え待ちのプレースホルダです。
          サービス公開前に弁護士監修テンプレートを反映してください。
          詳細手順は <code>docs/operations/PUBLIC_LAUNCH_CHECKLIST.md</code> §1.3 参照。
        </p>
      </div>

      <h2>本ドキュメントに含めるべきセクション (構造のみ、本文未作成)</h2>

      <ol>
        <li>収集する個人情報 — メールアドレス / 氏名 / 業務データ (プロジェクト・ナレッジ等)</li>
        <li>利用目的 — サービス提供 / 認証 / 課金 / サポート対応</li>
        <li>
          第三者提供 — 以下の事業者を利用し、各社の取扱いに従う
          <ul>
            <li>Anthropic (LLM API)</li>
            <li>Voyage AI (Embedding API)</li>
            <li>Supabase (DB / Storage)</li>
            <li>Brevo (メール送信)</li>
            <li>Vercel (ホスティング)</li>
            <li>Stripe (決済、v1.x 以降)</li>
          </ul>
        </li>
        <li>国外移転 — 上記事業者の所在地 (米国等) と適切な保護措置の言及</li>
        <li>
          保有期間 — テナント解約後の論理削除 / 物理削除タイミング
          (<code>docs/adr/0011-soft-delete-and-audit-log.md</code>)
        </li>
        <li>開示・訂正・削除の手続 — ユーザ申請窓口</li>
        <li>Cookie / トラッキング — NextAuth セッション Cookie / Vercel Speed Insights 等</li>
        <li>問い合わせ窓口 — <code>support@&lt;domain&gt;</code></li>
        <li>改訂日</li>
      </ol>

      <h2>関連</h2>
      <ul>
        <li>
          重大漏洩時の対応: <code>docs/operations/INCIDENT_RESPONSE.md</code> §6.10 / §8.1
        </li>
        <li>
          監査ログ仕様: <code>docs/adr/0011-soft-delete-and-audit-log.md</code>
        </li>
      </ul>

      <hr />
      <p className="text-xs text-muted-foreground">
        最終更新: 未確定 (法務監修後に確定)
      </p>
    </article>
  );
}
