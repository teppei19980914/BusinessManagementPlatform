# ADR-0020: DB 容量従量課金 — 月中 peak ベース階段関数型料金 (2026-05-25)

- **Status**: Accepted (2026-05-25)
- **Date**: 2026-05-25
- **Deciders**: teppei
- **Supersedes**: 旧 4 段階 Storage アドオン仕様 ([src/config/storage-addon.ts](../../src/config/storage-addon.ts) PR-3 / 2026-05-15)

---

## Context

### 旧仕様 (PR-3 / 2026-05-15)
PostgreSQL のテナント単位 row size 合計 (`pg_column_size` 16 テーブル横断) を「Storage」と呼び、4 段階月額固定プランで提供:

| プラン | 上限 | 月額 |
|---|---|---|
| Standard | 20MB | ¥0 |
| Plus | 220MB (20+200) | ¥500 |
| Pro Storage | 1.02GB (20+1000) | ¥1,500 |
| Enterprise | 5.02GB (20+5000) | ¥5,000 |

超過 7 日 Grace 後に write 拒否。

### 問題点
1. **ユーザ負担過大**: 21MB 使うだけで Plus ¥500/月発生、実コスト ¥18.75/GB-月 と乖離大
2. **段階の不連続性**: 200MB と 220MB で同じ料金、221MB で 1.02GB プラン強制
3. **採用ハードル**: 「使う前にプラン選ぶ」UX がブロッカー、ADR-0019 の「採用ハードル軽減」戦略に逆行
4. **計測対象の網羅性不足**: SQL ハードコード 16 テーブルのみ計測、新規テーブル追加時の漏れリスク (40+ テーブル中)

### Supabase 原価エビデンス (一次ソース確認済)
- Pro プラン基本料: $25/月固定
- Database Disk: 8GB 含有、**$0.125/GB-月** ([supabase.com/pricing](https://supabase.com/pricing))
- 計測単位: GB-Hours (1GB × 1h = 1 GB-Hr、月換算 ≈ 730 GB-Hrs)
- ¥150/USD 換算で約 **¥18.75/GB-月**、¥160/USD 円安バッファで **¥20/GB-月**

### 関連 ADR / Memory
- [ADR-0019](./0019-billable-feature-units-and-free-tier-expansion.md): 課金対象 featureUnit の明示化原則。本 ADR は同原則に沿って DB 容量を再設計
- [feedback_billing_invariant.md](../../memory/): ApiCallLog SUM = 画面 = 請求 = Stripe Meter invariant
- [feedback_3layer_sync_filter.md](../../memory/): テナント関連フィルタ 3 レイヤ (現在値 / cron snapshot / 履歴クエリ) 同期修正
- [feedback_drift_detection_design.md](../../memory/): drift 検知 4 点セット
- [feedback_tenant_isolation.md](../../memory/): テナント越境防止
- [feedback_post_merge_branch_push.md](../../memory/): orphan commit 防止

---

## Decision

### 1. 課金パラメータ

| 項目 | 値 | 根拠 |
|---|---|---|
| **無料枠** | **50MB / tenant** | 旧 20MB から拡大、採用ハードル軽減 |
| **超過単価** | **¥50 / GB tier (階段関数型)** | Supabase 原価 ¥18.75 比 +167% マージン、為替 ¥200/USD まで原価割れせず、Neon $0.30 と業界水準同等 |
| **端数処理** | 1MB 切上 → 1GB tier 切上 | 透明性確保 |
| **単位** | **SI 単位** (1MB=10⁶ bytes, 1GB=10⁹ bytes = 1000MB) | LP 表記 + Supabase 料金体系と整合 |
| **計測時点** | **月中 peak** (= max bytes during month) | 月末削除→月初再投入の抜け道防止、Supabase GB-Hours と乖離最小 |

### 2. 階段関数型料金計算式

```ts
// 1MB 切上
billable_mb = ceil(max(0, peak_bytes - 50MB) / 1MB)
// 1GB (= 1000MB) tier で切上
gb_tier = ceil(billable_mb / 1000)
// tier × ¥50
cost_jpy = gb_tier × 50
```

| 使用量 | 課金対象 (-50MB) | GB tier | 請求 |
|---|---|---|---|
| 0-50MB | 0 | 0 | **¥0** |
| 51MB ~ 1,050MB | 1-1,000MB | 1 | **¥50** |
| 1,051MB ~ 2,050MB | 1,001-2,000MB | 2 | **¥100** |
| ... 線形 | | | |
| 50GB (= ハードキャップ) | 49,950MB | 50 | **¥2,500** |

実装: [src/config/db-capacity-pricing.ts](../../src/config/db-capacity-pricing.ts) `calculateOverageJpy()`

### 3. 4 層防御 (R3「他テナントへの影響は絶対不許容」原則の技術実装)

| Level | 閾値 | アクション | 想定月額 |
|---|---|---|---|
| **L1** | 1GB | テナント設定画面 banner 表示 (能動通知なし) | ¥50 |
| **L2** | 10GB | super_admin 通知 (recordError warn) + ダッシュボード | ¥500 |
| **L3** | 50GB | **write 拒否 (ハードキャップ)** (read/export 可) | ¥2,500 |
| **L4** | instance-wide: Compute 推奨容量の 80% | super_admin に Compute upgrade alert | — |

**L3 = 50GB の技術根拠**: Supabase Pro 標準 Compute = Micro (1GB RAM)。embedding index 含めて単一テナント 50GB は他テナントの cache hit ratio を確実に破壊する ([Neon noisy neighbor](https://neon.com/blog/noisy-neighbor-multitenant))。コスト抑制目的ではなく、**他テナント保護の技術的安全弁**。

L4 instance-wide 閾値 (env `DB_INSTANCE_ALERT_THRESHOLD_BYTES` で上書き可):
| Compute | RAM | 推奨 DB | Alert (80%) |
|---|---|---|---|
| Micro (現状) | 1GB | 5GB | 4GB |
| Small | 2GB | 10GB | 8GB |
| Medium | 4GB | 25GB | 20GB |
| Large | 8GB | 100GB | 80GB |

### 4. 横断対応 (ADR-0019 課金 invariant 維持)

#### 4.1 ApiCallLog 真値経路
DB 容量請求も `ApiCallLog` を真値とする。`featureUnit='db-capacity-overage'` で識別:
- 月初 cron が前月 peak から `calculateOverageJpy()` で `costJpy` 計算 → ApiCallLog 1 件 INSERT
- 同時に `Tenant.currentMonthCostJpy` increment + `StripeUsageRecordQueue` enqueue
- 単一 transaction で確定 (= 真値経路の不整合を物理的に不可能化)

#### 4.2 Stripe Meter 設計 (案 A: 円単位 quantity)
**Stripe Meter Event 名**: `tasukiba_db_capacity_overage_jpy`

| 項目 | 値 |
|---|---|
| quantity | **`ApiCallLog.costJpy` 整数 (= 円単位そのまま)** |
| Price | **¥1 / unit** |
| 集約 | sum |

理由: GB 単位だと小数発生 (`54 / 1024 = 0.0527 GB`) → Stripe 側丸めと JS 側 ceil の不一致リスク。円単位整数なら **完全一致保証**。

#### 4.3 退会時の請求漏れ防止 (R5 横断対応)
旧仕様の月初 cron は `deletedAt IS NULL` フィルタで退会済テナント除外 → 月途中退会で当月分の課金が永久喪失。
本 ADR で **DB 容量 + API 利用量を共通サービスで「退会時即時請求集計」する**:
- 退会 API で `processTenantWithdrawalBilling(tenantId)` を呼出
- ① 当月 DB 容量 peak → ApiCallLog INSERT + Stripe Queue enqueue
- ② 当月 API 利用量 → 月初 cron と同じロジックで集計
- ③ その後 `deletedAt` をセット

実装: 新規 `src/services/tenant-withdrawal-billing.service.ts` を退会 API ([src/services/tenant.service.ts](../../src/services/tenant.service.ts)) から呼出。

### 5. 計測の網羅性保証 (R1 動的解決 + CI ガード)

旧仕様の `tenant-storage.service.ts:calculateTenantStorageBytes` は SQL に 16 テーブル名をハードコード。新規 model 追加時に SQL に追加し忘れる構造的欠陥あり。

新方式:
- **動的解決**: `information_schema.columns` を query して `column_name='tenant_id'` のテーブルを全列挙、UNION ALL で `pg_column_size` 集計
- **CI ガード**: `scripts/verify-tenant-storage-coverage.ts` が schema.prisma の `@@map` 一覧と DB の tenant_id 持ちテーブルを照合、差異なら CI fail

### 6. fail-close + Circuit Breaker (R3)

storage-guard の `pg_column_size` 計測が DB connection error 等で失敗した場合:
- **fail-open は禁止** (= 攻撃者が意図的に DB 高負荷を作って制限解除を狙える)
- **fail-close**: 計測失敗時は 403 で write 拒否
- **circuit breaker**: 3 回連続失敗で `storage_guard_circuit_opened_at` set → super_admin に緊急 alert
- 成功時に counter リセット

### 7. 並列性制御 (R8/R9)
- **月初 cron 排他**: PostgreSQL Advisory Lock (`pg_advisory_xact_lock(hashtext('tenant_billing_' || tenantId))`)
- **並列 write race 防止**: `SELECT ... FOR UPDATE` で tenant 行ロック → 同テナント並列 write が `assertStorageLimitInTx` で直列化

### 8. drift 検知 (R14)
- 全テナント peak SUM と `pg_database_size` の乖離率を月次計測
- 50% 乖離 → recordError warn / 100% 乖離 → recordError error + ダッシュボード alert
- env `DB_DRIFT_WARNING_RATIO` / `DB_DRIFT_CRITICAL_RATIO` で上書き可
- 目的: 計測対象漏れ / 運営直接 SQL / vacuum bloat の早期発見

### 9. UI / 通知設計 (R12)

| 通知種類 | チャネル | 冪等性 |
|---|---|---|
| 使用量 (L1/L2/L3) ユーザ向け | **テナント設定画面に表示のみ** (能動通知なし) | UI 表示は state-less |
| 使用量 super_admin 向け | recordError ログ + ダッシュボード banner | `dbCapacityWarningLevel` カラムで同月内重複発火を防止 |
| **単価変更 ユーザ向け** | **メール送信 + LP 掲示** (= 法務上の必須事項) | 単発イベント (年に数回以下) |

メール通知を使用量通知に使わない理由: メール枠制限 + spam リスク、テナント管理者は設定画面アクセス時に気づける。

### 11. インポート時の事前判定 (R20、2026-05-28 4 巡目フルスキャンで追記)

CSV / ZIP インポートで「取込後に L3 ハードキャップ超過 → 全件ロールバック」「Beginner で 50MB 無料枠を予測なく超過 → 想定外課金」の UX 破綻を防ぐため、**インポート系 API は preview / apply の両フェーズで事前判定する**:

#### 11.1 事前判定の対象経路

| 経路 | preview で表示 | apply で enforce |
|---|---|---|
| 経路 A: external-import wizard | ✅ Step 3 で警告/ブロック表示 | ✅ apply route で 403 拒否 |
| 経路 B: sync-import (5 entity) | ✅ dialog preview で警告/ブロック表示 | ✅ route で 403 拒否 |
| 経路 C: ZIP import | ❌ (preview なし) | ✅ route で 403 拒否 (file.size × 3 で推定) |

#### 11.2 判定マトリクス (=「Beginner 50MB block」の本ADR追加仕様)

| 取込後予測使用量 | Beginner | Expert / Pro |
|---|---|---|
| < 50MB (= 無料枠内) | OK | OK |
| 50MB - 1GB | **取込ブロック** ⛔ | OK (¥0 ~ ¥50/月) |
| 1GB - 10GB (L1) | **取込ブロック** ⛔ | **L1 警告** ⚠ (取込可、¥50 ~ ¥500/月) |
| 10GB - 50GB (L2) | **取込ブロック** ⛔ | **L2 警告** ⚠ (取込可、¥500 ~ ¥2,500/月) |
| ≥ 50GB (L3) | **取込ブロック** ⛔ | **取込ブロック** ⛔ |

**設計判断**: Beginner プランは「90 日完全無料」訴求 (ADR-0019 / ADR-0022) との整合性のため、**50MB 無料枠を超える取込は事前にブロック** する。明示的にアップグレードしない限り課金が発生しないことを保証し、「無料試用と思って取り込んだら ¥50 請求された」事故を防ぐ。

#### 11.3 行サイズ見積もり

取込増分の概算は **エンティティ別の平均行サイズ** で行う ([src/services/import-storage-precheck.service.ts](../../src/services/import-storage-precheck.service.ts) `AVG_BYTES_PER_IMPORTED_ROW`):

| エンティティ | 平均バイト数 (DB 行 + embedding) | 根拠 |
|---|---|---|
| Knowledge | 7 KB | title + 3 textarea + tags 3 種 + 1024 dim embedding |
| RiskIssue | 6 KB | title + content + cause + responsePolicy + 1024 dim embedding |
| Retrospective | 8 KB | KPT 4 セクション + 1024 dim embedding |
| Memo | 5 KB | title + content + 1024 dim embedding (user-scoped) |
| Task (WBS) | 1 KB | name + 期間 + 工数 + 階層 metadata、embedding なし |

完璧な精度は不要 (post-check = `assertStorageLimitInTx` が真の防衛線)。`DB_DRIFT_WARNING_RATIO` (§8) と乖離が見えたら見直し。

#### 11.4 post-check の必須化 (severity-1 修正)

sync-import 5 経路 は本 PR (2026-05-28) 以前 **`assertStorageLimitInTx` が呼ばれておらず L3 50GB ハードキャップが完全バイパス** されていた (R3 「他テナント保護絶対不許容」原則違反)。本 PR で全 5 経路の route layer に apply 後の post-check を追加:

```ts
try {
  await prisma.$transaction(
    async (tx) => assertStorageLimitInTx(tx, user.tenantId),
    { timeout: 10_000 },
  );
} catch (e) {
  const mapped = mapStorageGuardErrorToResponse(e);
  if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
}
```

注: precheck で事前ブロックしているため到達確率は低いが、複数取込並列 / 他経路の同時書込み等のレースで超過する可能性に備えた最終境界。

### 10. 旧コード除去 (R19) — **2026-05-26 実施完了**

以下を撤去完了 (chore/storage-addon-backend-removal、migration `20260531_remove_storage_addon`):
- ✅ `src/config/storage-addon.ts` 全体 (ADDON_MONTHLY_JPY / ADDON_EXTRA_BYTES / Grace period 定数)
- ✅ `src/services/tenant-storage.service.ts` の `getStorageInfo` / `isStorageWriteBlocked` / `updateStorageAddonPlan` / `cancelScheduledStorageAddon` / `checkAndStartGracePeriod` / `applyScheduledStorageChanges` 全関数 + 関連型
- ✅ Tenant 列: `storage_addon_plan` / `storage_grace_period_started_at` / `scheduled_storage_addon_at` / `scheduled_next_storage_addon` (migration 適用済)
- ✅ TenantMonthlyUsageHistory 列: `storage_addon_plan` / `storage_addon_jpy`
- ✅ Stripe 関連: `stripe_subscription_item_storage_id` カラム + `syncStorageAddonToStripe` 関数 + `getStoragePriceId` 関数
- ✅ 環境変数: `STRIPE_PRICE_STORAGE_PLUS` / `STRIPE_PRICE_STORAGE_PRO` 不要に
- ✅ JWT claim: `tenantStorageGracePeriodStartedAt` (middleware の Grace 7 日経過判定撤去)
- ✅ UI: 設定画面のストレージプラン選択 UI / super admin 3 画面の plan 表示

---

## 12. Stripe Subscription Item 紐付け (2026-05-30 補完)

> **背景**: 本 ADR §4.2 で定義した Meter Event (`tasukiba_db_capacity_overage_jpy`) は `stripe-usage-flush` cron で送信されるが、**Subscription Item に紐付かない Meter Event は Stripe Invoice に反映されない** のが Stripe 仕様。初版実装では `createSubscriptionForTenant` に DB 容量超過 Item の追加処理が欠けていたため、**credit_card 払いテナントの請求書に DB 容量超過分が載らない** 状態だった (= invoice 払いの BillingHistory と Stripe Invoice の金額が乖離 = invariant 違反)。本セクションで Stripe-ready 化を完遂する。

### 12.1 設計 (Stripe-ready optional パターン、ADR-0022 Embedding と同設計)

- **新規 schema 列**: `Tenant.stripeSubscriptionItemDbCapacityId` (`stripe_subscription_item_db_capacity_id` VARCHAR(50) NULLABLE)
- **新規環境変数**: `STRIPE_PRICE_DB_CAPACITY_OVERAGE` (optional、Test / Live で別 Price ID)
- **`createSubscriptionForTenant` の挙動**:
  - env 未設定: 旧挙動互換、Subscription Item に追加されない (= Haiku + Sonnet の 2 本のみ。リリース時の挙動)
  - env 設定済: 新規 Subscription 作成時に Item として追加され、Stripe Meter Event の円整数 quantity が当該 Item に集約されて Stripe Invoice に反映
- **Webhook 同期**: `handleSubscriptionUpdated` が `extractSubscriptionItemIds` で抽出した Item ID を `stripeSubscriptionItemDbCapacityId` に保存 (= カード再登録などで Subscription が再作成されても DB と Stripe の Item ID が常に一致)

### 12.2 invariant 担保

| 表示・請求経路 | 金額計算ロジック |
|---|---|
| テナントダッシュボード | `Tenant.currentMonthApiCostJpy` (`processTenantDbCapacityOverage` で月初に increment) |
| システム管理者ダッシュボード | 同上の SUM |
| 請求書 (BillingHistory, invoice 払い) | `BILLABLE_FEATURE_UNITS` の `ApiCallLog.costJpy` SUM (= db-capacity-overage 含む) |
| Stripe Invoice (credit_card 払い) | Meter Event の円整数 quantity SUM × Price ¥1/unit = ApiCallLog.costJpy SUM |

→ **4 経路すべてが ApiCallLog の `db-capacity-overage` cost を真値として一致** (= 完全 invariant 一致)

### 12.3 マイグレーション

[prisma/migrations/20260530_db_storage_subscription_items/migration.sql](../../prisma/migrations/20260530_db_storage_subscription_items/migration.sql) で `stripe_subscription_item_db_capacity_id` を NULLABLE 追加。既存 credit_card テナント不在 (= 6/1 ローンチは credit OFF) のため後付け実行不要、新規 Subscription は新コードで作成される。

### 12.4 セットアップ手順

詳細は [docs/operations/STRIPE_SETUP.md §2.5](../operations/STRIPE_SETUP.md) (DB 容量従量課金 + Subscription Item 紐付け項) を参照。

---

## 単価変更ルール (R15)

将来の単価変更時のルール (SaaS 規約と同一):

> 料金の値上げまたは課金体系の変更:
> **効力発生日の 30 日以上前** から ユーザ規約 (Terms of Service) 該当ページに掲示し、
> かつ **登録メールアドレスへ通知** する。

- 値下げの場合は即時適用可
- ADR 改訂必須 (新 ADR-002X 起票)
- 過去使用分には旧単価適用 (= 遡及課金禁止)

---

## Consequences

### Positive
- **ユーザ負担最小化**: 典型 100MB ユーザは月 ¥50、500MB ユーザでも月 ¥50 (旧 Pro ¥1,500 → -97%)
- **採用ハードル削減**: 50MB 無料 + 段階拒否なし、「使った分だけ」明快なメッセージング
- **事業継続性確保**: 原価マージン +150-167%、為替 ¥200/USD まで耐性
- **計測網羅性**: 動的解決で全テナント所属テーブルを必ず集計、新規 model 追加時の漏れ防止
- **誤請求リスク最小化**: ApiCallLog 真値経路維持、Stripe Meter 円単位で丸めロスゼロ
- **退会漏れ修正**: DB 容量 + API 利用量を横断的に退会時即時請求

### Negative / Trade-off
- **月中 peak のため一時的スパイクで Supabase 実コスト以上を請求するケースあり** (例: 1 日だけ 5GB → ¥247 請求 vs 実コスト ¥3) — Supabase GB-Hours との不公平性
- **既存 4 段階プランの全削除**: 旧 Plus/Pro/Enterprise を契約していたテナント (= default-tenant のみ存在) への影響だが、launch 前のため移行影響なし
- **計測動的化のクエリコスト微増**: information_schema 参照が 1 query 増えるが per-tenant では無視可能

### Risk / 留意事項
- **R3 (他テナント保護) と R5 (退会時請求) 横断対応のため、本 ADR は ADR-0019 の monthly cron 構造も変更する**
- **launch 直後の drift 計測実データを 3 ヶ月で再評価**: 50% / 100% 閾値の妥当性
- **Compute upgrade 判断**: L4 alert が頻発するなら Small/Medium への upgrade を super_admin 判断
- **R13 救済プロセス**: ハードキャップ到達ユーザは「データを削除してください」エラーのみで launch、v1.x で個別契約フロー検討

---

## Alternatives Considered

### Alt-1: 月末 snapshot 1 点で課金 (peak 不採用)
- **不採用理由**: 月末削除→月初再投入の抜け道、Supabase GB-Hours との乖離大

### Alt-2: 日次 snapshot 平均 (GB-Hours 近似)
- **不採用理由**: 公平性は最高だが、実装複雑度 +、外部 cron (cron-job.org) の実行枠制約あり、抜け道防止が peak より弱い。launch 後 6 ヶ月の運用データを見て、不公平苦情が顕在化したら検討

### Alt-3: 4 段階プラン継続 + 超過分のみ従量
- **不採用理由**: 「使った分だけ」コンセプトに不整合、UI 複雑化

### Alt-4: ハードキャップなし (純粋従量)
- **不採用理由**: マルチテナント noisy neighbor リスク。ユーザご合意通り 50GB hard cap

### Alt-5: 別 model (`DbCapacityBilling`) を新設
- **不採用理由**: ApiCallLog 真値経路の一本化原則と矛盾。`featureUnit='db-capacity-overage'` で識別可能

### Alt-6: Stripe Meter 単位を GB (小数)
- **不採用理由**: Stripe 側 rounding と JS 側 ceil() の不一致リスク → billing invariant 破壊。円単位整数で完全一致保証 (案 A 採用)

---

## 未確定事項 (実運用データで再検証)

| 項目 | 暫定値 | 再評価時期 |
|---|---|---|
| Drift warning 閾値 | 50% | launch 後 3 ヶ月 |
| Drift critical 閾値 | 100% | launch 後 3 ヶ月 |
| Instance alert (Micro) | 4GB | launch 後 3 ヶ月 |
| 月中 peak vs 日次平均 (不公平苦情ある場合) | 月中 peak | launch 後 6 ヶ月 |
| R13 救済プロセス (ハードキャップ到達ユーザ) | エラーメッセージのみ | v1.x で個別契約フロー検討 |

---

## Related

- 旧仕様: [src/config/storage-addon.ts](../../src/config/storage-addon.ts) (本 ADR で削除予定)
- 詳細設計: [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) (本 ADR 反映時に改訂)
- Stripe 連動: [docs/business/STRIPE_BILLING.md](../business/STRIPE_BILLING.md) / [docs/design/STRIPE_TECHNICAL_DESIGN.md](../design/STRIPE_TECHNICAL_DESIGN.md) / [ADR-0006](./0006-stripe-metered-billing-integration.md)
- ADR-0019: [課金対象 featureUnit の明示化](./0019-billable-feature-units-and-free-tier-expansion.md) (= 本 ADR は同原則を DB 容量に適用)
- **ADR-0025**: [Beginner プラン write ブロック](./0025-beginner-write-guard.md) (= Beginner プランの DB 50MB 超過時の挙動を本 ADR §11 をベースに全 write 経路へ拡張、overage 課金は skip)
- 縮退モード: [ADR-0008](./0008-graceful-degradation-mode.md)
- Memory: [feedback_billing_invariant.md](../../memory/) / [feedback_3layer_sync_filter.md](../../memory/) / [feedback_drift_detection_design.md](../../memory/) / [feedback_tenant_isolation.md](../../memory/)
- 公式ソース: [Supabase Pricing](https://supabase.com/pricing) / [Supabase Disk Size docs](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size) / [PostgreSQL Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html)
