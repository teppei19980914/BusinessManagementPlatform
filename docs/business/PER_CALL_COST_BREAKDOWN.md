# 機能別 API 1 Call あたりコスト内訳 (プラン × ユーザ負担 / 運営負担)

> **目的**: 7 機能 × 3 プランで、API 1 Call あたりの「**ユーザ負担** (請求書 / Stripe 課金額)」と「**運営側負担** (Anthropic / Voyage 実支払額)」を一覧化し、事業判断 (プラン値上げ / 機能廃止 / プラン構成変更) の根拠とする。
>
> 最終更新: 2026-05-30 (ADR-0028 RAG 移行反映)

---

## 0. 前提単価

### 0.0 ★前提為替レート★

本ドキュメントの全運営側コストは下記レートで円換算しています。為替変動で年単位で 10〜20% 程度ズレる可能性があるため、運営判断・プラン値上げ検討時は **本セクションのレートを最新値で見直す** こと。

| 項目 | 値 | 出典 / 想定 |
|---|---:|---|
| **基準為替レート** | **1 USD = ¥150** | 2026 年中期想定 (日銀公表参考レンジ ¥140〜¥160 の中央値) |
| 円高シナリオ (10% 円高) | 1 USD = ¥135 | 運営コスト 10% 減 (例: ヘルプ ¥0.96/call → ¥0.86/call) |
| 円安シナリオ (10% 円安) | 1 USD = ¥165 | 運営コスト 10% 増 (例: ヘルプ ¥0.96/call → ¥1.06/call) |

> 為替が ¥170 を超えるなどシナリオを大きく外れた場合は、本ドキュメントを再計算 + Expert/Pro 単価の値上げ検討トリガーとする。月次粗利モニタで自然検知される想定。

### 0.1 ユーザ請求単価 (ADR-0019 / 0022 / 0027 / 0028)

| 課金分類 | featureUnit | Beginner | Expert | Pro |
|---|---|---:|---:|---:|
| LLM_BILLABLE | `project-upsert` / `auto-tag-extract` / `suggestion-explanation` | **¥0** (月 50 件上限) | **¥10/call** | **¥15/call** |
| EMBEDDING_BILLABLE | `knowledge-embedding` 等 7 種 | **¥0** | **¥5/call** | **¥5/call** |
| STORAGE_OVERAGE | `db-capacity-overage` | DB 100MB 超過分 ¥50/GB tier | 同左 | 同左 |
| STORAGE_OVERAGE | `storage-file-overage` | File 100MB 超過分 ¥10/GB tier | 同左 | 同左 |
| LEARNING_FREE | `help-chat` / `help-chat-embedding` | **¥0** | **¥0** | **¥0** |

> Source: [src/config/llm.ts:95](../../src/config/llm.ts) / [src/config/embedding-pricing.ts:41](../../src/config/embedding-pricing.ts) / [src/config/billing-feature-units.ts](../../src/config/billing-feature-units.ts)

### 0.2 運営側実コスト単価 (外部 API 公式、2026 年時点、★円換算★)

> 為替前提: **1 USD = ¥150** (2026 年中期想定、年単位で 10〜20% 変動余地あり)。1M tokens = 100 万トークン。

#### Anthropic Claude (公式: https://docs.anthropic.com/en/docs/about-claude/pricing)

| Model | Input (cache miss) | Input (cache hit, 90% off) | Input (cache write, 25% premium) | Output |
|---|---:|---:|---:|---:|
| Claude Haiku 4.5 (Expert で使用) | **¥150 / 1M tokens** | **¥15 / 1M tokens** | **¥188 / 1M tokens** | **¥750 / 1M tokens** |
| Claude Sonnet 4.6 (Pro で使用) | **¥450 / 1M tokens** | **¥45 / 1M tokens** | **¥563 / 1M tokens** | **¥2,250 / 1M tokens** |

> 参考: USD 原価 (Haiku: input $1/$0.10/$1.25, output $5 ─ Sonnet: input $3/$0.30/$3.75, output $15) × ¥150/USD で算出。

#### Voyage AI (公式: https://docs.voyageai.com/docs/pricing)

| Model | 無料枠 | 超過時 |
|---|---:|---:|
| voyage-4-lite | **200M tokens / 月** (= 月 2 億トークンまで完全無料) | **¥3 / 1M tokens** (= $0.02/1M × ¥150) |

> 200M tokens は本サービス想定スケール (100 テナント × 月 1000 件 embedding × 200 tokens/件 = 月 20M) の **10 倍以上の余裕**。当面の超過課金は発生しない見込み。

---

## 1. 機能別 1 Call あたりコスト一覧

各機能について、**典型ケース 1 回操作時の単価**を整理します。

### 1.1 プロジェクト新規作成/更新 (`project-upsert`)

**API 構成**: 1 業務操作で「auto-tag (Anthropic Haiku) + embedding 生成 (Voyage)」を 1 ApiCallLog に集約 (PR #357 で確立、[[feedback_bulk_llm_call_unit]])。

| プラン | ユーザ負担 | 運営側負担 (実コスト) | 運営マージン |
|---|---:|---:|---:|
| Beginner | **¥0** | ~¥0.30 (Haiku input 500t × ¥150/1M = ¥0.075 + output 300t × ¥750/1M = ¥0.225) + Voyage 無料枠 | **−¥0.30** (運営損失、無料試用で吸収) |
| Expert | **¥10** | 同上 ~¥0.30 | **+¥9.70** |
| Pro | **¥15** | 同上 ~¥0.30 (Pro でも Haiku 使用、Sonnet は `suggestion-explanation` のみ) | **+¥14.70** |

> 注: Beginner は月 50 件上限で運営損失を有限化 (月 50 × ¥0.30 = 月 ¥15/テナント)

### 1.2 なぜ？機能 (`suggestion-explanation`)

**API 構成**: Pro 専用機能、Anthropic Claude Sonnet 4.6 で「提案の根拠を説明」する LLM 呼出。

| プラン | ユーザ負担 | 運営側負担 (実コスト) | 運営マージン |
|---|---:|---:|---:|
| Beginner | **N/A** (機能利用不可) | — | — |
| Expert | **N/A** (機能利用不可) | — | — |
| Pro | **¥15** | ~¥1.58 (Sonnet input 1000t × ¥450/1M = ¥0.45 + output 500t × ¥2,250/1M = ¥1.13) | **+¥13.42** |

> Pro 専用の付加機能、運営マージンが厚いことが Pro 価値の根拠。

### 1.3 資産の新規作成/更新

**API 構成**: 各 entity の作成・更新時に Voyage embedding を生成 (1 ApiCallLog/件)。featureUnit は以下 4 種:
- `knowledge-embedding` / `risk-issue-embedding` / `retrospective-embedding` / `memo-embedding`

| プラン | ユーザ負担 | 運営側負担 (実コスト) | 運営マージン |
|---|---:|---:|---:|
| Beginner | **¥0** | ~¥0.001 (Voyage 200t、無料枠で実質 ¥0) | **−¥0** (実質ゼロ損失) |
| Expert | **¥5** | 同上 | **+¥5.00** |
| Pro | **¥5** | 同上 | **+¥5.00** |

> Voyage 無料枠 (200M tokens/月) は資産 100 万件/月相当 (1 件 ~200 tokens 想定) で全社合計でも余裕。

### 1.4 チャット機能 (過去資産検索、`chat-semantic-search`)

**API 構成**: 質問文を Voyage embedding 化 (1 回) → pgvector で意味検索。LLM は使わない。

| プラン | ユーザ負担 | 運営側負担 (実コスト) | 運営マージン |
|---|---:|---:|---:|
| Beginner | **¥0** (月 10,000 回 fair use limit あり) | ~¥0.0003 (Voyage 50t、無料枠で実質 ¥0) | **−¥0** |
| Expert | **¥5** | 同上 | **+¥5.00** |
| Pro | **¥5** | 同上 | **+¥5.00** |

> Beginner は cost=0 のため `monthlyBudgetCap` で防御できず、Fair Use Limit (月 10,000 calls/tenant) で Voyage 200M 無料枠を保護 (ADR-0022)。

### 1.5 チャット機能 (ヘルプ・ガイド、`help-chat` + `help-chat-embedding`)

**API 構成** (ADR-0028 RAG 化後):
- `help-chat-embedding`: 質問文を Voyage embedding 化 (1 回)
- `help-chat`: pgvector で FAQ 上位 5 件抽出 → Anthropic Haiku 呼出 (system prompt キャッシュあり)

| プラン | ユーザ負担 | 運営側負担 (実コスト) | 運営マージン |
|---|---:|---:|---:|
| Beginner | **¥0** | **¥0.96** (Haiku input 4,600t × $1/1M × ¥150 cache hit 50%平均 + output 500t × $5/1M × ¥150) + Voyage ~¥0 | **−¥0.96** |
| Expert | **¥0** (LEARNING_FREE) | 同上 ~¥0.96 | **−¥0.96** |
| Pro | **¥0** (LEARNING_FREE) | 同上 ~¥0.96 | **−¥0.96** |

> ★全プラン無料★。テナント月 100 回上限 (`HELP_CHAT_MONTHLY_LIMIT_PER_TENANT`) で運営損失を有限化 (月 100 × ¥0.96 = **月 ¥96/テナント の運営負担**)。学習コストとして全プラン無料訴求を維持 (ADR-0027 / ADR-0028)。
>
> ★ADR-0028 効果★ 旧 full-context 方式では FAQ 件数に比例して ¥1.29 (46 件) → ¥9.50 (600 件) と線形増大していたが、RAG 化で **FAQ 件数に依存せず ¥0.96/call 固定** になった。FAQ 1000 件まで拡張してもコスト不変。

### 1.6 CSV インポート (`external-import-embedding`)

**API 構成**: N 件取込でも **1 ApiCallLog に集約** ([[feedback_bulk_llm_call_unit]])。Voyage `generateBatchEmbeddings` (MAX_BATCH_SIZE=128) で bulk 処理。

| プラン | ユーザ負担 | 運営側負担 (実コスト) | 運営マージン |
|---|---:|---:|---:|
| Beginner | **¥0** | ~¥0.06 (Voyage 200t/件 × N 件、無料枠ベース ≈ N × ¥0.0003) | **−¥0** |
| Expert | **¥5** (= N 件取込 1 ApiCallLog として、ADR-0029) | 同上 ~¥0.06 × N (例 100 件取込: ¥6 相当だが無料枠で ¥0) | **+¥5.00** (大量取込ほど運営利益、UX 配慮の bulk 集約設計) |
| Pro | **¥5** | 同上 | **+¥5.00** |

> N 件取込でも ¥5 のため、ユーザは「100 件取込で ¥500 課金される」という心理障壁なく一括取込可能。bulk 集約は UX 重視の設計判断 (ADR-0029 で ¥1→¥5 改定後も集約は不変)。

### 1.7 ファイル添付 (`attachment-embedding`)

**API 構成**: ファイル本文を Voyage embedding 化 (1 attachment = 1 ApiCallLog)。`MAX_INPUT_CHARS=8000` で truncate。

| プラン | ユーザ負担 (Embedding) | ユーザ負担 (ストレージ) | 運営側負担 |
|---|---:|---:|---:|
| Beginner | **¥0** (Voyage 無料) | 100MB 無料、超過分 ¥10/GB tier (`storage-file-overage`) | Embedding ~¥0.003 (Voyage 2000t、無料枠で実質 ¥0) + Supabase Storage (~$0.021/GB/月 = ¥3.15/GB/月) |
| Expert | **¥5** | 同上 | 同上 |
| Pro | **¥5** | 同上 | 同上 |

> **2026-05-31 改定 (ADR-0030)**: 旧仕様の Storage 50GB 累積ハードキャップは撤廃され、容量上限はなくなった (50GB は監視アラート閾値のみ)。運営損失の有限化はハードキャップではなく、ストレージ超過 ¥10/GB tier の青天井従量課金による部分回収 + 監視アラート (L3/L4) を受けた Supabase Compute 増強の運用判断で行う。参考: 50GB 使用時の Supabase 実コストは 50GB × ¥3.15/GB/月 = 月 ¥158/テナント (うち超過分は ¥10/GB tier で回収)。容量が大きいテナントほど ¥10/GB 課金額も比例増となり、原価増を従量課金で追従する構造。

---

## 2. プラン別 月間運営コスト試算

**前提**: 100 テナントが β 段階 / 初期商用フェーズで稼働、平均利用量 (上限の 30%) を想定。

### 2.1 1 テナント月間 (平均利用)

| 機能 | 利用回数想定 | Beginner 負担 | Expert 負担 | Pro 負担 | 運営負担 |
|---|---:|---:|---:|---:|---:|
| プロジェクト upsert | 5 件/月 | ¥0 | ¥50 | ¥75 | ¥1.5 |
| なぜ？機能 (Pro) | 10 回/月 | — | — | ¥150 | ¥16.9 |
| 資産 embedding | 50 件/月 | ¥0 | ¥250 | ¥250 | ¥0 (無料枠) |
| 過去資産検索 | 100 回/月 | ¥0 | ¥500 | ¥500 | ¥0 (無料枠) |
| ヘルプ・ガイド | 30 回/月 | ¥0 | ¥0 | ¥0 | **¥29** |
| CSV インポート | 1 回/月 (100 件) | ¥0 | ¥5 | ¥5 | ¥0 (無料枠) |
| ファイル添付 | 10 件/月 (10MB) | ¥0 | ¥50 | ¥50 | ¥0 (合計 100MB 無料枠内) |
| **合計** | — | **¥0** | **¥855** | **¥1,030** | **¥47** |

> Beginner 運営損失: ヘルプ¥29 + プロジェクト¥1.5 = **月 ¥30/テナント**
> Expert マージン: ¥855 − ¥47 = **¥808/テナント** (94% 粗利、ADR-0029 で embedding ¥5 化により上昇)
> Pro マージン: ¥1,030 − ¥47 = **¥983/テナント** (95% 粗利、同上)

### 2.2 100 テナント月間 (= 想定運営コスト)

| プラン構成 | テナント数 | 月間収益 | 月間運営費 | 月間粗利 |
|---|---:|---:|---:|---:|
| Beginner 50 / Expert 30 / Pro 20 | 100 | ¥0×50 + ¥211×30 + ¥386×20 = **¥14,050** | ¥30×50 + ¥47×30 + ¥47×20 = **¥3,850** | **¥10,200** (73% 粗利) |
| Beginner 70 / Expert 20 / Pro 10 (初期 β 想定) | 100 | ¥0×70 + ¥211×20 + ¥386×10 = **¥8,080** | ¥30×70 + ¥47×20 + ¥47×10 = **¥3,510** | **¥4,570** (57% 粗利) |
| Beginner 30 / Expert 40 / Pro 30 (成熟期想定) | 100 | ¥0×30 + ¥211×40 + ¥386×30 = **¥20,020** | ¥30×30 + ¥47×40 + ¥47×30 = **¥4,190** | **¥15,830** (79% 粗利) |

> Beginner 比率が高い初期 β でも粗利 57%。FAQ 件数を 1000 件に拡張しても ADR-0028 RAG により運営費は不変。

---

## 3. 設計判断のまとめ

### 3.1 「Beginner は cost=0 だが運営損失あり」を許容

| 機能 | Beginner 運営負担 | ハードキャップ |
|---|---:|---|
| プロジェクト upsert | ¥0.30/call | 月 50 件上限 (`beginnerMonthlyCallLimit`) → 月最大 ¥15 |
| ヘルプ・ガイド | ¥0.96/call | テナント月 100 回上限 (`HELP_CHAT_MONTHLY_LIMIT_PER_TENANT`) → 月最大 ¥96 |
| 過去資産検索 | ¥0/call (無料枠内) | Fair Use Limit 月 10,000 calls (Voyage 200M 保護) |
| 資産 embedding | ¥0/call (無料枠内) | (なし、Voyage 無料枠で吸収) |

→ Beginner 1 テナント月最大 ¥111 の運営損失で、90 日試用後 Expert/Pro へ転換を促す設計。

### 3.2 「ヘルプ・ガイド」だけ全プラン無料の理由

- たすきフクロウ AI は **初心者の使い方学習** が主目的 ([[project_faq_drives_ai_accuracy]])。
- Expert/Pro でも気軽に質問できないと FAQ 経由でのユーザ教育 (= サポート工数削減) が機能しない。
- LEARNING_FREE 分類で `withMeteredLLM` を経由しない独立経路 (ADR-0027) + ADR-0028 で RAG 化により FAQ 拡充時もコスト固定。

### 3.3 「LLM (Haiku/Sonnet) は plan 別単価、Embedding はプラン横断単価」の理由

- LLM は plan による品質差 (Haiku vs Sonnet) を提供するため plan 別 (Expert=Haiku/¥10、Pro=Sonnet/¥15)。
- Embedding は plan による品質差なし (全プラン voyage-4-lite)、運営実コストも plan 不依存のため固定 (Expert/Pro=¥5、ADR-0029)。

### 3.4 「bulk = 1 ApiCallLog」の UX 配慮

- CSV インポート 100 件取込で「¥100 課金」されると心理障壁が高く、データ移行が進まない。
- 「100 件取込 = ¥5」とすることで初心者ユーザのデータ流入を促進 ([[feedback_bulk_llm_call_unit]]、ADR-0029)。
- 運営側コストは Voyage 無料枠で吸収するため実質ゼロ損失。

### 3.5 ★ヘルプ・ガイド導入は Expert/Pro 前提で「運営側の絶対コストは発生するが、収益で十分吸収できる」

**結論**: ヘルプ・ガイドチャット導入による Anthropic / Voyage への **絶対的な運営支出は発生** しますが (テナント月最大 ¥96)、Expert/Pro テナント 1 社の粗利でその支出を **数倍カバー可能** なため、事業全体としては「実質的に運営負担なし」と判断できます。

#### 単一テナントでの ROI 比較 (1 ヶ月)

| プラン | ヘルプチャット運営支出 (最大値) | 他機能の粗利 (§2.1 試算) | 差引き粗利 (= ヘルプ込み実効粗利) |
|---|---:|---:|---:|
| Beginner (1 テナント) | ¥96 (= 100 回 × ¥0.96) | ¥0 (LLM/Embedding 無料、運営損失のみ) | **−¥126** (=  −¥30 既存損失 − ¥96 ヘルプ追加) |
| **Expert (1 テナント)** | ¥96 | **¥164** | **+¥68** (= ヘルプを払っても黒字) |
| **Pro (1 テナント)** | ¥96 | **¥339** | **+¥243** (= ヘルプを払っても十分黒字) |

> 注: ¥96 はテナント月 100 回 hard cap での「最悪値」。平均利用 30 回/月なら ¥29 程度に下がる。

#### 100 テナント構成別の比較 (1 ヶ月、§2.2 試算ベース)

ヘルプ・ガイド導入有無で月間粗利がどう変わるかを比較:

| プラン構成 | ヘルプなし時 月間粗利 | ヘルプ導入時 月間粗利 | 差分 (= ヘルプ導入コスト) |
|---|---:|---:|---:|
| Beginner 50 / Expert 30 / Pro 20 | ¥12,200 | **¥10,200** | **−¥2,000** (Beginner 50 × ¥29 + Exp/Pro 50 × ¥0 ≒ ¥1,450 相当、内部試算) |
| Beginner 70 / Expert 20 / Pro 10 (初期 β) | ¥6,600 | **¥4,570** | **−¥2,030** |
| Beginner 30 / Expert 40 / Pro 30 (成熟期) | ¥17,700 | **¥15,830** | **−¥1,870** |

→ 100 テナント月 ¥1,800〜¥2,000 程度の「ヘルプ導入による粗利下落」だが、いずれの構成も **粗利率 50% 以上を維持**。

#### 「Expert/Pro テナントがいる前提で運営負担なし」と言える条件

| 条件 | 判定 | 根拠 |
|---|---|---|
| **Expert/Pro が 1 社でもいる** | ✅ ヘルプ運営支出を吸収可能 | Expert 1 社の粗利 ¥164 で Beginner 5〜6 社分のヘルプ支出 (¥96 × 5 = ¥480 ← 平均 ¥29 換算なら 16 社分) をカバー |
| **Beginner only (Expert/Pro ゼロ)** | ❌ 純粋な運営損失 (= 学習投資) | 月最大 ¥126/テナント の損失 (¥30 既存 + ¥96 ヘルプ)。90 日試用での Expert/Pro 転換を期待する投資コスト |
| **為替 ¥165 以上に円安進行** | ⚠ 単価値上げ検討トリガー | ヘルプ支出が ¥1.06/call に上がり Beginner 月最大 ¥106、要 [§0.0](#00-前提為替レート) 再評価 |

#### 「絶対コストはある」を明示しておく理由

「運営負担ゼロ」と断言すると、以下の事業判断ミスを誘発する:

- ❌ ヘルプチャット利用上限 (`HELP_CHAT_MONTHLY_LIMIT_PER_TENANT = 100`) を撤廃 → bot 攻撃で 1 テナント月数千回の `~¥1,000+` 支出が発生
- ❌ FAQ embedding 再生成 (Voyage) を「無料だから」と過度に走らせる → Voyage 200M 無料枠超過時に直撃
- ❌ Anthropic / Voyage 単価値上げを見逃す → 為替変動と単価変更で粗利率がジワジワ悪化

正しくは「**Expert/Pro 収益が Beginner 学習投資 + ヘルプ運営支出を吸収できる範囲で、ヘルプチャットは事業継続性に影響しない**」が正確な判断。

#### 監視すべき指標 (粗利を毀損しないため)

| 指標 | 健全値 | 警戒値 | アクション |
|---|---|---|---|
| Expert/Pro テナント数 / 全テナント数 | ≥ 30% | < 20% | Beginner 期限切れ近いテナントへの転換キャンペーン |
| 1 テナントあたり月平均ヘルプ利用回数 | < 50 回 | > 80 回 | 月 100 回上限到達テナント増加、利用パターン調査 |
| Voyage 月間消費トークン (FAQ embedding 込み) | < 20M | > 150M | 200M 無料枠超過リスク、generate-faq-embeddings 実行頻度の最適化 |
| 為替レート | ¥140〜¥160 | < ¥130 / > ¥170 | プラン値上げ検討 + [§0.0](#00-前提為替レート) 再計算 |

> これらは将来 admin ダッシュボード化を検討 (現状は手動 SQL / cron health monitor で確認)。

---

## 4. 関連ドキュメント

- 課金分類定義: [src/config/billing-feature-units.ts](../../src/config/billing-feature-units.ts)
- LLM 単価実装: [src/config/llm.ts:resolveCostForPlan()](../../src/config/llm.ts)
- Embedding 単価実装: [src/config/embedding-pricing.ts](../../src/config/embedding-pricing.ts)
- 課金エンジン: [src/lib/llm/metered.ts](../../src/lib/llm/metered.ts)
- DB 容量超過課金: [DB_CAPACITY_BILLING.md](./DB_CAPACITY_BILLING.md)
- ファイル容量超過課金: [FILE_STORAGE_BILLING.md](./FILE_STORAGE_BILLING.md)
- Stripe 連携: [STRIPE_BILLING.md](./STRIPE_BILLING.md)
- プラン全体: [TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md)
- ADR-0019 (LLM 単価改定 + BILLABLE_FEATURE_UNITS 確立): [docs/adr/0019-billable-feature-units-and-free-tier-expansion.md](../adr/0019-billable-feature-units-and-free-tier-expansion.md)
- ADR-0022 (Embedding 課金導入): [docs/adr/0022-embedding-usage-based-billing.md](../adr/0022-embedding-usage-based-billing.md)
- ADR-0027 (ヘルプチャット LEARNING_FREE 導入、撤回): [docs/adr/0027-help-ai-concierge.md](../adr/0027-help-ai-concierge.md)
- ADR-0028 (ヘルプチャット RAG 移行): [docs/adr/0028-help-chat-rag-migration.md](../adr/0028-help-chat-rag-migration.md)

---

## 5. 改訂履歴

| 日付 | 改訂内容 |
|---|---|
| 2026-05-30 | 初版 (ADR-0028 RAG 移行を機にプラン × 機能のコスト一覧を整備、ユーザ要請による) |
