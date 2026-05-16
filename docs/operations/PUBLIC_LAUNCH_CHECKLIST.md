# 公開前チェックリスト (Public Launch Checklist)

本ドキュメントは、2026-06-01 のサービス公開前に **法的・UX・運用面で対応が必要な項目** を集約したチェックリストです。

> **位置づけ**: [GO_LIVE_RUNBOOK.md](./GO_LIVE_RUNBOOK.md) は「公開当日の時系列手順」、本書は「公開前 2 週間でクリアすべき法的・運用要件」を担当します。
>
> ⚠ **法的拘束力のある文書(利用規約 / プライバシーポリシー等)は必ず法務確認を経ること**。本書は構造とチェックポイントを提供しますが、本文ドラフトは含みません。

---

## 1. 法的書類 (法務レビュー必須)

### 1.1 LICENSE ファイル

- [x] **AGPL-3.0 公式テキスト** を `LICENSE` として配置(2026-05-19、GNU 公式 `https://www.gnu.org/licenses/agpl-3.0.txt` から取得)
- [ ] `package.json` の `license` フィールドが `"AGPL-3.0-or-later"` であることを確認
- [ ] README.md / docs/public/about.md にライセンス表記を追加(任意)

### 1.2 利用規約 (Terms of Service)

招待制 SaaS として最低限カバーすべき条項:

- [ ] **サービス内容**: 提案エンジン・ナレッジ管理等の機能範囲
- [ ] **登録要件**: 招待制であること、年齢制限の有無
- [ ] **禁止事項**: 不正アクセス / API 悪用 / リバースエンジニアリング / 自動収集等
- [ ] **知的財産権**: ユーザがアップロードするコンテンツの権利と利用許諾範囲
- [ ] **支払い条件**: per-API-call 課金、月次請求、滞納時の取扱い ([PAYMENT_TERMS.md](../business/PAYMENT_TERMS.md) と整合)
- [ ] **解約・退会**: ダウングレード制限 ([ADR-0013](../adr/0013-beginner-downgrade-prohibition.md)) を明示
- [ ] **免責事項**: サービス停止・データ消失時の責任範囲(縮退モードの説明含む)
- [ ] **準拠法・管轄**: 日本法 / 東京地方裁判所 等
- [ ] **改訂手続**: 規約変更の事前通知期間

#### ドラフト作成方法

- 自前でドラフトせず、以下のいずれかを推奨:
  - **弁護士監修テンプレート**: 弁護士ドットコム / クラウドサイン等の有料雛形
  - **専門家ヒアリング**: SaaS / 個人情報保護を扱う弁護士に直接依頼
- 配置先: `docs/public/terms-of-service.md` または `app/(public)/terms/page.tsx`
- フッタリンクから到達可能にする

### 1.3 プライバシーポリシー (Privacy Policy)

個人情報保護法 + 個人データの第三者提供を考慮:

- [ ] **収集する個人情報**: メールアドレス / 氏名 / 業務データ(プロジェクト・ナレッジ等)
- [ ] **利用目的**: サービス提供 / 認証 / 課金 / サポート対応
- [ ] **第三者提供**: Anthropic / Voyage AI / Supabase / Brevo / Vercel / Stripe の利用と各社のデータ取扱い
- [ ] **国外移転**: Anthropic (米国) / Voyage (米国) / Supabase (リージョン別) / Vercel (米国) — 適切な保護措置の言及
- [ ] **保有期間**: テナント解約後の論理削除 / 物理削除タイミング ([ADR-0011](../adr/0011-soft-delete-and-audit-log.md))
- [ ] **開示・訂正・削除の手続**: ユーザ申請窓口
- [ ] **Cookie / トラッキング**: NextAuth セッション Cookie / Vercel Speed Insights 等の利用範囲
- [ ] **問い合わせ窓口**: support@<domain>
- [ ] **改訂日**

#### 関連: 個人情報保護委員会への対応

- 重大漏洩時の報告義務窓口は [INCIDENT_RESPONSE.md §8.1](./INCIDENT_RESPONSE.md) に集約済
- 公開前に「個人情報取扱事業者」としての届出が必要かを法務確認

#### ドラフト作成方法

利用規約と同様、専門家監修推奨。配置先: `docs/public/privacy-policy.md` または `app/(public)/privacy/page.tsx`

---

## 2. 公開ページ整備

### 2.1 `/login` 初見訪問者向け案内

招待制のため、外部からアクセスした未認証ユーザに対する案内が必要:

- [ ] **「このサービスは招待制です」** の明示文言
- [ ] **問い合わせ導線**(`support@<domain>` または問合せフォーム)
- [ ] **「サービス概要を見る」リンク** → `/about` (公開ページ)
- [ ] フッタに利用規約 / プライバシーポリシー / 運営会社情報のリンク

実装: `src/app/(auth)/login/page.tsx` の冒頭にバナー or 既存 UI への追記

### 2.2 favicon / OG 画像

- [x] **favicon.ico** は配置済 (`src/app/favicon.ico` で Next.js が自動配信)
- [ ] **OG 画像 (`/og-image.png` 1200×630)** を作成し `public/` に配置(SNS シェア時のプレビュー用)
- [ ] `app/layout.tsx` のメタデータに OG 画像 URL を追加
- [ ] Twitter Card メタデータ追加(`twitter:card='summary_large_image'`)

### 2.3 robots.txt

- [x] **招待制中は noindex** のため `public/robots.txt` で `Disallow: /` を配置(2026-05-19)
- [ ] 一般公開フェーズに移行する際の更新ルール: `app/robots.ts` で動的生成に切替(環境変数で制御推奨)

### 2.4 sitemap.xml(任意、招待制中は不要)

招待制で全ページ noindex のため当面不要。一般公開時に検討。

---

## 3. 運用準備

### 3.1 監視チャネル

- [ ] **support@<domain>** メールアドレスの動作確認(受信できることを実テスト)
- [ ] **Supabase / Vercel / Anthropic / Voyage / Brevo** の Status Page を bookmark
- [ ] **Vercel Functions ログ** を毎日朝に確認する習慣化(初動 30 分ルーチンに組込み)

### 3.2 インシデント対応の最終確認

- [ ] [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) §0(初動 3 ステップ)を空読みでもイメージできる
- [ ] §6.5 ログイン失敗対処の SQL を 1 回試行(ステージング環境で)
- [ ] §7.1 Vercel Rollback をステージングで 1 回実施
- [ ] §8.2 ユーザ通知テンプレート 3 種をクリップボードに保存

### 3.3 バックアップの動作確認

- [ ] [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md) §3 の全フェーズを 1 回完了
- [ ] 検証結果を `docs/operations/backup-verifications/2026-05-XX.md` に記録

### 3.4 環境変数の最終確認

- [ ] [ENV_VARS.md](./ENV_VARS.md) の必須項目が本番 Vercel に全設定済
- [ ] **NEXTAUTH_SECRET / 各 API キー** を 1Password 等のパスワードマネージャに保管
- [ ] **CRON_SECRET** を本番と Vercel Cron 双方で一致確認

---

## 4. 公開直前の最終チェック (T-1 営業日)

[GO_LIVE_RUNBOOK.md](./GO_LIVE_RUNBOOK.md) §T-1 営業日と整合させること。

- [ ] 本書の §1〜§3 のすべての必須項目が完了
- [ ] 本番ステージングで完全 E2E 通過(認証 → プロジェクト作成 → ナレッジ登録 → 提案エンジン実行)
- [ ] セキュリティスキャン(`scripts/security-check.ts --min-score=90`)通過
- [ ] 法的書類(利用規約・プライバシーポリシー)が公開ページからアクセス可能
- [ ] `support@` 受信動作確認済
- [ ] バックアップ検証完了済(直近 30 日以内)

---

## 関連ドキュメント

- [GO_LIVE_RUNBOOK.md](./GO_LIVE_RUNBOOK.md) — 公開当日の時系列手順
- [RELEASE_NOTES_v1.md](./RELEASE_NOTES_v1.md) — v1.0 リリースノート(ユーザ向け告知)
- [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) — 障害対応 SOP + ユーザ通知テンプレート
- [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md) — バックアップ検証手順
- [PAYMENT_TERMS.md](../business/PAYMENT_TERMS.md) — 支払い条件(利用規約と整合)
- [ADR-0011](../adr/0011-soft-delete-and-audit-log.md) — 論理削除 + 監査ログ(プライバシーポリシー記載の根拠)
- [ADR-0013](../adr/0013-beginner-downgrade-prohibition.md) — Beginner ダウングレード禁止(利用規約と整合)

---

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-19 | 初版作成(LICENSE 取得・robots.txt 配置とセットで起票) |
