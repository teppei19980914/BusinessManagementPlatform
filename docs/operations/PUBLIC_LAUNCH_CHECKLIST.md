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

- [x] **本文公開**: HomePage repo `tasukiba-user.md` の `#terms` セクションに集約 (2026-05-21 / feat/legal-pages-lp-integration)
  - 全 28 条 + 附則 (改定履歴) を含む正式版 v1.0
  - 損害賠償上限 (過去 6 ヶ月分)、反社条項、AGPL-3.0 と SaaS 規約の独立適用、年齢制限 (成年/親権者同意)、適格請求書未登録の明示、12 項目の禁止事項、SLA 否認、サービス終了 60 日前予告 等を含む
  - 規約変更通知: 一般 7 日前 / 値上げ・課金体系変更 30 日前 + メール
- [x] **サインアップでの同意取得**: `src/app/(auth)/signup/page.tsx` に同意チェックボックス + サーバ側 zod で `acceptedTerms === true` 強制
- [x] **同意の証跡保存**: `TenantConsentLog` テーブル (`prisma/migrations/20260526_tenant_consent_log/`) に IP / User-Agent / バージョンを記録 (民法 548 条の 2 / 定型約款の組入合意根拠)
- [x] **ログイン画面フッタリンク**: 外部 LP の `#terms` アンカーに `target="_blank"` で遷移
- [ ] (将来) 規約改定通知システム — 案 A (Announcement テーブル + 管理 UI + cron) の実装が別途必要

### 1.3 プライバシーポリシー (Privacy Policy)

- [x] **本文公開**: HomePage repo `tasukiba-user.md` の `#privacy` セクションに集約 (2026-05-21 / feat/legal-pages-lp-integration)
  - 全 18 項 + 附則 (改定履歴) を含む正式版 v1.0
  - 第三者提供 (Anthropic / Voyage / Supabase / Brevo / Netlify / Stripe) の所在国・用途・学習利用方針を明示
  - 外国にある第三者への提供 (個人情報保護法 28 条) の同意根拠を明確化
  - 開示請求手数料: 無料、対応期限 14 営業日以内
  - 集計利用範囲: テナントを越えた量的集計 + 障害調査のみ (テナント越えの AI 学習は不可)
- [x] **サインアップでの同意取得**: `src/app/(auth)/signup/page.tsx` に同意チェックボックス + サーバ側 zod で `acceptedPrivacy === true` 強制
- [x] **同意の証跡保存**: `TenantConsentLog` に terms と同時に記録

#### 関連: 個人情報保護委員会への対応

- 重大漏洩時の報告義務窓口は [INCIDENT_RESPONSE.md §8.1](./INCIDENT_RESPONSE.md) に集約済
- 公開前に「個人情報取扱事業者」としての届出が必要かを法務確認

---

## 2. 公開ページ整備

### 2.1 `/login` 初見訪問者向け案内

招待制のため、外部からアクセスした未認証ユーザに対する案内が必要:

- [x] **「このサービスは招待制です」** の明示文言(2026-05-19、`src/app/(auth)/login/page.tsx` のフッタブロック)
- [x] **利用規約 / プライバシーポリシーへのリンク**(2026-05-21 更新: 外部 LP `tasukiba-user.md` の `#terms` / `#privacy` アンカーに `target="_blank"` で遷移)
- [x] **招待メール配送失敗時の UX サポート**(2026-05-23 / Phase 1 / feat/signup-email-resend-ux): サインアップ成功画面に「入力メールアドレス表示 + トラブルシュートチェックリスト + 再送ボタン + LP お問い合わせ動線」を実装。`POST /api/auth/resend-verification` (Rate Limit 多軸 + enumeration 防止) で再送を制御。Gmail Freemail 由来の配送 fail シナリオへの暫定対応 (= 独自ドメイン取得まで)。SOP 影響: 顧客からの「メールが届かない」問合せが LP `/contact/` 経由で流入する可能性 → CUSTOMER_FEEDBACK_TRIAGE.md に「お問い合わせ種別: たすきば」の分類処理ルートを将来追加
- [ ] **問い合わせ導線**(`support@<domain>` または問合せフォーム)— 連絡先確定後に追記
- [ ] **「サービス概要を見る」リンク** → `/about` (公開ページ、必要なら追加)

### 2.2 favicon / OG 画像

- [x] **favicon.ico** は配置済 (`src/app/favicon.ico` で Next.js が自動配信)
- [x] **`app/layout.tsx` のメタデータに OG 画像 URL 追加**(2026-05-19、`/og-image.png` を参照)
- [x] **Twitter Card メタデータ追加**(2026-05-19、`twitter:card='summary_large_image'`)
- [ ] **OG 画像本体 (`/og-image.png` 1200×630) のデザイン作成 + 配置**(`public/og-image.README.md` に仕様あり、画像未配置時は SNS プレビュー未表示のみで機能影響なし)

### 2.3 robots.txt

- [x] **招待制中は noindex** のため `public/robots.txt` で `Disallow: /` を配置(2026-05-19)
- [ ] 一般公開フェーズに移行する際の更新ルール: `app/robots.ts` で動的生成に切替(環境変数で制御推奨)

### 2.4 sitemap.xml(任意、招待制中は不要)

招待制で全ページ noindex のため当面不要。一般公開時に検討。

---

## 3. 運用準備

### 3.1 監視チャネル

- [ ] **support@<domain>** メールアドレスの動作確認(受信できることを実テスト)
- [ ] **Supabase / Netlify / Anthropic / Voyage / Brevo** の Status Page を bookmark
- [ ] **Netlify Functions ログ** を毎日朝に確認する習慣化(初動 30 分ルーチンに組込み)

### 3.2 インシデント対応の最終確認

- [ ] [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) §0(初動 3 ステップ)を空読みでもイメージできる
- [ ] §6.5 ログイン失敗対処の SQL を 1 回試行(ステージング環境で)
- [ ] §7.1 Netlify Rollback (Publish deploy) をステージングで 1 回実施
- [ ] §8.2 ユーザ通知テンプレート 3 種をクリップボードに保存

### 3.3 バックアップの動作確認

- [ ] [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md) §3 の全フェーズを 1 回完了
- [ ] 検証結果を `docs/operations/backup-verifications/2026-05-XX.md` に記録

### 3.4 環境変数の最終確認

- [ ] [ENV_VARS.md](./ENV_VARS.md) の必須項目が本番 Netlify に全設定済
- [ ] **NEXTAUTH_SECRET / 各 API キー** を 1Password 等のパスワードマネージャに保管
- [ ] **CRON_SECRET** を本番と外部 cron (cron-job.org) 双方で一致確認

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
