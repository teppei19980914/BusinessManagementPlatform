# システム管理者ダッシュボード 運用説明 (super_admin)

本書は **運営者専用 (super_admin) の `/admin/super` 配下画面** を、運用者 (オペレーション担当) が日々どう使うかの説明書です。各画面の「何を見るか / どんな操作を行うか / どの API・service を呼ぶか / 注意点」を実装ベースで記載します。

> **画面仕様 (UI 要素・関連 service の一覧)** は [specification/SCREENS.md §0.6](../../specification/SCREENS.md) が正です。本書は重複を避け、SCREENS の各行に対応した **運用手順と操作の裏側** に焦点を当てます。

> **認可**: これらはすべて super_admin 専用です。親 `layout.tsx` の super_admin guard + 一部は middleware Basic Auth で多層防御されており、顧客テナントの admin/general からは到達できません。Default テナント (= 運営者自身) は請求対象外として各画面で別枠表示されます。

---

## 画面一覧 (全 12 画面)

| # | 画面 | ルート |
|---|---|---|
| 1 | 運営ダッシュボード | `/admin/super` |
| 2 | テナント一覧 | `/admin/super/tenants` |
| 3 | 新規テナント払い出し | `/admin/super/tenants/new` |
| 4 | テナント詳細 | `/admin/super/tenants/[id]` |
| 5 | テナント診断 | `/admin/super/tenants/[id]/diagnostics` |
| 6 | 使用量サマリ | `/admin/super/usage` |
| 7 | 請求ダッシュボード | `/admin/super/billing` |
| 8 | 月次請求詳細 | `/admin/super/billing/[yearMonth]` |
| 9 | 診断ダッシュボード | `/admin/super/diagnostics` |
| 10 | cron 実行履歴 | `/admin/super/cron-history` |
| 11 | メール送付失敗 | `/admin/super/email-failures` |
| 12 | Stripe DLQ | `/admin/super/stripe-dlq` |

---

## 各画面の運用説明

### 1. 運営ダッシュボード (`/admin/super`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 全テナント横断のサマリを 1 画面に集約。顧客テナント数 / アクティブユーザ / 当月 API 呼出 / 合計課金の KPI カードに加え、Voyage AI 無料枠 (200M tokens/月)・Anthropic 使用量・Beginner プラン状況・Netlify ビルド credits・DB 容量・メール送信・休眠テナント・ストレージ TOP10・DB/ファイルストレージ従量課金 alert を表示。Default テナント (運営者自身) は専用セクションで別表示。 |
| 運用者が行う操作 | (a) 「全テナント再集計」ボタン、各カードの「再集計」ボタン。(b) 異常検知時に表示される赤バナーから診断ダッシュボードへ遷移。(c) 休眠テナント / 容量逼迫の早期検知。 |
| 呼ぶ API / service | 再集計ボタン → `POST /api/admin/super/recalculate-all` (`updateAllStorageBytesUsed` + `reconcileAllTenantsApiUsage`)。個別再集計 → `POST /api/admin/super/tenants/[id]/recalculate`。表示データは server component で `super-admin` / `db-capacity` / `email-send-log` / `netlify-metrics` / `diagnostics` service を直接呼出。 |
| 注意点 | DB 容量・API 利用量は **画面遷移時に毎回再集計** される (cron キャッシュに依存しない = 誤請求予防)。Suspense ストリーミングのため first paint 後にデータが順次表示される (集計に通常 5〜15 秒)。DB/ファイルストレージ従量課金 alert カードは L1 (1GB) / L2 (10GB) / L3 (50GB) の**監視通知**の確認に使う (2026-05-31 / ADR-0030 で write は累積では止まらないため、対応は Supabase Compute 増強の検討が中心)。`circuit breaker` 復旧手順は**dormant** (下記まとめ表・注記参照)。 |

### 2. テナント一覧 (`/admin/super/tenants`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 顧客テナント一覧 (tenantSeq 昇順)。当月 API 呼出 / 費用は **ApiCallLog SUM (真値)** を表示。drift がある行には ⚠ バッジが出てテナント診断へリンク。Default テナントは別セクション。 |
| 運用者が行う操作 | 各テナント行から詳細へ遷移。「+ 新規テナント払い出し」ボタンで発行画面へ。drift バッジから診断画面へ。 |
| 呼ぶ API / service | 表示は `listAllTenants` + `getDefaultTenantOwnSummary` + `reconcileAllTenantsApiUsage` (`super-admin` / `api-usage-recalc` service)。操作系はリンク遷移のみ。 |
| 注意点 | 管理テナント (運営内部) と Default テナントは顧客一覧から除外される。表示金額は請求書根拠と同じ真値 (PR-V8.1 invariant)。 |

### 3. 新規テナント払い出し (`/admin/super/tenants/new`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 顧客企業のテナントを手動発行するフォーム。請求先情報 + 初期管理者メールアドレスを入力。 |
| 運用者が行う操作 | フォーム送信でテナント作成。作成後、初期管理者宛に検証メールが送信され、リンクからパスワード設定後にログイン可能になる。 |
| 呼ぶ API / service | `POST /api/admin/super/tenants` (`TenantCreateForm` から)。 |
| 注意点 | `STRIPE_ENABLED` フラグにより credit_card の支払い方法 option が動的に disable される (UI と Server 403 ガードの整合担保)。 |

### 4. テナント詳細 (`/admin/super/tenants/[id]`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 1 テナントのプラン / アクティブユーザ / 最終ログイン (+ 休眠日数) / 当月 API 呼出・費用 (ApiCallLog SUM) / 月次予算上限 (LLM・Embedding) / Beginner 月間呼出上限 / エンティティ数 / ストレージ使用量 / 請求先情報 / プラン変更予約。 |
| 運用者が行う操作 | (a) 「このテナントを再集計」。(b) **データ代行エクスポート** (顧客サポート / 監査用に全業務データを ZIP 取得)。(c) **read-only 強制移行 (停止 / 再開)**。(d) **テナント削除** (論理削除、取消不可)。 |
| 呼ぶ API / service | 再集計 → `POST /api/admin/super/tenants/[id]/recalculate`。エクスポート → `GET /api/admin/super/tenants/[id]/export`。停止/再開 → `TenantSuspendButton` が `POST .../suspend` (reason: payment_delinquent / tos_violation / other) と `POST .../resume`。削除 → `TenantDeleteButton` が `DELETE /api/admin/super/tenants/[id]`。表示は `getTenantDetail` (`super-admin` service) + 遷移時に `updateStorageBytesUsedForTenant` + `reconcileTenantApiUsage`。 |
| 注意点 | 管理テナント (MANAGEMENT_TENANT_ID) では停止・削除・エクスポートのセクションは表示されない (自爆防止)。suspend/resume は配下全 user の tokenVersion を increment し既存セッションを即時失効させる。停止中も閲覧・エクスポート・プラン変更・セルフ解約は可能。停止/削除の運用手順は [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) を参照。 |

### 5. テナント診断 (`/admin/super/tenants/[id]/diagnostics`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 特定テナントで何が起きているかを時系列で可視化。(1) 基本情報 (counter / lastResetAt / TZ)、(2) counter vs ApiCallLog SUM 整合性、(3) 直近 30 日の日別 API 呼出、(4) counter 書き換え系 audit_log、(5) 月次履歴。 |
| 運用者が行う操作 | drift 検出時に **「修復する」ボタン** で counter を真値で上書き。audit_log で「誰が・いつ・どう counter を書き換えたか」を追跡。 |
| 呼ぶ API / service | 修復 → `POST /api/admin/super/tenants/[id]/repair-api-usage` (`repairTenantApiUsage`、内部で audit_log を 1 transaction 記録)。表示は `getTenantDiagnostics` (`tenant-diagnostics` service)。 |
| 注意点 | 修復は **破壊的操作** (counter を ApiCallLog SUM で上書き)。counter 書き換え audit が空なのに drift がある場合は、手動 SQL や未追跡経路で書き換えられた可能性を疑う。 |

### 6. 使用量サマリ (`/admin/super/usage`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 全テナント横断の使用量カード (テナント数 / ユーザ / API 呼出 / 合計課金 / Embedding 内訳) + プラン別分布 + 過去 6 ヶ月の使用量履歴テーブル。 |
| 運用者が行う操作 | **請求業務用 CSV ダウンロード**。当月分 (現在値) と過去月 (履歴) を選べる。「解約済テナント込み」CSV (月途中解約の請求漏れ検知用、解約日列付き) も別枠で取得可能。 |
| 呼ぶ API / service | CSV → `GET /api/admin/super/usage/export` (`?yearMonth=` / `?includeDeleted=true` クエリ対応)。表示は `getCrossTenantUsageSummary` + `listMonthlyUsageHistory` (`super-admin` service)。 |
| 注意点 | CSV は Excel 用に UTF-8 BOM 付き。過去月履歴は月初リセット cron (毎月 1 日 00:00 UTC) 以降に蓄積される。月途中解約は `deleteTenant()` のスナップショットで即時履歴記録される。請求業務の詳細は [BILLING_MONTHLY_OPERATIONS.md](./BILLING_MONTHLY_OPERATIONS.md)。 |

### 7. 請求ダッシュボード (`/admin/super/billing`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 当月の請求サマリ (請求総額 / 入金確認済 / 入金待ち / 引落失敗 / Stripe 一括置換済) + 支払方法別件数 + 過去 6 ヶ月の月次推移。 |
| 運用者が行う操作 | 当月 / 各月の詳細画面へ遷移。引落失敗件数が 0 でないかを日々確認。 |
| 呼ぶ API / service | `getBillingSummary` + `getRecentMonths` (`billing-dashboard` service) を server component で直接呼出。 |
| 注意点 | データソースは `BillingHistory` テーブル (Stripe Webhook 経由で自動更新)。引落失敗が出たら月次詳細 (§8) で個別対応する。 |

### 8. 月次請求詳細 (`/admin/super/billing/[yearMonth]`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 指定月のテナント別 `BillingHistory` 一覧。status / paymentMethod でフィルタ可能。credit_card 行には Stripe Dashboard へのディープリンク。失敗行には次回リトライ日 / リトライ枯渇 (past_due) を表示。 |
| 運用者が行う操作 | (a) 請求書/銀行振込 (invoice) かつ pending の行で **手動入金消込 (入金確認)**。(b) credit_card 行から Stripe Dashboard で詳細確認。(c) フィルタ結果を CSV エクスポート。 |
| 呼ぶ API / service | 入金確認 → `ConfirmPaymentButton` が `POST /api/admin/super/billing/[id]/confirm-payment`。CSV → `GET /api/admin/super/billing/export/[yearMonth]`。表示は `getMonthlyBillingDetail` (`billing-dashboard` service)。 |
| 注意点 | URL は `YYYY-MM` 形式のみ有効 (それ以外は 404)。手動消込は invoice / bank_transfer + pending の行にのみボタンが出る。クレジットカード分は Stripe 側で自動更新されるため手動消込ボタンは出ない。 |

### 9. 診断ダッシュボード (`/admin/super/diagnostics`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | システム全体の健全性を 1 画面に集約。(1) API 利用量 drift、(2) cron 健全性、(3) 縮退モード突入テナント、(3.5) BillingHistory 計算整合 (★請求最終防衛★)、(4) Stripe Usage Record 滞留/DLQ、(4.1) プラン変更予約の過去日付滞留、(4.2) super_admin 数 ≤ 1 警告、(5) メール送信失敗、(5) alert 機構の空打ち警告。異常があれば赤枠 + 件数バナー。 |
| 運用者が行う操作 | drift カードの **「修復する」ボタン** (`RepairDriftButton`)。各セクションから cron 履歴 / Stripe DLQ / テナント診断へ遷移。BillingHistory 計算違反やプラン変更滞留は記載の対応手順 (cron 再実行 / SQL 修正 + audit 記録) に従う。 |
| 呼ぶ API / service | 修復 → `POST /api/admin/super/tenants/[id]/repair-api-usage`。表示は `getDiagnosticsSummary` (`diagnostics` service)。 |
| 注意点 | 「想定外の事象が起きたとき最初に開く画面」。`force-dynamic` で毎回最新を集計。BillingHistory 計算整合違反 (3.5) が発火したら請求計算ロジック自体のバグであり最優先で原因究明する。 |

### 10. cron 実行履歴 (`/admin/super/cron-history`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 直近 24h の成功/失敗/running/stale 件数サマリ + 全登録 cron の動作概要テーブル (`CRON_JOBS` から) + 直近 100 件の実行履歴 (status バッジ + duration + errorMessage)。 |
| 運用者が行う操作 | 失敗 cron の errorMessage を展開して原因確認。stale running (timeout 疑い) の検知。 |
| 呼ぶ API / service | `fetchCronHistoryView` (`cron-history` service) を server component で直接読み。 |
| 注意点 | status='running' のまま 30 秒以上経過した実行は Netlify Functions の 10 秒制限超過の疑い。該当 cron の chunk 化 / async 化を検討する。cron スケジュール全体と死活監視は [CRON.md](./CRON.md) / [design/CRON_JOBS.md](../../design/CRON_JOBS.md)。時刻は JST 固定表示。 |

### 11. メール送付失敗 (`/admin/super/email-failures`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | 直近 24h (デフォルト) で `success=false` な `EmailSendLog` 一覧 + type 別集計。請求書送付 / 招待 / パスワードリセット / 警告通知の到達失敗を検知。 |
| 運用者が行う操作 | `?hours=` (1〜168) `?limit=` (10〜500) で集計範囲を調整。type 別集計でプロバイダ全体障害か個別失敗かを切り分ける。 |
| 呼ぶ API / service | `getRecentFailedEmails` (`email-send-log` service)。 |
| 注意点 | PII 保護のため宛先は SHA-256 ハッシュ化済でドメイン部のみ表示。個別宛先確認は `email_send_logs` テーブルへの直接クエリ + tenant_id 突合で行う。invoice テナントへの請求書送付失敗を放置すると滞納に直結する。 |

### 12. Stripe DLQ (`/admin/super/stripe-dlq`)

| 観点 | 内容 |
|---|---|
| 何を見る画面か | Stripe Webhook の未処理/DLQ と Usage Record Queue の未送信/DLQ を一覧表示。retryCount / nextRetryAt / errorMessage 付き。 |
| 運用者が行う操作 | **「再投入」ボタン** で retryCount をリセットし、次回 cron / 次回 Stripe 再送時に再処理させる。Stripe 側の再送がもう来ない Webhook は Stripe Dashboard で manual replay する。 |
| 呼ぶ API / service | Webhook 再投入 → `POST /api/admin/super/stripe-dlq/webhook/[id]/retry`。Usage 再投入 → `POST /api/admin/super/stripe-dlq/usage/[id]/retry`。表示は `listWebhookDlq` + `listUsageQueueDlq` (`stripe-dlq` service)。 |
| 注意点 | Usage Record の DLQ 滞留は **請求漏れに直結** する (ApiCallLog が Stripe 請求書に反映されない)。恒久失敗 (Subscription Item ID 誤り等) は再投入では解決しないため Stripe Dashboard で直接記録追加が必要。Webhook イベントの扱いは [STRIPE_WEBHOOK_EVENTS.md](./STRIPE_WEBHOOK_EVENTS.md)。 |

---

## 主要運用操作 まとめ (どの画面のどのボタンで何を呼ぶか)

| 操作 | 画面 | UI 要素 | 呼ぶ API | 裏側の service |
|---|---|---|---|---|
| 全テナント再集計 | 運営ダッシュボード | 「全テナント再集計」ボタン | `POST /api/admin/super/recalculate-all` | `updateAllStorageBytesUsed` + `reconcileAllTenantsApiUsage` |
| 個別テナント再集計 | テナント詳細 / ダッシュボード各カード | 「このテナントを再集計」ボタン | `POST /api/admin/super/tenants/[id]/recalculate` | tenant-storage + api-usage-recalc |
| テナント suspend (停止) | テナント詳細 | TenantSuspendButton | `POST /api/admin/super/tenants/[id]/suspend` | `suspendTenant` (tokenVersion increment) |
| テナント resume (再開) | テナント詳細 | TenantSuspendButton | `POST /api/admin/super/tenants/[id]/resume` | resume (tokenVersion increment) |
| テナント削除 (論理) | テナント詳細 | TenantDeleteButton | `DELETE /api/admin/super/tenants/[id]` | deleteTenant (履歴スナップショット) |
| データ代行エクスポート | テナント詳細 | 「ZIP でダウンロード」リンク | `GET /api/admin/super/tenants/[id]/export` | — (監査ログ記録) |
| drift 修復 | 診断 / テナント診断 | 「修復する」ボタン | `POST /api/admin/super/tenants/[id]/repair-api-usage` | `repairTenantApiUsage` |
| 請求の手動入金消込 | 月次請求詳細 | ConfirmPaymentButton | `POST /api/admin/super/billing/[id]/confirm-payment` | billing-dashboard |
| 請求 CSV エクスポート | 月次請求詳細 | 「CSV エクスポート」リンク | `GET /api/admin/super/billing/export/[yearMonth]` | billing-dashboard |
| 使用量 CSV エクスポート | 使用量サマリ | 各 CSV ダウンロードリンク | `GET /api/admin/super/usage/export` | super-admin |
| Stripe DLQ 再投入 | Stripe DLQ | 「再投入」ボタン | `POST /api/admin/super/stripe-dlq/{webhook,usage}/[id]/retry` | stripe-dlq |
| storage-guard リセット (**dormant**) | (UI ボタン無し) | — | `POST /api/admin/super/tenants/[id]/storage-guard-reset` (現在は呼ばれない死蔵 route) | tenant.update + audit + recordError |

> **storage-guard リセットの注意 (dormant / 2026-05-31 ADR-0030)**: **circuit breaker は ADR-0030「データはたすきばの命」で撤去されました**。これに伴い本操作は**現在使用されません**。`POST /api/admin/super/tenants/[id]/storage-guard-reset` route は後方互換のため残置されていますが、circuit breaker が無くなったため復旧対象が存在せず、**別 PR で撤去予定** です。計測失敗は現在 fail-open (write を止めず記録のみ、日次 cron `updateAllStorageBytesUsed` が真値を補正) のため、リセット操作自体が不要になりました。
>
> **(旧仕様 〜2026-05-30)**: 旧来はこの操作が「DB 容量従量課金 alert カードに『circuit breaker open 中。原因調査後 storage-guard-reset で復旧』という案内テキスト」を介して呼ばれ、circuit が open でないテナントへの実行は 409、管理テナントは 403 を返していました。

> **regenerate-monthly-history**: `POST /api/admin/super/tenants/[id]/regenerate-monthly-history` も実装されていますが、現状 super_admin 画面の UI からは呼ばれない API 単独の保守用エンドポイントです (月次履歴スナップショットの再生成)。

---

## 関連文書

| 内容 | 参照先 |
|---|---|
| 画面仕様・UI 要素・関連 service 一覧 | [specification/SCREENS.md §0.6](../../specification/SCREENS.md) |
| 支払い滞納時の停止/削除 SOP | [PAYMENT_DELINQUENCY_SOP.md](./PAYMENT_DELINQUENCY_SOP.md) |
| 月次請求業務 (CSV / 解約検知) | [BILLING_MONTHLY_OPERATIONS.md](./BILLING_MONTHLY_OPERATIONS.md) |
| Stripe Webhook イベント対応 | [STRIPE_WEBHOOK_EVENTS.md](./STRIPE_WEBHOOK_EVENTS.md) |
| cron スケジュール・死活監視 | [CRON.md](./CRON.md) / [design/CRON_JOBS.md](../../design/CRON_JOBS.md) |
| 障害対応・初動 | [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) |
| 課金 money-flow (連結) | [design/KEY_FLOWS.md](../../design/KEY_FLOWS.md) |
| データモデル | [design/DATA_MODEL.md](../../design/DATA_MODEL.md) |
