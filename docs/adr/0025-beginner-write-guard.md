# ADR-0025: Beginner プランの DB / File Storage 無料枠超過時 write ブロック

- **Status**: Accepted (本 ADR の Beginner write guard は不変)
- **Date**: 2026-05-29
- **Deciders**: teppei_suyama (Tech Lead)

> **2026-05-31 注記 (ADR-0030)**: 本 ADR が前提としていた「累積 50GB ハードキャップ」は [ADR-0030](./0030-embedding-monthly-budget-cap.md) §6 で**撤廃**された (= Expert/Pro は青天井従量、L3 は監視アラート閾値化)。本 ADR の **Beginner 無料枠ガード (DB 50MB / Storage 100MB の write block) は不変で存続**し、ハードキャップ撤廃後は**唯一存続する容量起因の write block** となる。本文中で「50GB ハードキャップとは別ロジック」等と記している箇所は、現行では「ハードキャップは撤廃済、Beginner ガードのみ存続」と読み替えること。

---

## Context (背景)

ADR-0020 (DB 容量従量課金) と ADR-0021 (ファイルストレージ従量課金) では、Beginner プランの扱いを次のように整理していた:

- 無料枠: DB 50MB / File Storage 100MB (全プラン共通)
- 超過時: 1GB tier ごと ¥50 (DB) / ¥10 (File Storage) で **全プラン共通の従量課金**
- 50GB ハードキャップで write 拒否 (storage-guard 4 層防御の L3) ※ **このハードキャップは 2026-05-31 (ADR-0030) で撤廃済。L3 は監視アラート閾値化され、Expert/Pro の write は止めない。以下「ハードキャップ」記述は当時の文脈**

しかし、Beginner プランは ADR-0019 / ADR-0022 で「**90 日完全無料**」を訴求している。LP / [docs/public/about.md](../public/about.md) / セットアップガイド等で「Beginner プランは完全無料」と明示しており、ユーザは「課金が発生しない」前提で利用を開始する。

そのため現状仕様 (Beginner も超過したら従量課金) では、以下の UX 破綻が発生する:

- ユーザ「Beginner で 90 日無料試用しよう」
- → 利用継続中に DB 使用量が 50MB を超える (例: Knowledge 100 件超 + 添付画像数枚)
- → 月末に「無料試用のはずなのに ¥50 請求された」事故
- → 信頼関係毀損 + 解約離脱

ADR-0020 §11 (2026-05-28 追記) では既に「**インポート時**は Beginner 50MB 超過を事前ブロック」を実装している。これにより CSV / external-import / sync-import 経路では Beginner が無料枠を超える書き込みを行えない。

しかし、`POST /api/projects/[projectId]/knowledge` のような **単発の API 経路** や、attachment upload では Beginner 50MB / 100MB ブロックが未実装で、ユーザが単発操作で無料枠を超過した場合に従量課金が発生する経路が残っている。

加えて、月初 cron (`tenant-monthly-reset.service.ts`) と退会精算 (`tenant-withdrawal-billing.service.ts`) は、現状プランを区別せずに `db-capacity-overage` / `storage-file-overage` の ApiCallLog を INSERT するため、Beginner ユーザに請求が発生する経路が残存している。

### 関連
- ADR-0019 (free-tier expansion): Beginner プランの「90 日完全無料」訴求
- ADR-0020 §11 (import-precheck): 本 ADR が全 write 経路に拡張するテンプレート
- ADR-0021 (file storage billing): File Storage 課金の本体定義
- ADR-0022 (embedding billing): Beginner Embedding 無料維持と同設計判断 (ユーザ非起動の課金は不当請求)
- ADR-0024 (explicit tenant_id): tenant_id 暗黙挙動排除の同時期改修
- `src/services/import-storage-precheck.service.ts`: §11 の実装、本 ADR が参考とするパターン

## Decision (採用した決定)

Beginner プランのテナントは、**DB 使用量が 50MB / File Storage 使用量が 100MB を超えた状態では INSERT / UPDATE を一律拒否する**。DELETE のみ許可し、容量を減らせば再び write 可能になる。Beginner ユーザに対する従量課金は一切発生させない。

### 1. write ブロック判定

**判定対象**: Beginner プランのテナントが行う INSERT / UPDATE (新規作成 / 既存更新)

**判定条件**:
- DB 容量: `plan === 'beginner' && cached storageBytesUsed > 50MB` (= `BEGINNER_DB_FREE_TIER_BYTES`)
- File Storage: `plan === 'beginner' && cached storageFileBytesUsed + 新ファイルsize > 100MB` (= `BEGINNER_STORAGE_FREE_TIER_BYTES`)

**判定値**: cron で集計済の **キャッシュ値**を使用 (`tenant.storageBytesUsed` / `tenant.storageFileBytesUsed`)。最大 24h のズレ許容。

**DELETE は対象外**: storage-guard の既存実装が write 操作のみで呼ばれる構造のため、DELETE は自動的に許可される (= 容量を減らす方向の操作は妨げない)。

### 2. 統合場所

[src/services/storage-guard.service.ts](../../src/services/storage-guard.service.ts) の既存 4 関数に plan 判定を追加する:

| 関数 | 既存責務 (本 ADR 時点 / ※印は 2026-05-31 ADR-0030 で撤廃) | 追加判定 (= 現行も存続) |
|---|---|---|
| `precheckStorageLimit()` | ~~DB 50GB hard cap pre-check~~※ → 計測のみ | + Beginner 50MB 超過判定 |
| `assertStorageLimitInTx()` | ~~DB 50GB hard cap post-check~~※ → peak/level 計測 + fail-open | + Beginner 50MB 超過判定 |
| `precheckFileStorageLimit()` | ~~File Storage 50GB hard cap pre-check~~※ | + Beginner 100MB 超過判定 |
| `assertFileStorageLimitInTx()` | ~~File Storage 50GB hard cap post-check~~※ → peak/level 計測 | + Beginner 100MB 超過判定 |

> **2026-05-31 (ADR-0030)**: 上表「既存責務」の 50GB hard cap 判定は撤廃済。4 関数は現在 (a) 月中 peak / 監視アラート Level の計測更新 と (b) 本 ADR の Beginner 無料枠判定 のみを担う。Beginner 無料枠判定 (右列) は不変で存続する。

これら 4 関数は既に複数経路から呼ばれているが、**呼出元ごとにエラーマッパーを個別に Beginner 対応させる必要がある** (= 戻り値の `code` を見ずにハードコードメッセージを返すラッパーが既存にあるため)。本 PR では以下 3 経路にエラーマッパー対応を追加した:

| 経路 | エラーマッパー対応 | 備考 |
|---|---|---|
| sync-import 5 route (knowledge / risks / retrospectives / memos / tasks) | ✅ 直接 `mapBeginnerWriteGuardErrorToResponse` 呼出 | 既存の `mapStorageGuardErrorToResponse` の前段で処理 |
| attachment/finalize | ✅ `BeginnerWriteGuardExceededError` インスタンス判定で分岐 | post-check 経路 |
| attachment/upload (Pre-signed URL) | ✅ `code === 'BEGINNER_STORAGE_QUOTA_EXCEEDED'` 分岐 | pre-check 経路 |
| **`requireStorageQuotaForWrite` ラッパー経由 (32 単発 POST/PUT route)** | ✅ `code === 'BEGINNER_DB_QUOTA_EXCEEDED'` 分岐 | [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) で集約対応 |
| ZIP import (`/api/tenants/me/import`) | ✅ `data-import.service.ts` で `BeginnerWriteGuardExceededError` を catch | post-check 経路 |

### 3. エラー型 / エラーコード

新規エラー型 `BeginnerWriteGuardExceededError` を `storage-guard.service.ts` に追加:

```ts
export class BeginnerWriteGuardExceededError extends Error {
  constructor(
    public readonly code: 'BEGINNER_DB_QUOTA_EXCEEDED' | 'BEGINNER_STORAGE_QUOTA_EXCEEDED',
    public readonly usedBytes: bigint,
    public readonly limitBytes: number,
  ) {
    super(`Beginner プランの無料枠を超えました (used=${usedBytes}, limit=${limitBytes})`);
  }
}
```

HTTP マッピングは (当時の) 既存 `StorageLimitExceededError` パターンを踏襲: **HTTP 403 Forbidden** + structured error body。

> **2026-05-31 (ADR-0030)**: `StorageLimitExceededError` は累積ハードキャップ撤廃に伴い実装から撤去済。現行で 403 を返すのは本 ADR の `BeginnerWriteGuardExceededError` → `mapBeginnerWriteGuardErrorToResponse` のみ。HTTP 403 + structured body の方式自体は不変。

### 4. エラー UX 文言 (3 経路統一)

| 経路 | 文言 |
|---|---|
| トースト | 「Beginner プランの無料枠 (DB 50MB / Storage 100MB) を超えました。不要なデータを削除する、または Expert プランへアップグレードしてください」 |
| API エラーレスポンス | 同上 + `code: BEGINNER_DB_QUOTA_EXCEEDED` (or `STORAGE_`) + `upgradeUrl: '/settings/tenant'` |
| フォームエラー | 同上 + 「[アップグレード →]」ボタン (フォーム右側) |

i18n キー (`src/i18n/messages/{ja,en-US}.json`) に追加:
- `beginnerWriteGuard.dbQuotaExceeded`
- `beginnerWriteGuard.storageQuotaExceeded`
- `beginnerWriteGuard.upgradeLink`

### 5. DELETE 後の自動再集計 (debounce 30s)

**問題**: cron キャッシュ値ベースの判定では、ユーザが DELETE で容量を減らしても、次の cron (最大 24h 後) まで `tenant.storageBytesUsed` が古いままで write が許可されない UX 問題が発生する。

**解決**: Beginner プランのテナントで対象エンティティ (Knowledge / Project / RiskIssue / Retrospective / Memo / Attachment / その他 cascade 対象) の DELETE が成功した直後に、`recalculateTenantStorageUsageWithDebounce()` を呼び出してキャッシュを即時更新する。

**debounce**: `tenant.storageBytesUsedAt` が直近 30s 以内なら再集計を skip (連続 DELETE での負荷防止)。

**fail-safe**: 再集計失敗は DELETE のビジネストランザクションをロールバックさせない (`try/catch` + `recordError`)。

**Expert / Pro**: 自動再集計は不要 (= cron 任せで OK、課金は ApiCallLog SUM で正確)。Beginner だけが「キャッシュ古さで write ブロックが解除されない」UX 問題を抱える。

### 6. Overage 課金 skip (severity-1)

Beginner プランのテナントに対する `db-capacity-overage` / `storage-file-overage` 系の ApiCallLog INSERT を、以下 2 経路で skip する:

| 経路 | 修正箇所 | 動作 |
|---|---|---|
| 月初 cron | [src/services/tenant-monthly-reset.service.ts](../../src/services/tenant-monthly-reset.service.ts) | `tenant.plan === 'beginner'` なら overage 計算と ApiCallLog INSERT を skip、internal log + auditLog に `'skipped: beginner plan, ADR-0025'` を記録 |
| 退会精算 | [src/services/tenant-withdrawal-billing.service.ts](../../src/services/tenant-withdrawal-billing.service.ts) | 同上 |

これにより:
- Beginner ユーザに対する Stripe queue 投入が発生しない
- 請求 CSV / Stripe 請求書に Beginner の overage 行が現れない
- ApiCallLog の `db-capacity-overage` SUM が **billing-aggregation の Beginner 集計対象から構造的に除外**される (= feedback_billing_invariant 維持)

**設計判断**: ADR-0022 の Embedding backfill 同様、「ユーザが明示的にアップグレードしていない状態での課金は不当請求」原則に従う。Beginner は write ブロックで容量制御し、課金は一切発生させない。

### 7. キャッシュ値ベース vs リアルタイム計測

**採用**: キャッシュ値ベース (cron で日次集計、最大 24h ズレ許容)

**却下した代替案**:
- (b) write 直前に `pg_total_relation_size()` でリアルタイム計測 — ホットパスで重い query
- (c) ハイブリッド (キャッシュ 8 割超でリアルタイム再計測) — 複雑度に対し利得が小さい

**根拠**: Beginner プラン = 個人試用想定で 24h ズレ許容可。DELETE 後の自動再集計 (§5) で UX ギャップを埋める。

## Consequences (影響)

### Positive

- **「90 日完全無料」訴求が実装で保証される**: ADR-0019 / ADR-0022 と整合、Beginner プランで意図せぬ課金が構造的に発生不可能になる
- **既存 storage-guard 4 関数への統合で全 write 経路が自動カバー**: 個別 route の修正が不要で実装範囲が局所化
- **ADR-0020 §11 (import-precheck) との一貫性**: 「Beginner 無料枠超過は事前ブロック」を全経路で統一
- **billing-invariant 維持**: ApiCallLog 自体に Beginner overage 行が記録されないため、SUM = 表示 = 請求の 3 経路整合性が崩れない (feedback_billing_invariant)
- **アップグレード動線**: write ブロック時のエラー文言で Expert プランへ誘導 (= 収益化に直結)

### Negative

- **DELETE 後の write 即時再開には自動再集計が必須**: 実装漏れがあると 24h ロックの UX 事故 → Phase 3 で全 DELETE 経路に E2E カバレッジを要求
- **キャッシュ古さによる過剰ブロック**: ユーザが大量 DELETE 直後でも cron 未走時は古いキャッシュで判定 → 自動再集計 + 手動 RecalculateButton で緩和
- **storage-guard の責務拡張**: plan 別判定が混入することで関数の単一責務性が薄れる → ADR-0025 で明示的に意思決定として記録、テストカバレッジで保護
- **Beginner ユーザに対する売上機会逸失**: 超過 = 強制アップグレードまたは離脱の二択 → ただしこれは ADR-0019 の意思決定 (Beginner=試用、収益は Expert/Pro) に沿った設計

### Neutral

- DB スキーマ変更なし (既存 `plan` + `storageBytesUsed` + `storageBytesUsedAt` カラムを再利用)
- migration 不要
- Expert / Pro テナントの挙動は本 ADR では不変 (本 ADR 時点では 50GB hard cap のみで判定、従量課金は従来通り)。**※ 2026-05-31 (ADR-0030) で Expert/Pro 側の 50GB hard cap は撤廃 → 青天井従量 + 監視アラートに変更。本 ADR の Beginner ガードはそれと独立して不変**

## Implementation Plan (実装手順)

実装は以下の順序で行う (詳細は本 PR の todo に記載):

1. **設定**: `src/config/db-capacity-pricing.ts` / `file-storage-pricing.ts` に `BEGINNER_DB_FREE_TIER_BYTES` / `BEGINNER_STORAGE_FREE_TIER_BYTES` を追加 (既存 `DB_CAPACITY_FREE_TIER_BYTES` と同値だが名称分離で意図明示)
2. **エラー型**: `BeginnerWriteGuardExceededError` 型 + `mapBeginnerWriteGuardErrorToResponse()` を storage-guard.service.ts に追加
3. **ガード本体**: storage-guard.service.ts の 4 関数に Beginner 判定追加 (tenant.plan を select に追加して N+1 回避)
4. **課金 skip**: tenant-monthly-reset.service.ts / tenant-withdrawal-billing.service.ts で Beginner skip ロジック
5. **自動再集計**: tenant-storage.service.ts に `recalculateTenantStorageUsageWithDebounce()` 新規実装、各 DELETE 経路から呼出
6. **UI**: PLAN_OPTIONS 文言 / DbCapacitySection / FileStorageSection (Server Component) で plan 分岐
7. **エラー UX**: i18n キー追加、トースト / API / フォームの 3 経路統一
8. **テスト**: 単体 + 統合 + E2E (Golden Path: DELETE → 自動再集計 → INSERT 可能)
9. **ドキュメント**: ADR-0020/0021 への cross-ref、業務/設計/運用/公開ドキュメントすべて更新

## Rollback (ロールバック手順)

万一 Beginner 顧客から「DELETE しても write できない」等の重大苦情が発生した場合:

1. storage-guard.service.ts の 4 関数から Beginner 判定を除去 (revert 1 commit)
2. tenant-monthly-reset.service.ts / tenant-withdrawal-billing.service.ts の skip ロジック除去
3. DELETE 経路の自動再集計呼出を除去
4. UI 文言を従来 (50GB hard cap のみ) に戻す
5. ADR-0025 を Status: Superseded に変更し、後続 ADR で代替設計を提示

DB スキーマ変更がないため、データ移行や migration 不要でロールバック可能。

## 関連
- ADR-0019: docs/adr/0019-billable-feature-units-and-free-tier-expansion.md
- ADR-0020: docs/adr/0020-db-capacity-usage-based-billing.md (§11 = 本 ADR のテンプレート)
- ADR-0021: docs/adr/0021-file-storage-usage-based-billing.md
- ADR-0022: docs/adr/0022-embedding-usage-based-billing.md (Beginner 課金 skip の先行事例)
- ADR-0030: docs/adr/0030-embedding-monthly-budget-cap.md (§6 で累積 50GB ハードキャップ撤廃。本 ADR の Beginner ガードは不変で存続)
- 仕様書: docs/specification/BEGINNER_PLAN.md (本 ADR 採用後に新規作成)
- 実装: src/services/storage-guard.service.ts, src/services/tenant-storage.service.ts
- 設定: src/config/db-capacity-pricing.ts, src/config/file-storage-pricing.ts
- Memory: feedback_billing_invariant, feedback_billing_4layer_classification, feedback_unjust_billing_risk_cron
