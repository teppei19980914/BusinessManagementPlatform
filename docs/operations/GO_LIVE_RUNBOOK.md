# Go-Live Runbook (2026-06-01 外部公開)

本ドキュメントは、2026-06-01 のたすきば Knowledge Relay 外部公開当日に従う **時系列の作業手順** です。

> **目的**: リリース当日に慌てない。チェックリスト方式で「何を / いつ / 誰が / どう確認するか」を事前に確定させておく。
>
> **担当**: teppei (1 人運用)

---

## T-2 週間前 (2026-05-18 頃) — 凍結前準備

- [ ] **機能スコープの凍結**: v1.0 で含める機能 / 含めない機能の最終決定 ([RELEASE_NOTES_v1.md](./RELEASE_NOTES_v1.md))
- [ ] **本番ステージング環境の準備**: 本番と同等構成の Netlify + Supabase project を起動 (まだ未整備なら本日着手)
- [ ] **データバックアップ機構の動作確認**: [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md) §3.1 を 1 回完了
- [ ] **ドキュメント全体の最終整合性確認**:
  - リーディングパス (docs/README.md) のリンク全部 OK ← CI link checker で自動
  - CONTRIBUTING.md / CLAUDE.md / ONBOARDING.md の整合
- [ ] **環境変数の最終確認**: [ENV_VARS.md](./ENV_VARS.md) の必須項目が本番 Netlify に全て設定済
- [ ] **シークレットの 1Password 保管**: NEXTAUTH_SECRET / DATABASE_URL / 各 API キーを暗号化保管

## T-1 週間前 (2026-05-25 頃) — 凍結

- [ ] **コード凍結**: 5/25 以降は新機能 PR をマージしない (緊急バグ修正のみ)
- [ ] **prisma/migrations 初期 5 件 squash の判断**: [B4 計画](#b4-prisma-migrations-squash) (実行 or 見送り)
- [ ] **本番ステージングで完全 E2E 通過**: Playwright 全 spec を本番類似データで実行
- [ ] **負荷見積もり**: テナント 10 / 同時ユーザ 50 のシナリオで遅延が許容範囲内 (1 秒以内、memory: feedback_performance)
- [ ] **セキュリティスキャン全 green**: `pnpm tsx scripts/security-check.ts --min-score=90` 通過
- [ ] **リリースノート v1 確定版へ更新**: [RELEASE_NOTES_v1.md](./RELEASE_NOTES_v1.md) の TODO セクション処理
- [ ] **support@ メールアドレスの動作確認**: テスト送信で実受領を確認

## T-3 営業日前 (2026-05-29 木) — 直前確認

- [ ] **monitoring の準備**:
  - Netlify Function ログを毎時確認できる体制
  - Supabase Dashboard でリアルタイム接続数モニタ
  - エラー集約 (`system_error_logs`) を 30 分ごとに確認
- [ ] **インシデント対応の練習**:
  - [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) §6.5 (ログイン失敗) を手元で 1 回試行
  - Netlify Rollback (Publish deploy、§7.1) を **ステージング環境で 1 回実施**
- [ ] **告知準備**:
  - リリース告知文の最終版作成 (Twitter / LinkedIn / 知人連絡用)
  - リリースノートを自社サイト掲載 (もしあれば)
- [ ] **休息確保**: 5/30-5/31 は意識的に休む (リリース当日に万全な状態で臨むため)

## T-1 営業日前 (2026-05-30 金) — 最終確認

- [ ] **リリース真値ファイルの最終更新** — [`RELEASE_PROCEDURE.md`](./RELEASE_PROCEDURE.md) §1 / §2.1 の (1)-(4) を確認
  - `CHANGELOG.md` に `## [1.0.0] — 2026-06-01` セクションが完成 / `package.json.version` が `1.0.0` / Netlify `NEXT_PUBLIC_RELEASE_DATE=2026-06-01` 設定済 / `/announcements/2026-06-01-launch.md` 完成
- [ ] **本番デプロイ前の最終 commit**: main の最新コミット SHA を記録
- [ ] **本番環境変数の再確認**: Netlify Dashboard で全変数の値を目視 (typo / 改行混入チェック)
- [ ] **ステージング環境で最終 dry-run**:
  - 新規ユーザサインアップ → メール認証 → ログイン → プロジェクト作成 → ナレッジ登録 → 提案エンジン実行
  - 全フロー成功確認
- [ ] **本番 DB の状態確認**:
  - `_prisma_migrations` テーブルに pending 状態がないか
  - seed データが想定通り
  - super_admin アカウントが作成済 (Teppei 自身)
- [ ] **休日のオンコール準備**:
  - 6/1 (日) は終日対応可能な状態
  - 緊急連絡先 (Supabase / Netlify) を即引ける位置に

---

## 2026-06-01 当日 (リリース日 / 日曜)

### 当日 09:00 — 朝の最終点検

- [ ] **コーヒーを淹れる ☕** (本気で)
- [ ] **Supabase Status Page 確認**: 障害告知がないか https://status.supabase.com/
- [ ] **Netlify Status Page 確認**: https://www.netlifystatus.com/
- [ ] **Anthropic Status 確認**: https://status.anthropic.com/
- [ ] **本番アプリの health check**:
  - `curl https://<production-domain>/` で 200 が返る
  - ログインページが表示される
- [ ] **DB 接続確認**: Supabase Dashboard → Project → 状態が `Active`

### 当日 10:00 — リリース判断

- [ ] **最終 go/no-go 判定**:
  - 9:00 点検で全 green → **GO**
  - いずれか 1 つでも問題があれば **延期**
- [ ] **GO の場合**:
  - 本番アプリの公開フラグを true に (もし feature flag で制御しているなら)
  - DNS / domain 設定の最終確認 (独自ドメインがあれば)

### 当日 10:30 — 公開告知

- [ ] **ユーザ向け告知メール送信** (登録済 beta ユーザがいれば)
- [ ] **SNS 告知** (Twitter / LinkedIn)
- [ ] **知人への直接連絡** (初期利用者の確保)
- [ ] **support@ の自動応答設定**: 「初期対応中、平日対応」の旨を auto-reply に

### 当日 11:00 〜 18:00 — 監視時間帯

30 分ごとに以下を確認:

- [ ] Netlify Function ログでエラー / 警告
- [ ] Supabase 接続数 / クエリ実行時間
- [ ] `system_error_logs` テーブルの新規エントリ
- [ ] サポートメール / Discord / GitHub Issues の新着

### 当日 18:00 — 初日締め

- [ ] **初日の指標記録** (`docs/operations/release-logs/2026-06-01.md`):
  - サインアップ数 / アクティブユーザ数
  - エラー件数 (システムエラー / ユーザ起因)
  - 主要機能の呼出数 (提案エンジン / ナレッジ登録 / プロジェクト作成)
- [ ] **異常がないか最終確認**
- [ ] **オンコール体制を「夜間最低限」に**: P0 緊急時のみ対応、それ以外は明朝

---

## T+1 営業日 (2026-06-02 月)

### 朝 9:00 — 初日振り返り

- [ ] 初日ログ確認
- [ ] サポート問い合わせのトリアージ ([CUSTOMER_FEEDBACK_TRIAGE.md](./CUSTOMER_FEEDBACK_TRIAGE.md))
- [ ] 残存課題の整理 (緊急対応 / 後日対応の仕分け)

### 通常運用へ移行

- [ ] 日次トリアージルーチン開始
- [ ] 週次の指標レビュー (毎週金曜 1 時間)

---

## ロールバック条件と手順

### 即時ロールバック判断基準

以下のいずれかで Netlify の前バージョンへ即時ロールバック ([INCIDENT_RESPONSE.md §7.1](./INCIDENT_RESPONSE.md)):

- ログイン機能が全ユーザで失敗
- 提案エンジンが全テナントで失敗 (LLM 障害ではなく自プロダクト由来)
- データ漏洩疑い (S-1)
- 何らかの理由で 5xx エラー率が 10% 超

### ロールバック手順

1. Netlify Dashboard → Deploys → 1 つ前の Published deploy → **Publish deploy**
2. ロールバック完了確認 (数秒〜数十秒)
3. ユーザ向け告知 (障害テンプレート、[INCIDENT_RESPONSE.md §8.2](./INCIDENT_RESPONSE.md))
4. 根本原因調査 → fix PR → 再度 6/1 リリース手順に従って公開

### DB スキーマを伴うロールバック

- コードロールバックでは戻らない。手動で逆 SQL 実行 ([INCIDENT_RESPONSE.md §7.2](./INCIDENT_RESPONSE.md))
- リスクが高いため、6/1 当日は **DB スキーマ変更を伴うデプロイは禁止** (5/30 までに完了させておく)

---

## B4: prisma migrations squash の判断

### 現状
- 2026-05-16 時点: 48+ 個の migration ファイル
- 初期 5 件 (init / estimates / retrospectives / email_verification / password_reset) は MVP 構築時のものでまとめ可能

### Squash 実行の判断

**実行する場合の手順** (5/29 木 までに完了):

1. 検証用 Supabase project で squash 後の migration を一度全て適用 → 結果が同じ schema になることを確認
2. 本番 DB のスナップショットを取得
3. `_prisma_migrations` テーブルを操作:
   - 旧 5 件のエントリを削除
   - 新規 squash migration を「適用済」状態で挿入
4. main にマージして本番デプロイ

**実行しない判断** (推奨):

- 48 個の管理は Prisma の通常運用範囲内
- 本番直前の DB 操作はリスクが高い
- v1 リリース後、運用が落ち着いてから (例: 7 月以降) 実施

**推奨方針**: **6/1 リリースでは squash を実行しない**。v1.x 期 (7 月以降) に整理。

---

## 関連ドキュメント

- リリースノート v1: [RELEASE_NOTES_v1.md](./RELEASE_NOTES_v1.md)
- インシデント対応: [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md)
- バックアップ検証: [BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md)
- サポート対応: [CUSTOMER_FEEDBACK_TRIAGE.md](./CUSTOMER_FEEDBACK_TRIAGE.md)
- 依存パッケージ脆弱性: [DEPENDENCY_VULNERABILITY_PROCESS.md](./DEPENDENCY_VULNERABILITY_PROCESS.md)
- Dogfooding (6/15 ± 1 週): [DOGFOODING_PLAN.md](./DOGFOODING_PLAN.md)
- 環境変数: [ENV_VARS.md](./ENV_VARS.md)
- デプロイ手順: [DEPLOYMENT.md](./DEPLOYMENT.md)
- DB マイグレーション: [DB_MIGRATION_PROCEDURE.md](./DB_MIGRATION_PROCEDURE.md)
