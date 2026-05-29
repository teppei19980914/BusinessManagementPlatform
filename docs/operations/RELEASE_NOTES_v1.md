# たすきば Knowledge Relay v1.0 リリースノート (ドラフト)

- **リリース予定日**: 2026-06-01
- **リリース種別**: 外部公開 (一般提供開始)
- **ステータス**: ドラフト (2026-05-16 起票、リリース直前に確定版へ更新、2026-05-25 ADR-0019 価格改定反映)

> 🆕 **ADR-0019 (2026-05-24) 価格改定 (リリース直前)**: 課金対象を `BILLABLE_FEATURE_UNITS` のみに縮小し、資産入力・チャット検索・CSV インポート・月初 backfill を **全プラン無料化**。Expert ¥10/call / Pro ¥15/call / Beginner プロジェクト作成/更新 月 50 回まで無料。詳細: [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md)

> 本ドキュメントは v1.0 リリースの **対外向け告知** と **内部記録** を兼ねる。
> リリース直前 (5/30 頃) に確定版にし、リリース当日にユーザへの告知メール / 自社サイト掲載用に転記する。

---

## ハイライト

たすきば Knowledge Relay は、**プロジェクトの知見を蓄積し、次の判断を強くする運営プラットフォーム** です。
v1.0 では、プロジェクトの企画 → 完了 → 振り返りまでを一気通貫で支援する基盤に加え、**過去資産を意味検索で再利用する提案エンジン** を核心機能として提供します。

### v1.0 の 3 つの差別化点

1. **意味検索ベースの提案エンジン** — 「セキュリティ要件」と「情報漏洩対策」が同じ意味だと理解して候補化。キーワード検索では取りこぼす過去資産を漏らさず提示
2. **使った分だけの透明な課金** — 月額固定なし、プロジェクト作成・更新 1 回ごとの per-call 課金 (Expert ¥10/call / Pro ¥15/call、ADR-0019 改定後)。Beginner プランはプロジェクト作成・更新が月 50 回まで無料 + 縮退モードで「壊れない」体験
3. **健全な運営を支える状態マシン** — 企画 → 見積 → 計画 → 実行 → 完了 → 振り返り → クローズの 7 状態モデルで、各フェーズで適切な操作のみ許可

---

## 含まれる機能

### A. プロジェクト運営
- プロジェクト管理 (CRUD + 7 状態の遷移マシン)
- 見積もり管理 (過去ナレッジ・実績参照)
- WBS / タスク管理 (階層構造)
- ガントチャート (時系列可視化)
- 進捗・実績更新
- リスク・課題管理 (統一フロー)

### B. 知見の再利用 (核心機能)
- 提案エンジン (Embedding + Voyage AI + pgvector)
- ナレッジ管理 (3 段階公開範囲: 自分のみ / 全メンバー)
- 振り返り (Retrospective)
- LLM 自動タグ抽出 (Anthropic Claude)
- embedding バックフィル (月初バッチ)

### C. 個人作業
- マイタスク (横断ビュー)
- メモ (Memo、個人ノート → 公開化で提案候補に昇格)

### D. チーム管理
- プロジェクトメンバー管理
- ユーザ管理 (テナント内)
- 顧客管理 (案件先マスタ)
- 権限変更履歴

### E. テナント / 課金
- LLM プラン 3 種 (Beginner / Expert / Pro)
- Storage プラン (Standard / Plus / Pro Storage / Enterprise)
- 利用量集計 (リアルタイム表示)
- 縮退モード (Beginner 上限到達時の fail-safe)
- Stripe Metered Billing 連携 (v1.x で順次)
- 請求書 / 銀行振込支払い (v1 主流)
- 月初バッチ (cron による課金確定・embedding 補完)

### F. セキュリティ・監査
- メール + パスワード認証 (NextAuth.js)
- MFA / TOTP (admin 必須・一般ユーザ任意)
- アカウントロック (ブルートフォース対策)
- パスワード管理 (ポリシー / リセット / 履歴)
- 監査ログ (全変更操作の追跡)
- 認証イベントログ
- エラー集約 (画面には固定文言、詳細は DB)

### G. 運用ツール (super_admin)
- super_admin ダッシュボード
- テナント管理
- 利用量モニタ
- DB 容量モニタ
- データ エクスポート

詳細: [docs/business/FEATURE_CATALOG.md](../business/FEATURE_CATALOG.md)

---

## v1.0 の対象外 (v1.x 以降に順次提供)

- **Stripe 自動課金フル機能**: v1 はカード課金は限定的、銀行振込が主流。v1.x で完全自動化
- **チャットボット**: 将来構想 ([docs/vision/](../vision/) §8)
- **Phase 3 LLM Re-ranking**: 提案エンジンの上位候補に対する LLM 再ランキング (v1.x 以降)
- **モバイルアプリ**: Web 版のみ (PWA 対応はあり)
- **SSO (Google / Microsoft 等)**: 認証は email+password と TOTP-MFA のみ
- **多言語対応**: 日本語のみ (UI 文字列は `src/labels/` に集約済、将来 i18n 対応の足場あり)
- **WebAuthn / Passkey**: v2 以降

---

## 技術スタック

| レイヤ | 採用 |
|---|---|
| フロントエンド | Next.js 14+ (App Router) / TypeScript / Tailwind CSS / shadcn/ui |
| バックエンド | Next.js API Routes / Server Actions |
| データベース | PostgreSQL 16 (Supabase) + pgvector |
| ORM | Prisma 6.x |
| LLM | Anthropic Claude (Haiku / Sonnet) |
| Embedding | Voyage AI |
| 認証 | NextAuth.js v5 (Auth.js) + TOTP MFA |
| メール | Brevo (旧 Sendinblue) |
| 決済 | Stripe (v1.x) / 銀行振込 (v1) |
| ホスティング | Netlify (アプリ、ADR-0023 で Vercel から移行) + Supabase (DB) |
| テスト | Vitest (単体) + Playwright (E2E) |

主要設計判断の根拠: [docs/adr/](../adr/) (ADR-0001 〜 0013)

---

## 既知の制約事項

| 項目 | 内容 | 対応予定 |
|---|---|---|
| 旧 Vercel Hobby Cron (現 cron-job.org) | 1 分間隔まで設定可だが日次運用継続中 | ops 即時性要求が出たら短間隔に切替 |
| Supabase Free DB 容量 | 500MB 上限 | DB 容量モニタで監視、80% 到達で Pro 移行検討 |
| Beginner プラン無料枠 | 月 100 回到達後は縮退モード (作成・更新は継続、提案エンジン停止) | 翌月 1 日にリセット + NULL embedding 補完 |
| Beginner プラン ダウングレード | 上位プラン → Beginner は不可 ([ADR-0013](../adr/0013-beginner-downgrade-prohibition.md)) | super_admin への問い合わせで個別対応 |
| MFA 暗号化キー | NEXTAUTH_SECRET 派生 (post-MVP で専用キーへ分離予定) | [SECURITY-TASKS.md F-01](../security/SECURITY-TASKS.md) |

---

## サポート

- 不具合報告: support@<domain> または GitHub Issues
- 一般質問: support@<domain>
- 緊急時: 平日 9-18 時対応、休日は P0 (致命的) のみ
- セキュリティ報告: [SECURITY.md](../../SECURITY.md) 参照

サポートトリアージプロセス: [docs/operations/CUSTOMER_FEEDBACK_TRIAGE.md](./CUSTOMER_FEEDBACK_TRIAGE.md)

---

## リリース後のロードマップ

短期 (1-3 ヶ月):
- 6/15 ± 1 週: dogfooding 検証 ([DOGFOODING_PLAN.md](./DOGFOODING_PLAN.md))
- 7 月初週: 初回 STRIDE 脅威モデリング ([STRIDE_REVIEW_PROCEDURE.md](../security/STRIDE_REVIEW_PROCEDURE.md))
- 7 月初週: 初回バックアップ検証 ([BACKUP_VERIFICATION.md](./BACKUP_VERIFICATION.md))
- Stripe 自動課金フル機能 ([ADR-0006](../adr/0006-stripe-metered-billing-integration.md))

中期 (3-6 ヶ月):
- 提案エンジンの Phase 3 LLM Re-ranking
- 多言語対応の足場拡充
- Pro プラン移行の判断 (テナント数 / DB 容量に応じて)

長期 (6-12 ヶ月):
- チャットボット
- AWS / Azure 移行 ([ADR-0012](../adr/0012-vercel-supabase-mvp-hosting.md) → ADR-0023 で Netlify へ移行済、将来 AWS 移行は [MIGRATION_TO_AWS.md](./MIGRATION_TO_AWS.md))
- WebAuthn / Passkey 検討

---

## 確定版への更新 TODO (5/30 頃)

リリース 1-2 日前に以下を確定:

- [ ] 実際の機能一覧の最終確認 (5/30 時点で main に取り込まれているもの)
- [ ] 既知の制約事項に直前で発覚した項目を追記
- [ ] 連絡先 (`support@<domain>`) の確定ドメイン置換
- [ ] サポートサイト URL (もし用意するなら) 追記
