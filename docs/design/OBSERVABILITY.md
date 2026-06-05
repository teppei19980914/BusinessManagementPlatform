# OBSERVABILITY — システム自己監視・記録・アラート設計

> **本書の位置づけ**: たすきば Knowledge Relay が「自分自身をどう監視・記録・アラートするか」を体系化した**設計ドキュメント**。
> 「何を / どこに記録し」「何を / どの閾値で検知し」「誰に / いつ通知するか」の**真値はソースコード**（`src/services/*` / `src/config/cron-jobs.ts` / `prisma/schema.prisma`）であり、本書はそれを横断的に索引する。
> **障害発生時の対応手順（runbook）は本書ではなく [operations/](../operations/README.md) 配下**を参照すること（→ §5 で役割分担を明記）。
>
> - **対象読者**: super_admin / 運用担当 / Claude Code（緊急時調査）
> - **更新規約**: 記録テーブル・監視 service・cron・閾値を変更したら本書も同時更新する。閾値は必ずソースの定数を孫引きせず直接参照する。

---

## 目次

- [§1 記録レイヤ（何がどこに残るか）](#1-記録レイヤ何がどこに残るか)
- [§2 監視・検知（何を / どの閾値で気付くか）](#2-監視検知何を--どの閾値で気付くか)
- [§3 アラート（誰に / いつ通知するか）](#3-アラート誰に--いつ通知するか)
- [§4 縮退モードの観測点（ADR-0008）](#4-縮退モードの観測点adr-0008)
- [§5 運用 runbook へのリンクと役割分担](#5-運用-runbook-へのリンクと役割分担)

---

## §1 記録レイヤ（何がどこに残るか）

システムが残す永続ログは 5 テーブル。すべて `prisma/schema.prisma` で定義され、各々専用の service 経由で書き込む。

| テーブル (`@@map`) | 用途 | 記録元 service / 経路 | 保持・特記 |
|---|---|---|---|
| `audit_logs` | **全データ変更操作 (CREATE/UPDATE/DELETE) の監査記録**。ADR-0011「全 mutation 記録」原則 + WORM 性。誰が・いつ・どのテナントの・何を・どう変更したかを before/after JSON で保持。 | [`audit.service.ts`](../../src/services/audit.service.ts) `recordAuditLog` / `recordBulkAuditLogs` | `tenantId`/`userId`/`entityId` は **`@db.Uuid` 厳格型**（非 UUID は PostgreSQL 22P02 で拒否、service 入口で `assertUuid`）。bulk は「1 エンティティ = 1 行」、文脈は `afterValue.operation` 等のメタに格納。機微フィールドは `sanitizeForAudit` で `[REDACTED]`。`action`: CREATE/UPDATE/DELETE/SYNC_IMPORT/EXPORT/BULK_UPDATE/BULK_DUPLICATE。 |
| `auth_event_logs` | 認証イベント記録（ログイン成否・ログアウト・lock・パスワード変更・アカウント作成/無効化/再有効化）。 | [`auth-event.service.ts`](../../src/services/auth-event.service.ts) `recordAuthEvent` | `tenantId` は **NULL 許容**（pre-auth の email-not-found 失敗は NULL のまま記録）。`eventType`: login_success/login_failure/logout/lock/password_change/account_created/account_deactivated/account_reactivated。 |
| `system_error_logs` | 内部エラー・クライアントエラーの秘匿保存。stack/設定値は **Console にも UI にも出さず DB のみ**に保存し、ユーザには固定文言のみ返す（DESIGN §9.8.5）。診断ダッシュボードの一部検知ソースも兼ねる。 | [`error-log.service.ts`](../../src/services/error-log.service.ts) `recordError` / `logUnknownError`。経路: API route try/catch (`source:'server'`) / cron (`'cron'`) / mail (`'mail'`) / auth (`'auth'`) / client error boundary → POST `/api/client-errors` (`'client'`) | `severity`: info/warn/error/fatal。`tenantId` 未指定時は **`DEFAULT_TENANT_ID` へ明示 fallback**（ADR-0024 で唯一の正当な例外）。**自身の書込み失敗は silent fail**（再帰ログ防止）。 |
| `email_send_logs` | 全メール送信を 1 送信 1 行で記録（送信件数集計 + 送信前の日次上限ガード）。 | [`email-send-log.service.ts`](../../src/services/email-send-log.service.ts) `recordEmailSend`。`src/lib/mail/index.ts` の `getMailProvider` wrapper から自動呼出。 | **PII 非保存**: 本文・件名は保存せず、宛先は **SHA-256 hash + ドメイン部のみ**。`type`/`success`/`errorMessage`/`providerName`。書込み失敗は silent fail（本体送信を止めない）。 |
| `cron_execution_logs` | cron 実行履歴（開始/完了/所要時間/status/エラー/payload/呼出元 IP）。死活監視と失敗検知の両方の基盤。 | `src/lib/cron-execution-log.ts` `withCronExecutionLogging(name, ...)`（各 cron route が wrap）。集計表示は [`cron-history.service.ts`](../../src/services/cron-history.service.ts) `fetchCronHistoryView`。 | `status`: running/success/failure。`cronName` は [`src/config/cron-jobs.ts`](../../src/config/cron-jobs.ts) の key と一致必須（typo は UI で「未登録 cron」扱い）。`/api/health` は本テーブルに記録しない（cron-job.org 側 history で確認）。 |

> 補足: 権限変更は別テーブル `role_change_logs`（schema 上存在、本書の主対象外）。可視化 UI は `super_admin` の `/admin/super/cron-history`・`/admin/super/diagnostics`・`/admin/super/tenants/[id]/diagnostics`。

### §1.1 監査ログ画面 (`/admin/audit-logs`) — テナント管理者向け表示 (2026-06-03)

テナント管理者 (admin + super_admin) が `audit_logs` を閲覧する画面。`page.tsx` (Server Component) が `recordAuditLog` 済みのログを取得し、表示用に整形して client table へ渡す。

**列**: 日時 / 操作者 / 操作 / 対象 / 対象名。
- **操作 / 対象はロケール翻訳**して表示 (例: `UPDATE`→更新、`knowledge`→ナレッジ)。未定義キーは生値にフォールバック (`t.has` で存在確認)。
- **リスク / 課題の区別**: `risk_issue` 系は記録 JSON の `type` で「リスク」「課題」に振り分けて行表示。
- **対象名**: 記録 JSON の `name` / `title` 等から推定 (無ければ「—」)。
- **添付 (リンク/ファイル)**: 添付ログの `afterValue` に `parentEntityType` / `storageProvider` を記録し、**操作** = リンク追加/削除・ファイル添付/削除 (storageProvider: `url`=リンク / `supabase`=ファイル)、**対象** = 親エンティティ種別 (どの画面で行われたか) を表示。リンク/ファイルの内容自体 (url/displayName) は記録しない。2026-06-03 以前の添付ログは親種別未記録のため汎用「添付」表示。

**絞り込み / 件数 / ページング / 列幅** (すべて client 側): 操作・対象・操作者プルダウン + キーワード検索 / 並び替え (`multiSort`) / 列幅ドラッグ + 「列幅をリセット」(`ResizableTableShell`、表の右上・全画面統一位置) / 表示件数 `100·300·1000·全件` (`?limit=` でサーバ再取得、既定 300) / 100 行/ページのページネーション (`useTablePagination`、§38.8 UI_PATTERNS)。

**記録スコープ** (この画面に出る / 出ない):
- **出る**: 業務データ (project / task / risk / issue / knowledge / retrospective / stakeholder / estimate / customer / comment / memo / member / user / attachment) の CREATE/UPDATE/DELETE、リンク/ファイルの添付・削除、CSV 一括取込 (`*_sync_import`)、一括公開範囲変更。
- **出ない**: ① 閲覧・検索・エクスポート (read 系は非記録) ② 認証イベント (login/MFA/password → `auth_event_logs`、§1。最終ログインはユーザ管理「前回ログイン」) ③ ロール変更の詳細 (`role_change_logs` / 権限変更履歴画面) ④ **テナント設定・課金・解約の変更 (現状 `audit_logs` 未記録、将来対応候補)**。

> 設計判断 (2026-06-03): 監査ログの対象は当面「業務データのみ」で確定。④ の追加は将来 PR 候補。

### §1.2 権限変更履歴画面 (`/admin/role-changes`) — テナント管理者向け表示 (2026-06-03)

`role_change_logs` (ロール/権限変更の専用ログ) をテナント管理者 (admin + super_admin) が閲覧する画面。`page.tsx` (Server Component) が取得し、種別・ロール・状態値をロケール/ラベル表示に変換して client table へ渡す。**監査ログ画面 (§1.1) と UI を統一** (画面見出し無し / 絞り込み / 並び替え / 列幅調整 + リセット / 表示件数 100·300·1000·全件 / 100 行ページネーション)。

**列**: 日時 / 変更者 / 対象ユーザ / 種別 / 変更前 / 変更後 / 理由。
- **種別**: `system_role`→システムロール、`project_role`→プロジェクトロール (i18n `changeTypeLabels`)。
- **変更前/変更後**: ロール値は `SYSTEM_ROLES` / `PROJECT_ROLES` のラベル (テナント管理者 / 一般ユーザ / PM/TL / メンバー 等)、状態値は i18n `roleStateLabels` で `active`→有効 / `inactive`→無効 / `deleted`→削除 / `removed`→解除。初回付与 (before=null) は「-」。
- **絞り込み**: 変更者 / 対象ユーザ / 種別 プルダウン + キーワード検索。

**記録スコープ** (`role_change_logs`、DATA_MODEL §8.26 参照): システムロール変更 / ユーザ新規登録 (初期ロール) / **アカウント有効化・無効化** / ユーザ削除 / プロジェクトメンバーの追加・ロール変更・解除。CSV エクスポートは **未実装** (旧ドキュメントの記載は誤り、2026-06-03 是正)。

---

## §2 監視・検知（何を / どの閾値で気付くか）

検知ロジックは個別 service に分散し、`diagnostics.service.ts` `getDiagnosticsSummary` が **9 カテゴリに集約**して `/admin/super/diagnostics` に表示する。`totalAnomalies` を 1 整数化して top page の赤バナーに使う。

### 2.1 cron 死活監視（2 段構え）

`cron_execution_logs` を 2 つの異なる観点で監視する。片方だけでは silent fail する設計上の理由がある。

| 段 | service / 関数 | 何を見るか | 閾値 |
|---|---|---|---|
| **① failure 検知** | [`admin-alert.service.ts`](../../src/services/admin-alert.service.ts) `detectAndAlertCronFailures` | 直近 **24h** で `status='failure'` の実行を cron 別に集約 | 直近 24h に failure が 1 件以上 |
| **② 長期未実行（記録なし）検知** | [`cron-health.service.ts`](../../src/services/cron-health.service.ts) `checkAllCronHealth` / `checkCronHealth` / `listUnhealthyCrons` | 最後の **成功**実行からの経過時間 vs 期待ギャップ。`status`: healthy / `stale`（ギャップ超過）/ `never_recorded`（記録ゼロ = cron-job.org 未登録 or 初回前） | `expectedMaxGapHours`（`CRON_JOBS` 定義）: daily=**25h**、monthly=**840h** (35日×24)、attachment-embedding=**2h** |

**なぜ 2 段か**: ① は「行が作られたが失敗」しか検知できない。cron-job.org に未登録 / endpoint 誤りで**そもそも行が作られない**ケース（実例: `tenant-monthly-reset` 未登録）は ② でしか検知できない（cf. memory: cron watchdog pattern）。
別途、実行中のまま放置された行は `cron-history.service.ts` の `STALE_RUNNING_THRESHOLD_MS = 30_000`（Netlify Functions 上限 + 余裕）で「timeout 疑い (`staleRunning`)」として集計する。

### 2.2 課金 drift 検知（両軸 max + 画面 + audit + 修復の 4 点セット）

| 観点 | 実装 |
|---|---|
| **両軸 max** | [`api-usage-recalc.service.ts`](../../src/services/api-usage-recalc.service.ts) `reconcileTenantApiUsage`（LLM 系）/ `reconcileTenantEmbeddingUsage`（Embedding 系、ADR-0030）。**呼出回数 drift 比率と費用 drift 比率の `Math.max`** を取り、片軸でも閾値超なら `hasDrift=true`。plan で常に 0 になる軸（Beginner は cost=0）の silent fail を防ぐ。 |
| **閾値** | `DRIFT_WARNING_THRESHOLD = 0.05`（5%、[`src/config/api-usage-drift.ts`](../../src/config/api-usage-drift.ts)） |
| **画面表示** | `reconcileAllTenantsApiUsage` → `diagnostics.service.ts` 経由で `/admin/super/diagnostics` の「API 利用量 drift」セクション。個別は `/admin/super/tenants/[id]/diagnostics`。 |
| **audit** | counter / plan 書き換え（`repair-api-usage` / `recalculate-self` / `recalculate` / `monthly-reset`）は `audit_logs` に記録、[`tenant-diagnostics.service.ts`](../../src/services/tenant-diagnostics.service.ts) が抽出表示。 |
| **修復経路** | 自動上書きせず、super_admin が明示的に `repairTenantApiUsage`（修復ボタン）を呼ぶ read-only 検知設計。 |

> 真値原則: 表示・請求書・CSV・Stripe 全経路で `ApiCallLog` の SUM を真値とし、counter はホットパスの上限チェック専用（cf. memory: billing invariant）。drift 検知はこの 2 つの乖離を監視する仕組み。

### 2.3 利用量モニタ（spike / 予算アラート判定）

[`usage-monitoring.service.ts`](../../src/services/usage-monitoring.service.ts)（`daily-usage-aggregation` cron + `/api/admin/usage-summary`）。**メール通知は 2026-05-14 に廃止**（縮退モード下で別経路の出費を増やさない方針、ダッシュボードで随時参照可）。

| 検知 | 閾値 |
|---|---|
| spike 異常検知 `detectAnomalies` | 過去 7 日ローリング平均の **5 倍**以上（`ANOMALY_MULTIPLIER_THRESHOLD=5`、窓 `ROLLING_WINDOW_DAYS=7`）。平均 < `MIN_ROLLING_AVG_FOR_DETECTION=5` のテナントは対象外（新規テナント誤検知防止）。 |
| 予算アラート `detectBudgetAlerts` | 月次予算消化率 **80% / 100% / 150%**（`warning_80` / `critical_100` / `overage_150`）。LLM 軸 (`monthlyBudgetCapJpy`) と Embedding 軸 (`monthlyEmbeddingBudgetCapJpy`) を**独立 2 軸**で判定（ADR-0030）。 |
| ストレージ容量 warning level（DB / File） | テナントの月中 peak が **L1=1GB / L2=10GB / L3=50GB** に到達すると `tenants.db_capacity_warning_level` / `file_storage_warning_level` を更新し、Level 昇格時のみ `recordError` で super_admin に通知（`kind='db_capacity_warning'` / `'file_storage_warning'`）。**L1/L2/L3 はいずれも通知のみ — write/upload は止めない**（2026-05-31 ADR-0030「データはたすきばの命」で累積 50GB ハードキャップ撤廃。L3=50GB は Supabase Compute 増強検討の合図）。write を止めるのは Beginner 無料枠ガード（DB 50MB / Storage 100MB、ADR-0025）と 1 操作ペイロード上限（DB 5MB / ファイル 50MB/件）のみ。計測失敗は **fail-open**（write 継続 + `kind='storage_guard_measure_failed'` 記録、日次 cron が真値補正）。 |

### 2.4 診断ダッシュボードの 9 検知（集約）

`diagnostics.service.ts` `getDiagnosticsSummary` が以下を `Promise.all` で集約（`totalAnomalies` に合算）:

1. **API 利用量 drift**（§2.2、`reconcileAllTenantsApiUsage`）
2. **cron 健全性異常**（§2.1②、`checkAllCronHealth` の `isUnhealthy`）
3. **縮退モード突入テナント**（§4、`listDegradedTenants`）
4. **メール送信失敗 (24h)**（`getRecentFailedEmails(24, 50)`）
5. **alert 機構の空打ち (7d)**（`listAlertNoRecipientWarnings`、`system_error_logs` の `admin-alert` 記録）
6. **Stripe Usage Record 滞留 / DLQ**（`listStripeUsageQueueIssues`: delayed = `sentAt=null` かつ `nextSendAt < now-24h` / dlq = `sentAt=null` かつ `nextSendAt=null`）— **請求漏れ直結**
7. **プラン変更滞留**（`listStalledPlanChanges`: `scheduledPlanChangeAt < now` かつ `scheduledNextPlan != null`）— 過剰/過少請求リスク
8. **super_admin 数 ≤1 警告**（`checkSuperAdminCount`: 0 or 1 人で `isAtRisk`、alert 機構の単一障害点）
9. **請求書計算ミス**（[`billing-integrity.service.ts`](../../src/services/billing-integrity.service.ts) `detectBillingHistoryIntegrityIssues`、直近 **6 ヶ月**）— §2.5

### 2.5 BillingHistory 整合性（請求の最終防衛線）

`billing-integrity.service.ts` が直近 6 ヶ月の `BillingHistory` で 4 不変条件を検証（read-only、自動修復しない）。許容差は `AMOUNT_RECONCILE_TOLERANCE_JPY`。

- `total_mismatch`: `totalAmountJpy = amountJpy + taxAmountJpy` 違反
- `tax_mismatch`: `taxAmountJpy = calculateTaxJpy(amountJpy)` 違反
- `negative_amount` / `negative_total`: 負値
- 除外: `status` が `canceled` / `replaced_by_stripe`（意図的不一致を許容）

---

## §3 アラート（誰に / いつ通知するか）

すべて `super_admin` 宛。送信は [`admin-alert.service.ts`](../../src/services/admin-alert.service.ts) `sendSuperAdminAlert` 経由（→ 自動的に `email_send_logs` に `type='admin_alert'` で記録）。

**通知先の決定**: `User.systemRole='super_admin'` AND `isActive=true` の**全員**に送信（1 人脱退しても冗長性確保）。0 人なら env `SUPER_ADMIN_INITIAL_EMAIL` にフォールバック。それも空なら **silent fail させず** `recordError(severity='error', kind='admin_alert_no_recipients')` で痕跡を残す（→ §2.4 検知 5）。

| アラート種別 | cron 名 / スケジュール | 発火条件 | 起動関数 |
|---|---|---|---|
| **cron 失敗 alert** | `cron-failure-alert` / **日次 12:00 JST** | 直近 24h に `status='failure'` が 1 件以上。**自身の前回成功 > 25h** なら「alert 機構サイレント停止」警告を最優先で付与（watchdog） | `detectAndAlertCronFailures` |
| **診断異常 push** | `diagnostics-daily-alert` / **日次 11:30 JST** | §2.4 の 9 検知合計 `totalAnomalies` が **1 件以上**（0 件なら送信しない＝ノイズ抑制）。ダッシュボード未閲覧期間の無音対策 | `detectAndAlertDiagnosticsAnomalies` |
| **入金期日超過 alert** | `billing-overdue-alert` / **日次 07:00 JST** | `BillingHistory.status='pending'` かつ `paymentMethod ∈ {invoice, bank_transfer}` かつ 支払期日 + 5 日超過。**24h 以内の重複送信は `overdueAlertSentAt` で dedup** | `detectAndAlertOverdueInvoices` |

> 送信メールは自動送信 (`noreply@tasukiba.com`)・返信不可フッタ付き。対応は管理画面（`/admin/super/diagnostics`・`/admin/super/cron-history`・`/admin/super/billing/[yearMonth]`）から実施する設計。
> cron-job.org の built-in 失敗通知（5xx 検知メール）も併用前提（アプリ内 alert 機構自体が停止した場合のバックストップ）。
> §2.3 の利用量アラートは**メール送信せずダッシュボード参照のみ**（2026-05-14 廃止）。

---

## §4 縮退モードの観測点（ADR-0008）

[ADR-0008](../adr/0008-graceful-degradation-mode.md): 上限到達時にハードカット 429 を出さず、**裏方の AI 処理（embedding 生成等）のみ停止、フロント業務処理は継続**する fail-safe 設計。観測は [`degraded-mode.service.ts`](../../src/services/degraded-mode.service.ts) `getDegradedModeState`。

| 観測点 | 判定（`reason`） |
|---|---|
| Beginner LLM | `currentMonthApiCallCount >= beginnerMonthlyCallLimit` → `beginner_limit_exceeded`（ADR-0019） |
| Expert/Pro LLM | `monthlyBudgetCapJpy` 設定時 `currentMonthApiCostJpy >= monthlyBudgetCapJpy` → `budget_exceeded` |
| Beginner Embedding | `currentMonthEmbeddingCallCount >= BEGINNER_EMBEDDING_MONTHLY_LIMIT (=100)` → `embedding_beginner_limit_exceeded`（ADR-0030） |
| Expert/Pro Embedding | `monthlyEmbeddingBudgetCapJpy` 設定時 `currentMonthEmbeddingCostJpy >= monthlyEmbeddingBudgetCapJpy` → `embedding_budget_exceeded` |

- **優先順位**: LLM 経路が active なら reason は LLM 側を優先。LLM 非 active のときのみ Embedding 経路を評価（`withMeteredLLM` Step 3/3.1/4/4.1 と整合）。`NULL` の budget cap は無制限（縮退しない）。
- **ユーザ向け可視化**: テナント設定画面のバナー（`degraded-mode-banner.tsx`）+ 設定タブの「縮退モード起動中」表示。
- **super_admin 向け可視化**: 診断ダッシュボードの「縮退モード突入テナント」セクション（§2.4 検知 3、`listDegradedTenants`）。
- **復帰**: 月初 `tenant-monthly-reset` で counter リセット → 欠損データは月初 embedding backfill バッチで補完。

---

## §5 運用 runbook へのリンクと役割分担

**設計（本書）と手順（operations）の役割分担**:

- **本書 (`docs/design/OBSERVABILITY.md`)** = *仕組みの設計*。「どのテーブルに何を記録し、どの service が何を / どの閾値で検知し、どのアラートが誰に飛ぶか」を答える。
- **`docs/operations/*`** = *人間の対応手順 (runbook)*。「アラートを受けた / 異常を見つけた後に何をどの順で実施するか」を答える。

| 状況 | 参照先（手順） |
|---|---|
| 重大障害の初動・切り分け・暫定回避 SOP | [operations/INCIDENT_RESPONSE.md](../operations/operate/INCIDENT_RESPONSE.md) |
| cron スケジュール一覧・cron-job.org 登録/復旧手順（§1 `cron_execution_logs` / §2.1 監視の運用面） | [operations/CRON.md](../operations/operate/CRON.md) |
| 月次請求業務・入金消込・督促・drift 修復の手順（§2.2 / §2.5 / §3 入金期日超過の運用面） | [operations/BILLING_MONTHLY_OPERATIONS.md](../operations/operate/BILLING_MONTHLY_OPERATIONS.md) |
| 入金遅延テナントへの対応 SOP | [operations/PAYMENT_DELINQUENCY_SOP.md](../operations/operate/PAYMENT_DELINQUENCY_SOP.md) |
| デプロイ・cron スケジュール仕様（JST 表記の根拠） | [operations/DEPLOYMENT.md](../operations/develop/DEPLOYMENT.md) §6.1 |

### 関連 ADR

- [ADR-0008](../adr/0008-graceful-degradation-mode.md): 縮退モード（§4）
- [ADR-0011](../adr/0011-soft-delete-and-audit-log.md): 論理削除 + 全変更操作の監査ログ完全記録（§1 `audit_logs`）
- [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md) / [ADR-0030](../adr/0030-embedding-monthly-budget-cap.md): 課金単位・予算上限（§2.3 / §4）
- [ADR-0024](../adr/0024-explicit-tenant-id-no-db-default.md): tenant_id DEFAULT 撤去（§1 `system_error_logs` の fallback が唯一の例外）
