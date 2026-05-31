# 提案機能 — 機能仕様とコスト構造 (Specification)

本ドキュメントは、本サービスの**核心機能である提案機能**を、**コストベースで理解できる粒度**で整理した機能仕様書である。事業継続判断 (どの操作で課金が発生し、月次でいくらかかるか) の根拠として常設する。

技術的な実装設計は [../design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md)、課金モデルのビジネスロジック詳細は [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)、インフラ容量計画は [../operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md) を参照。

> 🆕 **ADR-0019 (2026-05-24) 価格改定**: 課金対象は `BILLABLE_FEATURE_UNITS` (project-upsert / suggestion-explanation / auto-tag-extract) のみ。資産入力 (knowledge / risk-issue / retrospective / memo の embedding) / チャット検索 / CSV インポート / 月初 backfill cron は **全プラン無料化**。Expert 単価 ¥5 → ¥10、Pro ¥15 据置。詳細: [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md)。本ドキュメント内の `¥5` / `100 回` 等の数値は ADR-0019 で改定されている可能性があるため、最新値は ADR-0019 を優先参照のこと。

---

## 1. 提案機能とは何か

「**過去のプロジェクトで蓄積した資産 (ナレッジ・リスク・課題・振り返り・メモ) を、新規プロジェクトに自動で結びつけて提示する**」サービスの核心機能。ユーザが「過去にどこかで類似事例があった」を思い出す手間を**自動化**することで、抜け漏れゼロの企画立案を支援する。

### 1.1 提案対象の 5 カテゴリ (2026-05-15: Memo / Risk を追加)

| カテゴリ | 内容 | 提案候補化条件 |
|---|---|---|
| **Knowledge (ナレッジ)** | 過去プロジェクトで蓄積した教訓・パターン・調査結果 | `visibility='public'` (全メンバー公開) のみ |
| **過去リスク (RiskIssue type='risk', state='resolved')** | 他プロジェクトで顕在化対応 / 計画通り収束したリスク。次案件の先回り設計の雛形として活用 | `visibility='public'` **かつ** `state='resolved'` (= 「解消」に到達するまで embedding を生成しない、2026-05-15 最適化) |
| **過去課題 (RiskIssue type='issue', state='resolved')** | 他プロジェクトで発生し解消済の課題。新規案件の事前リスク提示として活用 | `visibility='public'` **かつ** `state='resolved'` (同上) |
| **振り返り (Retrospective)** | 過去プロジェクトの振り返り (KPT / 良かった点 / 問題 / 改善) | `visibility='public'` のみ |
| **メモ (Memo)** (2026-05-15 追加) | 全メンバー公開で共有された個人ノート。プロジェクト非紐付きの汎用知見 | `visibility='public'` のみ。Memo は `visibility` 値が他資産と異なり `'private'` (= 「自分のみ」) / `'public'` (= 「全メンバー」) の 2 値 |

**「公開範囲: 自分のみ」のデータは提案エンジン対象外**:
- Knowledge / RiskIssue / Retrospective: `visibility='draft'` のとき
- Memo: `visibility='private'` のとき

これらは embedding 生成も行わず (Voyage API 課金回避)、提案候補にも乗らない。「自分のみ → 全メンバー」遷移時に初回 embedding 生成される (= 公開化のタイミングで提案エンジンに参加)。

### 1.2 提案を発動するタイミング

| 発動 UI | 場所 |
|---|---|
| Project 作成直後の自動モーダル | 新規プロジェクト作成成功時に自動表示 |
| 「参考」タブ | プロジェクト詳細画面のタブ。いつでも再表示可 |
| リスク/課題起票時の inline 軽量提示 | 起票ダイアログで text 入力中に類似過去課題を提示 |

---

## 2. API 呼び出しトリガー (誰がいつ何を呼ぶか)

提案機能の API 呼び出しは **3 つのトリガー** に分類される。これ以外の操作で外部 API は呼ばれない。

| # | トリガー | 呼び出される API | 1 業務操作あたりの ApiCallLog (= ユーザ請求回数) |
|---|---|---|---|
| **①** | **Project 作成・更新時** (purpose/background/scope の text 変更時) | **Anthropic** + **Voyage** | 内部 2 API を呼ぶが **1 回に集約** (`featureUnit='project-upsert'`、2026-05-15 統合 / 1 業務操作 = 1 ApiCallLog ルール) |
| **②** | **資産作成・更新時** (Knowledge / RiskIssue / Retrospective / Memo の embedding 対象項目変更時) | **Voyage** | Voyage **1 回** (`featureUnit` は資産種別ごと: `knowledge-embedding` / `risk-issue-embedding` / `retrospective-embedding` / `memo-embedding`) |
| **③** | **提案機能実行時** (Project 作成後の提案モーダル / 参考タブ / 課題起票画面の inline 提示) | **Supabase pgvector のみ** (DB 内処理で完結) | **外部 API 呼び出しなし (¥0)** |

### 2.1 設計上の重要点: 提案画面の表示は ¥0

トリガー③ の「提案画面表示」では **何度開いても外部 API は呼ばれない**。事前にトリガー①②で生成・保存済みの embedding を Supabase pgvector が読み出して比較するだけのため、**ユーザは何度提案を見ても追加課金が発生しない**。

これは本サービスのアーキテクチャ上の優位性で、**外部 API 障害時 (Voyage 全停止) でも提案機能は止まらない fail-safe 性**を担保する。

---

## 3. 機能概要 (各トリガーで何が起きるか)

### 3.1 Project 作成・更新時 (トリガー①)

`purpose` / `background` / `scope` の text から **Anthropic が自動でタグを抽出**。プランによってモデルが切り替わる。

| プラン | 使用モデル | 1 回あたりの実コスト (推定) |
|---|---|---|
| Beginner / Expert | Claude **Haiku** | 入力 5K token + 出力 0.5K token ≒ **¥1.1 / 回** |
| Pro | Claude **Sonnet** | 入力 5K token + 出力 0.5K token ≒ **¥3.4 / 回** |

同時に **Voyage が text → 1024 次元 embedding を生成** し、Supabase pgvector の `content_embedding` 列に保存する (全プラン共通)。

**1 業務操作 = 1 ApiCallLog (2026-05-15)**: 内部的には Anthropic と Voyage の 2 API を呼ぶが、`extractTagsAndEmbedForProject()` が `withMeteredLLM` を 1 度だけラップして両者を実行する。ApiCallLog 1 件 / Tenant counter +1 / costJpy 1 回分のみ計上。`featureUnit='project-upsert'`。両 inner API が共に失敗した場合のみ throw され課金されない (どちらか 1 つ成功すれば 1 件計上)。

**空 text 早期 return (2026-05-15)**: `purpose` / `background` / `scope` の **すべて** が空文字 (または空白のみ) の場合、`withMeteredLLM` 自体を呼ばずに `tags=null, embedding=null` で早期 return する。ApiCallLog / counter / costJpy のいずれも増分なし (= 完全な ¥0 操作)。

### 3.2 資産作成・更新時 (トリガー②)

Knowledge / RiskIssue / Retrospective / Memo の主要 text フィールドから **Voyage が embedding を生成** し、Supabase pgvector に保存する (全プラン共通)。Anthropic は呼ばれない (自動タグ抽出は Project 限定機能)。

#### 各資産の embedding 対象項目

| 資産 | embedding 対象項目 | featureUnit |
|---|---|---|
| Knowledge | title / background / content / result / conclusion / recommendation | `knowledge-embedding` |
| RiskIssue (リスク / 課題) | title / content / cause / responsePolicy / responseDetail | `risk-issue-embedding` |
| Retrospective | planSummary / actualSummary / goodPoints / problems / improvements / knowledgeToShare | `retrospective-embedding` |
| **Memo** (2026-05-15 追加) | **title / content** | `memo-embedding` |

#### embedding 生成 / 再生成のトリガー条件 (コスト最適化)

「**公開範囲: 全メンバー** かつ **embedding 対象項目の実値が変更されたとき**」のみ Voyage が呼ばれる。それ以外は LLM 課金が発生しない (= ¥0)。

| 遷移ケース | embedding 生成 |
|---|---|
| 新規作成「自分のみ」(draft / private) | ❌ 課金なし |
| 新規作成「全メンバー」+ text あり | ✅ 1 件計上 |
| 新規作成「全メンバー」+ text 空 | ❌ 課金なし (Voyage 呼ばず) |
| 更新 自分のみ → 自分のみ | ❌ 課金なし |
| 更新 **自分のみ → 全メンバー** | ✅ 1 件計上 (初回公開化、text 変更なしでも) |
| 更新 全メンバー → 全メンバー + 対象項目変更あり | ✅ 1 件計上 |
| 更新 全メンバー → 全メンバー + 対象項目変更なし (タイトルだけ・タグだけ・ステータスだけ等) | ❌ 課金なし |
| 更新 全メンバー → 自分のみ | ❌ 課金なし (既存 embedding は削除せず保持、提案エンジン側 filter で除外) |

#### RiskIssue (リスク・課題) のみの追加条件: state='resolved' 限定 (2026-05-15)

RiskIssue は提案エンジンが **`state='resolved'` のみを候補化** する設計のため、上記マトリクスに加えて **state も `'resolved'` でない限り embedding を生成しない**。

| state 遷移ケース | embedding 生成 |
|---|---|
| 新規 state='open' / 'in_progress' / 'monitoring' (= 起票直後の通常状態) | ❌ 課金なし (resolved 化まで保留) |
| 新規 state='resolved' (= 外部 import 等で初期から解消済) | ✅ 1 件計上 |
| 更新 **state が 'resolved' に新たに遷移** | ✅ 1 件計上 (text 変更不要、初回 embedding 化) |
| 更新 state='resolved' のまま text 変更 | ✅ 1 件計上 |
| 更新 state='resolved' のまま text 変更なし | ❌ 課金なし |
| 更新 state='resolved' → 'open' / 'in_progress' / 'monitoring' (再オープン) | ❌ 課金なし (既存 embedding は保持) |

(= Knowledge / Retrospective / Memo には state 概念がないため、この追加条件は RiskIssue のみに適用される)

### 3.3 提案機能実行時 (トリガー③)

Supabase pgvector が **保存済の embedding 同士の Cosine 類似度を DB 内で計算**。3 軸合算スコアで候補を並べ替え、上位 N 件を返す。**外部 API 呼び出しは発生しない**。

**3 軸合算スコア式**:
```
最終スコア = (タグ類似度 × 0.3) + (文字列類似度 × 0.2) + (意味類似度 × 0.5)
```

- タグ類似度 0.3: Project タグと候補側タグの Jaccard 係数
- 文字列類似度 0.2: pg_trgm (3-gram 部分一致)。「請求書」⇔「請求」のような表記ゆれを拾う
- 意味類似度 0.5: Voyage embedding の Cosine 類似度。「請求書」⇔「インボイス」のような意味的な近さを拾う (本軸)

各カテゴリで `SUGGESTION_SCORE_THRESHOLD = 0.01` ([src/config/suggestion.ts:72](../../src/config/suggestion.ts)) 以上のものをスコア降順でソートし、`SUGGESTION_DEFAULT_LIMIT = 50` ([src/config/suggestion.ts:81](../../src/config/suggestion.ts)) 件まで返す → **各カテゴリ最大 50 件、5 カテゴリ (Knowledge / 過去リスク / 過去課題 / 振り返り / メモ) 合計最大 250 件**。

> **PR-X6 (2026-05-07) 改定**: 閾値 0.05 → **0.01**、件数上限 10 → **50** に変更済 (旧「高精度・低再現率」設計から「全網羅 + 段階表示」の高再現率設計へ転換)。weak tier は UI 折りたたみで情報過多を回避する。本ドキュメント内に旧値 (0.05 / 10) が残っていた場合は config を真値とする。

**最低件数保証**: 閾値以上の候補が `SUGGESTION_MINIMUM_GUARANTEED_COUNT = 5` 件未満の場合、閾値を無視してスコア降順 Top 5 を返す (`applyMinimumGuarantee`、[src/config/suggestion.ts:266](../../src/config/suggestion.ts))。シードと異業種プロジェクトでも 0 件にならない設計。

**Memo の tagScore は常に 0** (Memo はタグを持たない設計 + 親 Project もないため proxy にできない) → 縮退モード重み再配分の対象になり、text と embedding 類似度で実用ランキング。「なぜ?」説明文 (Phase 3) も Memo 対応済。

### 3.4 ハードキャップ超過時の挙動 (機能停止しない fail-safe 設計)

テナント単位の月次 API 呼び出しキャップを超過した場合の挙動:

| 操作 | 影響 |
|---|---|
| 新規 Project / 資産 作成 | Anthropic / Voyage の呼び出しがブロック → embedding は **NULL のまま保存** (本体データは正常保存) |
| 既存データの提案画面表示 | キャップ無関係で動作 (元々外部 API を呼ばないため) |
| キャップ中に作成された新規データの提案表示 | **重み再配分縮退モード** (タグ：テキスト = 5：5、合計重み 1.0) に自動遷移 |

**全候補は常に同じ土俵 (3 軸合算) で評価される**。ベクトルが保存されている候補は embedding 軸で寄与し、NULL の候補は embedding 軸で 0 として扱われる。「タグ全文検索」と「ベクトル検索」が別経路で走るのではなく、**1 つの統一スコア体系**で全データが比較される。

### 3.6 UI 段階表示と初期可視性 (2026-05-29 改修 / chat-panel と統一)

提案結果は **3 段階の tier 表示** に分かれ、それぞれ初期表示状態が異なる。これは「**強く関連の上位 5 件で判断できる**」サービス哲学を UI レイヤで強化するための設計判断で、姉妹機能であるチャット意味検索 ([CHAT_SEMANTIC_SEARCH.md §UI 段階表示](./CHAT_SEMANTIC_SEARCH.md)) と同一パターンを採用する。

**tier 分類は `assignPercentileTiers()` ([src/config/suggestion.ts:224](../../src/config/suggestion.ts)) の相対分位方式が通常パス**。各カテゴリの候補をスコア降順ソートし、上位 30% (`SUGGESTION_TIER_PERCENTILE_STRONG_RATIO`) を strong、続く 50% (`..._MEDIUM_RATIO`) を medium、残り 20% を weak とする。候補が 5 件 (`SUGGESTION_TIER_PERCENTILE_FALLBACK_THRESHOLD`) 以下の少件数時は絶対閾値方式 (`classifyTier`) にフォールバックする。strong に昇格しても score が `SUGGESTION_TIER_ABSOLUTE_FLOOR_FOR_STRONG = 0.05` 未満なら medium に降格 (誤誘導防止ハイブリッド)。

| Tier | UI ラベル | 分類 (通常パス = パーセンタイル) | 少件数時 (≤5 件) の絶対閾値 | 初期表示状態 | 装飾 |
|---|---|---|---|---|---|
| **strong** | 「🟢 強く関連 (N 件)」 | 上位 30% (かつ score ≥ 0.05) | score ≥ 0.3 (`SUGGESTION_TIER_STRONG_THRESHOLD`) | **上位 5 件のみ展開**。6 件目以降は「▶ さらに N 件を表示」アコーディオン (デフォルト閉じ) | 緑のボーダー |
| **medium** | 「🟡 中程度の関連 (N 件)」 | 続く 50% | 0.1 ≤ score < 0.3 (`SUGGESTION_TIER_MEDIUM_THRESHOLD`) | **デフォルト折りたたみ** (2026-05-29 改修、旧仕様: 常時展開) | 黄色のボーダー |
| **weak** | 「⚪ 弱い関連性 (N 件)」 | 残り 20% | score < 0.1 | **デフォルト折りたたみ** (PR-X6 から不変) | 灰色のボーダー |

#### 設計判断の根拠

1. **「上位 5 件で判断できる」哲学の徹底** (参照: [docs/public/about.md §3-2](../public/about.md))
   - 100 件をスクロールさせるのではなく、**5 件で目的の情報にたどり着けるなら 6 件目以降は展開不要**。
   - 強く関連 6 件目以降をアコーディオン化することで、視覚的な情報過多を防ぎつつ「念のため広く見たい」需要も担保する。

2. **「中程度の関連」への改称** (旧: 「関連の可能性」)
   - 「関連の可能性」というラベルは「**弱い関連性**」との差分が利用者に伝わりにくいというフィードバックがあった (2026-05-27 ユーザ実機確認)。
   - 「中程度の関連」は **強い ↔ 中程度 ↔ 弱い** の対比で強度ランクが直感的に理解できる。
   - 同時にデフォルト折りたたみ化することで、初期の視覚密度を「強く関連 上位 5 件」に絞り込む。

3. **chat-panel との UX 一貫性**
   - 提案機能 ([projects/[projectId]/suggestions/suggestions-panel.tsx](../../src/app/(dashboard)/projects/[projectId]/suggestions/suggestions-panel.tsx)) と チャット意味検索 ([chat-semantic-search/chat-panel.tsx](../../src/components/chat-semantic-search/chat-panel.tsx)) は同じ tier データ構造を返すため、UI も統一すべき。
   - 共有定数 `SUGGESTION_TIER_STRONG_INITIAL_VISIBLE = 5` ([src/config/suggestion.ts](../../src/config/suggestion.ts)) を両者で参照する。

#### 状態管理の実装

- **suggestions-panel**: 4 カテゴリ (knowledge / issue / risk / retrospective) × 3 tier の折りたたみ状態を `Set<SuggestionCategory>` × 3 (`expandedStrong` / `expandedMedium` / `expandedWeak`) で管理。
- **chat-panel**: 1 ターン内の 3 tier 状態を `useState(false)` × 3 で管理 (ターンごとに独立)。
- ユーザ操作は **session に閉じる** (永続化しない) — 次回開いたときは再びデフォルト状態に戻る。これは「最初に目に入る情報量を最小化する」UX 原則のため。

#### 件数表示の運用ルール

- ラベルは「**強く関連 (8 件)**」のように **その tier の総件数** を表示する (折りたたみ中の件数を含む)。
- 強く関連の「さらに N 件を表示」ボタンの N は **折りたたまれている件数** (6 件目以降の総数)。
- 強く関連の「さらに表示中 (N 件)」ボタンの N も **折りたたまれていた件数 (= 新たに見えている件数)** で統一する (= `strongRest.length`)。
  この意味は chat-panel と suggestions-panel で **必ず一致** させる (KDD §5.X+182、2 巡目フルスキャン検証で発覚した UX 一貫性バグの予防)。

#### アクセシビリティ (a11y)

3 つの toggle button (strong 6 件目以降展開 / medium 全体展開 / weak 全体展開) すべてに以下属性を付与:

- `aria-expanded={isExpanded}` — 展開状態
- `aria-controls={"suggestion-${tier}-content-${category}"}` — 制御対象コンテンツの id (WCAG 1.3.1)
- `focus:outline-2 focus:outline-offset-2` — キーボード focus 可視性
- `data-testid` — category 単位の E2E セレクタ安定性

対応するコンテンツ要素には `id` 属性を付与してスクリーンリーダーで関係が伝わるようにする。

### 3.7 Pro 限定「なぜ?」説明文 (実装済 / P-3)

Pro プランの差別化価値として、提案結果の各候補に **「なぜこのプロジェクトに関連するのか」の自然言語説明文を Lazy 生成** する機能は **実装済** ([src/services/suggestion-explanation.service.ts](../../src/services/suggestion-explanation.service.ts)、API: `src/app/api/projects/[projectId]/suggestions/explain/route.ts`)。

- **Pro 限定**: サービス層で `tenant.plan !== 'pro'` を `plan_forbidden` で拒否する defense-in-depth。Beginner / Expert は UI でも button 非表示 ([suggestion-explanation.service.ts:173](../../src/services/suggestion-explanation.service.ts))。
- **モデル**: `withMeteredLLM` が `resolveModelForPlan` で Pro → Claude Sonnet (`claude-sonnet-4-6`) を自動選択。`featureUnit='suggestion-explanation'` で ¥15/call 課金 (LLM_BILLABLE)。
- **Lazy + DB キャッシュ**: ユーザが「なぜ?」をクリックした候補のみ生成。`SuggestionExplanation` テーブル (unique key: projectId × candidateKind × candidateId) にキャッシュし、cache hit 時は再課金しない。
- **対応候補種別**: knowledge / issue / risk / retrospective / memo の 5 種 (`CandidateKind`、[suggestion-explanation.service.ts:50](../../src/services/suggestion-explanation.service.ts))。
- **再ランキング**: LLM による並べ替え (re-ranking) は行わない。説明文付与のみ (検索順位は 3 軸スコアのまま)。

---

## 4. プラン概要 (3 プラン構成)

> **ADR-0019 (2026-05-24) 改定済**: Expert ¥5 → ¥10 / Pro ¥15 据置 / 課金対象を `BILLABLE_FEATURE_UNITS` (プロジェクト作成・更新のみ) に縮小。Beginner 上限を 100 → 50 (課金対象 call のみカウント) に改定。詳細は [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md) を最新基準として参照。

| プラン | 席数 | 月額固定 | 従量課金 (ADR-0019 改定後) | API 呼び出し上限 | 自動タグ抽出モデル | 提案機能 (検索) | 提案機能 (説明文付与) |
|---|---|---|---|---|---|---|---|
| **Beginner** | 5 席まで | ¥0 | なし | プロジェクト作成・更新 月 50 回まで無料、超過後縮退 | Haiku | ✅ 3 軸スコアリング | ❌ Pro 限定 (plan_forbidden) |
| **Expert** | 無制限 | ¥0 | **¥10 / プロジェクト作成・更新 1 回** | 無制限 | Haiku | ✅ 3 軸スコアリング | ❌ Pro 限定 (plan_forbidden) |
| **Pro** | 無制限 | ¥0 | **¥15 / プロジェクト作成・更新 1 回** + **¥15 / 「なぜ?」1 回** (Pro 限定) | 無制限 | Sonnet | ✅ 3 軸スコアリング | ✅ 「なぜ?」説明文 実装済 (§3.7) |

**3 プラン共通**: 上限到達時は **縮退モード**（[docs/business/TENANT_AND_BILLING.md §34.14.4](../business/TENANT_AND_BILLING.md) / NF-13.14 参照）に遷移。エンティティ作成・更新は HTTP 200 で継続、embedding 生成と auto-tag 抽出は一時停止。提案エンジンは NULL 候補をタグ：テキスト = 5：5 の重み再配分で評価。月初バッチで一括補完して翌月には完全回復する fail-safe 設計。

詳細な課金モデル (ダウングレード制御 / 月次予算上限 UI 等) は [../business/TENANT_AND_BILLING.md Part 5](../business/TENANT_AND_BILLING.md) を参照。

---

## 5. 4 機能のコア — 課金構造の詳細

提案機能は **2 つの外部 LLM API + 1 つの DB サービス** で構成される。それぞれの課金体系は独立しており、月次コスト試算は 3 つの合算で計算する。

### 5.1 Anthropic Claude API (自動タグ抽出 / 将来の Phase 3)

**完全従量課金 / 無料枠なし / 入出力トークン別単価**

| モデル | 入力トークン | 出力トークン | 用途 (本サービス) |
|---|---|---|---|
| **claude-haiku-4-5** | **$1 / 1M token** | **$5 / 1M token** | Beginner / Expert プランの自動タグ抽出 |
| **claude-sonnet-4-6** | **$3 / 1M token** | **$15 / 1M token** | Pro プランの自動タグ抽出 |

> ※ 単価は 2026 年初頭時点の概算。最新は [Anthropic 公式 pricing](https://www.anthropic.com/pricing) で要確認

**コスト最適化機能**:
- **Prompt Caching**: 同じシステムプロンプト再利用で入力料金 50% off
- **Batch API**: 非同期処理で 50% off (本サービスはリアルタイム性重視のため未使用)

### 5.2 Voyage AI Embedding API (embedding 生成)

**従量課金 + 無料枠あり / 入力トークンのみ課金 (出力ベクトルは課金対象外)**

| モデル | 無料枠 | 超過後 | 用途 (本サービス) |
|---|---|---|---|
| **voyage-4-lite** | **200M token / 月** | **$0.02 / 1M token** | 全プラン共通の embedding 生成 |

> ※ 単価は 2026 年初頭時点。最新は [Voyage AI 公式 pricing](https://docs.voyageai.com/docs/pricing) で要確認
>
> **重要**: 「200M token / 月」は **月初リセットの無料枠**。「$0.02 / 1M token」は超過分の単価で、**月をまたぐ概念はない** (使い切り、繰り越しなし)。

**Voyage Organization 単位で集計**: 全テナントが共有する 1 つの API キー = 1 つの Voyage Organization で 200M を共有する。テナント別の無料枠分配機能は Voyage 側にないため、本サービスの `withMeteredLLM` ミドルウェアでテナント単位の API 呼び出し回数を制御する設計。

### 5.3 Supabase + pgvector (ベクトル保存・類似度検索)

**pgvector 拡張機能は無料**。ただし Supabase 全体としてはプラン制で、容量・帯域・接続数に上限がある。

| プラン | 月額 | DB 容量 | API 帯域 (egress) | 同時接続 | pgvector |
|---|---|---|---|---|---|
| **Free** | **$0** | **500 MB** | **5 GB / 月** | **60** | ✅ 含む |
| **Pro** | **$25 / 月** | **8 GB** (超過後 **$0.125 / GB**) | **250 GB / 月** | **200** | ✅ 含む |
| **Team** | **$599 / 月** | 8 GB+ (超過後同単価) | **無制限** | **400+** | ✅ 含む |
| Enterprise | 個別見積 | 個別 | 個別 | 個別 | ✅ 含む |

> ※ 単価は 2026 年初頭時点。最新は [Supabase pricing](https://supabase.com/pricing) で要確認

**重要**: pgvector 自体はオープンソース拡張で追加料金なし。ただし embedding ベクトル (1024 次元 × 4 バイト ≒ 4KB / 行) は **DB 容量を消費** するため、間接的に Supabase プランの上限に影響する。

**用語の意味**:
- **DB 容量**: テーブル + インデックス + embedding ベクトルの合計サイズ
- **API 帯域 (egress)**: Supabase から外部 (ブラウザ・サーバ) へ送信されたデータ量。**ダウンロード方向のみ**課金 (アップロードは無料)
- **同時接続**: PostgreSQL に同時に張られる TCP コネクション数。Netlify Functions (AWS Lambda 相当) で大量並列実行する場合、Supavisor (Transaction pooler) を使うことで実質無制限化可能 (本サービスは利用済)

---

## 6. 月次コスト試算 (シナリオ別)

### 6.1 6/1 リリース直後の現実的シナリオ

**前提**: 5-10 テナント / 月間 1,000 操作 / 自動タグ抽出 100 回 (Haiku)

| サービス | 月次使用量 | 月次コスト |
|---|---|---|
| Anthropic Haiku (タグ抽出 ×100 回) | 0.5M token (入力 + 出力) | 約 **¥80** |
| Voyage (embedding 生成 ×1,000 回) | 1.5M token | **¥0** (無料枠 200M の 0.75%) |
| Supabase Free | DB ≒ 12MB / 帯域数 GB | **¥0** |
| Netlify Personal | Function 実行 数千回 | **¥0** (credits 内、1,000 credits/月) |
| **合計** | — | **月 ¥80 程度** |

これに対する**本サービスのテナント側課金 (Expert プラン仮)**: ¥10/回 × 100 回 = ¥1,000 → **粗利 92%** (ADR-0019 / 2026-05-24 改定後)。

### 6.2 中規模シナリオ (3-6 ヶ月後)

**前提**: 20-50 テナント / 月間 10,000 操作 / 自動タグ抽出 1,000 回

| サービス | 月次使用量 | 月次コスト |
|---|---|---|
| Anthropic (Haiku 700 回 + Sonnet 300 回想定) | 5M token | 約 **¥1,800** |
| Voyage (embedding 生成 ×10,000 回) | 15M token | **¥0** (無料枠の 7.5%) |
| Supabase Pro 昇格想定 (DB 600MB 前後) | — | **¥4,000** |
| **合計** | — | **月 ¥5,800 程度** |

### 6.3 拡大シナリオ (1 年後 / 200 テナント)

**前提**: 月間 100,000 操作 / 自動タグ抽出 10,000 回

| サービス | 月次使用量 | 月次コスト |
|---|---|---|
| Anthropic (Haiku 7,000 回 + Sonnet 3,000 回想定) | 50M token | 約 **¥18,000** |
| Voyage (embedding 生成 ×100,000 回) | 150M token | **¥0** (無料枠の 75%) ※あと数ヶ月で超過の見込み |
| Supabase Pro (DB 4GB) | — | **¥4,000** |
| **合計** | — | **月 ¥22,000 程度** |

このシナリオで月間売上 (Expert ¥10/回 × 100,000 = ¥1,000,000、ADR-0019 / 2026-05-24 改定後) → **原価率約 2.2%、粗利率 97.8%** を維持できる構造。Stripe 手数料 (3.6%) を考慮しても粗利率 94% 程度を確保。

---

## 7. コスト超過リスクと監視ポイント

| 監視項目 | 閾値 | 超過時のアクション | 通知手段 |
|---|---|---|---|
| Voyage 月次使用量 | 200M token (無料枠) | 課金開始 ($0.02/M)。アプリ側 `Tenant.monthlyApiCallCap` でハードキャップ | Voyage Budget Alerts ($7 設定済) |
| Anthropic 月次使用料 | 月 $100 相当 | 事業性審査の閾値 ([../operations/MIGRATION_TO_AWS.md §34.13.3](../operations/MIGRATION_TO_AWS.md)) | Anthropic Console + workspace ハード上限 |
| Supabase DB 容量 | 400MB (Free 80%) | Supabase Pro ($25/月) へ昇格、ダウンタイムなし | 月次 Cron で `pg_database_size` を記録 |
| Supabase API 帯域 | 4GB (Free 80%) | Pro 昇格 (250GB/月化) | Supabase ダッシュボード |

---

## 8. 関連ドキュメント

| ドキュメント | 役割 |
|---|---|
| [../design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) | 技術的実装設計 (Prisma schema / Service 層 / API ルート) |
| [../business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md) | プラン構成 / ダウングレード制御 / 月次予算上限 UI 仕様 |
| [../operations/MIGRATION_TO_AWS.md](../operations/MIGRATION_TO_AWS.md) | DB 容量試算 / Supabase Pro 昇格判断 / AWS RDS 移行検討 |
| [../security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md) | 5 層悪用防止アーキテクチャ / 脅威モデル STRIDE 分析 |
| [../archive/roadmap/SUGGESTION_ENGINE_PLAN.md](../archive/roadmap/SUGGESTION_ENGINE_PLAN.md) | Phase 1〜3 の実装計画 (実装完了済・archive) / Phase 3 LLM Re-ranking 仕様 |
