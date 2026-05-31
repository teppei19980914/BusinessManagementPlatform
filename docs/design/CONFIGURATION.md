# CONFIGURATION — チューナブル定数 単一リファレンス

> `src/config/**`（および密接に関連する `src/lib/**` の一部）で定義される **全チューナブル定数** を 1 箇所に集約した索引。
> 価格・上限・閾値を変更するとき、各所を探さずにここから影響範囲を把握するためのリファレンス。
>
> **真値はあくまでソースコード**。本ドキュメントは `file:line` で実値を引用するが、値が乖離した場合は **コードを正** とし、本ファイルを追従修正すること。

関連ドキュメント:
- 環境変数（env で上書き可能な定数の env 値そのもの）: [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)
- cron スケジュール詳細: [CRON_JOBS.md](./CRON_JOBS.md)
- 課金 invariant / 提案エンジン設計: [SUGGESTION_ENGINE.md](./SUGGESTION_ENGINE.md) / ADR `docs/adr/`

---

## 定数を変更するときの原則

1. **`@/config/*` に集約する理由 = Client Component への Prisma 混入回避**
   閾値・単価などのチューナブル定数は、`src/services/*`（Prisma を import するモジュール）ではなく `src/config/*` に置く。
   Client Component が service の value import をすると Prisma が client bundle に混入し **build が失敗する** ため、定数は Prisma 非依存の pure module（`@/config/*`）へ分離する。
   例: `CHAT_SEARCH_INPUT_MAX_CHARS` は `embedding.service.ts` の同値を Client から触れないため `@/config/suggestion` に独立定義（[suggestion.ts:307-314](../../src/config/suggestion.ts)）。

2. **価格定数を変更したら 4 軸で grep する**
   生値（`5`）/ 表示文字列（`'1,500'` などの `toLocaleString`）/ 自然文（"¥5/call"）/ アサーション（Playwright `toContainText`・unit の `expect().toBe()`）の 4 軸で横展開チェック。生値 grep だけでは表示文字列を取り逃す。

3. **課金分類 config の変更は課金エンジン・drift 検知と同一 PR にバンドルする**
   `BILLABLE_FEATURE_UNITS` 等の課金分類を `withMeteredLLM`（`src/lib/llm/metered.ts`）や drift 検知（`api-usage-recalc.service.ts`）と別 PR にすると、drift 誤発火・既存テスト破壊を起こす。

4. **請求 invariant を守る**
   表示・請求書・CSV・Stripe の全経路で `ApiCallLog` の SUM（真値）を使う。価格定数（`EMBEDDING_PRICE_JPY_BY_PLAN` 等）と Stripe Price 単価は必ず一致させる。

5. **env 上書き可能な定数は env 名を併記**（本ファイル）し、env 値そのものは [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) に一本化する（二重記載しない）。

6. **DB スキーマと整合する文字数上限は Prisma の VARCHAR 長を同時確認**（例: `TITLE_MAX_LENGTH=150` ↔ `knowledges.title VARCHAR(150)`）。

---

## 1. 課金単価

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `EMBEDDING_PRICE_JPY_BY_PLAN` | beginner:0 / expert:5 / pro:5 | Embedding 系 featureUnit の plan 別 ¥/call（税抜） | [embedding-pricing.ts:49](../../src/config/embedding-pricing.ts) | ApiCallLog.costJpy / Stripe Meter 単価（要一致）/ ADR-0022・ADR-0029 / 4 軸 grep 必須 |
| `DB_CAPACITY_PRICE_JPY_PER_GB_TIER` | 50 | DB 容量超過 1GB tier あたり ¥50（税抜、階段関数） | [db-capacity-pricing.ts:70](../../src/config/db-capacity-pricing.ts) | `calculateOverageJpy` / db-capacity-overage 課金 / ADR-0020 / LP 表記 |
| `FILE_STORAGE_PRICE_JPY_PER_GB_TIER` | 10 | ファイルストレージ超過 1GB tier あたり ¥10（税抜） | [file-storage-pricing.ts:68](../../src/config/file-storage-pricing.ts) | `calculateFileStorageOverageJpy` / storage-file-overage 課金 / ADR-0021 |
| `resolveCostForPlan()` （LLM 単価） | beginner:0 / expert:¥10 / pro:¥15 | LLM(Claude) call の plan 別単価。Expert/Pro は `tenant.pricePerCallHaiku/Sonnet`（DB 列、default ¥10/¥15） | [llm.ts:95](../../src/config/llm.ts) / 既定値は schema `pricePerCallHaiku/Sonnet` | LLM 課金全経路 / Beginner 50 件上限 / monthlyBudgetCap / ADR-0019・ADR-0002 |
| `TAX_RATE` | 0.10 | 消費税率 10%（軽減税率非対象 SaaS）。全単価は税抜、請求書生成時に加算 | [billing.ts:14](../../src/config/billing.ts) | invoice / bank_transfer 請求額 / Stripe Tax 整合 |
| `TAX_ROUNDING_MODE` | `'round'` | 消費税端数処理（四捨五入、Stripe Tax 整合） | [billing.ts:17](../../src/config/billing.ts) | 請求額の端数 |
| `INVOICE_PAYMENT_DUE_DAY` | 25 | 銀行振込 支払期日（翌月 25 日固定） | [billing.ts:28](../../src/config/billing.ts) | `calculateInvoiceDueDate` / 督促 cron / LP FAQ Q8 |
| `OVERDUE_ALERT_THRESHOLD_DAYS` | 5 | 期日超過 alert 閾値（期日 +5 日） | [billing.ts:54](../../src/config/billing.ts) | billing-overdue-alert cron |
| `EMAIL_FAILURE_ALERT_THRESHOLD` | 1 | メール送付失敗 alert 発火件数（直近 24h） | [billing.ts:67](../../src/config/billing.ts) | 請求メール監視 |
| `AMOUNT_RECONCILE_TOLERANCE_JPY` | 1 | Stripe↔DB 金額照合の許容差分（円） | [billing.ts:73](../../src/config/billing.ts) | stripe-reconcile cron alert |

LLM/Embedding モデル名（単価ではないが課金・品質に直結）:

| 定数名 | 値 | 意味 | source | 影響範囲 |
|---|---|---|---|---|
| `LLM_MODELS.HAIKU` | `claude-haiku-4-5` | Beginner/Expert 用 Claude モデル | [llm.ts:20](../../src/config/llm.ts) | LLM 呼出全体 / `resolveModelForPlan` |
| `LLM_MODELS.SONNET` | `claude-sonnet-4-6` | Pro 用 Claude モデル | [llm.ts:20](../../src/config/llm.ts) | LLM 呼出全体 |
| `LLM_MODELS.EMBEDDING` | `voyage-4-lite` | Voyage 埋め込みモデル（200M tokens 無料枠） | [llm.ts:20](../../src/config/llm.ts) | embedding 全生成 / 無料枠監視 |
| `EMBEDDING_DIMENSIONS` | 1024 | embedding ベクトル次元（`vector(1024)` と要同期） | [llm.ts:45](../../src/config/llm.ts) | Prisma `content_embedding vector(N)` / 変更時 migration + 全再生成 |

---

## 2. 無料枠・上限（プラン別 / 課金分類）

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `DB_CAPACITY_FREE_TIER_BYTES` | 50MB（50,000,000） | DB 容量 無料枠 / tenant | [db-capacity-pricing.ts:43](../../src/config/db-capacity-pricing.ts) | `calculateBillableBytes` / 全 DB 容量課金 / ADR-0020 |
| `BEGINNER_DB_FREE_TIER_BYTES` | =50MB | Beginner write block 閾値（DB）。意図明示の別名 | [db-capacity-pricing.ts:57](../../src/config/db-capacity-pricing.ts) | storage-guard / ADR-0025 |
| `FILE_STORAGE_FREE_TIER_BYTES` | 100MB（100,000,000） | ファイルストレージ 無料枠 / tenant | [file-storage-pricing.ts:50](../../src/config/file-storage-pricing.ts) | ファイル課金全体 / ADR-0021 |
| `BEGINNER_STORAGE_FREE_TIER_BYTES` | =100MB | Beginner write block 閾値（ファイル）。意図明示の別名 | [file-storage-pricing.ts:65](../../src/config/file-storage-pricing.ts) | storage-guard / ADR-0025 |
| `FILE_STORAGE_MAX_FILE_SIZE_BYTES` | 50MB（50,000,000） | 1 ファイルのアップロード上限 | [file-storage-pricing.ts:71](../../src/config/file-storage-pricing.ts) | アップロード API バリデーション |
| `BEGINNER_EMBEDDING_MONTHLY_LIMIT` | 100 | Beginner の Embedding 月次試用上限（件/月） | [embedding-pricing.ts:95](../../src/config/embedding-pricing.ts) | metered.ts Step3 / ADR-0030 / BEGINNER_PLAN.md |
| `tenant.beginnerMonthlyCallLimit`（DB列, default） | 50 | Beginner の LLM 月次無料 call 上限（件/月） | schema `prisma/schema.prisma:109` / 判定 [metered.ts:279](../../src/lib/llm/metered.ts) | LLM Beginner 上限 / ADR-0019 |
| `FAIR_USE_LIMIT.WARNING` | 8,000 | Beginner Embedding 月次 fair use 警告（super_admin 通知） | [fair-use-limit.service.ts:75](../../src/services/fair-use-limit.service.ts) | Voyage 枠保護 / ADR-0019・ADR-0022 |
| `FAIR_USE_LIMIT.HARD` | 10,000 | Beginner Embedding 月次 fair use 停止（縮退モード） | [fair-use-limit.service.ts:79](../../src/services/fair-use-limit.service.ts) | チャット検索/資産入力の月内停止 |
| `HELP_CHAT_MONTHLY_LIMIT_PER_TENANT` | 100 | たすきフクロウ AI ヘルプチャット tenant 月次上限（回） | [billing-feature-units.ts:318](../../src/config/billing-feature-units.ts) | help/chat route 429 + FAQ フォールバック / ADR-0027 |

課金分類 featureUnit（4 階層 + 学習無料）。配列内容を変えると課金経路・集計 filter に直結:

| 定数名 | 内容 | source | 影響範囲 |
|---|---|---|---|
| `LLM_BILLABLE_FEATURE_UNITS` | project-upsert / suggestion-explanation / auto-tag-extract | [billing-feature-units.ts:69](../../src/config/billing-feature-units.ts) | LLM 課金 + Beginner 50件上限 + budget cap |
| `EMBEDDING_BILLABLE_FEATURE_UNITS` | knowledge/risk-issue/retrospective/memo-embedding / chat-semantic-search / external-import-embedding / attachment-embedding（7種） | [billing-feature-units.ts:104](../../src/config/billing-feature-units.ts) | Embedding 課金 / fair use カウント / ADR-0022 |
| `STORAGE_OVERAGE_FEATURE_UNITS` | db-capacity-overage / storage-file-overage | [billing-feature-units.ts:127](../../src/config/billing-feature-units.ts) | 月初 cron 直 INSERT 課金 |
| `EMBEDDING_BACKFILL_FEATURE_UNITS` | *-embedding-backfill（5種、**明示的 free**） | [billing-feature-units.ts:149](../../src/config/billing-feature-units.ts) | cron 自動リカバリは ¥0 維持（不当請求防止）/ ADR-0022 |
| `BILLABLE_FEATURE_UNITS` | LLM + EMBEDDING + STORAGE_OVERAGE の union | [billing-feature-units.ts:171](../../src/config/billing-feature-units.ts) | billing-aggregation / api-usage-recalc の集計 filter |
| `LEARNING_FREE_FEATURE_UNITS` | help-chat / help-chat-embedding（全プラン無料、集計対象外） | [billing-feature-units.ts:294](../../src/config/billing-feature-units.ts) | ヘルプチャット / ADR-0027・ADR-0028 |

---

## 3. レート制限

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `LLM_RATE_LIMIT.PER_MINUTE` | 10 | LLM 呼出 1 ユーザ/分 上限。超過で縮退（`rate_limited`） | [llm.ts:58](../../src/config/llm.ts) | withMeteredLLM / 提案・なぜ?機能 |
| `LLM_RATE_LIMIT.PER_HOUR` | 60 | LLM 呼出 1 ユーザ/時 上限 | [llm.ts:58](../../src/config/llm.ts) | 同上 |
| 認証 RL `DEFAULT_WINDOW_MS` | 5分（300,000ms） | 公開認証 API の IP 別 window | [rate-limit.ts:47](../../src/lib/rate-limit.ts) | reset-password/setup-password/lock-status の 429 |
| 認証 RL `DEFAULT_MAX` | 10 | 同 window 内の IP 別最大件数 | [rate-limit.ts:48](../../src/lib/rate-limit.ts) | 同上（CWE-307 対策） |
| subject RL 既定 window | 1分（60,000ms） | per-tenant/user RL の既定 window | [rate-limit.ts:165](../../src/lib/rate-limit.ts) | applySubjectRateLimit |
| `PRESIGNED_URL_RATE_LIMIT_PER_MIN` | 10 | per-tenant Pre-signed URL 発行 上限/分 | [file-storage-pricing.ts:142](../../src/config/file-storage-pricing.ts) | ファイルDL URL 発行 / ADR-0021 |
| `DELETE_API_RATE_LIMIT_PER_MIN` | 100 | per-tenant delete API 上限/分 | [file-storage-pricing.ts:145](../../src/config/file-storage-pricing.ts) | ファイル削除 API |
| `InMemoryRateLimiter` maxSize | 10,000 | LLM RL の in-memory バケット上限（GC 閾値） | [rate-limiter.ts:68](../../src/lib/llm/rate-limiter.ts) | メモリ使用量（serverless instance-local） |

---

## 4. 認証・セキュリティ

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `BCRYPT_COST` | 12 | bcrypt コスト（OWASP 2026 推奨） | [security.ts:21](../../src/config/security.ts) | パスワードハッシュ全体（再ハッシュは再ログイン時に漸進） |
| `PASSWORD_HISTORY_COUNT` | 5 | パスワード履歴保持件数（再利用禁止） | [security.ts:24](../../src/config/security.ts) | パスワード変更バリデーション |
| `LOGIN_FAILURE_MAX` | 5 | ログイン失敗上限（超過で一時ロック） | [security.ts:29](../../src/config/security.ts) | アカウントロック / DESIGN §9.4.4 |
| `TEMPORARY_LOCK_DURATION_MS` | 30分（1,800,000ms） | 一時ロック継続時間 | [security.ts:32](../../src/config/security.ts) | ロック自動解除タイミング |
| `PERMANENT_LOCK_THRESHOLD` | 3 | 一時ロック N 回で永続ロック | [security.ts:41](../../src/config/security.ts) | 総当たり攻撃対策 |
| `INACTIVE_USER_LOCK_DAYS` | 30 | 非アクティブ自動ロック猶予（日） | [security.ts:59](../../src/config/security.ts) | lock-inactive-users cron（isActive=false） |
| `SESSION_JWT_MAX_AGE_SEC` | 32,400（9時間） | JWT 有効期限 = アイドル時間上限 | [security.ts:72](../../src/config/security.ts) | 強制ログアウト / NextAuth session.maxAge |
| `EMAIL_VERIFICATION_TOKEN_EXPIRY_HOURS` | 24 | メール検証トークン期限（時間） | [security.ts:77](../../src/config/security.ts) | 招待メール |
| `PASSWORD_RESET_TOKEN_EXPIRY_MINUTES` | 30 | パスワードリセットトークン期限（分） | [security.ts:80](../../src/config/security.ts) | リセットメール |
| `RECOVERY_CODE_COUNT` | 10 | リカバリコード発行個数 | [security.ts:83](../../src/config/security.ts) | アカウント作成時 MFA |
| `RECOVERY_CODE_CHARSET` | `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` | リカバリコード文字集合（紛らわしい文字除外） | [security.ts:89](../../src/config/security.ts) | コード生成 |
| `PASSWORD_MIN_LENGTH` | 10 | パスワード最小文字数 | [security.ts:94](../../src/config/security.ts) | パスワードバリデーション / DESIGN §9.4.2 |
| `PASSWORD_MAX_LENGTH` | 128 | パスワード最大文字数（bcrypt DoS 対策） | [security.ts:97](../../src/config/security.ts) | 同上 |
| `PASSWORD_REQUIRED_CHAR_TYPE_COUNT` | 3 | 必要文字種数（英大/英小/数字/記号のうち） | [security.ts:100](../../src/config/security.ts) | 同上 |
| `PASSWORD_MAX_CONSECUTIVE_SAME_CHARS` | 4 | 同一文字連続の上限 | [security.ts:103](../../src/config/security.ts) | 同上 |
| `DB_PING_TIMEOUT_MS` | 5,000 | /api/health の DB ping タイムアウト | [security.ts:108](../../src/config/security.ts) | ヘルスチェック degraded 判定 |

---

## 5. 提案エンジン

スコア重みは合計 1.0（タグ0.3 + テキスト0.2 + embedding0.5）。embedding NULL 時は DEGRADED に再配分。

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `SUGGESTION_TAG_WEIGHT` | 0.3 | タグ Jaccard 重み | [suggestion.ts:34](../../src/config/suggestion.ts) | スコアリング / SUGGESTION_ENGINE.md |
| `SUGGESTION_TEXT_WEIGHT` | 0.2 | pg_trgm 文字列類似度 重み | [suggestion.ts:37](../../src/config/suggestion.ts) | スコアリング |
| `SUGGESTION_EMBEDDING_WEIGHT` | 0.5 | embedding 意味類似度 重み（主軸） | [suggestion.ts:43](../../src/config/suggestion.ts) | スコアリング |
| `SUGGESTION_TAG_WEIGHT_DEGRADED` | 0.5 | 縮退時タグ重み | [suggestion.ts:58](../../src/config/suggestion.ts) | embedding NULL 候補のスコア |
| `SUGGESTION_TEXT_WEIGHT_DEGRADED` | 0.5 | 縮退時テキスト重み | [suggestion.ts:59](../../src/config/suggestion.ts) | 同上 |
| `SUGGESTION_EMBEDDING_WEIGHT_DEGRADED` | 0 | 縮退時 embedding 重み | [suggestion.ts:60](../../src/config/suggestion.ts) | 同上 |
| `SUGGESTION_SCORE_THRESHOLD` | 0.01 | 候補残存閾値（全網羅・高再現率設計） | [suggestion.ts:72](../../src/config/suggestion.ts) | 提案件数 / PR-X6 |
| `SUGGESTION_DEFAULT_LIMIT` | 50 | カテゴリ別最大件数 | [suggestion.ts:81](../../src/config/suggestion.ts) | 提案表示件数 |
| `SUGGESTION_TIER_STRONG_THRESHOLD` | 0.3 | strong tier しきい値（絶対閾値方式） | [suggestion.ts:88](../../src/config/suggestion.ts) | UI 段階表示 |
| `SUGGESTION_TIER_MEDIUM_THRESHOLD` | 0.1 | medium tier しきい値 | [suggestion.ts:96](../../src/config/suggestion.ts) | UI 段階表示 |
| `SUGGESTION_MINIMUM_GUARANTEED_COUNT` | 5 | 閾値未満時の Top N 最低保証件数 | [suggestion.ts:115](../../src/config/suggestion.ts) | `applyMinimumGuarantee` |
| `SUGGESTION_TIER_STRONG_INITIAL_VISIBLE` | 5 | strong tier 初期可視件数（UI レイヤ） | [suggestion.ts:131](../../src/config/suggestion.ts) | アコーディオン折りたたみ |
| `SUGGESTION_INLINE_MAX_RESULTS` | 5 | inline 軽量サジェスト返却件数（service レイヤ） | [suggestion.ts:149](../../src/config/suggestion.ts) | 起票ダイアログ |
| `SUGGESTION_TIER_PERCENTILE_STRONG_RATIO` | 0.3 | パーセンタイル分類 strong 比率 | [suggestion.ts:178](../../src/config/suggestion.ts) | `assignPercentileTiers` |
| `SUGGESTION_TIER_PERCENTILE_MEDIUM_RATIO` | 0.5 | パーセンタイル分類 medium 比率 | [suggestion.ts:184](../../src/config/suggestion.ts) | 同上 |
| `SUGGESTION_TIER_ABSOLUTE_FLOOR_FOR_STRONG` | 0.05 | strong 昇格の絶対下限（誤誘導防止） | [suggestion.ts:191](../../src/config/suggestion.ts) | 同上 |
| `SUGGESTION_TIER_PERCENTILE_FALLBACK_THRESHOLD` | 5 | パーセンタイル→絶対閾値 フォールバック件数 | [suggestion.ts:198](../../src/config/suggestion.ts) | 少件数時の tier 分類 |
| `CHAT_SEARCH_INPUT_MAX_CHARS` | 8,000 | チャット意味検索の入力上限文字数 | [suggestion.ts:314](../../src/config/suggestion.ts) | チャット検索バリデーション |
| `CHAT_SEARCH_INPUT_WARN_THRESHOLD` | 10 | チャット検索の短すぎ警告閾値 | [suggestion.ts:322](../../src/config/suggestion.ts) | UI 警告表示 |
| `DRIFT_WARNING_THRESHOLD` | 0.05 | counter vs ApiCallLog SUM の drift 警告比率（5%） | [api-usage-drift.ts:14](../../src/config/api-usage-drift.ts) | 請求 drift chip / api-usage-recalc |

緊急停止フラグ `SUGGESTION_ENGINE_DISABLED`（env、`true` で提案機能完全停止）: [suggestion.ts:299](../../src/config/suggestion.ts) → [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)

---

## 6. ストレージ・容量ガード（監視アラート + Beginner 無料枠ガード）

DB 容量 / ファイルストレージとも L1 通知 → L2 admin → L3 監視アラート の 3 段階。**2026-05-31 (ADR-0030「データはたすきばの命」)**: 累積 50GB ハードキャップ (全プラン write/upload 拒否) と circuit-breaker (計測失敗 fail-close) は撤去済。**L1/L2/L3 はいずれも super_admin への監視アラート閾値で、write/upload は止めない**。累積容量による write block は廃止し、noisy-neighbor は Supabase Compute 増強 (運用) で吸収する方針。write を止めるのは **Beginner 無料枠ガード** (DB 50MB / Storage 100MB、ADR-0025) と **1 操作あたりペイロード上限** (`DB_WRITE_PAYLOAD_MAX_BYTES` 5MB / ファイル 50MB/件) のみ。

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `DB_CAPACITY_L1_USER_WARNING_BYTES` | 1GB | DB L1 ユーザ通知 | [db-capacity-pricing.ts:77](../../src/config/db-capacity-pricing.ts) | テナント設定画面 / `classifyDbCapacityLevel` |
| `DB_CAPACITY_L2_ADMIN_ALERT_BYTES` | 10GB | DB L2 super_admin 通知 | [db-capacity-pricing.ts:80](../../src/config/db-capacity-pricing.ts) | recordError + ダッシュボード |
| `DB_WRITE_PAYLOAD_MAX_BYTES` | 5MB（5,000,000、UTF-8 バイト） | 1 操作あたり DB ペイロード上限（Netlify Functions 6MB の手前で clean error）。瞬間負荷ガード | [db-capacity-pricing.ts:98](../../src/config/db-capacity-pricing.ts) | `requireStorageQuotaForWrite` → 413 PAYLOAD_TOO_LARGE / ADR-0030 |
| `DB_CAPACITY_L3_HARD_CAP_BYTES` | 50GB | DB L3 **監視アラート閾値（write は止めない）**。2026-05-31 ADR-0030 で累積ハードキャップ撤廃。定数名の HARD_CAP は import 影響回避で残置 | [db-capacity-pricing.ts:123](../../src/config/db-capacity-pricing.ts) | `classifyDbCapacityLevel` → super_admin 監視アラート / ADR-0030 |
| `DB_INSTANCE_ALERT_THRESHOLDS_BY_COMPUTE` | micro:4 / small:8 / medium:20 / large:80 GB | L4 instance-wide alert（compute 別） | [db-capacity-pricing.ts:97](../../src/config/db-capacity-pricing.ts) | super_admin alert。env `DB_INSTANCE_ALERT_THRESHOLD_BYTES` / `SUPABASE_COMPUTE_SIZE` で上書き |
| `DB_DRIFT_WARNING_RATIO` | 0.5 | tenant SUM vs pg_database_size 乖離 warning | [db-capacity-pricing.ts:112](../../src/config/db-capacity-pricing.ts) | drift 検知 |
| `DB_DRIFT_CRITICAL_RATIO` | 1.0 | 同 critical（2 倍超） | [db-capacity-pricing.ts:115](../../src/config/db-capacity-pricing.ts) | drift 検知 |
| `STORAGE_GUARD_CIRCUIT_BREAKER_THRESHOLD` | 3 | **dormant**: ADR-0030 (2026-05-31) で circuit-breaker ロジックを撤去し計測失敗時は **fail-open** (write 継続) に変更。定数は import 影響回避で残置・未使用（別 PR で撤去予定） | [db-capacity-pricing.ts:159](../../src/config/db-capacity-pricing.ts) | 参照箇所なし（dormant） |
| `FILE_STORAGE_L1_USER_WARNING_BYTES` | 1GB | ファイル L1 通知 | [file-storage-pricing.ts:78](../../src/config/file-storage-pricing.ts) | `classifyFileStorageLevel` |
| `FILE_STORAGE_L2_ADMIN_ALERT_BYTES` | 10GB | ファイル L2 admin 通知 | [file-storage-pricing.ts:81](../../src/config/file-storage-pricing.ts) | 同上 |
| `FILE_STORAGE_L3_HARD_CAP_BYTES` | 50GB | ファイル L3 **監視アラート閾値（アップロードは止めない）**。2026-05-31 ADR-0030 で累積ハードキャップ撤廃。定数名の HARD_CAP は import 影響回避で残置 | [file-storage-pricing.ts:93](../../src/config/file-storage-pricing.ts) | `classifyFileStorageLevel` → super_admin 監視アラート / ADR-0030 |
| `FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES` | 5GB | 1 日増加量 anomaly alert | [file-storage-pricing.ts:91](../../src/config/file-storage-pricing.ts) | super_admin anomaly 通知 |
| `FILE_STORAGE_DRIFT_WARNING_RATIO` / `_CRITICAL_RATIO` | 0.5 / 1.0 | ファイルストレージ drift 閾値 | [file-storage-pricing.ts:97](../../src/config/file-storage-pricing.ts) | drift 検知 |
| `PRESIGNED_URL_TTL_SECONDS` | 60 | Pre-signed URL 有効期限（秒、漏洩被害最小化） | [file-storage-pricing.ts:139](../../src/config/file-storage-pricing.ts) | ファイルDL URL |
| `MAX_FILE_NAME_LENGTH` | 200 | ファイル名長さ上限（sanitize で slice） | [file-storage-pricing.ts:148](../../src/config/file-storage-pricing.ts) | `sanitizeFileName` |
| `MAX_CONCURRENT_EMBEDDING_PER_TENANT` | 5 | per-tenant 同時 embedding job 上限 | [file-storage-pricing.ts:155](../../src/config/file-storage-pricing.ts) | attachment-embedding throttle |
| `MAX_GLOBAL_EMBEDDING_CONCURRENT` | 50 | グローバル同時 embedding job 上限（Voyage RL 抵触防止） | [file-storage-pricing.ts:158](../../src/config/file-storage-pricing.ts) | 同上 |
| `EMBEDDING_MAX_RETRY` | 3 | embedding 生成リトライ回数（超過で failed） | [file-storage-pricing.ts:161](../../src/config/file-storage-pricing.ts) | attachment-embedding cron |
| `DANGEROUS_FILE_EXTENSIONS` | .exe/.sh/.js… 等の配列 | 危険拡張子 blacklist（アップロード拒否） | [file-storage-pricing.ts:109](../../src/config/file-storage-pricing.ts) | アップロード検証 / ADR-0021 §10.3 |
| `EMBEDDING_SUPPORTED_EXTENSIONS` | .pdf/.xlsx/.csv/.txt/.md/.json/.docx | embedding 対象拡張子 | [file-storage-pricing.ts:126](../../src/config/file-storage-pricing.ts) | embeddingStatus 判定 |
| `FILE_SCOPE_KEYWORDS` | ファイル/添付/PDF… 配列 | チャット検索の file scope 検出語 | [file-storage-pricing.ts:167](../../src/config/file-storage-pricing.ts) | チャット検索のスコープ絞り |

DB 容量モニタ（super_admin、`pg_database_size` ベース、Storage 課金とは別系）:

| 定数名 | 値 | 意味 | source | 影響範囲 |
|---|---|---|---|---|
| `DB_CAPACITY_DEFAULT_LIMIT_BYTES` | 500MB（Supabase Free） | DB 容量モニタ上限の既定値。env `DB_CAPACITY_LIMIT_BYTES` で上書き | [db-capacity.ts:40](../../src/config/db-capacity.ts) | super_admin 容量カード / [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) |
| `DB_CAPACITY_WARN_THRESHOLD` | 0.8 | 容量 warning（80%） | [db-capacity.ts:46](../../src/config/db-capacity.ts) | `classifyDbCapacityStatus` |
| `DB_CAPACITY_ALERT_THRESHOLD` | 0.9 | 容量 alert（90%） | [db-capacity.ts:53](../../src/config/db-capacity.ts) | 同上 |
| `DB_CAPACITY_TOP_TABLES_LIMIT` | 10 | テーブル別内訳の表示件数 | [db-capacity.ts:56](../../src/config/db-capacity.ts) | super_admin 画面 |

---

## 7. 工数（workload）

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `WORKLOAD_WARN_HOURS` | 7 | 日次工数 warning 閾値（超過で黄色） | [workload.ts:20](../../src/config/workload.ts) | WBS ACT 作成/編集 / `classifyWorkloadLevel` |
| `WORKLOAD_ALERT_HOURS` | 8 | 日次工数 alert 閾値（超過で赤色） | [workload.ts:23](../../src/config/workload.ts) | 同上 / オーバーアサイン防止 |

---

## 8. メール送信上限

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `EMAIL_DAILY_LIMIT_DEFAULT` | 300（Brevo 無料） | 日次メール送信上限の既定値。env `EMAIL_DAILY_LIMIT` で上書き | [email-limit.ts:20](../../src/config/email-limit.ts) | super_admin メール監視 / [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) |
| `getEmailMonthlyLimit()` | null（既定） | 月次上限。env `EMAIL_MONTHLY_LIMIT` 指定時のみ有効 | [email-limit.ts:47](../../src/config/email-limit.ts) | 同上（Resend/SES 等） |
| `EMAIL_WARN_THRESHOLD` | 0.8 | 警告（80%、黄色） | [email-limit.ts:59](../../src/config/email-limit.ts) | `classifyEmailLimitStatus` |
| `EMAIL_ALERT_THRESHOLD` | 0.9 | アラート（90%、赤色） | [email-limit.ts:62](../../src/config/email-limit.ts) | 同上 |

---

## 9. cron（概要のみ。詳細・スケジュール変更は [CRON_JOBS.md](./CRON_JOBS.md)）

`CRON_JOBS`（[cron-jobs.ts:55](../../src/config/cron-jobs.ts)）に各 cron の `description` / `schedule`(JST) / `endpoint` / `expectedMaxGapHours`(watchdog 閾値) を集約。key は `withCronExecutionLogging` の cron 名と一致必須。

| cron 名 | スケジュール（JST） | `expectedMaxGapHours` |
|---|---|---|
| lock-inactive-users | 日次 21:00 | 25 |
| daily-notifications | 日次 07:00 | 25 |
| daily-usage-aggregation | 日次 11:00 | 25 |
| tenant-monthly-reset | 月初 1 日 00:00 | 840（35日） |
| stripe-usage-flush | 日次 14:00 | 25 |
| stripe-auto-suspend | 日次 13:00 | 25 |
| stripe-reconcile | 月初 1 日 15:00 | 840 |
| billing-monthly-aggregation | 月初 2 日 00:00 | 840 |
| billing-overdue-alert | 日次 07:00 | 25 |
| cron-failure-alert | 日次 12:00 | 25 |
| diagnostics-daily-alert | 日次 11:30 | 25 |
| attachment-embedding | 10 分毎 | 2 |

watchdog 閾値の意味（daily=25h / monthly=840h）は cron-jobs.ts ヘッダ参照。スケジュールの真値は cron-job.org 設定で、`schedule` 文字列はその実態同期表示。

---

## 10. バリデーション（文字数 / 配列上限）

Zod スキーマ（`src/lib/validators/`）と JSX `maxLength` の両方が参照。DB の VARCHAR 長と整合させること。

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `NAME_MAX_LENGTH` | 100 | 名称（project/customer/user 名等） | [validation.ts:23](../../src/config/validation.ts) | 各種 name バリデーション / Project.name VARCHAR(100) |
| `TITLE_MAX_LENGTH` | 150 | タイトル（Memo/Knowledge/RiskIssue） | [validation.ts:27](../../src/config/validation.ts) | knowledges.title / memos.title VARCHAR(150) |
| `DISPLAY_NAME_MAX_LENGTH` | 200 | 表示名（添付名・見積項目名） | [validation.ts:30](../../src/config/validation.ts) | 添付/見積 |
| `NOTES_MAX_LENGTH` | 1,000 | 備考 | [validation.ts:35](../../src/config/validation.ts) | プロジェクト/見積備考 |
| `MEDIUM_TEXT_MAX_LENGTH` | 2,000 | 中程度テキスト（振り返り項目/背景/リスク内容） | [validation.ts:38](../../src/config/validation.ts) | 各種中文 |
| `LONG_TEXT_MAX_LENGTH` | 3,000 | やや長文（リスク本文/振り返り総括） | [validation.ts:41](../../src/config/validation.ts) | 各種長文 |
| `KNOWLEDGE_CONTENT_MAX_LENGTH` | 5,000 | Knowledge 内容 | [validation.ts:46](../../src/config/validation.ts) | Knowledge フォーム |
| `MEMO_CONTENT_MAX_LENGTH` | 10,000 | Memo 本文 | [validation.ts:49](../../src/config/validation.ts) | Memo フォーム（maxLength=10000） |
| `COMMENT_CONTENT_MAX_LENGTH` | 2,000 | コメント本文 | [validation.ts:56](../../src/config/validation.ts) | コメント |
| `URL_MAX_LENGTH` | 2,000 | 添付 URL（DB VARCHAR(2000)） | [validation.ts:61](../../src/config/validation.ts) | 添付 URL |
| `ATTACHMENT_SLOT_MAX_LENGTH` | 30 | 添付 slot 名 | [validation.ts:64](../../src/config/validation.ts) | 添付 |
| `ATTACHMENT_MIME_HINT_MAX_LENGTH` | 50 | 添付 mimeHint | [validation.ts:67](../../src/config/validation.ts) | 添付 |
| `TAGS_MAX_COUNT` | 50 | タグ配列上限（tech/process/businessDomain 共通） | [validation.ts:72](../../src/config/validation.ts) | タグ入力 |
| `CSV_MAX_BYTES` | 10MB（10×1024×1024） | CSV インポート ファイルサイズ上限 | [csv-import-helpers.ts:23](../../src/lib/csv-import-helpers.ts) | sync-import 413 |
| `CSV_MAX_ROWS` | 500 | CSV インポート 行数上限 | [csv-import-helpers.ts:32](../../src/lib/csv-import-helpers.ts) | `checkCsvRowCount` 413 |

---

## 11. その他（i18n / コミュニティ / persona）

| 定数名 | 値 | 意味 | source | 変更時の影響範囲 |
|---|---|---|---|---|
| `DEFAULT_TIMEZONE` | `Asia/Tokyo`（fallback） | システム既定 TZ。env `APP_DEFAULT_TIMEZONE` 上書き | [i18n.ts:42](../../src/config/i18n.ts) | 日時描画全体 / [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) |
| `DEFAULT_LOCALE` | `ja-JP`（fallback） | システム既定 locale。env `APP_DEFAULT_LOCALE` 上書き | [i18n.ts:47](../../src/config/i18n.ts) | i18n / 日時フォーマット |
| `SUPPORTED_LOCALES` | ja-JP / en-US | サポート対象 locale | [i18n.ts:79](../../src/config/i18n.ts) | 設定画面セレクト |
| `SELECTABLE_LOCALES` | ja-JP:true / en-US:true | UI で選択可能な locale フラグ | [i18n.ts:97](../../src/config/i18n.ts) | 設定画面 disabled / API 400 |
| `DEFAULT_DISCORD_INVITE_URL` | `https://discord.com/invite/EqY82YvxuG` | Discord 招待 URL 既定値。env `NEXT_PUBLIC_DISCORD_INVITE_URL` 上書き | [community.ts:26](../../src/config/community.ts) | ヘルプ/コミュニティ導線 |
| `PRODUCT_LP_URL` | HomePage product URL | プロダクト LP（固定） | [community.ts:57](../../src/config/community.ts) | CTA / 使い方ページ |
| `SETUP_GUIDE_URL` | HomePage setup-guide URL | 初回ログイン手順ガイド（固定） | [community.ts:72](../../src/config/community.ts) | login フッタ + smoke spec href |
| `CHAT_PERSONA` | name:たすきフクロウ / avatar | チャットアシスタント persona | [chat-persona.ts:29](../../src/config/chat-persona.ts) | chat-fab / chat-panel |

`getFeatureRequestUrl()`（env `NEXT_PUBLIC_FEATURE_REQUEST_URL`、未設定で一般 Discord フォールバック）: [community.ts:46](../../src/config/community.ts)。

---

## env で上書き可能な定数（一覧）

env 値そのものの説明は [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) を参照（本ファイルでは二重記載しない）。

| env 名 | 上書き対象定数 / 関数 | source |
|---|---|---|
| `DB_CAPACITY_LIMIT_BYTES` | `getDbCapacityLimitBytes()`（既定 500MB） | [db-capacity.ts:28](../../src/config/db-capacity.ts) |
| `DB_INSTANCE_ALERT_THRESHOLD_BYTES` / `SUPABASE_COMPUTE_SIZE` | `getInstanceAlertThresholdBytes()` | [db-capacity-pricing.ts:201](../../src/config/db-capacity-pricing.ts) |
| `EMAIL_DAILY_LIMIT` | `getEmailDailyLimit()`（既定 300） | [email-limit.ts:27](../../src/config/email-limit.ts) |
| `EMAIL_MONTHLY_LIMIT` | `getEmailMonthlyLimit()`（既定 null） | [email-limit.ts:47](../../src/config/email-limit.ts) |
| `APP_DEFAULT_TIMEZONE` | `DEFAULT_TIMEZONE` | [i18n.ts:42](../../src/config/i18n.ts) |
| `APP_DEFAULT_LOCALE` | `DEFAULT_LOCALE` | [i18n.ts:47](../../src/config/i18n.ts) |
| `NEXT_PUBLIC_DISCORD_INVITE_URL` | `getDiscordInviteUrl()` | [community.ts:35](../../src/config/community.ts) |
| `NEXT_PUBLIC_FEATURE_REQUEST_URL` | `getFeatureRequestUrl()` | [community.ts:46](../../src/config/community.ts) |
| `SUGGESTION_ENGINE_DISABLED` | `isSuggestionEngineDisabled()`（緊急停止） | [suggestion.ts:299](../../src/config/suggestion.ts) |
