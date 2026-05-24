# ADR-0019: 課金対象 featureUnit の明示化と無料利用範囲の拡大 (2026-05-24)

- **Status**: Accepted (2026-05-24)
- **Date**: 2026-05-24
- **Deciders**: teppei
- **Supersedes**: [ADR-0002](./0002-tenant-billing-per-api-call.md) (プラン構成・単価・課金対象 call の定義を本 ADR で再定義)

---

## Context

[ADR-0002](./0002-tenant-billing-per-api-call.md) で確定した「すべての LLM/Embedding API 呼び出しを課金対象とする」モデルは、実コスト構造を再検討した結果、以下の不整合が明らかになった。

### 実コスト構造の再検証 (2026-05-24)

公式ソースを一次確認:

| 種別 | 単価 (USD/1M tokens) | 出典 |
|---|---|---|
| Voyage voyage-4-lite (embedding) | $0.02 | [docs.voyageai.com/docs/pricing](https://docs.voyageai.com/docs/pricing) |
| Voyage 月間無料枠 | **200M tokens / アカウント** | 同上 |
| Claude Haiku 4.5 (LLM) | input $1 / output $5 | [platform.claude.com](https://platform.claude.com/docs/en/about-claude/models/overview) |
| Claude Sonnet 4.6 (LLM) | input $3 / output $15 | 同上 |

1 call あたりの実コスト (1 USD = ¥150 換算):

| 呼出種別 | 実コスト/call |
|---|---|
| Embedding (12K tokens) | **¥0.036** (200M 無料枠内なら **¥0**) |
| LLM Haiku (10K in + 0.5K out) | ¥1.875 |
| LLM Sonnet (10K in + 0.5K out) | ¥5.625 |

→ Embedding は LLM の **1/52 〜 1/156** のコスト。200M 無料枠 (全テナント共有) があるため、Knowledge Relay 全体で月数万 call までは **追加コスト ¥0**。

### 機能別の LLM 利用実態

| 機能 | LLM 利用 | Embedding 利用 | 旧課金 (ADR-0002) | 実コスト |
|---|---|---|---|---|
| プロジェクト作成/更新 | ✅ auto-tag | ✅ | ✅ 課金 (¥5/¥15) | LLM コスト発生 |
| 各資産 (Knowledge/Risk/Retro/Memo) 作成/更新 | ❌ | ✅ | ✅ 課金 (¥5/¥15) | embedding のみ |
| チャット機能 (semantic search) | ❌ | ✅ | ✅ 課金 (¥5/¥15) | embedding のみ |
| なぜ機能 (suggestion-explanation) | ✅ | ❌ | ✅ 課金 (¥15、Pro 限定) | LLM コスト発生 |

→ **資産作成/更新・チャット機能は LLM を使わず embedding のみ** = 実コストは無視できる水準。これらを課金対象とするのは「実コストとの整合性」という ADR-0002 の前提から外れる。

### ユーザ採用上の課題

- 「資産入力で課金が発生する」ことが心理的ハードル → 入力量低下 → 提案エンジンの再現率低下 (= [project_suggestion_engine_priority.md](../knowledge/) の高再現率設計と矛盾)
- 「チャットで検索する度に課金」は UX 上の摩擦が大きい

## Decision

**課金対象を LLM 実コストが発生する操作のみに限定し、Embedding のみの操作は全プランで無料化する。**

### 改定後の課金マトリクス

| featureUnit | 機能 | Beginner | Expert | Pro |
|---|---|---|---|---|
| `project-upsert` | プロジェクト作成/更新 (LLM + Embed) | 月 **50 件**まで無料 | **¥10/call** | **¥15/call** |
| `suggestion-explanation` | なぜ機能 (LLM、Pro 限定) | 使用不可 | 使用不可 | **¥15/call** |
| `knowledge-embedding` | Knowledge 作成/更新 (Embed only) | **無料** | **無料** | **無料** |
| `risk-issue-embedding` | RiskIssue 作成/更新 (Embed only) | **無料** | **無料** | **無料** |
| `retrospective-embedding` | Retrospective 作成/更新 (Embed only) | **無料** | **無料** | **無料** |
| `memo-embedding` | Memo 作成/更新 (Embed only) | **無料** | **無料** | **無料** |
| `chat-semantic-search` | チャット検索 (Embed only) | **無料** | **無料** | **無料** |
| `*-embedding-backfill` (5種) | 月初 cron 補完 | **無料** | **無料** | **無料** |
| `external-import-embedding` | CSV インポート | **無料** | **無料** | **無料** |

### 「課金対象 featureUnit」の中央定義

`src/config/billing-feature-units.ts` に `BILLABLE_FEATURE_UNITS` 配列を定義し、`withMeteredLLM` がこれを参照して以下を分岐:

- **課金対象**: `costJpy = resolveCostForPlan(plan)`、`Tenant.currentMonthApiCallCount/CostJpy` を increment、`StripeUsageRecordQueue` に enqueue
- **無料**: `costJpy = 0`、counter は increment しない、`ApiCallLog` 自体は記録する (= 監査・分析・将来の課金復活時の根拠データ)

### Beginner プラン上限の再定義

旧: 全 API call で月 100 件 → 新: **課金対象 call (= `project-upsert`) のみで月 50 件**。

数値の根拠:
- 資産入力とチャットは無料 → これらが上限を消費しなくなる
- プロジェクト作成のみが上限対象なら 50 件で個人ユーザの試用には十分
- 50 件超過時の Pro 移行動機を保つ

### LLM 暴走防止の多層防御

事業継続性 ([feedback_billing_invariant.md](../knowledge/)) の根本のため、以下の防御層を維持・追加する:

1. **既存**: user-level rate limit (1 分 10 / 1 時間 60、[src/config/llm.ts:58-63](../../src/config/llm.ts#L58-L63))
2. **既存**: tenant-level budget cap (`monthlyBudgetCapJpy`、課金対象のみ対象)
3. **既存**: Beginner 月次 call 上限 (50 件、課金対象のみカウント)
4. **新規**: **tenant-level fair use limit** — 無料 featureUnit の暴走を防ぐ tenant 単位の月次上限
   - Warning: 月 **8,000 calls** で super_admin 通知
   - Hard limit: 月 **10,000 calls** で当該 featureUnit を縮退モード
   - 実装: `src/services/fair-use-limit.service.ts` (新規) を `withMeteredLLM` の Step 3.5 として統合
5. **新規**: **Voyage 全社横断トークン監視** — Voyage 200M 無料枠 (アカウント単位 = 全テナント共有) の超過を防ぐ
   - Warning: **160M tokens** (80%) で super_admin 通知
   - Critical: **180M tokens** (90%) で全テナントの embedding 系を縮退モード
   - 実装: `usage-monitoring.service.ts` に日次集計メトリクス追加 + 既存 [feedback_drift_detection_design.md](../knowledge/) の 4 点セット (両軸 max + 画面表示 + audit + 修復経路) に従う
6. **新規**: **CI ガード** — `getAnthropicClient` / `voyageEmbed` の直叩きを禁止する grep 検証スクリプトを `scripts/` に追加し、`ci.yml` に組込み

### 収益影響と事業継続性

仮想テナント (典型利用) の月次比較:

| プラン | 旧 (ADR-0002) | 新 (本 ADR) | 変化 |
|---|---|---|---|
| Expert (proj 5 / asset 50 / chat 100) | ¥775 | ¥50 | **-94%** |
| Pro (proj 5 / asset 50 / chat 100 / why 30) | ¥2,775 | ¥525 | **-81%** |

絶対売上は大幅減、しかし:
- マージン: Expert 80% / Pro 63% を維持 (実コスト極小のため)
- テナント数スケール (5-10 倍) を成長戦略の前提とする
- 採用ハードル削減によりテナント数増加を期待

### Stripe 連動の維持

Stripe Meter Event 名 (`tasukiba_haiku_api_call` / `tasukiba_sonnet_api_call`) は据置。Haiku Price は新規発行 (¥10/call) し、旧 Price (¥5/call) は archive する。Sonnet Price は変更なし。

詳細手順: [docs/operations/STRIPE_SETUP.md](../operations/STRIPE_SETUP.md) (本 ADR 反映時に更新)

## Consequences

### Positive

- **採用ハードル大幅削減**: 「資産入力とチャット検索は完全無料」「課金はプロジェクト作成 + AI 補助のみ」のシンプルなメッセージング
- **提案エンジン品質向上**: 資産入力の心理的ハードルが消えるため、データ蓄積が進む = 提案再現率向上
- **チャット利用促進**: 無料化によりナレッジ検索が日常動作に統合される
- **Pro アップセル動線が明確化**: なぜ機能 (Sonnet) が Pro 限定の唯一の付加価値ポイントとして際立つ
- **LLM 暴走防止の多層化**: fair use limit と Voyage 全社監視で事業継続性をシステム的に担保

### Negative / Trade-off

- **絶対売上 -80%〜-94%**: テナント数スケールが前提となる成長戦略への転換
- **ApiCallLog 記録量増加**: 無料 call も記録するため DB 容量が増える (= 監査・分析価値とのトレードオフ)
- **fair use limit が UX を制約する可能性**: 月 10,000 無料 call 上限に到達するヘビーユーザが Pro 強制となる
- **無料 featureUnit に対する monthlyBudgetCapJpy が機能しなくなる**: `costJpy=0` のため。fair use limit が代替防御線として必要

### Risk / 留意事項

- **Voyage 200M 無料枠の超過リスク**: 全テナント共有のため、テナント数増加で枠超過しうる。160M / 180M の 2 段階監視で予防
- **既存テナントへの影響**: `default-tenant` (beginner) の上限が 100→50 に減少。management テナントは課金対象外で影響なし
- **既存 ADR-0002 との整合**: 本 ADR が ADR-0002 の単価・課金対象を上書き。ADR-0002 の Status を Superseded に変更

## 未確定事項 (実運用データで再検証)

以下は推奨デフォルト値で開始し、3-6 ヶ月の実運用データで再評価する:

| 項目 | 暫定値 | 再評価時期 |
|---|---|---|
| Fair use limit warning | 8,000 calls/月/tenant | 運用 3 ヶ月後 |
| Fair use limit hard | 10,000 calls/月/tenant | 運用 3 ヶ月後 |
| Voyage 全社 warning | 160M tokens/月 (80%) | 運用 3 ヶ月後 |
| Voyage 全社 critical | 180M tokens/月 (90%) | 運用 3 ヶ月後 |
| Beginner 上限 50 件 | 50 件/月 | 運用 6 ヶ月後 (アップグレード率を見て) |
| Expert ¥10/call | ¥10/call | 運用 6 ヶ月後 (チャーン率を見て) |
| Pro 単価 ¥15/call (据置) | ¥15/call | 継続検討 (ADR-0002 でも明記) |

## Alternatives Considered

### Alt-1: Embedding を低単価 (¥1/call) で課金維持
- 概要: Embedding も課金対象として残し、¥1/call で薄く課金
- 不採用理由: 「無料」「課金」の二分明快さが顧客説明力で勝る。実コスト ¥0.036 に対し ¥1 は 28 倍のマージンで、訴求力としても「実質無料」より「無料」が強い

### Alt-2: Beginner プランを廃止し最初から Expert
- 概要: Beginner を廃止、Expert (¥10/call) を最小プランに
- 不採用理由: 無料体験動線を完全に閉ざすと初回採用が困難。Beginner を「お試し」として残す方が funnel が機能する

### Alt-3: fair use limit を実装しない
- 概要: 無料 featureUnit は完全無制限とする
- 不採用理由: ユーザ要望 (「LLM 暴走防止をシステムで完全制御」) と矛盾。実コストは小さくとも、Voyage 無料枠の全社共有特性により 1 テナントが枠を食い潰す事故が発生し得る

## Related

- 旧課金 ADR: [ADR-0002](./0002-tenant-billing-per-api-call.md) (Superseded by 本 ADR)
- 詳細設計: [docs/business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) (本 ADR 反映時に改訂)
- 提案エンジン: [docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md)
- Stripe 連動: [docs/design/STRIPE_TECHNICAL_DESIGN.md](../design/STRIPE_TECHNICAL_DESIGN.md), [ADR-0006](./0006-stripe-metered-billing-integration.md)
- 縮退モード: [ADR-0008](./0008-graceful-degradation-mode.md)
- Memory: [feedback_billing_invariant.md](../../memory/), [feedback_drift_detection_design.md](../../memory/), [feedback_bulk_llm_call_unit.md](../../memory/)
