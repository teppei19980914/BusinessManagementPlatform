# 機能カタログ (Feature Catalog)

本ドキュメントは、たすきば Knowledge Relay の **機能 × 顧客課題 × 関連ファイル** のマトリクスを提供する。

> **使い方**: 顧客フィードバックを受けたときに、(1) どの顧客課題に関連するか、(2) どの機能に手を入れるか、(3) どのファイルを変更するか、を即座に判定するための参照点。

---

## カテゴリ分類

| カテゴリ | 顧客課題 (中心テーマ) | 関連機能 |
|---|---|---|
| **A. プロジェクト運営** | プロジェクトの状態を可視化し、健全な運営を継続したい | プロジェクト管理 / WBS / ガント / 進捗管理 / 分析 (予実カーブ) / リスク・課題 |
| **B. 知見の再利用 (核心機能)** | 過去資産が次の判断に活きていない | 提案エンジン / チャット意味検索 / AI ヘルプチャット / ナレッジ / 振り返り / 自動タグ抽出 |
| **C. 個人作業の管理** | 自分のタスクを横断して把握したい | マイタスク / メモ |
| **D. チーム管理** | メンバーの権限・参加を柔軟に管理したい | プロジェクトメンバー / ユーザ管理 / ロール / ステークホルダー / メンション / 通知 / コメント |
| **E. テナント / 課金** | 利用量と料金を把握・予測したい | プラン管理 / 利用量集計 / 縮退モード / Stripe 決済 |
| **F. セキュリティ・監査** | データの安全性と追跡可能性を保ちたい | 認証 (MFA) / 監査ログ / アカウントロック |
| **G. 運用ツール** | システム管理者として運用判断したい | super_admin ダッシュボード / バックアップ / Cron |

---

## A. プロジェクト運営

| 機能 | 顧客課題 | 主な変更先ファイル | 関連ドキュメント |
|---|---|---|---|
| **プロジェクト管理** (CRUD + 状態遷移) | 「企画 → 完了の流れを 1 つで管理したい」 | `src/services/project.service.ts` / `src/app/(dashboard)/projects/` | [SCREENS §11.1-11.2](../specification/SCREENS.md) / [PROJECT_LIFECYCLE.md](./PROJECT_LIFECYCLE.md) |
| **見積もり管理** | 「過去実績を踏まえた見積もりを作りたい」 | `src/services/estimate.service.ts` / `src/app/(dashboard)/projects/[projectId]/estimates/` | [SCREENS §11.3](../specification/SCREENS.md) |
| **WBS / タスク管理** | 「タスクの階層構造と進捗をシンプルに」 | `src/services/task.service.ts` / `src/app/(dashboard)/projects/[projectId]/tasks/` | [SCREENS §11.4](../specification/SCREENS.md) |
| **進捗確認 (旧称: ガントチャート)** | 「スケジュールの遅延を時系列で把握したい」「担当者ごとに直近の状況を一目で確認したい」 | `src/app/(dashboard)/projects/[projectId]/gantt/` | [SCREENS §11.5](../specification/SCREENS.md) |
| **進捗・実績更新** | 「日々の進捗をワンクリックで」 | `src/services/task.service.ts` (updateProgress 系) | [SCREENS §11.4 / §11.6](../specification/SCREENS.md) |
| **分析タブ (5 パネル)** | 「完了に向けた現在地と消化ペース、担当者の生産性・作業負担・日次の山積みをグラフで把握したい」(PM/PL + admin、v1.2.0)。表示名/概念: 進捗の遅れ・先行 (予実カーブ) / 消化ペースと効率 (週次消化工数) / 見積の精度 (予実差) / 作業量の偏り (作業負担) / 日別の負荷 (日次工数 8h ヒートマップ)。ツールバーで表示グラフ・対象期間を選択 | `src/services/analytics.service.ts` / `src/app/(dashboard)/projects/[projectId]/analysis/` / `src/components/charts/` | [SCREENS §11.5b](../specification/SCREENS.md) / [ADR-0038](../adr/0038-project-analytics-tab-and-generic-chart-foundation.md) |
| **リスク・課題管理** | 「リスクと課題を統一フローで起票・追跡したい」 | `src/services/risk.service.ts` / `src/app/(dashboard)/projects/[projectId]/risks/` (+ プロジェクト外横断: `src/app/(dashboard)/risks/` / `issues/`) | [SCREENS §11.7](../specification/SCREENS.md) |

---

## B. 知見の再利用 (核心機能)

| 機能 | 顧客課題 | 主な変更先ファイル | 関連ドキュメント |
|---|---|---|---|
| **提案エンジン (核心)** | 「過去のナレッジが埋もれて活用できない」「キーワード検索では取りこぼす」 | `src/services/suggestion.service.ts` / `src/services/embedding.service.ts` / `src/services/suggestion-explanation.service.ts` (なぜ機能) | [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) / [ADR-0003](../adr/0003-embedding-based-suggestion-engine.md) / [SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) |
| **チャット意味検索 (核心)** | 「会議中に過去事例を即座に呼び出したい」「全文検索では絞り込めない」 | `src/services/chat-search.service.ts` / `src/app/api/chat/search/` / `src/components/chat-semantic-search/` | [CHAT_SEMANTIC_SEARCH.md](../specification/CHAT_SEMANTIC_SEARCH.md) / [chat-semantic-search-guide.md](../public/chat-semantic-search-guide.md) |
| **ナレッジ管理** | 「知見を構造化して残したい」「公開範囲を制御したい」 | `src/services/knowledge.service.ts` / `src/app/(dashboard)/knowledge/` | [SCREENS §11.8](../specification/SCREENS.md) / [USER_ROLES §6.5](./USER_ROLES.md) |
| **振り返り (Retrospective)** | 「プロジェクト完了後の総括を残したい」 | `src/services/retrospective.service.ts` / `src/app/(dashboard)/projects/[projectId]/retrospectives/` (+ 横断: `src/app/(dashboard)/retrospectives/`) | [SCREENS §11.9](../specification/SCREENS.md) |
| **AI ヘルプチャット (たすきフクロウ)** | 「使い方が分からない / FAQ を自然文で聞きたい」 | `src/services/help-search.service.ts` (FAQ/Guide RAG) / `src/app/api/help/chat/route.ts` / `src/app/(dashboard)/help/` / `src/components/help-chat/` | [ADR-0027](../adr/0027-help-ai-concierge.md) / [ADR-0028](../adr/0028-help-chat-rag-migration.md) / memory: project_faq_drives_ai_accuracy |
| **LLM 自動タグ抽出** | 「タグ付けの手間を省きたい」 | `src/services/auto-tag.service.ts` / `src/lib/llm/metered.ts` | [GLOSSARY: LLM 自動タグ抽出](./GLOSSARY.md) / [ADR-0002](../adr/0002-tenant-billing-per-api-call.md) |
| **embedding バックフィル** | 「縮退モード中に生成されなかった embedding を月初に補完」 | `src/services/embedding-backfill.service.ts` / `src/services/attachment-embedding-cron.service.ts` / `src/app/api/cron/attachment-embedding/route.ts` | [SUGGESTION_ENGINE.md §B-4](../design/SUGGESTION_ENGINE.md) / [ADR-0026](../adr/0026-embedding-async-generation.md) |
| **資産導線 (昇華リンク・手動リンク) / v1.3.0** | 「リスクが顕在化したら課題に、課題が解消したら知見に、その都度ゼロから書き直すのが手間」「関連する過去資産を相互に辿れない」 | `src/services/promotion.service.ts` (リスク→課題 / 課題→ナレッジ昇華) / `src/services/asset-link.service.ts` (5 資産間の汎用手動リンク) / `src/components/common/promotion-badge-list.tsx` / `src/components/common/asset-link-section.tsx` / `src/components/dialogs/promote-*-dialog.tsx` | [DATA_MODEL.md §8.44-8.46](../design/DATA_MODEL.md) |
| **WBS 完了バナー / v1.3.0** | 「タスクが完了しても振り返りを忘れてしまう」 | `src/services/task.service.ts` (`getWbsCompletionBannerState`) / `src/components/wbs-completion-banner.tsx` / `src/lib/wbs-completion-banner-dismiss-storage.ts` | [DATA_MODEL.md](../design/DATA_MODEL.md) |

---

## C. 個人作業の管理

| 機能 | 顧客課題 | 主な変更先ファイル | 関連ドキュメント |
|---|---|---|---|
| **マイタスク** | 「複数プロジェクトを横断して自分の作業を一覧したい」 | `src/services/task.service.ts` (`listMyTasks` / `listMyTaskProjects`) / `src/app/(dashboard)/my-tasks/` | [SCREENS §11.6](../specification/SCREENS.md) |
| **メモ (Memo)** | 「個人的なメモを残し、公開化したものは提案候補にも乗せたい」 | `src/services/memo.service.ts` / `src/app/(dashboard)/memos/` (横断: `src/app/(dashboard)/all-memos/`) | [GLOSSARY: 可視性](./GLOSSARY.md) |

---

## D. チーム管理

| 機能 | 顧客課題 | 主な変更先ファイル | 関連ドキュメント |
|---|---|---|---|
| **プロジェクトメンバー管理** | 「プロジェクトごとに参加メンバーを柔軟に」 | `src/services/member.service.ts` (`listMembers` / `addMember` / `updateMemberRole` / `removeMember`) / `src/app/(dashboard)/projects/[projectId]/members-client.tsx` | [SCREENS §11.10](../specification/SCREENS.md) |
| **ユーザ管理 (テナント内)** | 「テナント管理者として、ユーザを追加・無効化したい」 | `src/services/user.service.ts` / `src/app/(dashboard)/admin/users/` | [SCREENS §11.11](../specification/SCREENS.md) / [USER_ROLES.md](./USER_ROLES.md) |
| **顧客管理 (案件先)** | 「プロジェクトの顧客 (案件先) を統一管理」 | `src/services/customer.service.ts` / `src/app/(dashboard)/customers/` | [SCREENS §11.11b](../specification/SCREENS.md) |
| **権限変更履歴** | 「誰がいつ権限を変更したかを追跡したい」 | `src/services/audit.service.ts` (role-change 種別) / `src/app/(dashboard)/admin/role-changes/` | [SCREENS §11.12](../specification/SCREENS.md) |
| **ステークホルダー管理** (PMBOK 13) | 「内部・外部の全関係者を Power/Interest grid で管理したい」 | `src/services/stakeholder.service.ts` / `src/app/(dashboard)/projects/[projectId]/stakeholders/` | [MVP_SCOPE.md §7.11](./MVP_SCOPE.md) |
| **メンション** (@通知) | 「コメントで関係者に通知したい」 | `src/services/mention.service.ts` / `src/app/api/mention-candidates/` | [GLOSSARY: メンション](./GLOSSARY.md) |
| **通知 (Notification)** | 「期限・メンション・状態変化を通知ベルで把握したい」 | `src/services/notification.service.ts` / `src/components/notifications/notification-bell.tsx` / `src/app/api/cron/daily-notifications/route.ts` | [GLOSSARY: 通知](./GLOSSARY.md) |
| **コメント** | 「タスク・ナレッジ等にコメントを残したい」 | `src/services/comment.service.ts` | — |

---

## E. テナント / 課金

| 機能 | 顧客課題 | 主な変更先ファイル | 関連ドキュメント |
|---|---|---|---|
| **プラン管理 (LLM / Storage)** | 「Beginner / Expert / Pro の切替・Storage 容量 add-on をスムーズに」 | `src/services/tenant-self.service.ts` (テナント自身) / `src/services/super-admin.service.ts` (横断) / `src/app/(dashboard)/settings/tenant/billing/` | [TENANT_AND_BILLING Part 5 / §34.14](./TENANT_AND_BILLING.md) / [ADR-0002](../adr/0002-tenant-billing-per-api-call.md) |
| **利用量集計 / 表示** | 「今月いくら使ったか即座に把握したい」 | `src/services/api-usage-recalc.service.ts` / `src/services/billing-dashboard.service.ts` / `src/app/(dashboard)/settings/tenant/` (usage タブ) | [TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md) / memory: feedback_billing_data_realtime |
| **縮退モード** | 「Beginner 上限到達でも完全停止せず、月初に自動復帰」 | `src/services/degraded-mode.service.ts` | [GLOSSARY: 縮退モード](./GLOSSARY.md) / [ADR-0002](../adr/0002-tenant-billing-per-api-call.md) |
| **Embedding 課金 (ADR-0022/0029/0030)** | 「Expert/Pro は embedding 従量 ¥5、Beginner は月 100 件試用上限」 | `src/config/billing-feature-units.ts` / `src/config/embedding-pricing.ts` / `src/services/embedding.service.ts` | [GLOSSARY: プラン](./GLOSSARY.md) / [ADR-0029](../adr/0029-embedding-price-revision-5jpy.md) / [ADR-0030](../adr/0030-embedding-monthly-budget-cap.md) |
| **Stripe 決済 (5 Item 従量)** | 「クレジットカードで自動引き落とし (Haiku/Sonnet/Embedding/DBCap/Storage)」 | `src/lib/stripe.ts` / `src/services/stripe-billing.service.ts` / `src/app/api/webhooks/stripe/route.ts` | [STRIPE_BILLING.md](./STRIPE_BILLING.md) / [ADR-0006](../adr/0006-stripe-metered-billing-integration.md) |
| **Stripe DLQ / 同期復旧** | 「webhook 失敗・usage 記録漏れを検知し手動/自動で復旧」 | `src/services/stripe-dlq.service.ts` / `src/services/stripe-reconcile.service.ts` / `src/services/stripe-usage-flush.service.ts` / `src/app/(dashboard)/admin/super/stripe-dlq/` | [STRIPE_BILLING.md](./STRIPE_BILLING.md) |
| **請求書・銀行振込 + クレジットカード (v1)** | 「請求書/銀行振込とクレジットカード払いの 2 経路で運用 (credit_card は 2026-05-30 有効化、それ以前は銀行振込のみ)」 | `src/services/billing-management.service.ts` (`confirmInvoicePayment` 系) / `src/services/billing-aggregation.service.ts` | [PAYMENT_TERMS.md](./PAYMENT_TERMS.md) / [ADR-0007](../adr/0007-unify-invoice-and-bank-transfer.md) |
| **外部データ取込 (テナント機能)** | 「他システムから CSV / API 連携で 7 種 (顧客・プロジェクト・WBS・リスク課題・ナレッジ・振り返り) を一括 import (preview → apply)」 | `src/services/import/migration-import.service.ts` / `src/services/import-storage-precheck.service.ts` / `src/app/api/tenants/me/migration-import/` (`csv-preview` / `preview` / `apply` / `connect`) / `src/app/(dashboard)/settings/tenant/migration-import/` / `api-import/` | ADR-0034 / memory: feedback_bulk_llm_call_unit |
| **月初 cron バッチ (月次リセット)** | 「月次カウンタリセット・embedding 補完・プラン切替予約適用 (legacy)」 | `src/app/api/cron/tenant-monthly-reset/route.ts` / `src/services/tenant-monthly-reset.service.ts` | [INCIDENT_RESPONSE.md §6.8](../operations/operate/INCIDENT_RESPONSE.md) |
| **月初 cron バッチ (課金確定)** | 「LLM/DB容量/ファイル peak の月初請求確定・前月 snapshot 保存」 | `src/app/api/cron/billing-monthly-aggregation/route.ts` / `src/services/billing-aggregation.service.ts` | [INCIDENT_RESPONSE.md §6.8](../operations/operate/INCIDENT_RESPONSE.md) |

---

## F. セキュリティ・監査

| 機能 | 顧客課題 | 主な変更先ファイル | 関連ドキュメント |
|---|---|---|---|
| **認証 (Email + Password)** | 「シンプルにメールアドレスでログインしたい」 | `src/lib/auth.ts` / `src/app/api/auth/` | [SECURITY.md](../design/SECURITY.md) |
| **MFA (TOTP)** | 「admin は強制 / 一般ユーザは任意で多要素認証」 | `src/services/mfa.service.ts` / `src/app/(auth)/login/mfa/` / `src/app/api/auth/mfa/` | [GLOSSARY: MFA](./GLOSSARY.md) / [SECURITY.md](../design/SECURITY.md) |
| **アカウントロック** | 「ブルートフォース攻撃を弾きたい」 | `src/services/password.service.ts` / `src/services/user.service.ts` (`lockInactiveUsers`) / `src/app/api/auth/lock-status/` | [INCIDENT_RESPONSE §6.5](../operations/operate/INCIDENT_RESPONSE.md) |
| **パスワード管理** | 「ポリシー / リセット / 履歴チェック」 | `src/services/password.service.ts` / `src/services/password-reset.service.ts` | [SECURITY.md](../design/SECURITY.md) |
| **監査ログ** | 「全変更を追跡可能にしたい (WORM)」 | `src/services/audit.service.ts` / `src/app/(dashboard)/admin/audit-logs/` | [GLOSSARY: 監査ログ](./GLOSSARY.md) |
| **認証イベントログ** | 「ログイン失敗・MFA 試行を追跡したい」 | `src/services/auth-event.service.ts` | [INCIDENT_RESPONSE §6.5](../operations/operate/INCIDENT_RESPONSE.md) |
| **エラー集約 (system_error_logs)** | 「エラーは画面に出さず DB に記録、画面は固定文言」 | `src/services/error-log.service.ts` | [SECURITY.md](../design/SECURITY.md) |

---

## G. 運用ツール (super_admin)

| 機能 | 顧客課題 | 主な変更先ファイル | 関連ドキュメント |
|---|---|---|---|
| **super_admin ダッシュボード** | 「テナント横断で利用状況をモニタしたい」 | `src/app/(dashboard)/admin/super/` | [SCREENS](../specification/SCREENS.md) |
| **テナント管理** | 「テナント追加・削除・プラン変更」 | `src/services/super-admin.service.ts` | [TENANT_AND_BILLING Part 3](./TENANT_AND_BILLING.md) |
| **利用量モニタ** | 「テナント別・featureUnit 別の API 呼出推移」 | `src/app/(dashboard)/admin/super/usage/` | [INCIDENT_RESPONSE §6.6](../operations/operate/INCIDENT_RESPONSE.md) |
| **DB 容量モニタ** | 「Supabase 無料枠到達リスクを早期検知」 | `src/services/db-capacity.service.ts` | [INCIDENT_RESPONSE §6.9](../operations/operate/INCIDENT_RESPONSE.md) |
| **データエクスポート** | 「テナント解約時に全データを CSV で受け取れる」 | `src/services/data-export.service.ts` / `src/app/api/tenants/me/export/` | — |
| **テナント診断 / ドリフト修復** | 「課金カウンタの drift を検知・修復する」 | `src/services/tenant-diagnostics.service.ts` / `src/services/diagnostics.service.ts` / `src/app/(dashboard)/admin/super/diagnostics/` | [INCIDENT_RESPONSE.md](../operations/operate/INCIDENT_RESPONSE.md) / memory: feedback_drift_detection_design |
| **DB 容量 / ファイル Storage モニタ** | 「Supabase 無料枠・Storage バケット使用量を監視」 | `src/services/db-capacity.service.ts` / `src/services/file-storage-bucket-usage.service.ts` / `src/app/(dashboard)/admin/super/db-capacity-alerts-card.tsx` ほか | [INCIDENT_RESPONSE §6.9](../operations/operate/INCIDENT_RESPONSE.md) |

---

## 機能カタログの使い方 (顧客フィードバック受領時のフロー)

1. **顧客の用語を辞書化** ([GLOSSARY.md](./GLOSSARY.md)): 顧客が言う「○○」が、本サービスのどのドメイン用語に対応するか確認
2. **カテゴリ判定**: 上記 A〜G のどれに該当するか (複数該当もあり)
3. **機能特定**: カテゴリ内のどの機能か (同名機能が複数カテゴリにまたがる場合あり)
4. **影響ファイル列挙**: 「主な変更先ファイル」を起点に `grep` で関連箇所を網羅 ([CONTRIBUTING.md §5.1 横展開チェック](../../CONTRIBUTING.md))
5. **設計判断の確認**: 関連する ADR があれば事前に読み、設計意図を守った修正にする ([docs/adr/](../adr/))

---

## カタログ更新ルール

- 新規機能を追加した PR では本ファイルにも 1 行追加する (CONTRIBUTING.md §5.10 のチェックリスト対象)
- 機能廃止時は **DEPRECATED** マークを付けて残す (履歴として参照されるため即削除しない)
- 「主な変更先ファイル」は **代表的なエントリポイント** のみ。完全網羅は不要 (それは grep で行う)
- カテゴリ分類が曖昧なら、複数カテゴリに重複記載してよい (発見性優先)
