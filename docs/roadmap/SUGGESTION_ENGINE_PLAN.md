# 提案エンジン強化計画 (T-03)

- 起票日: 2026-05-01
- 対象リリース: 2026-06-01 (v1) / 2026-06-15 以降 (v2 以降のバージョンアップ)
- 関連ドキュメント:
  - 要件: [REQUIREMENTS.md §13](./REQUIREMENTS.md)
  - 仕様: [SPECIFICATION.md §26](./SPECIFICATION.md)
  - 設計: [DESIGN.md §34](./DESIGN.md)
  - 脅威モデル: [docs/security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)
  - 経緯: [DEVELOPER_GUIDE.md §5.62](./DEVELOPER_GUIDE.md)

---

## 📊 進捗ログ

### サマリー (2026-05-02 時点)

| 項目 | 計画 | 実績 |
|---|---|---|
| 着手日 | 2026-05-01 | 2026-05-02 (PR #1 設計のみ 5/1 着手) |
| PR #5 完了予定日 (計画) | 2026-05-22 | **2026-05-02** (20 日前倒し) |
| 進捗 | PR #5 まで完了予定 (5/22) | **PR #5-b まで完了** ✅ |
| 残作業 | PR #6〜#8 (推定 10-14 日) | PR #5-c + PR #6〜#8 |
| 6/1 リリースまでバッファ | 計画: ~10 日 | **実績: ~28 日** |

**所感**: AI 駆動開発 (Claude Code) によりコード実装の所要時間が大幅短縮され、計画 22 日分の作業が 1 日で完了。残るのは初期シードデータ (PR #6) と監視/統合テスト (PR #7-#8) + 任意拡張 (PR #5-c)。リリース日厳守の余裕度が大幅に向上した。

### 完了 PR (2026-05-02 までに main にマージ完了)

| PR # | 計画 PR | 内容 | 単体ステータス |
|---|---|---|---|
| #214 | PR #1 | 設計ドキュメント整備 (本ファイル含む) | ✅ |
| #216 | PR #2-a | マルチテナント基盤スキーマ (Tenant + ApiCallLog + tenant_id 14 entity) | ✅ |
| #217 | PR #2-b | NextAuth セッション拡張 + 認可ユーティリティ (`requireSameTenant` 等) | ✅ |
| #218 | PR #2-c | `withMeteredLLM` ミドルウェア + rate limiter (in-memory) | ✅ |
| #219 | PR #2-d | 月次リセット Cron + プラン変更適用 + slug routing helper | ✅ |
| #221 | (consolidation) | スタック PR を main に集約 (#217〜#220 取り込み) | ✅ |
| #222 | (merge) | feat/tenant-cron-and-slug マージ | ✅ |
| #220 | PR #3 | Phase 1 LLM 自動タグ抽出 サービス (Anthropic SDK 導入) | ✅ |
| #223 | PR #3-b | Project create/update への自動タグ統合 (計画外の分割) | ✅ |
| #224 | PR #4 | Phase 2 pgvector + Voyage AI Embedding 基盤 + タグ UI 折りたたみ + 設計ドキュ更新 | ✅ |
| #225 | PR #5-a | Project への embedding 生成フック (計画外の分割) | ✅ |
| #226 | PR #5-b | suggestion.service への embedding 軸組込 (3 軸合成 0.3/0.2/0.5) | ✅ |

**累計**: 12 PR (うち consolidation/merge 2 PR、設計外スコープ 3 PR)

### 残作業

| PR # | 内容 | 計画 工数 | 状態 |
|---|---|---|---|
| PR #5-c | Knowledge / RiskIssue / Retrospective の embedding 生成フック (新規データ用) | 計画外 (1 セッション) | ⏳ 翌日着手予定 (2026-05-03) |
| PR #6 | 初期シードデータ + テナント別シーディング機構 | 3-4 日 | ✅ 完了 (2026-05-03) |
| PR #7 | 監視と異常検知 | 3-4 日 | ✅ 完了 (2026-05-03) |
| PR #8 | 統合テスト + リリース準備 | 4-5 日 | ✅ 完了 (2026-05-03) |

### 計画 vs 実績の差分

#### ⚡ 加速要因

- **AI 駆動開発の効果**: Claude Code による実装速度が想定より高く、計画 5〜7 日 / PR が 1 セッション以内で完了
- **失敗の早期発見**: スタック PR の運用リスクが PR #217-#220 マージ時に顕在化 → 即座に方式 C (base=main 単一 PR) に切替え、以降は同様の事故ゼロ
- **設計ドキュメントの品質**: PR #1 (設計) が詳細だったため後続 PR の手戻りが最小化 (要件・仕様・設計の 3 階層が分離されていた)

#### 📈 計画外で追加したスコープ (品質向上)

- **タグ UI アコーディオン化** (PR #4 に統合、ユーザ要望): タグ入力欄を `<details>` で折りたたみ + 案内文表示。新規ユーザの入力負担軽減
- **voyage-3-lite → voyage-4-lite 切替** (PR #4 に統合): voyage-3-lite が旧世代化し無料枠失効を発見 → 200M 無料枠の 4-lite に変更 (1024 次元、設計ドキュメントも同時更新)
- **PR #5 を #5-a + #5-b に分割**: 計画では 1 PR だったが、Project 生成フック (#5-a) と suggestion.service (#5-b) を分けて段階的レビューを実現
- **PR #5-c の追加**: Knowledge / RiskIssue / Retrospective の embedding 生成フック。当初は PR #6 シードデータ投入時に同時対応の予定だったが、独立 PR として分離する方が運用上きれい

#### 🔧 計画外で追加した修正 (品質保証)

- **CI Postgres イメージを pgvector/pgvector:pg16 に変更** (PR #224 内): 標準 postgres:16 では vector 拡張が CI に存在せず migration 失敗 → 公式 pgvector イメージに切替
- **`$queryRawUnsafe` / `$executeRawUnsafe` を tagged template に置換** (PR #224 内): セキュリティスコア 74 → 94 に改善 (TypeScript union + exhaustive switch で SQL injection 経路ゼロ)

#### ✅ 計画通りに進行

- 全 PR が設計ドキュメントの仕様通りに実装
- 失敗時の fail-safe 設計 (auto-tag 失敗 / embedding 失敗で本体保存は継続)
- 5 層悪用防止すべて実装済 (シークレット保護 / 認証強化 / rate limit / プロンプトインジェクション対策 / workspace 上限)
- マルチテナント基盤を v1 では default-tenant 単一運用、v1.x で UI 提供する設計通り

#### 📉 計画から後退した項目

- なし (= 計画スコープからの省略・縮退ゼロ)

### ユーザ側の未着手アクション

| # | 項目 | 緊急度 | 失効時の挙動 |
|---|---|---|---|
| 1 | **Supabase pgvector 拡張の有効化** (Dashboard → Database → Extensions → vector) | 🔴 必須 | 本番 `prisma migrate deploy` で `extension "vector" is not available` エラー |
| 2 | **ANTHROPIC_API_KEY** を Vercel 環境変数に登録 | 🟡 推奨 | 自動タグ抽出が失敗 (本体保存は成功) |
| 3 | **VOYAGE_API_KEY** を Vercel 環境変数に登録 | 🟡 推奨 | embedding 生成が失敗 (本体保存は成功、suggestion engine は 2 軸縮退) |
| 4 | Anthropic / Voyage **workspace 月間ハード上限** の金額決定 + Dashboard 設定 | 🟢 リリース前 | コスト爆発の最終防衛ライン (= 設定なしでも free tier 内なら問題なし) |

### 次セッション (2026-05-03 以降) の着手順

1. **PR #5-c**: Knowledge / RiskIssue / Retrospective の embedding 生成フック (1 セッション)
2. **PR #6**: 初期シードデータ 30〜100 件 + テナント別シーディング (1-2 セッション、シードコンテンツのユーザレビュー必要)
3. **PR #7**: 監視と異常検知 (1 セッション)
4. **PR #8**: 統合テスト + リリース準備 (1-2 セッション、最終)

リリース予定日 6/1 まで残 30 日。実装側のバッファは充分、ユーザ側のキー登録 + Supabase 設定をリリース前のいずれかのタイミングで実施いただければ問題なくリリース可能。

---

## 概要

本計画書は、提案エンジン (Suggestion Service) の根本的な性能向上を実現するための、3 段階のアーキテクチャ刷新計画を定義する。本機能は本サービスの核心機能であり、既存の PM ツールとの最大の差別化ポイントである。同時に、外部 LLM API への継続的な金銭コストが発生する初の機能でもあり、悪用された場合のリスクが極めて高い。本計画はそのバランスを取りながら、6月1日リリースで初期版を投入し、その後のバージョンアップで段階的に完成させる戦略を採る。

---

## 背景と課題

現状の提案エンジン (PR #65) は、`pg_trgm` による文字 n-gram 類似度と、ユーザが手動入力したタグの Jaccard 係数を半々の重みで合成してスコアを算出している。この方式は実装が単純で外部依存もない長所がある一方で、文章の意味的な近さを捉えられず、「ログイン認証エラー」と「サインインの不具合」のような **意味は同じだが用語が違う** ペアを発見できないという根本的な弱点を抱える。

さらに、ユーザがタグを未入力のままでは Jaccard 係数が常に 0 となりスコアが半減するため、新規ユーザほど提案精度の低下を体験しやすく、これがサービスの第一印象を毀損する構造になっている。新規ユーザに「過去の知見が活用される PM ツール」という本サービスの差別化体験を最初から届けるには、この構造的弱点を抜本的に解消する必要がある。

---

## 戦略

本機能は無料の OSS 版で全機能を提供しつつ、有料プランで AI 推論の深さを増幅するという freemium モデルで提供する。無料ユーザは Claude Haiku を用いた提案を受け、データ蓄積によって価値を体感する。十分な利用後、ユーザは「自分専属のアドバイザー」を求めるようになり、Pro プランへのサブスクリプション課金を経て Claude Sonnet による深い説明文付き提案にアップグレードする、というジャーニーを設計する。

無料プランでも検索精度の根幹 (embedding ベースの意味検索) は完全に提供されるため、無料版は「劣化版」ではなく「十分に機能するベースライン」として成立する。Pro プランの差は説明文の質と並び替えの精緻さに集中させ、ユーザに「払って良かった」と感じてもらう体験を設計する。

---

## アーキテクチャの 3 段階

### Phase 1: LLM による自動タグ抽出

ユーザがプロジェクトの purpose / background / scope を入力した時点で、Claude Haiku に「この文章を読んで、businessDomainTags / techStackTags / processTags にあたるタグを抽出してください」と依頼し、空のタグ列を自動補完する。既存の Jaccard 計算ロジックは一切変更せず、入力データの質が改善されるだけで提案精度が向上する、という性質を持つ。これにより新規ユーザがタグを書かないことによる「タグスコア 0」問題を構造的に解消する。

タグ抽出は Project の作成時と更新時 (purpose / background / scope のいずれかが変わった場合) に同期実行する。LLM 呼び出しは Server Action 内で完結し、失敗時は既存の手動タグ入力にフォールバックする。

### Phase 2: pgvector + Embedding による意味検索

Knowledge / RiskIssue / Retrospective / Memo / Project のテキストフィールドを Voyage AI (または OpenAI) の embedding モデルでベクトル化し、Postgres の pgvector 拡張を用いて Cosine Similarity で意味的な近さを計算する。これによって用語の揺れ・シノニム・概念的な類似が、辞書を一切書かずに自動解決される。

スコア式は 3 軸の重み付き合成に変更する。タグ Jaccard と pg_trgm 文字一致は二次的な根拠として残し、embedding 意味類似を主軸に据える (重みは初期 0.3 / 0.2 / 0.5)。閾値や重みは config に外出しして運用中の調整を可能にする。

### Phase 3: LLM による Re-ranking と説明文生成 (バージョンアップで実装)

Phase 2 で得た上位 20 件の候補を Claude に渡し、ユーザの新規プロジェクト文脈と照合して「最も関連が高い順への並び替え」と「なぜ関連が高いかを 1 行で説明する文」の生成を依頼する。これにより、ユーザは候補の並び順だけでなく **「なぜこれが自分に役立つのか」** を自然言語で理解できる。

無料プランは Haiku を使用し、形式的に妥当な説明文を生成する。Pro プランは Sonnet を使用し、文脈の機微を読み取った深い洞察を含む説明文を生成する。両者の切り替えは `User.subscription_tier` を見るだけのモデル名分岐で実現し、コードベースは単一構成を維持する。

---

## 6月1日リリース (v1) の最小スコープ

リリース日厳守とテスト期間の確保を両立させるため、初期リリースの実装範囲を以下に絞る。

**含むもの**: Phase 1 (LLM 自動タグ抽出)、Phase 2 (pgvector + embedding 意味検索)、初期データ整備 (法則・公開事例ベースの独自要約 30〜100 件)、`User.subscription_tier` カラムと月間トークン使用量の追跡基盤、悪用防止のための 5 層防御の実装、Vercel Cron による異常検知の最小実装、ヘルプ機能 (ユーザ作業)、6月1日に向けたテスト期間 (5 月最終週)。

**含まないもの (バージョンアップで対応)**: Phase 3 (LLM Re-ranking と説明文生成)、Sonnet ティーザー機能、30 日無料試用機能、組織単位の課金、観測ダッシュボード UI。

これにより、v1 でも「embedding ベースの意味検索 + 自動タグ抽出」によって既存版から劇的な改善が得られ、ユーザは差別化体験を完全に享受できる。Phase 3 と説明文生成は v1 リリース後の最初のマイナーバージョンアップとして追加し、ユーザに「アプリが進化し続けている」というシグナルを継続的に送る。

---

## 実装順序と PR 分割

実装は以下の順序で 8 個の PR に分割し、各 PR は独立してレビュー・マージ可能とする。後続 PR は前 PR の機能を前提とせず動作することを原則とし、リリース直前に問題が見つかった場合に部分的にロールバック可能な構成を保つ。

### PR #1: 設計ドキュメント整備 (本 PR)

要件定義 / 仕様 / 設計の正式追記、脅威モデル文書の作成、計画書の整備。実装には触れず、後続 PR の前提となる設計合意を文書化する。所要見込み 1 日。

### PR #2: マルチテナント基盤と経済的安全性の基盤実装

本 PR は提案エンジン v2 の **土台となるマルチテナント アーキテクチャの導入** であり、後続のすべての PR の前提となる。テナント関連の作業と、当初予定していた経済的安全性の基盤を統合して 1 PR にまとめる。

具体的には、新規 `Tenant` テーブルの作成と、`User` および全業務エンティティ (Project / Knowledge / RiskIssue / Retrospective / Memo / Customer / Stakeholder / Comment / Mention / Notification / Attachment / SystemErrorLog) への `tenantId` カラム追加を含む。既存データを `default-tenant` という単一テナントに収容する migration を作成し、ダウンタイムなしで安全に適用する。

`Tenant` テーブルには **3 プラン構成 + 従量課金 (per-API-call) の確定モデル** に基づき、以下のカラムを配置する: `plan` ('beginner' | 'expert' | 'pro')、`currentMonthApiCallCount` (今月の API 呼び出し回数)、`currentMonthApiCostJpy` (今月の課金額・円)、`monthlyBudgetCapJpy` (ユーザ自己設定の月次予算上限、NULL=無制限)、`beginnerMonthlyCallLimit` (Beginner プランの月間上限、default 100)、`beginnerMaxSeats` (Beginner プランの席数上限、default 5)、`pricePerCallHaiku` (default 10)、`pricePerCallSonnet` (default 30)、`scheduledPlanChangeAt` / `scheduledNextPlan` (ダウングレード遅延適用用)。当初予定していた `subscription_tier` / `current_month_token_usage` / `monthly_token_limit` 等のカラムは廃止。

新規テーブル `ApiCallLog` を追加し、各 API 呼び出しを (timestamp, tenantId, userId, featureUnit, modelName, llmInputTokens, llmOutputTokens, embeddingTokens, costJpy, latencyMs, requestId) で記録する。`featureUnit` は「new-project-suggestion」「project-suggestion-refresh」「risk-creation-suggest」のような機能単位の識別子で、ユーザに見える 1 操作と内部処理の対応を追跡する。これは課金の根拠データとして法的に重要となる。

API 呼び出し前のミドルウェア `withMeteredLLM()` を実装する。このミドルウェアは以下を順に実行する: (1) Upstash Redis での短期 rate limit (1 ユーザ / 1 分 / 10 回、1 ユーザ / 1 時間 / 60 回)、(2) Tenant の plan を取得、(3) Beginner プランの場合は `currentMonthApiCallCount >= beginnerMonthlyCallLimit` をチェックして超過なら縮退モード返却、(4) `monthlyBudgetCapJpy` が設定されている場合は予測コスト超過をチェックして超過なら縮退モード返却、(5) LLM 呼び出し実行、(6) 成功時に `currentMonthApiCallCount` と `currentMonthApiCostJpy` をインクリメント + ApiCallLog に記録。これら 6 ステップを共通ミドルウェアに集約することで、漏れを防ぐ。

すべての API ルートに対して、リクエストユーザの `tenantId` と操作対象データの `tenantId` が一致することを検証する標準パターンを導入する。`@/lib/permissions.ts` に `requireSameTenant(user, entity)` ユーティリティを新設し、認可ロジックの入り口として機能させる。NextAuth.js の session に `tenantId` を含めるよう拡張する。middleware で URL パスからテナント slug を解決するヘルパー (v1 では default-tenant に固定、v1.x で動的解決) を準備する。

Vercel Cron で月初リセットバッチを動作させ、`lastResetAt` が前月以前のテナントを検出して `currentMonthApiCallCount = 0` / `currentMonthApiCostJpy = 0` にリセットする。同 Cron で `scheduledPlanChangeAt` が当日以前のテナントを検出してプラン適用 (Expert/Pro → Beginner ダウングレードの翌月適用) を実行する。

Upstash Redis を Vercel ダッシュボードから有効化し、`@upstash/ratelimit` パッケージを導入する。

所要見込み 5〜7 日 (当初の 3〜4 日からテナント基盤と課金モデル分が増加)。本 PR は規模が大きく、既存機能への影響範囲も広いため、慎重なレビューと段階的なテストが必要である。v1 時点では UI を公開せず、すべてのテナント (実質 default-tenant のみ) は Beginner プラン扱いで稼働する。

### PR #3: Phase 1 (LLM 自動タグ抽出)

Anthropic SDK の導入、`@/services/auto-tag.service.ts` の新設、Project 作成・更新時の Server Action フックでの自動タグ抽出実行。プロンプトインジェクション対策 (XML タグでの分離、入力長制限、出力スキーマ検証) を初日から実装する。LLM 呼び出し失敗時の既存手動タグ入力へのフォールバック動作を担保する。所要見込み 4〜5 日。

### PR #4: Phase 2 基盤 (pgvector + Embedding)

Supabase で `vector` 拡張を有効化、`schema.prisma` で各エンティティに `content_embedding vector(1024)` カラムを追加、Voyage AI クライアントの導入 (HTTP 直叩き)、`@/services/embedding.service.ts` の新設 (テキスト → ベクトル変換、Cosine Similarity 検索)。既存データに対する一括 backfill スクリプトを `scripts/backfill-embeddings.ts` として用意する。所要見込み 5〜7 日。

### PR #5: Phase 2 統合 (suggestion.service への組み込み)

既存の `suggestion.service.ts` のスコア式に embedding 軸を追加。重み (タグ 0.3 / pg_trgm 0.2 / embedding 0.5) を config 外出し。`suggestRelatedIssuesForText` (リスク起票時の軽量サジェスト) も embedding 化に統一。既存テストを拡張し、embedding が期待通りに動作することを担保する。所要見込み 3〜4 日。

### PR #6: 初期シードデータ投入とテナント別シーディング機構

`prisma/seed-suggestion.ts` を新設し、ユーザが選定・要約した 30〜100 件のナレッジを default-tenant に登録する。これは v1 リリース時点で動作する基本シードデータとなる。

加えて、**テナント新設時に当該テナントへ初期シードデータを clone する関数** `seedTenant(tenantId)` を実装する。これは v1.x でのテナント招待運用フローで呼び出される想定だが、v1 時点でも関数として整備し、admin から手動でテストできるようにしておく。clone 処理は default-tenant のシードナレッジを読み出し、`tenantId` を切り替えて新テナントに INSERT する。embedding カラムは src 側のベクトルをそのままコピーすることで、再生成コストを節約する (= 同じ内容のナレッジは同じベクトル)。

これらは visibility=public で当該テナント内の全ユーザに対する提案候補として機能する。**ナレッジ自体はテナント間で重複** するが (例: 100 テナントが同じ Brooks の法則を持つ)、これは設計上の許容事項で、テナント独立性を担保する代償として受け入れる。

所要見込み 3〜4 日 (実装はユーザの要約作業と並行、当初の 2〜3 日からテナント別シーディング分が増加)。

### PR #7: 監視と異常検知

`SystemErrorLog` への LLM 呼び出しログ記録、日次集計バッチ (合計コスト・ユーザ別異常検知)、admin への通知メール (高負荷時)、Anthropic dashboard との突合用の simple な内部ダッシュボード (admin 向け、JSON 表示でも可)。所要見込み 3〜4 日。

### PR #8: 統合テスト + リリース準備

E2E テスト追加 (新規プロジェクト作成 → タグ自動抽出 → 提案表示)、視覚回帰テスト、本番環境での段階的有効化 (feature flag 経由)、ヘルプドキュメント連携。最終的なセキュリティチェック (`/threat-model` skill Mode B-1) で score 90+ を担保。所要見込み 4〜5 日 (うち 1〜2 日はバッファ)。

---

## スケジュール

5月1〜2日に PR #1 (設計ドキュメント整備) を完成させ、5月3日以降を実装期間として確保する。週次のチェックポイントを設け、進捗の遅延を早期に発見する。

5月3日〜5月9日 (Week 1) は PR #2 (マルチテナント基盤 + 経済的安全性基盤) の完成に充てる。これは規模が拡大した PR であり、後続すべての PR の前提となるため、単独で 1 週間を確保する。5月10日〜5月14日 (Week 2 前半) で PR #3 (Phase 1 自動タグ抽出) を完成させる。5月15日〜5月22日 (Week 2 後半〜Week 3 前半) で PR #4 と PR #5 (Phase 2 基盤と統合) を完成させる。5月23日〜5月27日 (Week 3 後半〜Week 4 前半) で PR #6 と PR #7 (テナント別シーディングと監視) を完成させる。5月28日〜5月31日 (Week 4 後半) で PR #8 (統合テスト) を完了し、6月1日リリースに臨む。

ただし、**5月22日時点で PR #5 まで完成していない** 場合は、リリース日を 6月8日に 1 週間延伸する判断を予め決めておく。これは「品質を担保せずにリリースして悪用される方が、1 週間の延伸より遥かに重大なダメージ」という経営判断の表明である。マルチテナント基盤の追加によって元々のスケジュールが後ろ倒しになっているため、Week 3 の進捗が判断のキータイミングとなる。

#### スケジュール圧迫時の縮退オプション

万が一スケジュールがさらに逼迫した場合、以下の優先順位で機能を後続化する。第一に、**Phase 2 の HNSW インデックス最適化** を後続化し、初期は brute-force な Cosine Similarity 検索で対応する (規模が小さい初期段階では性能差が体感できない)。第二に、**詳細な異常検知ロジック** (PR #7) を後続化し、初期はシンプルな日次合計コストの admin 通知のみとする。第三に、**初期シードデータの量** を 100 件目標から 30 件最低ラインに削減する。これらの縮退で Week 3 までに必達範囲を確保する。

縮退してはいけないものは、マルチテナント基盤 (PR #2)、5 層悪用防止 (PR #2 と PR #3 にまたがる)、最小限の監視 (admin 通知のみ) である。これらはセキュリティと経済的安全性の根幹であり、後続化は許容しない。

---

## リスク登録簿

第一のリスクは **API キー漏洩による経済破綻** で、影響度は最大、発生確率は低いが、発生時の損失は致命的。対策は環境変数管理の徹底、git pre-commit hook での自動検知、GitHub Push Protection の有効化、Anthropic workspace 月間ハード上限の設定で多重に防御する。

第二のリスクは **プロンプトインジェクション攻撃** で、影響度は中、ソースコード公開により発生確率は高め。対策は入力サニタイズ、システムプロンプトとユーザデータの XML タグでの分離、出力スキーマ検証、コンテキスト隔離 (他ユーザの個人情報や admin 情報をプロンプトに含めない設計) で多層的に防御する。

第三のリスクは **ユーザ単位のコスト爆発攻撃** で、影響度は中、発生確率は中。対策は `User.current_month_token_usage` によるアプリケーションレベルの月間上限管理、Upstash Redis による短期 rate limit、サインアップ時の reCAPTCHA / Turnstile による不正アカウント乱造の抑止で対処する。

第四のリスクは **6月1日リリースに間に合わない可能性** で、影響度は中、発生確率は中。対策は週次進捗レビュー、5月25日時点での 80% 完成判定、間に合わない場合の 1 週間延伸 Plan B、Phase 2 の高度な機能 (HNSW インデックスの最適化、ハイブリッド検索の重みチューニング) を後続化する選択肢の事前合意。

第五のリスクは **Anthropic API の障害** で、影響度は中、発生確率は低。対策は LLM 呼び出し失敗時に embedding ベースの並びだけを返すフォールバック設計、エラーログの DB 記録、admin への通知。

---

## 意思決定ログ

本計画に至るまでに行われた主要な意思決定を、根拠と共に記録する。

**LLM プロバイダ**: Anthropic Claude を採用。本サービス自体が Claude Code で開発されており API key 管理が既存、日本語精度が高く、prompt caching 機能でコスト最適化が可能、という 3 点を根拠とする。OpenAI / Google の検討は将来余地として残すが、初期実装の単一プロバイダ依存を許容する。

**Embedding プロバイダ**: Voyage AI の `voyage-4-lite` (1024 次元) を第一候補、OpenAI `text-embedding-3-small` を代替候補とする。Voyage は Anthropic 推奨の embedding モデルで日本語性能も高く、API 形式が OpenAI 互換のため将来切り替え可能。**voyage-4-lite は 200M トークンが無料** で、v1 規模では完全無料運用が可能。当初検討した `voyage-3-lite` は 2026 年時点で旧世代化し無料枠が失効 ($0.02/M tokens) したため、4 系に切替。公式ドキュメント (https://docs.voyageai.com/docs/embeddings) で「4 系は 3 系より品質・コンテキスト長・レイテンシ・スループット全面で優れる」と明記されている。

**ベクトル DB**: Supabase の pgvector 拡張を採用。既存の Postgres に閉じることで追加サービスを増やさず、運用の複雑度を抑える。Pinecone / Weaviate などの専用ベクトル DB は、規模が拡大して pgvector の性能限界を体感した場合に再検討する。

**初期実装の LLM モデル**: Phase 1 (auto-tagging) と Phase 3 (re-ranking) のいずれも Claude Haiku を採用。Sonnet 化はバージョンアップで Pro プランの提供時に行う。これによって試験運用期間のコストを月数百円に抑えつつ、ユーザフィードバックでの Sonnet 価値検証を可能にする。

**ライセンス**: AGPL を採用。OSS としてコードを公開しつつ、競合 SaaS の商用クローンによる事業価値の毀損を防ぐ。MIT / Apache の寛容型は、競合への塩送りリスクを許容できないため不採用。

**リリース戦略**: freemium with experience escalation。無料版で本質的価値を完全提供し、Pro プランで体験を増幅する。これは Notion / Linear / Figma が歩んだ王道のパターンで、本サービスの差別化との整合性が高い。

**Phase 3 の後続化**: 6月1日リリースの最小機能ラインから Phase 3 を外す。Phase 2 までで「embedding ベースの意味検索」という核心的な差別化体験は完全に成立し、Phase 3 は説明文生成という付加価値層として後続でリリースする方が、ユーザに「進化し続けるアプリ」というシグナルを送れる戦略的判断。

---

## 関連ドキュメントへのリンク

本計画書はあくまで計画 (進め方) のみを定義し、各論は以下を参照する。

ユーザから見える機能仕様は [SPECIFICATION.md §26](./SPECIFICATION.md) を参照。要件定義は [REQUIREMENTS.md §13](./REQUIREMENTS.md) を参照。アーキテクチャ・データモデル・5 層防御の実装詳細は [DESIGN.md §34](./DESIGN.md) を参照。攻撃面の網羅と対策の対応関係は [docs/security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md) を参照。本計画に至るまでの設計議論の経緯と意思決定ログは [DEVELOPER_GUIDE.md §5.62](./DEVELOPER_GUIDE.md) を参照。
