/**
 * /terms — 利用規約ページ
 *
 * ⚠ 本ページは **ドラフト (法務監修待ち)** です。
 *
 * 正式な利用規約は以下のいずれかの方法で作成し、本ファイルを置き換えてください:
 *   1. 弁護士監修テンプレート (弁護士ドットコム / クラウドサイン等の有料雛形)
 *   2. SaaS / 個人情報保護に詳しい弁護士に直接依頼
 *
 * 詳細: docs/operations/PUBLIC_LAUNCH_CHECKLIST.md §1.2 利用規約
 */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '利用規約 - たすきば Knowledge Relay',
  description: 'たすきば Knowledge Relay の利用規約',
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  return (
    <article className="prose prose-sm max-w-none dark:prose-invert">
      <h1>利用規約</h1>

      <div className="my-6 rounded-md border-l-4 border-l-warning bg-warning/10 p-4 text-sm">
        <p className="m-0 font-semibold">ドラフト版 - 法務監修待ち</p>
        <p className="m-0 mt-1">
          本ページは正式な利用規約への差し替え待ちのプレースホルダです。
          サービス公開前に弁護士監修テンプレートを反映してください。
          詳細手順は <code>docs/operations/PUBLIC_LAUNCH_CHECKLIST.md</code> §1.2 参照。
        </p>
      </div>

      <h2>本ドキュメントに含めるべきセクション (構造のみ、本文未作成)</h2>

      <ol>
        <li>サービス内容 — 提案エンジン・ナレッジ管理等の機能範囲</li>
        <li>登録要件 — 招待制であること、年齢制限の有無</li>
        <li>禁止事項 — 不正アクセス / API 悪用 / リバースエンジニアリング / 自動収集</li>
        <li>知的財産権 — ユーザがアップロードするコンテンツの権利と利用許諾範囲</li>
        <li>
          支払い条件 — per-API-call 課金、月次請求、滞納時の取扱い
          (<code>docs/business/PAYMENT_TERMS.md</code> と整合)
        </li>
        <li>
          解約・退会 — ダウングレード制限 (<code>docs/adr/0013-beginner-downgrade-prohibition.md</code>) を明示
        </li>
        <li>免責事項 — サービス停止・データ消失時の責任範囲 (縮退モードの説明含む)</li>
        <li>準拠法・管轄 — 日本法 / 東京地方裁判所</li>
        <li>改訂手続 — 規約変更の事前通知期間</li>
      </ol>

      <h2>問い合わせ</h2>
      <p>
        本サービスに関するお問い合わせは <code>support@&lt;domain&gt;</code> までご連絡ください。
      </p>

      <hr />
      <p className="text-xs text-muted-foreground">
        最終更新: 未確定 (法務監修後に確定)
      </p>
    </article>
  );
}
