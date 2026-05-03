# 提案エンジン v2: 技術設計 (Program Design)

本ドキュメントは、本サービスの核心機能である提案エンジン v2 の技術設計を集約する。ビジネスロジック (テナント・課金) は [business/TENANT_AND_BILLING.md](../business/TENANT_AND_BILLING.md)、要件は [archive/developer/REQUIREMENTS.md §13](../archive/developer/REQUIREMENTS.md)、機能仕様は [archive/developer/SPECIFICATION.md §26](../archive/developer/SPECIFICATION.md)、脅威モデルは [security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)、実装計画は [roadmap/SUGGESTION_ENGINE_PLAN.md](../roadmap/SUGGESTION_ENGINE_PLAN.md)、設計議論経緯は [archive/developer/DEVELOPER_GUIDE.md §5.62](../archive/developer/DEVELOPER_GUIDE.md) を参照。

---

## 概要 — 一目で分かる構成 (2026-05-03 時点)

提案エンジンは「**過去の資産 (Knowledge / 過去課題 / 振り返り) を、新しいプロジェクトに自動で結びつける**」サービスの核心機能。本セクションでは、運用者が「何が動いていて、どの API キーが何に使われているか」を一目で把握できるよう、3 つの構成要素を整理する。

### 構成要素マップ

| 構成要素 | 担当 | 課金体系 | 必要環境変数 / 設定 | 実装状況 |
|---|---|---|---|---|
| **Supabase pgvector** | 1024 次元のベクトル類似度検索 (Cosine Similarity) | DB 容量制限内なら無料 | Supabase ダッシュボードで `vector` 拡張を有効化 (DB 設定) | ✅ 6/1 リリース時稼働 |
| **VOYAGE_API_KEY** (Voyage AI `voyage-4-lite`) | テキスト → 1024 次元ベクトル変換 (entity 保存時 + 検索クエリ時) | **200M token/月まで完全無料**、超過分は $0.02/M token | Vercel 環境変数 | ✅ 6/1 リリース時稼働 |
| **ANTHROPIC_API_KEY** (Claude Haiku/Sonnet) | プロジェクト作成時の **自動タグ抽出** (purpose/background/scope → 各種タグ) | 完全従量課金 (無料枠なし)、Haiku 約 ¥1.6/M input token | Vercel 環境変数 | ✅ 6/1 リリース時稼働 (タグ抽出のみ) |
| Anthropic による「上位 N 件への絞り込み再ランキング」 | (将来 Phase 3 構想) | — | — | ❌ **6/1 リリース時点で未実装**。Phase 3 で追加予定 |

### スコアリングの仕組み (3 軸合算)

提案候補の最終スコアは、3 つの類似度の重み付き合算で算出する。

```
最終スコア = (タグ類似度 × 0.3) + (文字列類似度 × 0.2) + (意味類似度 × 0.5)
                ↑                    ↑                      ↑
                Jaccard 係数         pg_trgm                Voyage embedding
                (補助)               (表記ゆれに強い、補助)  (本軸 — 意味で繋がる)
```

| 軸 | 重み | 担当 | データソース |
|---|---|---|---|
| **タグ類似度** | 0.3 | Project タグと候補側タグの Jaccard 係数 | Project / Knowledge の `businessDomainTags` / `techStackTags` / `processTags` |
| **文字列類似度** | 0.2 | pg_trgm (3-gram 部分一致)。「請求書」⇔「請求」のような表記ゆれを拾う | Project の purpose+background+scope / 候補の title+content |
| **意味類似度** | 0.5 | Voyage embedding の Cosine 類似度。「請求書」⇔「インボイス」のような **意味的な近さ** を拾う (本軸) | 各 entity の `content_embedding` (1024 次元) |

**3 軸の縮退モード**: embedding が NULL の候補 (Voyage 障害時 / 既存データで未生成) は意味類似度 = 0 として計算 → 自動的にタグ + 文字列の 2 軸 (合計 0.5) で評価される。**致命的停止にはならない fail-safe 設計**。

### 候補の絞り込み

| ステップ | 内容 | 件数 |
|---|---|---|
| ① 取得 | DB から候補をすべて取得 (visibility + 自プロジェクト除外) | 全件 |
| ② スコア計算 | 3 軸合算で各候補にスコア付与 | 全件 |
| ③ 閾値カット | `SUGGESTION_SCORE_THRESHOLD = 0.05` 未満を除外 | (ノイズ除去) |
| ④ ソート | スコア降順 | — |
| ⑤ 上位 N 件 | カテゴリごとに `SUGGESTION_DEFAULT_LIMIT = 10` 件まで | **各カテゴリ最大 10 件、3 カテゴリで合計最大 30 件** |

**Anthropic による再ランキングはこの段階に存在しない**。スコア計算は純粋に数値演算 (タグ Jaccard + pg_trgm + Voyage embedding cosine) のみで完結する。

### LLM 呼び出しが発生するタイミング

| イベント | 呼び出し | 用途 |
|---|---|---|
| Project 新規作成 | Anthropic 1 回 | 自動タグ抽出 (purpose/background/scope → タグ) |
| Project 新規作成 | Voyage 1 回 | embedding 生成 (本体保存) |
| Knowledge / RiskIssue / Retrospective 新規作成 | Voyage 1 回 | embedding 生成 (本体保存) |
| 上記の更新 (text 変更時のみ) | Voyage 1 回 | embedding 再生成 |
| 上記の更新 (text 非変更、visibility 等のみ) | 0 回 | embedding 再生成スキップ (LLM 課金回避) |
| **提案画面の表示** | **0 回 (LLM 不使用)** | DB 内の embedding と pg_trgm + タグだけで完結 |
| **リスク起票時の inline 軽量サジェスト** | **0 回 (LLM 不使用)** | pg_trgm のみで類似 issue 検索 (PR #5-b で確定: 500ms debounce 中の連続入力で LLM 課金が発生するのを避けるため、意図的に embedding は使わない設計) |

**重要**: 検索・表示系の操作では Anthropic も Voyage も呼ばれない (= ユーザは何度提案を見ても追加課金なし)。Voyage は **データ保存時に 1 回だけ** 呼ばれる ETL 専用の用途で、保存されたベクトルを使った検索は pgvector が DB 内で完結させる。

### 月次コスト試算 (6/1 リリース直後の想定: 5-10 テナント / 月 1000 操作)

| サービス | 推定使用量 | コスト |
|---|---|---|
| Voyage AI | 月 5000 リクエスト × 平均 1500 token = 7.5M token | **¥0** (200M token 無料枠の 4%) |
| Anthropic Haiku | 月 100 プロジェクト作成 × 約 5000 token = 0.5M token | 約 ¥80 (¥1.6/M × 0.5M) |
| Supabase | DB 数十 MB | **¥0** (500MB Free tier の数 %) |
| Vercel Hobby | Function 実行 数千回 | **¥0** (無料枠内) |
| **合計 (推定)** | | **月 ¥100 未満** |

実際の課金発生は Anthropic のみで、規模が伸びても**月 1000 円未満で当分推移する**見込み。

---

## v1 (PR #65) — 旧版の参考

提案エンジン v1 (現行実装) は pg_trgm + タグ Jaccard ベース。

## 23. 核心機能: 提案型サービス (PR #65)

### 23.1 位置付け

本プロダクトの**核心価値**は、単なる情報の一元管理ではなく
「**過去の資産を未来のプロジェクトに自動で活かす**」ことにある。
人が探す限り抜け漏れが発生し、未然に防げた課題が顕在化してしまう。
本機能はその抜け漏れを極小化することを目的とする。

### 23.2 推薦対象

| エンティティ | 絞り込み条件 | 理由 |
|---|---|---|
| Knowledge | `visibility='public'` + 論理削除除外 + **自プロジェクト未紐付け** | 全社で共有済の知見のみを候補にする。自プロジェクト紐付け済は「参考」タブに出しても価値が無く UX ノイズになる (PR #160 で `NOT: { knowledgeProjects: { some: { projectId } } }` を where 節に追加し DB レベルで除外) |
| 過去 Issue (type='issue') | `state='resolved'` + 他プロジェクト (`NOT: { projectId }`) | リスクは未発生の不確実性で「事実」ではないため除外。発生済かつ解消済の課題のみを過去資産として扱う |

**除外** (3 種共通の方針): 自プロジェクトの資産はすべて候補から除く。
普段の一覧で見える + 提案リストの趣旨は「他プロジェクトの過去資産活用」なので
混ぜると UX ノイズになる。Knowledge / Issue / Retrospective で同じ DB レベル除外を採用 (PR #160 で parity 達成)。

### 23.3 類似度計算

2 つの指標の重み付き平均 (Phase 1 の既定は 50% / 50%):

**タグ交差 (Jaccard 係数)**: Project タグ (businessDomain ∪ techStack ∪ process) と Knowledge タグ (tech ∪ process) を
大文字小文字無視・前後空白除去・重複除外した上で集合比較。過去 Issue はタグ列を持たないため `tagScore=0`。

**テキスト類似度 (pg_trgm similarity)**: Project の purpose + background + scope を `$queryRaw` で渡し、
対象テキスト (Knowledge: title + content / Issue: title + content) と比較。PostgreSQL の `pg_trgm` 拡張を
migration で有効化済。`gin_trgm_ops` GIN インデックスで高速化。

**最終スコア**: `(tagScore × 0.5 + textScore × 0.5)` → 閾値 0.05 以上で採用、上位 10 件 (`limit` で可変)。

### 23.4 採用 UX

| 対象 | 操作 | DB 影響 |
|---|---|---|
| Knowledge | 「このプロジェクトに紐付け」 | `knowledge_projects` に中間行 INSERT (skipDuplicates) |
| 過去 Issue | 「雛形として採用」 | 新規 `risks_issues` を type='issue' / state='open' / visibility='draft' で複製。title / content / cause / impact / likelihood / priority / responsePolicy / responseDetail を継承し、reporter は採用者に差し替え |

採用後の Issue は「未然対応」の位置付けなので state='open' からリスタート。過去の result / lessonLearned は持ち越さない。

### 23.5 発動ポイント

- **(A) 新規プロジェクト作成直後**: 作成成功時に `/projects/[id]?suggestions=1` に遷移 → `SuggestionsPanel` をモーダル表示。抜け漏れゼロ化の UX を強制露出する
- **(B) プロジェクト詳細「参考」タブ**: 常設。いつでも再確認できる

両方とも `SuggestionsPanel` を再利用する (DRY 原則 §21.2)。

### 23.6 スキーマ変更

- `projects.process_tags` (JSONB NOT NULL DEFAULT '[]') を追加 (Knowledge 側の粒度に揃える)
- `CREATE EXTENSION IF NOT EXISTS pg_trgm`
- `knowledges.title` / `knowledges.content` / `risks_issues.title` / `risks_issues.content` に `gin_trgm_ops` インデックス

### 23.7 認可

- GET: `project:read` (メンバー or admin)
- POST (採用): `project:update` (pm_tl / member / admin)
- 他プロジェクトの Issue を含むため「そのプロジェクトのメンバー」に閲覧を限定

### 23.8 フェーズ

| フェーズ | 内容 | 状態 |
|---|---|---|
| Phase 1 | タグ交差 + pg_trgm、参考タブ + 作成後モーダル、Knowledge 紐付け + Issue 雛形複製 | PR #65 で実装 |
| Phase 2 (a) | Retrospective を推薦対象に追加 (読み物として提示、採用操作なし) | PR #65 で追加実装 |
| Phase 2 (b) | Knowledge に businessDomainTags 追加、Project と対称化 | PR #65 で追加実装 |
| Phase 2 (c) | リスク起票ダイアログで類似過去課題を inline 提示 (500ms debounce) | PR #65 で追加実装 |
| Phase 2 (d) 延期 | フィードバック学習 (採用/却下履歴) — 実運用データ蓄積後に再検討 | 未着手 |
| Phase 2 (e) 延期 | 振り返りからナレッジ化自動フロー — 責務が「蓄積」側なので別 PR | 未着手 |
| Phase 3 | 埋め込みベクトル検索 (pgvector + OpenAI embeddings)、精度評価指標の監視 | 未着手 |

### 23.10 Phase 2 追加要素の詳細 (PR #65 続編)

**(a) Retrospective 推薦**
- `suggestForProject` が返す `SuggestionsResult.retrospectives` に追加
- テキスト類似度は `problems + improvements` 連結で計算 (振り返りの最も意味のある部分)
- `gin_trgm_ops` インデックスを `retrospectives.problems` / `retrospectives.improvements` に付与
- UI は `SuggestionsPanel` に読み物専用セクションとして追加、採用ボタンなし

**(b) Knowledge.businessDomainTags**
- スキーマに `business_domain_tags JSONB NOT NULL DEFAULT '[]'` 追加
- `unifyKnowledgeTags` に反映、Jaccard の比較軸を Project と対称化
- Knowledge 作成フォームに 3 種類のタグ入力欄 (businessDomain / tech / process) を追加
- 既存ナレッジは空配列で起動、PATCH で後追い登録可

**(c) 起票中の類似過去課題 inline 提示**
- 専用軽量 API `POST /api/projects/:projectId/suggestions/related-issues`
- 入力 text が 10 文字以上のときのみ、500ms debounce で問い合わせ
- 閾値 0.08 / 上位 5 件 (メインフォームの表示スペースを圧迫しないため Phase 1 より厳しめ)
- 過去同種課題への気付きを促す警告バナー UI

### 23.9 実装ファイル参照

- `src/lib/similarity.ts` / `similarity.test.ts` — 純粋関数 (Jaccard / unify / combineScores) + 16 テストケース
- `src/services/suggestion.service.ts` — サービス層 (DB クエリ + 採用操作 + pg_trgm raw SQL)
- `src/app/api/projects/[projectId]/suggestions/route.ts` — GET
- `src/app/api/projects/[projectId]/suggestions/adopt/route.ts` — POST (採用)
- `src/app/(dashboard)/projects/[projectId]/suggestions/suggestions-panel.tsx` — 共通 UI (参考タブ + 作成後モーダル共用)

---


---

## v2 — 提案エンジン v2: アーキテクチャと多層防御 (T-03 / 2026-06-01 リリース、DESIGN.md §34 全文)

## 34. 提案エンジン v2: アーキテクチャと多層防御 (T-03 / 2026-06-01 リリース)

本セクションは、提案エンジン v2 の技術設計を記述する。要件定義は [REQUIREMENTS.md §13](./REQUIREMENTS.md)、機能仕様は [SPECIFICATION.md §26](./SPECIFICATION.md)、脅威モデルは [docs/security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)、実装計画は [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) を参照。本セクションでは「どう作るか」の技術判断を記述する。

### 34.1 全体アーキテクチャ

提案エンジン v2 は 3 段階のパイプラインで構成される。第一段階は LLM (Claude Haiku) による自動タグ抽出で、ユーザの新規プロジェクト入力を受け取って構造化タグを抽出する。第二段階は pgvector による意味検索で、Voyage AI で生成した embedding ベクトルを Cosine Similarity で照合し、上位 N 件の候補を取得する。第三段階は v1.x で追加される LLM Re-ranking で、上位候補を Claude が並び替えて説明文を付与する。v1 リリースでは第一・第二段階を実装し、第三段階は後続バージョンで追加する。

各段階は独立して動作し、後段が失敗しても前段の結果を返せる優雅な縮退設計とする。第三段階が未実装または失敗した場合は第二段階の embedding スコア順をそのまま返し、第二段階が失敗した場合は v1 互換の Jaccard + pg_trgm スコアにフォールバックする。

### 34.2 データモデルの拡張

提案エンジン v2 の動作のため、複数のテーブルにカラムを追加する。

**User テーブル** には以下のカラムを追加する。`subscription_tier` (string、デフォルト 'free'、'free' / 'pro_trial' / 'pro' のいずれか) はプラン管理用のフラグで、LLM のモデル切替に使う。`current_month_token_usage` (bigint、デフォルト 0) は今月の累計 LLM トークン消費量で、月間上限の判定に使う。`monthly_token_limit` (bigint、デフォルト 100000) はプラン別の上限値で、subscription_tier の変更時に同時に更新する。`last_token_reset_at` (timestamptz) は月初リセット日時で、Vercel Cron による月次リセットの基準点となる。

**Knowledge / RiskIssue / Retrospective / Memo / Project テーブル** には `content_embedding` (vector(1024)) カラムを追加する。これは Voyage AI の `voyage-4-lite` モデル (1024 次元) で生成される embedding ベクトルで、データ作成・更新時に同期的に生成される。NULL を許容し、生成失敗時のフォールバック動作を保つ。

> **2026-05-02 更新**: 当初選定の `voyage-3-lite` (1536 次元) は旧世代化し、無料枠が失効 ($0.02/M tokens 課金) したため、新世代の `voyage-4-lite` (1024 次元、200M トークン無料) に切り替えた。公式ドキュメント (https://docs.voyageai.com/docs/embeddings) で「4 系は 3 系より品質・コンテキスト長・レイテンシ・スループット全面で優れる」と明記されている。本切替により v1 規模 (1 万プロジェクト想定) でも完全無料運用が可能となった。

**新規テーブル `token_usage_audit`** を追加する。これはユーザ単位月間トークン使用量の不正改ざん検知のための監査ログで、毎日 1 度のスナップショットを記録する。`(user_id, snapshot_date, token_usage)` をキーとし、不自然なリセットや減少を事後検出可能にする。

**新規テーブル `llm_call_log`** を追加する。これは LLM 呼び出しの完全な監査ログで、`(timestamp, user_id, entity_type, model_name, input_tokens, output_tokens, latency_ms, ip_address, user_agent, request_id)` を記録する。法的な「合理的な記録の保持」要件を満たし、ユーザクレーム対応の根拠となる。

**新規テーブル `subscription_tier_change_log`** を追加する。これは subscription_tier の変更履歴を記録する監査ログで、`(timestamp, user_id, before_tier, after_tier, changed_by, reason)` を保存する。不正な権限昇格の検出と、決済プロバイダ webhook からの変更の追跡に使う。

### 34.3 5 層悪用防止アーキテクチャ

本機能は経済的損失リスクが極めて高いため、5 層の防御をすべて実装する。各層は独立して機能し、ある層が破られても他の層で被害を抑え込む設計とする。

**第一層: シークレット保護**。Anthropic と Voyage AI の API キーは Vercel 環境変数 (`ANTHROPIC_API_KEY` / `VOYAGE_API_KEY`) のみに格納し、コードには絶対に含めない。Husky による git pre-commit hook で gitleaks が実行され、コミット前に API キー候補のパターンを検出した場合はコミットを拒否する。GitHub Push Protection を repo 設定で有効化し、push の段階でも自動検知する二重防御を実現する。エラーログ (`recordError` 関数内) は API キー候補のパターンを正規表現でマスク化してから DB に書き込む。`process.env.ANTHROPIC_API_KEY` は Server Action と Route Handler 内でのみ参照し、絶対に client side に渡さない。Anthropic SDK の呼び出しはすべて Next.js のサーバ側で完結する。

**第二層: 認証・認可の強化**。OSS 公開によって不正アカウント乱造のリスクが高まるため、サインアップ時に Cloudflare Turnstile (無料 tier) を導入し、bot 経由の自動アカウント作成を弾く。サインアップエンドポイントには Upstash Redis ベースの IP rate limit (1 IP / 1 時間 / 5 アカウントまで) を設定する。メールアドレスの正規化 (`+` トリックや小数点の除去) で同一アドレスからの複数登録を検出する。サインアップ直後 24 時間以内に LLM 機能を集中使用するパターン (例: 100 回以上の suggestion 表示) は admin に通知する。

**第三層: ユーザ単位レート制限とトークン上限**。LLM 呼び出しを行うすべての API ルートに、共通ミドルウェア `withLLMRateLimit()` を適用する。このミドルウェアは以下の 3 つのチェックを順に実行する。第一に Upstash Redis での短期 rate limit (1 ユーザ / 1 分 / 10 回、1 ユーザ / 1 時間 / 60 回) を確認し、超過時は 429 を返す。第二に DB から `User.current_month_token_usage` を取得し、`monthly_token_limit` を超過していれば 429 を返す。第三に LLM 呼び出し成功後に消費トークン数を `current_month_token_usage` に加算する。これらのチェックを実装ミスで飛ばさないため、LLM 呼び出しは必ずミドルウェア経由で行うことを設計ルールとして DEVELOPER_GUIDE に明記する。

**第四層: プロンプトインジェクション対策**。ユーザ入力を LLM に渡す処理は、必ず `@/lib/llm-prompt-builder.ts` の共通関数経由で行う。この関数は以下を強制する: ユーザ入力の長さ制限の再検証 (DB 制約とは別に LLM 呼び出し直前にも検証)、システムプロンプトとユーザ入力の XML タグでの明確な分離 (`<user_input>` `</user_input>` で囲み、Anthropic ベストプラクティスに従い「タグ内側は信頼できない外部データ」と明示)、LLM 出力の zod スキーマによる構造化検証、コンテキスト隔離 (他ユーザの個人情報・admin 情報・システム秘匿情報を絶対にプロンプトに含めない)。LLM 呼び出しのコードレビューでは、これらの 4 点が実装されていることを必ず確認する。

**第五層: workspace 上限と監視**。Anthropic workspace の月間予算ハード上限を $30 (= 約 4500 円、想定使用量 $10 の 3 倍) に設定する。これにより、上記 4 層がすべて破られても、最終的な損失は $30 に制限される。さらに workspace 使用量が上限の 80% に達した時点で admin にメール通知が飛ぶ閾値を設定する。Voyage AI 側も同様の上限と通知を設定する。

### 34.4 LLM 統合の実装パターン

LLM (Anthropic) と Embedding (Voyage AI) の呼び出しは、それぞれ専用のサービス層に集約する。

`@/services/auto-tag.service.ts` は Phase 1 の自動タグ抽出を担当する。入力は `{ purpose: string, background: string, scope: string }`、出力は `{ businessDomainTags: string[], techStackTags: string[], processTags: string[] }`。内部では Claude Haiku を使い、システムプロンプトで「以下のプロジェクト説明から、businessDomainTags / techStackTags / processTags を抽出してください。各タグ列には最大 5 個まで、簡潔な単語または短いフレーズを返してください」と指示する。出力は zod スキーマで検証し、形式不正時は空配列を返してフォールバックする。

`@/services/embedding.service.ts` は Phase 2 の embedding 生成と検索を担当する。`generateEmbedding(text: string): Promise<number[]>` は Voyage AI を呼び出して 1024 次元のベクトルを返す (voyage-4-lite default)。`searchSimilar(queryVector, entityType, options): Promise<Result[]>` は pgvector の Cosine Similarity 検索を実行する。Cosine Similarity は `<=>` 演算子を使い、HNSW インデックス (将来追加候補) で高速化する。

`@/services/suggestion.service.ts` は既存の v1 サービスを拡張する形で、3 軸統合スコアリングを実装する。`suggestForProject(projectId, options)` の内部で、第一段階としてプロジェクトの content_embedding を取得 (なければ生成)、第二段階として候補テーブルから embedding 検索で上位 50 件取得、第三段階として 50 件に対してタグ Jaccard と pg_trgm スコアを計算し 3 軸で合成、第四段階として閾値で足切りして上位 N 件を返す、という流れを取る。

### 34.5 Embedding の生成タイミングと整合性

embedding はデータ作成・更新時に同期的に生成する。Knowledge / RiskIssue / Retrospective / Memo / Project の `create` / `update` で content フィールドが変更された場合、その Server Action 内で embedding を再生成する。生成中の不整合を避けるため、embedding 生成失敗時はトランザクション全体をロールバックせず、`content_embedding` を NULL にしてから commit する (本体データの保存を優先する設計)。

NULL になった embedding は、Vercel Cron で日次に動作する `@/cron/regenerate-embeddings.ts` が検出して非同期に再生成する。これにより、API 障害時でもデータ保存は成功し、後続の cron で復旧する優雅な縮退を実現する。

### 34.6 監視と異常検知のデータモデル

[REQUIREMENTS.md NF-13.4](./REQUIREMENTS.md) の要件「将来的にサービス内ダッシュボード `/admin/observability/llm` を構築する」を満たすため、監視データは構造化された形で DB に蓄積する。

`llm_call_log` テーブルは個別呼び出しの完全記録を担い、`token_usage_audit` テーブルはユーザ単位の月次累積をスナップショットする。日次集計のため、`@/cron/llm-cost-aggregation.ts` が毎日 1 度動作し、当日の合計コスト・ユーザ別使用量・エラー率を `llm_daily_summary` テーブルに集計する。これらのテーブルは将来のダッシュボード UI のクエリ元として直接利用され、新たな集計ロジックの実装を不要にする。

異常検知は集計バッチ内で行う。当日の合計コストが過去 30 日平均の 3 倍を超えた場合、特定ユーザが過去 1 時間で平均利用量の 10 倍を超えた場合、いずれかが検出されたら admin にメール通知を送る。通知メールには対象ユーザ ID・時刻・トークン数を含めるが、ユーザの個人情報 (氏名・メールアドレス) は含めず、admin が必要に応じて DB を直接参照する設計とする (個人情報の不必要な転送を避ける)。

### 34.7 設定値と外出し

提案エンジンの動作を支配する数値定数はすべて `@/config/suggestion.ts` に外出しし、運用中のチューニングを可能にする。タグ Jaccard 重み (`SUGGESTION_TAG_WEIGHT`、デフォルト 0.3)、pg_trgm 重み (`SUGGESTION_TEXT_WEIGHT`、デフォルト 0.2)、embedding 重み (`SUGGESTION_EMBEDDING_WEIGHT`、デフォルト 0.5)、スコア閾値 (`SUGGESTION_SCORE_THRESHOLD`、デフォルト 0.05)、件数上限 (`SUGGESTION_DEFAULT_LIMIT`、デフォルト 10)、月間トークン上限 (`MONTHLY_TOKEN_LIMIT_FREE` = 100000、`MONTHLY_TOKEN_LIMIT_PRO` = 1000000) を含む。

LLM プロンプトのテンプレートは `@/config/llm-prompts.ts` に外出しし、プロンプトエンジニアリングのチューニングを実装変更なしに可能にする。各プロンプトには版数を付与し、変更履歴を git 履歴で追跡可能にする。

### 34.8 テスト戦略

提案エンジン v2 のテストは 3 層で構成する。

**ユニットテスト**: `auto-tag.service.test.ts`、`embedding.service.test.ts`、`suggestion.service.test.ts` を新設または拡張し、各サービスのロジックを独立して検証する。LLM API と Embedding API は完全にモック化し、テストの再現性とコストの両方を担保する。プロンプトインジェクション攻撃を模した入力に対して、LLM 呼び出しが防御できているかを確認するテストケースを必ず含める。

**統合テスト**: `/api/projects/[id]/suggestions` エンドポイントに対する統合テストで、認証・認可・rate limit・トークン上限・LLM 呼び出し・結果のスコアリング・閾値での足切りまでを E2E で検証する。Playwright ではなく vitest の `supertest` 相当で実装する。

**E2E テスト**: 新規プロジェクト作成 → タグ自動抽出 → 提案表示までを Playwright で検証する。LLM はモック化するが、API ルート / DB / UI の連携を実機で確認する。

### 34.9 既存コードへの影響範囲

v1 提案エンジン (PR #65 で実装) は段階的に v2 に置き換える。`@/services/suggestion.service.ts` の `suggestForProject` 関数のスコア計算部分のみが変更され、API シグネチャは維持される。これにより、`@/app/(dashboard)/projects/[projectId]/suggestions/suggestions-panel.tsx` などの呼び出し側コードは無修正で動作する。

embedding カラムの追加に伴う既存データの backfill は、初回 deploy 時に動作する `scripts/backfill-embeddings.ts` で実行する。1000 件のエンティティで処理時間は約 10 分、コストは $0.01 程度と見込まれる。backfill 中は提案精度が一時的に低下する (embedding 軸が NULL なので 0 として扱われる) が、ユーザ操作は阻害されない。

### 34.10 v1.x バージョンアップでの拡張ポイント

本設計は v1.x 以降の拡張を前提とした構造を持つ。

Phase 3 (LLM Re-ranking) を追加する際は、`@/services/suggestion.service.ts` に `rerank()` 関数を追加し、Phase 2 の結果を入力として受け取る。Pro プラン (Sonnet) と Free プラン (Haiku) の切り替えは、`User.subscription_tier` を見るモデル名分岐で実装する。プロンプトキャッシュは Anthropic SDK の prompt caching 機能と Postgres でのアプリケーションレベルキャッシュ (5〜10 分 TTL) を併用する。

30 日無料試用は `User.subscription_tier='pro_trial'` と `trial_ends_at` カラムで実装し、Vercel Cron で日次に期限切れユーザを `'free'` にダウングレードする。ティーザー機能は `User.teaser_uses_this_month` カラムで管理し、月 3 回まで Sonnet 出力を許可する。

組織単位課金は将来 Organization テーブルを新設して User.organization_id で紐付けする形で導入する。この時 subscription_tier は Organization に移管し、User 側のフィールドは互換のため残しつつ Organization の値を優先する設計とする。これは v2 以降の本格的なエンタープライズ展開時に検討する。

### 34.11 マルチテナント アーキテクチャ (外部公開後の運用前提)

§34.1〜§34.10 は「単一テナント前提」で記述したが、本サービスは外部公開後 **マルチテナント SaaS** として運用する設計を本セクション以降で定める。各外部ユーザ (個人または組織) ごとに **論理テナント** を割り当て、テナント間ではデータが完全に分離される構造とする。これにより、悪用された場合の影響を当該テナントに閉じ込めることができ、また他テナントのデータを誤って提案候補に混入させるリスクを構造的に排除できる。

#### 34.11.1 テナントの位置付けと運用フロー

外部ユーザが本サービスの利用を申し込んだ時点で、運用者 (admin) は新たな論理テナントを作成し、そのテナント内に当該ユーザを最初の管理者として招待する。テナント作成と同時に **初期シードデータ** (資格試験事例・著名な法則の独自要約 30〜100 件) が当該テナントに自動的に投入され、新規ユーザはサインアップ直後から提案エンジンの価値を体験できる状態になる。これは初期離脱を防ぐための仕組みで、データが空のために「このサービスは何の価値もない」と判断される時間をゼロに近付ける。

外部ユーザは自身のテナント内でサービスを利用し、データを蓄積していく。テナント間ではデータが完全に分離されているため、運用者 (私) が登録したデータを外部ユーザが閲覧・更新・削除することはなく、逆に外部ユーザが登録したデータを運用者が閲覧することもない。この相互不可視性は、**機密情報を扱う法人ユーザの導入障壁を下げる重要な設計判断** である。同時に、運用者にとっても「ユーザのデータを見たくない・触りたくない」という運用上の安全装置として機能する。

外部ユーザがサブスクリプション (Pro プラン) を契約した場合、その契約は当該テナント単位で適用され、テナント全体の `subscription_tier` が `'pro'` に変更される。これにより、テナント内のすべてのユーザが Sonnet 出力 (深い説明文付きの提案) を享受できるようになる。逆に契約解除時はテナント全体が Free プランに戻り、すべてのユーザの体験が縮退する。

利用停止時 (チャーン) は、生成 AI の悪用 (退会後の API 連打など) を防ぐためテナント自体を削除する運用とする。テナント削除時は当該テナントに紐付くすべてのデータ (ユーザ、プロジェクト、ナレッジ、リスク、振り返り、メモ、添付、コメント、メンション、通知、監査ログ等) を物理削除する。法的な保存義務がある特定のログ (例: 監査ログ) のみ、別途匿名化して保管する例外を設けるが、提案エンジンの動作に必要なデータは完全に削除する。テナント削除の運用詳細 (グレースピリオド、データエクスポート猶予、課金清算等) は OPERATION.md で別途定める。

#### 34.11.2 データモデル: Tenant エンティティの中心化

新規エンティティとして `Tenant` テーブルを追加し、これを **業務データの最上位の認可境界** とする。

```
model Tenant {
  id                       String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  slug                     String   @unique @db.VarChar(50)  // URL 識別子 (例: 'acme-corp')
  name                     String   @db.VarChar(100)         // 表示名
  subscriptionTier         String   @default("free")          // 'free' | 'pro_trial' | 'pro'
  currentMonthTokenUsage   BigInt   @default(0)
  monthlyTokenLimit        BigInt   @default(100000)
  trialEndsAt              DateTime?
  suggestionDailyLLMCalls  Int      @default(0)              // 提案多用に対する日次キャップ用
  createdAt                DateTime @default(now())
  deletedAt                DateTime?

  users        User[]
  projects     Project[]
  knowledges   Knowledge[]
  // ... 他の業務エンティティすべてが Tenant に紐付く
}
```

User テーブルには `tenantId` カラムを追加し、ユーザが所属するテナントを明示する。1 ユーザは 1 テナントにのみ所属する (シンプルさを優先、複数テナント所属は将来 Organization 化のタイミングで再検討)。同様に Project / Knowledge / RiskIssue / Retrospective / Memo / Customer / Stakeholder / Comment / Mention / Notification / Attachment / SystemErrorLog の各テーブルにも `tenantId` カラムを追加し、すべての業務データがいずれかのテナントに属することを保証する。

§34.2 で述べた `current_month_token_usage` / `monthly_token_limit` / `subscription_tier` は **User ではなく Tenant に配置** する。これによりテナント内の複数ユーザが同じ予算を共有し、コスト管理が「契約単位 = テナント単位」と完全に一致する。1 ユーザのテナントでも 100 ユーザのテナントでも、課金とコスト管理の単位は変わらない。

#### 34.11.3 テナント認可の二段階モデル

提案エンジン v2 を含むすべての業務処理において、認可は **2 段階で評価** する。

**第一段階はテナント境界の確認** で、リクエストを発行したユーザの `tenantId` と、操作対象データの `tenantId` が一致することを必ず検証する。これは API ルートの最初の行で実施する標準パターンとし、すべてのクエリの WHERE 句に `tenantId` 条件を含める。`@/lib/permissions.ts` に `requireSameTenant(user, entity)` ユーティリティを新設し、認可ロジックの入り口として機能させる。

**第二段階はテナント内の認可** で、これは既存の認可ロジック (project member / system role / visibility) をそのまま流用する。テナント内ユーザは互いの公開データを共有でき、private データは作成者のみがアクセスできる、という現在の設計はテナント内に限定して継続する。

この二段階構造により、認可ロジックの変更は **第一段階の追加** のみで完結し、既存の第二段階ロジックには手を入れずに済む。これは大規模な refactoring を避ける重要な設計判断である。

PostgreSQL Row-Level Security (RLS) を将来的なオプションとして検討する。これは DB レベルでテナント境界を強制する仕組みで、アプリケーション層のバグでテナント境界を越えてしまった場合の最終防衛線となる。ただし RLS は実装の複雑度を上げるため v1 では導入せず、アプリケーション層での `tenantId` フィルタの徹底で対処する。RLS への移行は v1.x または v2 で再検討する。

#### 34.11.4 提案エンジンの動作: テナント内に閉じる

§34.4 で述べた suggestion.service の動作を、マルチテナント前提に修正する。`suggestForProject(projectId)` は内部で当該プロジェクトの `tenantId` を取得し、候補検索の WHERE 句に `tenantId` フィルタを追加する。これにより **提案候補は必ず同じテナント内のデータのみ** に絞り込まれ、テナント間でデータが混入する経路を構造的に排除する。

embedding 検索においても、pgvector の Cosine Similarity 検索の WHERE 句に `tenantId = $1` を含める。HNSW インデックスは `(tenantId, content_embedding)` の複合インデックスで作成することで、テナント数が増えても検索性能を維持する。

初期シードデータは **テナント作成時に当該テナント内に複製** される。これは「すべてのテナントが同じ参照データを共有する」のではなく、「各テナントが独立した参照データのコピーを持つ」設計である。データ重複によるストレージ消費は微小 (1 テナントあたり ~6KB × 100 件 = ~600KB) で、Supabase Free 枠 500MB に対して 100 テナント分でも 60MB 程度に収まる。逆にこの設計の利点は、テナントがシードデータを編集・追加できる柔軟性、テナント削除時の整合性 (シードデータも一緒に消える)、テナント間の独立性の担保である。

#### 34.11.5 LLM 多用に対するコスト保護

「参考」タブなどユーザが提案を多用する経路でコストが暴発するリスクを抑制するため、**3 段階のコスト保護** を実装する。

**第一段階は積極的キャッシュ戦略** で、Phase 3 の LLM Re-ranking 結果は `(tenantId, projectId, contentHash)` をキーにして Postgres に 5〜10 分間キャッシュする。同一プロジェクトで suggestions パネルを連続で開いた場合、初回のみ LLM を呼び、以降はキャッシュから返す。これにより典型的な「タブを行き来する」操作のコストを 1 操作分に圧縮する。`contentHash` はプロジェクトの purpose/background/scope の SHA-256 で算出し、内容が変わったら自動で無効化する。

**第二段階はテナント単位の日次 LLM 呼び出しキャップ** で、`Tenant.suggestionDailyLLMCalls` カラムで 1 日あたりの Phase 3 LLM 呼び出し回数を追跡する。Free プランは日次 30 回、Pro プランは日次 200 回を上限とし、超過時は Phase 3 をスキップして Phase 2 (embedding ベースの並びのみ) を返す。これにより悪意ある「タブを連打する」攻撃や、UI バグによる無限ループでも被害が日次上限で打ち止めになる。

**第三段階は月間トークン上限と Anthropic workspace 上限** で、これは §34.3 で述べた既存の防御線をそのまま継承する。Free 10万 / Pro 100万 トークンに加え、workspace 全体で $30 (約 4500 円) のハード上限が最終防衛線となる。

これら 3 段階により、最悪ケースでも 1 テナントあたりの月間損失は数百円〜千円程度に制限され、サービス全体では workspace 上限の 4500 円を超えることはない。

#### 34.11.6 テナント識別とルーティング

外部ユーザがアクセスする URL は `https://tasukiba.vercel.app/{tenantSlug}/...` の **path-based ルーティング** を採用する。サブドメインベース (`{slug}.tasukiba.vercel.app`) も検討したが、Vercel 標準ドメインでのワイルドカード DNS 設定が煩雑、SSL 証明書の管理、サブドメイン名の制約 (DNS 仕様) などの理由で path-based を選択した。将来的な独自ドメイン化 (例: customer の独自ドメインで運用) は v2 以降で検討する。

Next.js の動的ルートとして `app/(tenant)/[tenantSlug]/...` のようなディレクトリ構造を採用するか、middleware でテナント解決してから既存のルートに転送するか、の 2 択がある。後者のほうが既存のルート構造を維持できるため、middleware でテナント slug を抽出して `request.headers` に追加し、各 API ルートで `getTenantFromRequest()` ヘルパー経由で取得する形を採る。これにより、既存のルートは最小限の変更で multi-tenant 対応できる。

セッション (NextAuth.js) には `user.tenantId` を含めるよう拡張する。これにより、ユーザがどのテナントに所属するかが session 内で常に解決でき、認可チェックが軽量化される。テナント切り替え (将来的に複数テナント所属を許す場合) は session の更新で実現する。

#### 34.11.7 v1 (6月1日) でのテナント実装範囲

リリース日厳守のため、v1 でのテナント実装は **「単一デフォルトテナントへの収容」** に絞る。具体的には以下を v1 で実装する。

Tenant テーブルの新設、User と全業務エンティティへの `tenantId` カラム追加、既存データを `default-tenant` という単一テナントに紐付ける migration、`subscription_tier` / `current_month_token_usage` / `monthly_token_limit` / `suggestionDailyLLMCalls` の Tenant への配置、すべての API ルートでの `tenantId` フィルタ追加、middleware でのテナント解決ヘルパー、提案エンジン内の WHERE 句更新、初期シードデータの当該テナントへの投入、を v1 リリースの最小スコープとする。

これにより、**v1 時点では実質的に 1 テナント (default-tenant) のみが存在し、すべてのユーザがそこに所属する** 状態となる。コード上はマルチテナント完全対応だが、運用上は単一テナントとして稼働する。これは将来のテナント追加が「テナント新設 + ユーザ招待」の運用作業のみで完結する状態を作り出すことが目的で、外部ユーザの最初の申し込みが来た時点で、admin 操作で新規テナントを作成し、招待メールを送る、という運用が可能になる。

v1.x で実装する範囲は、テナント管理 UI (admin only)、テナント作成時のシードデータ自動投入、テナント削除時のカスケード削除、テナント招待メール、テナント slug の URL ルーティング (path-based)、自己テナント設定画面 (テナント名変更等)、課金プロバイダ (Stripe) 連携、を想定する。これらは外部ユーザの本格的な受け入れと並行して実装する。

#### 34.11.8 既存データのマイグレーション戦略

v1 リリース時、既存ユーザは全員 `default-tenant` に所属することになる。この migration は破壊的でなく、`tenantId` カラムを追加して既存レコードに `default-tenant` の ID を設定するだけで完結する。`prisma migrate` で安全に実行可能で、ダウンタイム不要。

既存の visibility=public データはすべて default-tenant 内で公開された状態となり、運用者 (私) が登録した「教科書事例」などのナレッジも default-tenant 内のユーザに表示される。ここまでは v1 の動作として正常である。

外部ユーザが申し込みで新テナントが作られた時点で、その新テナントには **教科書事例の独自コピー** が新規生成される (default-tenant のレコードを clone)。これにより新テナントのユーザは、運用者の作ったコンテンツを **そのテナント内のローカルコピー** として閲覧できる。逆に運用者は新テナントの内部データを見ることができない (=テナント境界の相互不可視性が成立)。

### 34.12 テナント単位の課金とコスト管理

#### 34.12.1 Free プランと Pro プランの境界

Free プランのテナントは月間 100,000 トークンの上限を持ち、提案エンジンは Haiku で動作し、日次 LLM 呼び出しキャップは 30 回となる。Pro プランのテナントは月間 1,000,000 トークン (10 倍) の上限を持ち、提案エンジンは Sonnet で動作し (v1.x で有効化)、日次 LLM 呼び出しキャップは 200 回となる。

これらの数値はテナント創設時に `Tenant` テーブルにコピーされ、運用中の上限変更は admin 操作で個別テナントごとに調整可能とする (例: エンタープライズ顧客向けに 10 倍プランを提供する場合)。

#### 34.12.2 課金プロバイダとの連携 (将来計画)

v1 ではすべてのテナントが Free プランで運用され、課金は発生しない。v1.x で Stripe を統合し、Pro プランへのアップグレードを Stripe の subscription として実装する。Stripe の webhook で `subscription.created` / `subscription.deleted` イベントを受信し、`Tenant.subscriptionTier` を `'pro'` または `'free'` に更新する。webhook 受信時はシグネチャ検証を必須とし、不正な更新を防ぐ。

Stripe との連携時、テナント ID と Stripe customer ID の対応を `Tenant.stripeCustomerId` で保持する。サブスク状態の変更履歴は `subscription_tier_change_log` テーブルに記録し、不正な権限昇格を事後追跡可能にする。

#### 34.12.3 コスト可視化と admin への通知

admin はサービス内の `/admin/observability/llm` ダッシュボード (v1.x で実装) で、テナントごとの月間トークン使用量・コスト・上限到達状況を確認できる。これは Phase 3c の `/admin/observability` の一部として実装され、提案エンジン以外の LLM 利用 (将来追加されうる機能) も統合的に表示する。

異常検知は v1 から最小実装され、特定テナントの使用量が前日比 5 倍を超えた場合、特定テナントが workspace 上限の 80% に達した場合、admin にメール通知を送る。通知メールにはテナント slug と異常パターンを含め、admin が即座に対処判断できるようにする。

### 34.13 インフラスケーラビリティと将来の移行計画

現状のインフラ (Vercel Hobby + Supabase Free) は試験運用段階での運用には十分だが、**外部ユーザ拡大に伴いいくつかの制約に直面する可能性** がある。本セクションでは、これらの制約と移行候補を整理する。

#### 34.13.1 Vercel の制約と回避策

Vercel Hobby プランの主要な制約は、Function 実行時間の上限 (Hobby: 10 秒、Pro: 60 秒、Enterprise: 900 秒) と、月間 Function 実行回数の制約である。提案エンジンは LLM 呼び出しと embedding 検索を含むため、Phase 3 の re-ranking では Anthropic API のレスポンス時間 (1〜3 秒) が乗ることで合計 4〜8 秒となり、10 秒上限の余裕は徐々に薄れる。

短期的な対策として、Vercel Pro プラン ($20/月) へのアップグレードで 60 秒上限を確保する。これは月数千円のコストだが、Function timeout エラーによるユーザ体験の悪化を確実に防ぐ。10 秒上限のままでは、ピーク時に処理が時間切れになる可能性が無視できない。

中期的な対策として、Edge Functions (Cloudflare Workers ベース、低レイテンシ) と Serverless Functions (Node.js、長時間処理向け) の使い分けを最適化する。LLM 呼び出しのような長時間処理は Serverless Functions に閉じ込め、軽量な GET リクエストは Edge に乗せることで、それぞれの強みを活かす。

長期的な視点として、ユーザが **数千〜数万人規模に達した場合** は、Vercel から AWS / Azure / GCP への移行を検討する余地がある。具体的には、Next.js の output mode を `standalone` に変更して Docker 化し、AWS ECS Fargate / Azure Container Apps / Google Cloud Run のいずれかにデプロイする選択肢がある。これらの選択肢は Function 実行時間の制約がなく、必要に応じて instance の縦・横スケールが可能。コストは Vercel より低く抑えられる場合があるが、運用負荷は増す。

#### 34.13.2 Supabase の制約と移行候補

Supabase Free プランの主要な制約は、データベースサイズ (500MB)、月間 API 呼び出し数 (50,000 / 月)、同時接続数 (60)、月間帯域 (5GB) である。提案エンジンの embedding カラムは 1 行あたり 6KB と大きく、テナント数が増えると 500MB 上限に到達する可能性がある。100 テナント × 平均 1000 entity × 6KB = 600MB と、Free 枠を超える試算になる。

短期的な対策として、Supabase Pro プラン ($25/月) で 8GB のデータベースサイズに拡大する。これでも数千テナント規模までは余裕が生まれる。

中期的には、AWS RDS for PostgreSQL に移行する選択肢がある。Supabase の独自機能 (Auth、Realtime、Storage) を本サービスがほとんど使っていないため、移行の障壁は低い。RDS なら 1TB 規模のデータベースを月数十ドルで運用でき、IOPS の調整も柔軟である。

#### 34.13.3 移行判断のトリガー条件

インフラ移行は早すぎても遅すぎてもコストになる。以下を **移行検討のトリガー** として記録しておく。

第一に、月次の Vercel Function timeout エラー率が 1% を超えた場合。これはユーザが「ロードが終わらない」体験をする頻度を意味し、サービス品質の悪化シグナルとなる。

第二に、Supabase データベースサイズが Free / Pro プランの 80% に達した場合。これは数ヶ月以内に上限到達することを意味し、移行を計画する時間的余裕を確保する。

第三に、月間 Anthropic / Voyage の API 利用料が $100 を超えた場合。これはサービスが事業として成立する規模に達したことを意味し、より柔軟なインフラへの投資を正当化する。

第四に、ユーザから「動作が遅い」というフィードバックが構造的に集まった場合。これは単一の指標ではなく総合的な判断だが、最も重要なトリガーである。

#### 34.13.4 移行時のコード変更ポイント

本サービスのアーキテクチャは、現時点で **インフラに対する依存をほぼコード化していない** ため、移行コストは比較的低い。具体的には、Prisma が DB プロバイダを抽象化しており、PostgreSQL 互換 DB への移行は接続文字列の変更で完結する。Next.js のサーバランタイムも `output: 'standalone'` で Docker 化可能で、Vercel 依存の API (例: `@vercel/cron`) は標準の cron に置き換える程度の変更で対応できる。

移行時の主な作業は、環境変数の再設定、Docker image の構築、CI/CD パイプラインの再構築 (GitHub Actions → AWS / Azure)、監視・ログの再設定 (Vercel Analytics → CloudWatch / Application Insights) である。実工数は 1〜2 週間と見込む。

これらは将来の判断材料として記録するが、v1 リリース時点ではすべて Vercel + Supabase で運用する。本格的な事業拡大段階で判断する。

### 34.14 課金モデル: 3 プラン構成と従量課金 (per-API-call) の確定版

§34.11.4〜§34.12 でテナント単位のコスト管理を扱ったが、**最終的な課金モデルを 3 プラン + 従量課金 (per-API-call)** で確定する。これは「ユーザ数を基準にすると集計直前の意図的なユーザ削除で誤魔化される脆弱性」「アクセスユーザ数を基準にすると未使用ユーザ分のコストが運用者の損失になる構造」の両方を回避し、純粋に「使った分だけ払う」という公平性と「お得感」を両立させる設計判断である。

#### 34.14.1 3 プランの構造

**Beginner プラン** は **無料の試験運用プラン** で、最大 5 席までの席数制限を持ち、Claude Haiku で動作する。月間 100 回までの API 呼び出しが可能で、超過時は提案機能が縮退モード (Phase 2 の embedding ベース並びのみ、説明文なし) に切り替わる。これは小〜中規模プロジェクトでの試用と、上位プランへのアップセル誘導の入り口として機能する。Beginner の制約は「無料を維持しつつ運用者のコスト上限を担保する」という両立を実現する。

**Expert プラン** は **席数無制限の従量課金プラン** で、Claude Haiku で動作する。1 回の API 呼び出しごとに ¥10 が課金され、月間使用量に上限はない (= 使った分だけ請求される)。主に中〜大規模チームで日常的に提案機能を使うユーザを想定する。

**Pro プラン** は **席数無制限の従量課金プラン** で、Claude Sonnet で動作する。1 回の API 呼び出しごとに ¥30 が課金される。Sonnet による深い説明文付きの提案を享受でき、PMO や経営層など「助言の質」を重視するユーザに向けた最上位プランである。

価格は初期値であり、実運用データを見ながら段階的に調整する想定。Tenant テーブルの設定値として外出しし、運用中の柔軟な変更を可能にする。

#### 34.14.2 「1 回の API 呼び出し」の定義 (課金単位)

per-API-call の「1 回」は **ユーザに見える機能単位** で定義する。内部的に複数の LLM / Embedding API 呼び出しが走っても、ユーザから見て 1 つの操作として認識される単位を 1 回としてカウントする。具体的には以下を 1 回とする。

新規プロジェクト作成時の自動タグ抽出 + 初回提案生成は、内部的に Phase 1 の自動タグ抽出 (LLM 1 呼び出し) + content_embedding 生成 (Embedding 1 呼び出し) + Phase 2 検索 (LLM なし) + Phase 3 re-ranking (LLM 1 呼び出し) が走るが、これらをまとめて **1 回** とカウントする。同一プロジェクトの提案画面を再表示する場合、キャッシュヒット時は 0 回、キャッシュ無効後の再生成は 1 回とカウントする。リスク起票時の類似 issue サジェストは 1 回。コメント投稿時の mention 候補補完は通常 0 回 (LLM 不使用)、mention に LLM が関与する将来機能では 1 回。

**embedding 生成 (= データ作成・更新時のバックグラウンド処理) は課金対象外** とする。これはユーザに見えない処理であり、データ蓄積のインセンティブを削がないためである。embedding コストは無視できるレベル (1 件あたり 0.001 円) で、運用者が吸収する。

この定義により、ユーザは「自分がクリックした操作 ≒ 課金額」と直感的に予測でき、メーターを気にせず機能を使える。一方、Phase 3 のキャッシュヒット率向上などの内部最適化を進めても、ユーザの請求額には影響しない。

#### 34.14.3 データモデルの確定

§34.11.2 で示した Tenant テーブルの設計を、課金モデル確定版に更新する。

```
model Tenant {
  id                       String   @id
  slug                     String   @unique
  name                     String
  plan                     String   @default("beginner")  // 'beginner' | 'expert' | 'pro'
  currentMonthApiCallCount Int      @default(0)
  currentMonthApiCostJpy   Int      @default(0)
  monthlyBudgetCapJpy      Int?                            // ユーザ自己設定の月次予算上限
  beginnerMonthlyCallLimit Int      @default(100)          // Beginner プランの月間上限 (default 100、admin 調整可)
  beginnerMaxSeats         Int      @default(5)            // Beginner プランの席数上限 (default 5、admin 調整可)
  pricePerCallHaiku        Int      @default(10)           // 円
  pricePerCallSonnet       Int      @default(30)           // 円
  lastResetAt              DateTime?
  createdAt                DateTime @default(now())
  deletedAt                DateTime?

  users        User[]
  apiCallLogs  ApiCallLog[]
  // ... 他の業務エンティティ
}
```

`subscription_tier` という名称は廃止し、より明確な `plan` に統一する。`current_month_token_usage` も `currentMonthApiCallCount` (回数) と `currentMonthApiCostJpy` (円換算額) の 2 軸で管理する。月間トークン上限の概念は撤廃し、Beginner は回数上限、Expert/Pro は無制限 (従量課金) とする。

新規テーブル `ApiCallLog` を追加する。これは個別の API 呼び出しを記録する完全な監査ログで、`(timestamp, tenantId, userId, featureUnit, modelName, llmInputTokens, llmOutputTokens, embeddingTokens, costJpy, latencyMs, requestId)` を保存する。`featureUnit` は「new-project-suggestion」「project-suggestion-refresh」「risk-creation-suggest」のような機能単位の識別子で、ユーザに見える単位と内部処理の対応を追跡可能にする。これは課金の根拠データとして法的にも重要で、ユーザクレーム対応の根拠となる。

#### 34.14.4 Beginner プランの月間上限の挙動

Beginner プランは月間 100 回の API 呼び出し上限に達した時点で、その月の残期間中は **提案機能が縮退モード** に切り替わる。具体的には、Phase 1 の自動タグ抽出は失敗 → 既存手動タグ入力にフォールバック、Phase 3 の re-ranking はスキップ → Phase 2 の embedding ベース並びのみ表示、という動作になる。embedding ベース並びは LLM を使わないため上限に関わらず利用でき、検索精度の根幹は維持される。

ユーザには明示的に「今月の AI 詳細解析の上限に達しました。来月 1 日にリセットされます。Expert / Pro プランへのアップグレードで上限なくご利用いただけます」というメッセージを表示し、アップグレード導線を強化する。これは「無料で価値を体験 → 限界を感じる → アップグレード」という SaaS の典型的な funnel である。

月初リセットは Vercel Cron で日次に動作するバッチが、`lastResetAt` が前月以前のテナントを検出して `currentMonthApiCallCount = 0` にリセットする。リセット時刻は UTC 月初の 00:00 (= JST 09:00) で、これはユーザの利用パターンと反対のため運用上の影響が小さい。

#### 34.14.5 月次予算上限の自己設定機能

ユーザ (テナント管理者) は自テナントの設定画面から、月次予算上限を **自分で設定** できる。例: 「Expert プランで月最大 ¥10,000 まで」と設定すると、その金額に達した時点で Beginner と同じ縮退モードに自動切替される。これは pure metered billing の最大の弱点である **「請求額の予測不可能性」** を解消する仕組みで、Stripe / Twilio など主要な従量課金 SaaS が採用する標準パターンである。

実装は `Tenant.monthlyBudgetCapJpy` に保存し、API 呼び出し前のミドルウェアで `currentMonthApiCostJpy + 次の呼び出しの予測コスト > monthlyBudgetCapJpy` をチェックして、超過する場合は縮退モードに切り替える。`monthlyBudgetCapJpy` が `NULL` の場合は上限なし (= 純粋な従量課金) として動作する。

UI 上は「予算 ¥10,000 のうち、今月 ¥3,200 を使用 (32%)」のような可視化を行い、ユーザが現在地と予算をいつでも確認できるようにする (詳細は §34.14.7 で詳述)。

#### 34.14.6 プラン変更フローと制御ロジック

テナント管理者は自テナントのシステム管理者設定画面からプランを変更できる。変更フローは方向によって異なる挙動とする。

**Beginner → Expert / Pro へのアップグレード** は、決済情報の登録 (Stripe 連携、v1.x で実装) と同時に **即時有効化** する。アップグレード後の API 呼び出しから新プランの料金体系で課金される。これは「もっと使いたい」というユーザの意欲を即座に満たす設計で、待たせる理由がない。

**Expert ↔ Pro の切替 (LLM モデル変更)** は **即時反映** する。技術的には `Tenant.plan` を見て分岐する 1 行の変更で、次の API 呼び出しから対応モデル (Haiku / Sonnet) に切り替わる。当月の使用分は切替前後それぞれの単価で集計され、月次請求書で内訳表示する。

**Expert / Pro → Beginner へのダウングレード** には **システム側で必ず制御を加える**。第一に、現在の席数が Beginner 上限 (5 席) を超えている場合、ダウングレードは **拒否** され、ユーザに「6 席以上を Beginner にダウングレードできません。先に席数を 5 以下に減らしてください」という警告が表示される。これを画面上で強制し、admin が API を直接叩いてもサーバ側で拒否する二重防御とする。第二に、ダウングレード適用は **当月末まで現プラン継続、翌月 1 日から Beginner 適用** とする。これは月の途中ダウングレードによる課金回避 (= 月末ぎりぎりにダウングレードして当月分を 0 円にする) を防ぐ仕組みで、実装上は `Tenant.plan` ではなく `Tenant.scheduledPlanChangeAt` と `Tenant.scheduledNextPlan` のような遅延適用フィールドで実現する。

ユーザには「ダウングレードはこの月の月末から適用されます。当月分の従量課金は通常通り発生します」という注意事項を、変更操作の前段で **明示的に確認させる** UI を必須とする。

#### 34.14.7 リアルタイム使用量ダッシュボード

ユーザ (テナント管理者) は自テナントの設定画面から、リアルタイムの使用状況ダッシュボードを閲覧できる。表示する情報は以下の 4 つのレイヤーで構成する。

第一に **当月のサマリー** で、今月の API 呼び出し回数、課金額、予算 (設定されていれば) との比較、を 1 行で表示する。例: 「今月の使用状況: 320 回 / ¥3,200 (予算 ¥10,000 の 32%)」。

第二に **プラン情報と席数** で、現在のプラン名、席数 (Beginner なら N/5、Expert/Pro なら無制限)、Beginner なら月間上限残量 (例: 「残 25 回 / 100 回」)、を表示する。

第三に **日次の使用推移グラフ** で、当月の日別 API 呼び出し回数と費用を簡易な棒グラフで可視化する。これは突発的な使用量増加 (= 異常パターン) をユーザ自身が発見できる窓口となる。

第四に **機能別の内訳** で、「新規プロジェクト時の提案: N 回」「提案画面の再表示: M 回」「リスク起票時の関連 issue 検索: K 回」のように、`featureUnit` 単位で集計したテーブルを表示する。これによりユーザは「どの機能で多く使っているか」を理解し、利用パターンを最適化できる。

これらは v1.x で完全実装する想定だが、**データ蓄積は v1 から開始する**。Tenant テーブルの集計フィールドと `ApiCallLog` テーブルを v1 から運用し、UI は v1.x で追加することで、UI 公開時点で過去 1 ヶ月分の履歴がすでに表示できる状態となる。

#### 34.14.8 v1 と v1.x の実装範囲

**v1 (6月1日) で実装する範囲** は **データモデルと内部ロジック** に絞る。Tenant テーブルへの `plan`、`currentMonthApiCallCount`、`currentMonthApiCostJpy`、`monthlyBudgetCapJpy`、`beginnerMonthlyCallLimit`、`pricePerCallHaiku`、`pricePerCallSonnet` カラムの追加、ApiCallLog テーブルの新設、API 呼び出し直前にプランと使用量をチェックして適切に課金 / 縮退するミドルウェアロジック、Beginner プランの月間上限チェック、Vercel Cron による月初リセットバッチ、を含む。v1 時点ではすべてのテナント (実質 default-tenant のみ) は Beginner プラン扱いで稼働し、Expert / Pro への切替は admin が DB を直接更新する運用となる。ユーザ向け UI は v1 では公開しない。

**v1.x で実装する範囲** は **UI と Stripe 連携** で、テナント管理者設定画面 (プラン情報表示・変更ボタン・予算上限自己設定・リアルタイムダッシュボード)、Stripe との連携 (Subscription with Metered Billing、月末自動請求)、ダウングレード時の警告 UI と席数制約チェック、Webhook 経由のプラン状態同期、を順次追加する。

Stripe の Metered Billing は本ユースケースに完全に適合する機能で、各 API 呼び出し時に Stripe にイベント送信 (`stripe.subscriptionItems.createUsageRecord`) するだけで、月末に自動で請求額が確定し、ユーザに請求書が送られる。実装パターンが業界標準なので、トラブルシューティングも容易である。
