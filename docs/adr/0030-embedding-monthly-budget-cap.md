# ADR-0030: Embedding 月次予算上限の導入 + Beginner Embedding 100 件試用上限

- **Status**: Accepted (2026-05-30)
- **Date**: 2026-05-30
- **Deciders**: teppei_suyama (Tech Lead)
- **関連**: [ADR-0022](./0022-embedding-usage-based-billing.md) (Embedding 従量課金導入、本 ADR は判断を一部上書き) / [ADR-0029](./0029-embedding-price-revision-5jpy.md) (Embedding 単価 ¥5/call、本 ADR の予算換算根拠) / [ADR-0026](./0026-embedding-async-generation.md) (Embedding 非同期化、本 ADR と縮退モード設計が整合)
- **影響**: テナント管理者画面 (使用量タブ + 請求タブ) UI 再編 / `withMeteredLLM` Step 3-4 判定経路 / Tenant スキーマ 1 カラム追加 / **(2026-05-31 §6) ADR-0020・ADR-0021 の累積 50GB ハードキャップ・circuit-breaker 撤廃 (storage-guard.service.ts / db-capacity-pricing.ts / file-storage-pricing.ts)**
- **Amends**: [ADR-0020](./0020-db-capacity-usage-based-billing.md) / [ADR-0021](./0021-file-storage-usage-based-billing.md) (§6 で累積ハードキャップ撤廃)

---

## Context

ADR-0022 (2026-06-01) で Embedding 系 7 featureUnit を Expert/Pro で従量課金化したとき、**「Embedding はチャット意味検索/資産入力に必須機能のため、`monthlyBudgetCapJpy` の判定対象外」** とした。理由は「予算超過で Embedding が止まるとサービスの基本機能が崩壊する」という UX 観点の保全だった。

その後の運用設計の進展で、以下の 2 つの状況変化が生じた:

1. **Embedding 非同期化 (ADR-0026 / 2026-05-29)**: 資産作成・更新時の embedding 生成が `after()` 経由の非同期処理となり、生成失敗・遅延が業務フローを直接ブロックしなくなった。
2. **月初 backfill cron (ADR-0022 §EMBEDDING_BACKFILL_FEATURE_UNITS)**: 失敗した embedding を月初に自動再生成する経路が稼働している。**ユーザ非起動の修復処理として全プラン ¥0 維持** が明示判断されている。

この 2 経路の組合せにより、**「Embedding 呼出を一時的にブロックしても、既存 embedding での意味検索は継続し、新規生成失敗分は月初 backfill で次月補填される」** という多層フォールバックが成立する。つまり「Embedding 上限到達 = サービス停止」ではない設計が既に整っている。

一方、Embedding 単価は ADR-0029 で ¥1 → ¥5/call に改定されたため、Expert/Pro の月間請求額が想定より大きくなるリスクが顕在化した。LLM (Claude) と同じく **ユーザ自身が予算上限を設定して予測超過時にブロックできる手段** をテナント管理者に提供すべき段階に来た。

また、Beginner プランは ADR-0022 / 0029 で「Embedding は ¥0 維持・無制限」を訴求してきたが、Voyage 無料枠 (= 全テナント共有 200M トークン/月) の保護として Fair Use Limit (= 月 10,000 calls/tenant) が稼働している。この閾値はテナント運営側の安全弁としては正しいが、**ユーザ向け試用枠の明示としては大きすぎ**、「いつまで無料で使えるのか」がユーザに不透明だった。

### 制約 (継承、変更しない)

- **Beginner LLM 50 件月次上限** (ADR-0019): 不変
- **`monthlyBudgetCapJpy` の LLM 判定対象** (ADR-0019): 不変 (= 既存 Expert/Pro の LLM 予算上限挙動はそのまま)
- **backfill 全プラン ¥0 維持** (ADR-0022): 不変 (= 不当請求回避)
- **Embedding 単価 ¥5/call** (ADR-0029): 不変
- **Fair Use Limit 10,000 件** (ADR-0019/0022): 撤去せず safety net として残置

### 制約 (新規)

- **DB 容量 / ファイルストレージには月次予算上限 (ユーザ設定 cap) を設けない**: 「データはたすきばの命」(= サービス継続性の根本) のため、容量制限による write block はユーザの蓄積資産を直接損なう。ユーザ設定可能な金額 cap は導入しない。要望が出た時点で別 ADR で再検討する。
  - **2026-05-31 追加判断**: この「データはたすきばの命」原則をさらに推し進め、**従来 ADR-0020/0021 で設けていた累積 50GB ハードキャップ (= write/upload block) 自体も撤廃**することにした。詳細は本 ADR §6「2026-05-31 改定: DB/Storage 累積ハードキャップの撤廃」を参照。Beginner 無料枠ガード (ADR-0025) のみ存続する。

---

## Decision

### 1. Embedding 月次予算上限の新設 (Expert/Pro 任意)

Tenant スキーマに `monthlyEmbeddingBudgetCapJpy: Int?` カラムを追加 (NULL = 無制限、既存 `monthlyBudgetCapJpy` と並列)。テナント管理者が **使用量タブ「Embedding 生成回数」セクション直下** から金額 (¥/月) で設定する。

- 単位: **金額 ¥/月** (= 既存 LLM cap と同じ ADR-0019 invariant: 「ApiCallLog SUM = 表示 = 請求」を維持)
- UI 上の補助表示: 入力金額を `EMBEDDING_PRICE_JPY_BY_PLAN` (= ¥5、ADR-0029) で除算した **「約 N 回」換算** を併記
- `withMeteredLLM` Step 4 を拡張: `isEmbeddingBillable` 時 `tenant.currentMonthEmbeddingCostJpy + 予測コスト > tenant.monthlyEmbeddingBudgetCapJpy` で `reason: 'embedding_budget_exceeded'` 縮退モード返却

### 2. Beginner Embedding 100 件試用上限の新設

新規定数 `BEGINNER_EMBEDDING_MONTHLY_LIMIT = 100` を `src/config/embedding-pricing.ts` に追加。Beginner プランの EMBEDDING_BILLABLE call が月 100 件到達時、`withMeteredLLM` Step 3 で `reason: 'embedding_beginner_limit_exceeded'` 縮退モード返却。

- LLM 50 件 / Embedding 100 件の **非対称設計**: Embedding は LLM (Claude) より単価桁違いに低い (Voyage 実コスト ¥0.036/call × 100 件 = ¥3.6/月/Beginner テナント) ため、無料試用範囲を 2 倍に取れる
- LP 訴求「90 日完全無料、Embedding 無制限」を「90 日完全無料、Embedding は月 100 件まで」に修正
- 通常利用ペース (= 試用ユーザの資産入力 + チャット検索) は月数十件程度のため、100 件は試用範囲として十分

### 3. 縮退モード到達時の挙動 (LLM cap と同等)

両 cap 到達時とも `withMeteredLLM` 自体は 200 OK を返し、内部で縮退モード reason を載せる (= ADR-0008 graceful degradation 原則を踏襲)。**基本機能は継続**:

- チャット意味検索: **既存 embedding** での類似度判定は継続 (新規 embedding 生成のみ停止)
- 資産入力: 保存自体は成功、embedding が後日 backfill cron で次月生成
- LLM (プロジェクト作成・「なぜ?」機能): 影響なし (LLM cap とは独立判定)

UI 上は **縮退モードバナー** で「Embedding 上限到達中。新規 embedding は次月生成、既存 embedding 検索は継続」を明示。Expert/Pro は予算引き上げで即時復活、Beginner は月初リセットまたは Expert/Pro へのアップグレードで復活。

### 4. 請求タブに「今月請求金額」セクション新設

テナント管理者が **月内請求額の合計** を一目で把握できるよう、請求タブ先頭に「今月請求金額」セクションを追加:

```
今月請求金額
├─ LLM 費用                    ¥X (= currentMonthApiCostJpy)
├─ Embedding 費用              ¥Y (= currentMonthEmbeddingCostJpy)
├─ DB 容量超過 (想定)          ¥Z (= 月中 peak から計算)
├─ ファイルストレージ超過 (想定) ¥W (= 月中 peak から計算)
└─ 合計                        ¥(X+Y+Z+W)
```

`BILLABLE_FEATURE_UNITS` 三階層 (LLM + EMBEDDING + STORAGE_OVERAGE) と完全一致させ、**「ApiCallLog SUM = 画面表示 = 請求書」invariant** を維持する ([[feedback_billing_invariant]])。

DB/Storage は月中 peak ベースで月末 cron 確定のため、請求タブでは **「想定」** 表示として明示する。

### 5. Fair Use Limit との関係

`FAIR_USE_LIMIT.HARD = 10,000 件` (= Voyage 無料枠保護の運営側 safety net) は **撤去せず併存**。論理的階層:

| 階層 | 閾値 | 目的 | 到達順序 (典型) |
|---|---|---|---|
| **Beginner Embedding 上限** (本 ADR) | 100 件/月 | ユーザ向け試用範囲明示 | 1st (= 通常運用で先に到達) |
| **Fair Use Limit** (ADR-0019/0022) | 10,000 件/月 | Voyage 無料枠の bug / 攻撃対策 | 2nd (= Beginner 上限を意図的に外したコードバグ等の safety net) |

Beginner cap 100 件が先に発火する設計のため Fair Use Limit は通常運用では到達しないが、不慮の cap bypass バグへの保険として残置。

### 6. 2026-05-31 改定: DB/Storage 累積ハードキャップの撤廃

本 ADR の「データはたすきばの命」原則を DB 容量 / ファイルストレージの設計判断へ拡張し、**従来 [ADR-0020](./0020-db-capacity-usage-based-billing.md) / [ADR-0021](./0021-file-storage-usage-based-billing.md) で設けていた累積 50GB ハードキャップ (= write/upload block) を撤廃する**。embedding 月次予算上限の本論 (§1〜§5) は不変。

#### (a) 撤廃の意思決定 — 「データはたすきばの命」の拡張

ADR-0020/0021 初版は「単一テナントが累積 50GB に到達したら write/upload を拒否する」ハードキャップを「他テナント保護の技術的安全弁」として設けていた。しかし本 ADR の中核原則「**データはたすきばの命** = 蓄積資産がサービス価値の源泉」に照らすと、**容量起因の write block はユーザが時間をかけて蓄積したナレッジ資産を直接損ない、大量ナレッジの継続蓄積を阻害する**。これは予算上限と Embedding の関係 (= 縮退モード + backfill で代替経路を保てる) とは異なり、DB/Storage には「止めても後で取り返せる代替経路」が存在しない。

したがって、**全プラン共通の累積ハードキャップ (write/upload block) を撤廃**する。Expert/Pro は **青天井従量** (DB ¥50/GB、Storage ¥10/GB、旧「最大 ¥2,500 / ¥500」上限を撤廃) とし、write を止めない。**Beginner 無料枠ガード ([ADR-0025](./0025-beginner-write-guard.md): DB 50MB / Storage 100MB) のみ存続** — これはユーザ起動の課金回避 (90 日完全無料訴求) が目的で、容量保護とは別ロジックのため不変。

#### (b) noisy-neighbor → Supabase Compute 増強の運用吸収

旧ハードキャップが担っていた noisy-neighbor 対策 (= 単一テナントの巨大 DB が Supabase Micro 1GB RAM の cache hit ratio を劣化させる懸念) は、**write を止めるのではなく運用で吸収**する:

- DB の L3 (50GB) / L4 (instance-wide、Compute 推奨容量の 80%) は **super_admin への監視アラート閾値**として機能 (write は止めない)。
- alert を受けた super_admin が **Supabase Compute サイズを増強** (Micro → Small → Medium …) して吸収する。判断材料は **cache hit ratio**。将来 super_admin 画面に cache hit ratio 等の判断材料を表示する機能追加を予定。
- ファイルストレージは Supabase Storage (オブジェクトストレージ) で Postgres RAM 非依存のため、そもそも noisy-neighbor 懸念がない。

#### (c) 1 操作ペイロード上限 5MB の導入 (DB)

累積ハードキャップ撤廃に伴い、「1 操作あたりの瞬間サーバ負荷」を抑える唯一のアプリ層ガードとして **`DB_WRITE_PAYLOAD_MAX_BYTES = 5MB` (UTF-8 byte 基準)** を新設 ([src/config/db-capacity-pricing.ts](../../src/config/db-capacity-pricing.ts))。Netlify Functions (= AWS Lambda) のリクエストペイロード硬上限 6MB の手前に置き、プラットフォームが不透明な 413 を返す前にアプリがクリーンなエラーを返す。検証は [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) `requireStorageQuotaForWrite`。ファイルは既存の **50MB/件** (`FILE_STORAGE_MAX_FILE_SIZE_BYTES`) が瞬間負荷ガードとして存続。

#### (d) L3 (50GB) → 監視アラート閾値化

DB/Storage 共に L1(1GB)/L2(10GB)/L3(50GB) は **監視アラート閾値のみ**となり、write/upload は止めない。L3 到達は「このテナントが 50GB に到達、Compute 増強を検討」を super_admin に知らせる合図。`classifyDbCapacityLevel` / `classifyFileStorageLevel` の `'l3'` 判定はそのまま (= 通知用)、定数名 `*_L3_HARD_CAP_BYTES` は import 影響回避のため残置 (リネームは別 PR 候補)。

#### (e) circuit-breaker → fail-open

「計測失敗時に write を拒否する circuit-breaker (fail-close)」を撤廃 → **fail-open** へ。累積ハードキャップが無くなり「計測できないから write 拒否」の根拠が消えたため。計測失敗時も write を通し、`recordError` で記録のみ残す。真値は日次 cron `updateAllStorageBytesUsed` が再計測して補正 (課金は月内 MAX peak で取りこぼさない)。撤去した実装シンボル: `StorageLimitExceededError` / `StorageGuardCircuitOpenError` / `FileStorageLimitExceededError` / `mapStorageGuardErrorToResponse` / `mapFileStorageGuardErrorToResponse` / `STORAGE_GUARD_CIRCUIT_BREAKER_THRESHOLD`。これらを「現行」として参照しないこと。

> **実装の真値**: [src/config/db-capacity-pricing.ts](../../src/config/db-capacity-pricing.ts) / [src/config/file-storage-pricing.ts](../../src/config/file-storage-pricing.ts) / [src/services/storage-guard.service.ts](../../src/services/storage-guard.service.ts)。本改定で ADR-0020/0021 に Amended-by note を付与済。

---

## Consequences

### Positive
- **Expert/Pro テナントの予算予測可能性向上**: Embedding 単価 ¥5/call の改定 (ADR-0029) に伴う想定外の請求額膨張をユーザ自身が予防できる
- **Beginner の試用範囲が明示**: 「Embedding 無制限」の曖昧さが「月 100 件まで」と具体的になり、Beginner→Expert/Pro アップグレードの判断材料として機能する
- **既存設計の整合保全**: ADR-0026 非同期化 + 月初 backfill cron + 既存 embedding 継続利用の多層フォールバックで、上限到達してもサービス停止しない
- **「今月請求金額」可視化**: テナント管理者が請求書発行前に当月予測額を確認でき、Stripe 自動引落 / 銀行振込いずれでも事前心算が可能になる ([[feedback_billing_invariant]] の整合点も維持)

### Negative / Trade-off
- **ADR-0022 の「Embedding は予算上限と独立」判断を一部撤回**: 設計判断の安定性として ADR の上書きはコスト。ただし ADR-0026/0029 後の状況変化を踏まえれば妥当な進化
- **LP / 公開 docs の訴求修正コスト**: 「Beginner Embedding 無制限」表記を「月 100 件まで」に書き換え (api-usage-guide / plan-guide / about / HomePage)
- **`withMeteredLLM` の判定経路が複雑化**: Step 3 (Beginner LLM 50 / Embedding 100 / Fair Use 10,000) と Step 4 (LLM cap / Embedding cap) の分岐が増加。ユニットテストで全パスを網羅
- **`monthlyBudgetCapJpy` と `monthlyEmbeddingBudgetCapJpy` の 2 カラム化**: 将来の cap 種別追加 (例: DB/Storage cap) があれば「N カラム化」が懸念だが、本 ADR では DB/Storage cap を意図的にスコープ外としているため当面 2 種で固定

### Risk / 留意事項
- **Beginner 100 件上限が試用ユーザの離脱要因になる可能性**: 90 日試用中に Embedding 100 件を消費しきった Beginner ユーザが Expert/Pro へアップグレードせずに離脱するリスク。LP の文言は「無制限」を訴求点から外し、「初心者プランは月 100 件のお試し枠」と前向きに表現する
- **Fair Use Limit との関係が分かりにくい**: 「Beginner 100 件と Fair Use 10,000 件はなぜ両方ある?」が運用者・開発者の困惑要因になり得る。本 ADR §5 で明示し、`fair-use-limit.service.ts` JSDoc にも追記
- **「想定請求額」と確定請求額の乖離**: 月中 peak ベースの想定は月末確定値とズレる可能性 (= 月後半に peak 更新)。請求タブ UI で「月末 cron で確定、現時点は想定値」を明示

### ★severity-high★ 認知必須リスク: race condition による微量超過 + drift 累積

本 ADR は既存 LLM cap (ADR-0019) と同じ check-then-increment パターンを採用するため、以下 2 つのリスクを **明示的に継承** する。事業継続性の観点で運用者・開発者が認識すべき重要事項:

#### 1. Race condition (同時並行リクエスト)

`withMeteredLLM` の Step 3.1 / Step 4.1 でのカウント / 予算チェックは、Tenant テーブルから fetch した **snapshot** に対して行われる。Step 6 の counter increment との間に時間差があるため、**2 つ以上の並行リクエストが同時に cap 直前で gate を通過し、両方とも increment された結果 cap を +1 だけ超える** 可能性がある。

例 (Embedding 予算上限 ¥1000 / 単価 ¥5 / 現在累積 ¥995):
- リクエスト A: tenant fetch → costJpy=995、`995 + 5 > 1000` = false (= 通過)
- リクエスト B: 同時に tenant fetch → costJpy=995、同じく false (= 通過)
- 両方 LLM 呼出成功 → Step 6 で両方 increment → 最終累積 ¥1005

**実害範囲**:
- Beginner Embedding 100 件試用上限: cost=0 のため**金銭的影響なし** (= 件数のみ +1 超過、UX 上は無視可能)
- Expert/Pro Embedding 予算上限: 1 回の race で **最大 ¥5 (1 call 分) の超過**。N 件並行で N×¥5
- 想定発生頻度: ユーザの並行操作 (= 連続クリック / 複数タブ) で日常的にあり得るが、通常は数件オーダー

**緩和策**:
- **drift detection** (`reconcileTenantEmbeddingUsage`) が日次で counter vs ApiCallLog SUM のズレを検知 → 表示は真値ベース
- **RepairOwnDriftButton** でテナント管理者が自己修復可能
- ApiCallLog SUM (= 請求書根拠) は immutable で正確のため、**請求書と Stripe 送信は実際の超過分も含めて正確** に出る ([[feedback_billing_invariant]])

**未採択の防御案** (将来必要があれば再検討):
- `SELECT FOR UPDATE` + 楽観ロックで Step 3.1 〜 Step 6 を完全 atomic 化 (= 性能影響大、既存 LLM cap も含む構造改変が必要)
- 条件付き UPDATE (`updateMany` with `WHERE current < limit`) で「cap を超えるなら increment しない」を保証 (= LLM cost は既に発生済のため、ApiCallLog 不記録 / Stripe queue 不投入で運営側負担を吸収)

#### 2. Drift accumulation (counter ≠ ApiCallLog SUM)

`withMeteredLLM` の gate check は **counter (cache)** を読むが、画面表示は **reconcile (= ApiCallLog SUM の真値)** を読む。両者が乖離した場合:

- **counter < truth** (= cache が遅れている): cap が **発火しない** ケースで真値は超過済 → ユーザに「上限超過してるのに通った」誤体験 + 請求書には超過分も乗る
- **counter > truth** (= cache が進みすぎ): cap が **早期発火** → ユーザに「まだ枠あるはずなのに止まった」誤体験 + サービス停止

**実害範囲**:
- 通常運用では counter と truth はほぼ一致 (= 同 transaction で記録)
- transaction 失敗時の不整合 / 移行直後 / 障害復旧時に drift する可能性

**緩和策**:
- `reconcileTenantApiUsage` / `reconcileTenantEmbeddingUsage` が ApiCallLog SUM ベースで自動検知
- 使用量タブの `UsageDriftBadge` で drift をユーザに可視化
- RepairOwnDriftButton (本人) / super-admin の repair-api-usage route (運営) で手動修復
- 請求書は ApiCallLog SUM ベースで生成 (= counter drift が請求書に出ない invariant)

#### 設計判断のサマリ

本 ADR は **「カップが微量超過することがあっても、請求書は ApiCallLog SUM (真値) ベースで正確である」** という invariant を維持する。完全 atomic 化は性能コストが大きく、既存 LLM cap も含む全体改修が必要なため、本 ADR スコープでは採用しない。Beginner cap の race は cost=0 で無害、Expert/Pro cap の race は最大数件分 (¥5〜数十円) の微量超過に留まるため、`feedback_billing_invariant` の「請求書 = 真値」原則と矛盾しない範囲で許容する。

将来の高並行運用 (= 1 テナントで分単位 100+ Embedding 同時) で実害が顕著になった場合、別 ADR で条件付き UPDATE パターンへの移行を検討する。

---

## Alternatives Considered

### Alt-1: Embedding cap を新設せず、現状維持
- 概要: ADR-0022 の判断 (= Embedding は予算上限独立) を維持し、Expert/Pro テナントは LLM cap のみで予算管理
- メリット: 設計のシンプルさ、ADR の安定性
- 不採用理由: ADR-0029 で Embedding ¥5/call に値上げした結果、Expert/Pro の Embedding 月額が無視できない規模 (= 月 1000 件 = ¥5,000) になり、ユーザ予算管理の手段が不足する。LLM 並みの予算上限機能を提供しないと「Embedding 暴走で想定外請求」リスクが残る

### Alt-2: Embedding cap 到達時に縮退モードではなく "Warning のみ" にする
- 概要: 予算超過しても呼出を継続、メール/ダッシュボード通知のみ
- メリット: ADR-0022「ユーザを止めない」原則を厳密に保つ
- 不採用理由: 「予算上限を設定する」操作のユーザ期待は「超過したら止まる」。通知のみだとユーザ期待を裏切る + Expert/Pro テナントが本機能を予算管理として活用できない

### Alt-3: Beginner Embedding 上限を 1,000 件 or 5,000 件にする
- 概要: 100 件 (本 ADR) より緩めの試用枠
- メリット: 試用ユーザの離脱リスク低減
- 不採用理由: 通常利用ペース (= 月数十件) を踏まえると 100 件で試用範囲として十分。1,000 件以上だと Fair Use Limit (10,000 件) との階層差が縮まり、Beginner cap の存在意義が薄れる

### Alt-4: 単位を「金額 ¥/月」ではなく「回数 件/月」にする
- 概要: 直感的に「Embedding を月 N 件まで」と設定
- メリット: ユーザ理解の容易さ
- 不採用理由: 既存 LLM cap (= `monthlyBudgetCapJpy` = ¥/月) と単位を揃えないと UI 一貫性が崩れる + 「ApiCallLog SUM = 表示 = 請求 invariant」([[feedback_billing_invariant]]) は金額ベースで確立されており、回数換算は表示のみで補完する方が筋

### Alt-5: DB/ファイルストレージにもユーザ設定可能な月次上限を導入
- 概要: 「想定請求額が ¥X を超えたら write block」または「N GB を超えたら write block」をユーザ設定可能化
- メリット: 4 課金軸 (LLM / Embedding / DB / Storage) で UI 一貫性
- 不採用理由: DB/Storage の write block は **データ蓄積の停止** = サービスの根幹を損なう。Embedding が「縮退モード + backfill」で代替経路を保てるのとは状況が異なる。「データはたすきばの命」の原則として、ユーザ設定可能な金額 cap は導入しない。要望が出たら別 ADR で再検討する
  - **2026-05-31 追記**: この原則の延長で、サービス側の累積 50GB ハードキャップ (= write/upload block) も撤廃した (本 ADR §6)。容量起因の write block は Beginner 無料枠ガード (ADR-0025) のみが存続し、Expert/Pro は青天井従量 + 監視アラート + Compute 増強運用で管理する

---

## Related

- 詳細設計 (実装後): `src/lib/llm/metered.ts` Step 3-4 / `src/services/tenant-self.service.ts` / `src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx`
- 関連 ADR: [ADR-0019](./0019-billable-feature-units-and-free-tier-expansion.md) / [ADR-0022](./0022-embedding-usage-based-billing.md) / [ADR-0026](./0026-embedding-async-generation.md) / [ADR-0029](./0029-embedding-price-revision-5jpy.md)
- **§6 で改定 (Amends)**: [ADR-0020](./0020-db-capacity-usage-based-billing.md) (DB 容量) / [ADR-0021](./0021-file-storage-usage-based-billing.md) (ファイルストレージ) — 累積 50GB ハードキャップ・circuit-breaker 撤廃 / [ADR-0025](./0025-beginner-write-guard.md) (Beginner 無料枠ガードは不変で存続)
- 仕様: [docs/specification/BEGINNER_PLAN.md](../specification/BEGINNER_PLAN.md) / [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)
- 公開 docs: [docs/public/api-usage-guide.md](../public/api-usage-guide.md) / [docs/public/plan-guide.md](../public/plan-guide.md)
- Memory: [[feedback_billing_invariant]] (ApiCallLog SUM = 画面 = 請求 invariant)
