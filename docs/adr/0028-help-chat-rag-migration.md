# ADR-0028: たすきフクロウ AI ヘルプチャットを full-context から RAG (Voyage embedding) へ移行

- **Status**: Accepted (Supersedes [ADR-0027](./0027-help-ai-concierge.md))
- **Date**: 2026-05-29
- **Deciders**: tasukiba プロジェクト管理者
- **関連 PR**: feat/faq-pr7-docs-and-adr (PR #471) 内で ADR-0027 を撤回し本 ADR を正式化

---

## Context (背景)

[ADR-0027](./0027-help-ai-concierge.md) で「FAQ 全文を毎回 Claude Haiku の system prompt に同梱する **full-context 方式**」を採用したが、リリース前のユーザレビューで以下の **致命的な設計上の弱点** が判明した:

### 判明した問題 1: FAQ 拡張時のコスト線形増大

full-context 方式では、FAQ 件数の増加に伴い 1 query あたりの input tokens が線形に増える。Anthropic Prompt Caching (1h TTL, cache hit 10% off) を適用しても、cache miss 時のコストが本質的に増大する:

| FAQ 規模 | system tokens | Cache miss | Cache hit | 50% cache 平均 |
|---|---|---|---|---|
| 42 件 (リリース時想定) | ~10K | ¥2.0 | ¥0.5 | ¥1.25 |
| 600 件 (将来の拡張目標) | ~100K | ¥17 | ¥1.9 | ¥9.5 |

テナント月 100 回上限 (`HELP_CHAT_MONTHLY_LIMIT_PER_TENANT`) を維持しても、運営コストは FAQ 規模に応じて青天井で増大する構造。

### 判明した問題 2: 設計判断時の起点ミス

ADR-0027 の「RAG 不採用」判断は、リリース時点の **FAQ 42 件規模を起点にした短期最適化** だった。ユーザ ([[project_faq_drives_ai_accuracy]] memory に既述) は「FAQ を継続的に拡充して AI 学習を実現したい」という **長期視点** を当初から表明されており、その視点を初期設計に反映できていなかった。これは KDD §5.X+192 として独立に事例化する設計判断ミスである。

### 判明した問題 3: 既存資産の過小評価

たすきば は `chat-semantic-search` で既に Voyage AI を本番運用しており、`pgvector` + 既存 embedding 生成基盤 (`src/services/embedding.service.ts` の `generateBatchEmbeddings`) が成熟している。これらを流用すれば RAG 実装の追加コストは限定的だったにもかかわらず、ADR-0027 で「新規実装の負担」を過大に見積もっていた。本判断は [[feedback_reuse_existing_design_first]] memory に明示された「既存設計流用最優先」方針への違反でもあった。

## Decision (採用した決定)

### 1. アーキテクチャ転換: full-context → RAG

`/api/help/chat` の AI 呼出ロジックを、以下の RAG (Retrieval-Augmented Generation) 構成へ移行する:

```
[ビルド時 / FAQ 更新時]
  src/config/faq-content.ts と guide-content.ts の各 entry/step を
    Voyage AI で embedding 化 (1024 次元ベクトル)
    → DB の faq_embeddings / guide_embeddings テーブルに upsert

[ユーザ質問時 /api/help/chat]
  1. 認証 + IP rate limit + テナント月 100 回上限チェック (現状維持)
  2. ユーザ質問を Voyage AI で embedding 化 (~¥0.036/query)
  3. pgvector の <=> cosine 距離演算で viewer 権限フィルタ済 entries の中で
     top-K (FAQ 5 件 + Guide 3 件 = 計 8 件) を抽出
  4. ★severity-1★ defense-in-depth: 抽出結果に getFaqEntriesForRole(viewer) を
     再適用して許可外 id を drop (料金 FAQ 漏洩防止の二段防御)
  5. PERSONA + 権限ガイダンスは system に cache_control 付与で固定
     RAG 結果は user message に動的注入
  6. Haiku が回答生成 + sourceFaqIds[] を返却
  7. サーバ側で sourceFaqIds の権限再検証 (現状維持)
```

### 2. 既存資産の徹底流用 ([[feedback_reuse_existing_design_first]] 方針実践)

| 流用元 (既存) | 流用先 (新規 help-chat RAG) | 新規実装の有無 |
|---|---|---|
| `src/lib/llm/voyage-client.ts` の `voyageEmbed()` | RAG での質問 embedding 化 | なし (そのまま import) |
| `src/services/embedding.service.ts` の `generateBatchEmbeddings()` | FAQ/Guide bulk embedding 化 | なし (そのまま呼出) |
| `prisma/schema.prisma` の `Unsupported("vector(1024)")` パターン | 新規 FaqEmbedding / GuideEmbedding model | パターンコピー (~50 行) |
| `src/services/chat-search.service.ts` の `pgvectorSearch()` パターン | help-search service の top-K 抽出 | パターンコピー (~150 行) |
| `src/config/faq-content.ts` の `getFaqEntriesForRole(viewer)` 権限フィルタ | defense-in-depth で再利用 | なし (そのまま呼出) |
| `chat-semantic-search` の Voyage rate limit / fair-use-limit 分離設計 | help-chat の独立 rate limit と整合 | なし |

実装新規分は推定 ~500 LOC (Agent 調査結果)、既存資産流用 ~600 LOC。新規実装は既存パターン適用で本質的な設計判断は不要。

### 3. 課金分類: LEARNING_FREE 維持 + 新 featureUnit 追加

- `help-chat`: 既存通り LEARNING_FREE (Haiku 呼出、cost=0)
- `help-chat-embedding`: 新規 featureUnit、LEARNING_FREE に追加 (Voyage 呼出、cost=0)
  - FAQ/Guide のビルド時 embedding 生成 (`generate:faq-embeddings` script 実行時)
  - ユーザ質問時の質問 embedding 化
  - すべて運営が学習コストとして吸収 (= ユーザ無料維持)

### 4. ★最重要★ FAQ ライフサイクル SOP (生命線対策)

FAQ や使い方ガイドの追加・更新・削除を行った場合、対応する embedding を再生成しない限りフクロウは古い情報を返し続け、**ユーザ信頼が崩壊する** = サービス存続の生命線。よって以下を多重防御で対策する:

1. **手動 SOP の明文化**: `docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md §7` を「FAQ ライフサイクル SOP」として再構成し、追加 / 更新 / 削除 ごとの手順を明示
2. **CI ガード**: `scripts/check-faq-embeddings-sync.ts` を新設し、`faq-content.ts` / `guide-content.ts` のハッシュと DB の embedding 状態を比較。drift があれば CI fail
3. **deploy 連携**: `docs/operations/DEPLOYMENT.md` に「prisma migration 実行時に併せて `pnpm generate:faq-embeddings` を実行する」を SOP 化
4. **KDD §5.X+193 として記録**: 同期 drift 検知パターンを横展開可能なナレッジに昇格

### 5. Prompt Caching の再設計

ADR-0027 + KDD §5.X+191 で導入した Anthropic Prompt Caching は、RAG 化により適用範囲が変わる:

```ts
// 修正後の system 構造 (RAG 版)
system: [
  {
    type: 'text' as const,
    text: PERSONA_PROMPT_HEAD + buildRoleGuardancePromptSection(viewer),  // 静的
    cache_control: { type: 'ephemeral' as const, ttl: '1h' },  // cache 可能
  },
],
messages: [
  {
    role: 'user',
    content: `${input.query}\n\n【関連 FAQ・ガイド】\n${ragResults}\n\n---\n${outputInstruction}`,
    // RAG result は動的なので cache 外
  },
],
```

→ core 部分 (~2K tokens) は cache hit が効き、RAG 結果 (~1.5K tokens) は毎回新規。トータル input は ~3.5K tokens (full-context 時の 10K tokens から削減) + cache hit で更にコスト減。

## Consequences (影響)

### Positive (採用効果)

- **コスト固定化**: FAQ 件数によらず query あたりコストはほぼ一定 (¥35-40/月/テナント)。1000 件超でも本質的な増大なし
- **スケール性**: FAQ ∞ までスケール可能 (DB と Voyage の上限のみ)
- **UX の本質的価値**: 「FAQ 追加 → ビルドで embedding 自動生成 → フクロウが新知識を獲得」という体験が技術的に成立 (ユーザの当初認識通り)
- **既存資産の最大活用**: chat-semantic-search の Voyage 基盤を完全流用、実装コスト最小化
- **設計判断ミスの是正**: ADR-0027 の短期最適化を撤回し、長期視点で再判断

### Negative / Trade-off

- **実装複雑度の増加**: full-context のシンプル構造から、Voyage + pgvector + DB 同期 + ライフサイクル SOP の多段構成へ
- **運用負担**: FAQ 更新時に embedding 同期が必須 = 忘れるとユーザに古い情報が表示される (※ 4 つの多重防御で対策)
- **Prompt cache 効果の縮小**: 動的部分 (RAG 結果) が cache 不能のため、core 部分のみ cache 適用となる
- **既存テストの修正**: `faq-content.test.ts` 等の 35+ ケースで `buildFaqPromptSection` パターンが変わる
- **新規 DB テーブル**: 2 テーブル追加 (faq_embeddings / guide_embeddings) + migration

### Risk / 留意事項

- **★severity-1★ FAQ embedding 同期忘れ**: 開発者が `faq-content.ts` を更新したのに `pnpm generate:faq-embeddings` を実行し忘れる → フクロウが古い情報を返す → ユーザ信頼喪失。これに対しては (a) CI ガード (b) SOP 明文化 (c) deploy 時 SOP (d) KDD 横展開 の 4 重防御で対策。サービス存続の生命線として扱う。
- **★severity-1★ 権限フィルタ漏洩**: top-K 抽出後に viewer 権限再フィルタを忘れると料金 FAQ が一般メンバーに漏洩。defense-in-depth で必ず実装。
- **Voyage API 障害時**: 既存 chat-semantic-search の pg_trgm fallback パターンを流用可能 (実装は後続課題)。
- **embedding 次元のバージョン**: Voyage `voyage-4-lite` の 1024 次元を採用 (既存実装と同一)。将来モデル変更時は全 entry の re-embedding が必要。

## Alternatives Considered (検討した代替案)

| 案 | 内容 | 不採用理由 |
|---|---|---|
| **A. ADR-0027 維持 (full-context)** | FAQ 全文を毎回 system prompt 同梱 | FAQ 拡張時のコスト線形増大が本質的解消されない。長期視点で破綻 |
| **B. RAG (本決定)** | Voyage embedding + pgvector top-K | **採用** |
| C. ハイブリッド | コア FAQ は full-context、周辺は RAG | 過剰設計。現フェーズの規模では複雑度がメリットを上回る |
| D. ファインチューニング | Claude Custom Model 等で FAQ を内蔵知識化 | 投資が大きく、現フェーズ (10 テナント) では ROI 不明。Anthropic 公式提供状況の確認も必要。将来検討課題 |

## Migration Plan (ADR-0027 からの移行手順)

1. **ADR-0027** に "Superseded by ADR-0028" header を追記、判断ミスの振り返りを Context section に追加
2. **PR #471 内で本 ADR を実装**: 既に PR #471 で full-context 版が deploy preview に上がっているため、同 PR の追加コミットで RAG 化を実施
3. **DB migration**: 新規 faq_embeddings / guide_embeddings テーブルを追加 (既存テナントへの影響なし、空テーブル)
4. **初回 embedding 生成**: deploy 後に `pnpm generate:faq-embeddings` を実行して production DB に投入
5. **既存 ADR-0027 由来の prompt caching ナレッジ (KDD §5.X+191)** を RAG 版に更新

## 関連

- 撤回される ADR: [ADR-0027](./0027-help-ai-concierge.md) (Superseded by 本 ADR)
- 流用元実装: [src/lib/llm/voyage-client.ts](../../src/lib/llm/voyage-client.ts) / [src/services/embedding.service.ts](../../src/services/embedding.service.ts) / [src/services/chat-search.service.ts](../../src/services/chat-search.service.ts)
- 新規実装: src/services/help-search.service.ts / scripts/generate-faq-embeddings.ts / scripts/check-faq-embeddings-sync.ts
- 改修対象: src/app/api/help/chat/route.ts / src/components/chat-semantic-search/chat-panel.tsx (mode タブ統合) / prisma/schema.prisma
- ライフサイクル SOP: [FAQ_AND_OWL_CHAT_GUIDE.md §7](../developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md) (FAQ 追加/更新/削除手順)
- 関連 ADR: [ADR-0019](./0019-billable-feature-units-and-free-tier-expansion.md) (BILLABLE_FEATURE_UNITS) / [ADR-0022](./0022-embedding-usage-based-billing.md) (Embedding 課金) / [ADR-0026](./0026-embedding-async-generation.md) (embedding 非同期化、本 ADR の知見が応用可能)
- 関連 KDD: §5.X+191 (Prompt caching、RAG 版に更新) / §5.X+192 (本 ADR を生んだ設計判断ミス事例) / §5.X+193 (FAQ embedding 同期 drift 検知パターン)
- 関連 memory: [[feedback_reuse_existing_design_first]] (既存設計流用最優先) / [[feedback_ui_completion_is_default_scope]] (機能 + UI までがスコープ) / [[project_faq_drives_ai_accuracy]] (FAQ 拡充が AI 精度向上に直結)
