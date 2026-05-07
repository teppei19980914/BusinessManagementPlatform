# シードデータの維持・更新ガイド

このドキュメントは、提案エンジン (suggestion engine) のシードデータを変更する際の手順と、
**「提案機能で拾われやすい」文章を書くためのガイドライン** を記載する。

シードデータは新規ユーザがサービスを評価する際に最初に見る「過去の業界資産」であり、
このサービスを使い続けるかどうかの判断基準に直結する。**抜けもれなく、どんなプロジェクトでも
hit する** ことを目標として継続的に拡充する。

## 1. シードデータの構成

### 1-1. 編集対象ファイル

| ファイル | 役割 |
|---|---|
| [`prisma/seed-suggestion.ts`](../../prisma/seed-suggestion.ts) | シードデータ本体 (TypeScript 配列) |
| [`prisma/seed-suggestion-embeddings.json`](../../prisma/seed-suggestion-embeddings.json) | 事前生成 embedding (自動生成) |
| [`scripts/generate-seed-embeddings.ts`](../../scripts/generate-seed-embeddings.ts) | embedding 生成スクリプト |
| [`scripts/check-seed-length.ts`](../../scripts/check-seed-length.ts) | 文字数チェックスクリプト |

### 1-2. シードデータの種類

| 配列名 | 内容 | 配置先 |
|---|---|---|
| `SEED_KNOWLEDGE` | 業務横断のベストプラクティス・教訓 (現 50 件) | default-tenant + 各テナント |
| `SAMPLE_PROJECTS` | 業界横断のサンプルプロジェクト (10 件 / 業務アプリ・インフラ・コンサル・データ・医療・HR・モバイル等を網羅) | default-tenant + 各テナント (`isSampleData=true` で画面非表示・提案候補としてのみ可視) |
| `SAMPLE_ISSUES` | 各 sample project に紐付くサンプル課題 (40 件) | 同上 |
| `SAMPLE_RETROSPECTIVES` | 各 sample project に紐付くサンプル振り返り (15 件) | 同上 |

## 2. シードデータの変更手順

### 2-1. 新規追加 (Knowledge / Issue / Retrospective を追加する場合)

1. [`prisma/seed-suggestion.ts`](../../prisma/seed-suggestion.ts) の該当配列に entry を追加
2. **embedding 再生成** (= 開発者環境で 1 回実行):
   ```bash
   pnpm seed:generate-embeddings
   ```
   → [`prisma/seed-suggestion-embeddings.json`](../../prisma/seed-suggestion-embeddings.json) が更新される。差分追記方式のため、新規 entry のみ Voyage API を呼ぶ (= 既存分のクレジット消費はゼロ)
3. JSON ファイルを git commit
4. PR 作成

### 2-2. 既存 entry の修正 (text 系フィールドを変更する場合)

text フィールド (`title` / `background` / `content` / `result` / `conclusion` / `recommendation` 等) を変更すると、その entry の hashKey が変わり、JSON 内の該当 embedding が「古いキーのまま」残る。**再生成が必須** となる。

1. `prisma/seed-suggestion.ts` を編集
2. embedding 再生成 (上記 2-1 と同じコマンド)
3. JSON commit + PR 作成

### 2-3. 本番投入

```bash
pnpm db:seed:suggestion
```

これで `default-tenant` に SEED_KNOWLEDGE / SAMPLE_PROJECTS / SAMPLE_ISSUES / SAMPLE_RETROSPECTIVES が投入される。冪等性により再実行可能。

### 2-4. 既存データへの embedding backfill (本番運用後の改修時のみ)

過去にシード投入済のデータや、ユーザが手動で作成したデータには embedding が NULL のままの場合がある。これに対しては:

```bash
pnpm seed:generate-embeddings --backfill-existing
```

を **本番 DB に向けて** 実行 (`.env.local` に本番接続情報を一時設定)。`content_embedding=NULL` の全行に対して Voyage API で embedding を生成・書込する。冪等性あり (再実行可能)、所要時間は数十秒〜数分。

**実行タイミング**: PR-X5 (シードデータ拡充) + PR-X6 (段階表示 UI) のすべての改修が完了した直後に 1 回実施する。それ以降は新規データには自動で embedding が付与されるため不要。

## 3. embedding 向けに「拾われやすい」シードデータを書くコツ

提案エンジンは Voyage AI の `voyage-4-lite` モデルで text を 1024 次元の意味ベクトルに変換し、Cosine Similarity で類似候補を提案する。embedding が「拾いやすい」content とは、**意味の濃さ + 業界文脈の明確さ** を備えたものである。文字数を稼ぐより **要点を絞る** ことを優先する。

### ✅ 推奨される書き方

#### 3-1. 具体性 — 一般論より「実体験」を書く

抽象的な原則は embedding が拾えない。具体的な状況・原因・対応・結果を書く。

| | |
|---|---|
| ❌ 悪い例 | 「リスク管理は重要である。」 |
| ✅ 良い例 | 「金曜午後の本番デプロイで障害が発生し、週末対応に追われた事例。原因はデプロイ直前のレビュー不足。火-木の午前中のみデプロイするルールを設定した結果、週末対応がゼロに。」 |

#### 3-2. 業界・業務用語を含める

embedding は「PowerPlatform」「請求書発行」「経理」のような **業界固有の用語** を理解できる。プロジェクトのタグや業界用語を意識的に文中に含めることで類似度が大幅に上がる。

| | |
|---|---|
| ❌ 悪い例 | 「業務システムの導入では教育が重要。」 |
| ✅ 良い例 | 「PowerPlatform を使った請求書承認ワークフロー導入時、経理部のユーザ研修で実機操作 60% + 業務シナリオ 40% のハイブリッド教育を採用したところ、利用率が 60% → 90% に改善した。」 |

#### 3-3. 「問題 → 原因 → 対応 → 結果 → 教訓」の構造を明確に

人間が読んで理解できる構造は、embedding にも有効。各フィールドに以下の役割を持たせる:

| フィールド | 書く内容 | 文字数目安 |
|---|---|---|
| `background` (背景) | 問題が起きた状況 / 環境 | 100-300 字 |
| `content` (本文) | 何が問題か、なぜ起きたか (技術的・組織的原因) | 200-400 字 |
| `result` (結果) | 対応によって何がどう改善されたか (数値あれば必ず入れる) | 100-300 字 |
| `conclusion` (教訓) | 次回への学び (1-2 文で簡潔に) | 50-150 字 |
| `recommendation` (推奨) | 同じ状況の人が取るべき具体的アクション | 100-300 字 |

合計 **500-1500 字** が目安。冗長に書く必要はない。

#### 3-4. 数値を含める

「30% 遅延」「月 40 時間 → 8 時間」のような **数値** は意味の濃さを高める。

| | |
|---|---|
| ❌ 悪い例 | 「データ移行で問題が起きた」 |
| ✅ 良い例 | 「3,000 件中 800 件 (約 27%) が重複登録となり、本稼働開始が 2 週間遅延した」 |

#### 3-5. タグと内容の整合

`techTags` / `processTags` / `businessDomainTags` に書いた語は、本文中にも自然に登場するように書く。タグだけ置いて本文と乖離していると、Jaccard 軸は強くても embedding 軸が弱くなる。

### ❌ 避けるべき書き方

#### 3-6. 抽象論・スローガン

「品質第一」「お客様視点」のようなスローガンは embedding が拾えない。具体的な行動・基準・指標で書く。

#### 3-7. 過度な略語

「PJ」「DB」「PoC」のような社内略語は避けるか、初出時に正式名称を明記する。embedding は文脈が薄いと意味を取れない。

#### 3-8. 冗長な説明

意味のない繰り返し・冗長な接続詞は embedding 精度を下げる (= ノイズになる)。

| | |
|---|---|
| ❌ 悪い例 | 「このような感じで色々と問題があったわけですが、それを踏まえてあれこれ対応していった結果、まあそれなりに...」 |
| ✅ 良い例 | 「Aurora フェイルオーバ時に既存コネクションが残り、再接続に 11 分かかった。HikariCP の `connectionInitSql` を調整し、復旧時間が 90 秒に短縮された。」 |

#### 3-9. 1500 字超の冗長拡張は逆効果

文字数を稼ぐために同じ内容を繰り返したり、関連の薄い枝葉を書き足すのは embedding 精度を **下げる**。
意味のない長文よりも、500-1000 字の濃い文章の方が hit 率が高い。

### 📊 文字数の目安と狙い

| 区分 | 目安 | 狙い |
|---|---|---|
| **要点が絞られた entry** | 各セクション 100-300 字、合計 500-1000 字 | **推奨。意味の濃さを優先** |
| 詳細な事例 | 合計 1000-1500 字 | 業界固有の詳細を伝えたい場合 |
| 過剰 | 1500 字以上 | embedding 精度向上は頭打ち、編集コスト増、ノイズ混入リスク |

→ **「短く濃い」を目指す**。1000 字超を目標にせず、500-1000 字で要点が伝わるかを基準に書く。

## 4. シードデータ変更時のチェックリスト

PR 作成前に以下を確認:

- [ ] `pnpm tsx scripts/check-seed-length.ts` で文字数バランスを確認 (極端に短い entry がないか / 極端に長く冗長な entry がないか)
- [ ] `pnpm seed:generate-embeddings` で JSON を更新 (失敗時は `VOYAGE_API_KEY` 環境変数を確認)
- [ ] [`prisma/seed-suggestion-embeddings.json`](../../prisma/seed-suggestion-embeddings.json) を git commit
- [ ] `pnpm test prisma/seed-suggestion.test.ts` を実行 (件数最低要件 / 親 Project 紐付け / enum 値 等のチェック)
- [ ] 新規 entry の場合、テスト [`SEED_KNOWLEDGE.length >= 50`](../../prisma/seed-suggestion.test.ts) 等のしきい値を必要に応じて更新

## 5. トラブルシューティング

### 5-1. `pnpm seed:generate-embeddings` が認証エラー

`VOYAGE_API_KEY` 環境変数が未設定または無効。`.env.local` または `.env` を確認:

```bash
VOYAGE_API_KEY=pa-xxxxxxxxxxxxxxxx
```

API キーは [Voyage AI Dashboard](https://www.voyageai.com/) で発行する。

### 5-2. backfill モードで「No DB connection」

`DATABASE_URL` 環境変数が未設定または本番接続情報になっていない。`.env.local` に Supabase Session Pooler の URL を設定:

```
DATABASE_URL=postgresql://postgres.[ref]:[pw]@aws-1-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
```

詳細手順は [DB_MIGRATION_PROCEDURE.md §3.3.2](../operations/DB_MIGRATION_PROCEDURE.md) を参照。

### 5-3. seed 投入後、画面で提案候補が出ない

以下を順に確認:

1. 提案エンジン緊急停止フラグが ON になっていないか (`SUGGESTION_ENGINE_DISABLED=true` の有無を確認)
2. シードが対象テナントに投入されているか (`SELECT count(*) FROM knowledges WHERE tenant_id = ...`)
3. embedding 列が NULL でないか (`SELECT count(*) FROM knowledges WHERE content_embedding IS NULL`)
4. プロジェクトの business_domain_tags / tech_stack_tags が JSON 配列として正しく入っているか

詳細な切り分け手順は [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) を参照。

## 6. 関連ドキュメント

| ドキュメント | 内容 |
|---|---|
| [V1_FINAL_TASKS.md](../roadmap/V1_FINAL_TASKS.md) | PR-X5 / PR-X6 の計画 (シードデータ拡充 + 段階表示 UI) |
| [SUGGESTION_ENGINE_PLAN.md](../roadmap/SUGGESTION_ENGINE_PLAN.md) | 提案エンジン v2 の全体計画 |
| [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) | 提案エンジン技術設計 (embedding / scoring 仕様) |
| [SUGGESTION_ENGINE_VERIFICATION.md](../operations/SUGGESTION_ENGINE_VERIFICATION.md) | 改修効果の検証記録 (before/after) |
| [DB_MIGRATION_PROCEDURE.md](../operations/DB_MIGRATION_PROCEDURE.md) | DB マイグレーション・接続情報設定手順 |
