# ADR-0003: Embedding ベース意味検索を提案エンジンに採用

- **Status**: Accepted
- **Date**: 2026-04 (Voyage AI 採用時点)
- **Deciders**: teppei

---

## Context

たすきば Knowledge Relay の核心機能は「**過去プロジェクトで蓄積した資産 (Knowledge / RiskIssue / Retrospective / Memo / Project) を、新しい判断時に再利用できるよう提案する**」こと (2026-05-15: Memo を提案候補に追加)。
これは単なる検索機能ではなく、サービスの差別化点そのものである (memory: project_suggestion_engine_priority — 高再現率の網羅性が最重視される)。

検討時の制約:

- **キーワード一致では取りこぼしが致命的**: 顧客が「セキュリティ要件」で起票した過去リスクを、新プロジェクトの担当者が「情報漏洩対策」というキーワードで検索しても見つからない。これでは「蓄積した資産が活きない」というサービス価値の根幹が崩れる
- **業界用語・社内用語のバリエーション**: 「QCD」「品質・コスト・納期」「Quality/Cost/Delivery」が同義であることを把握する必要がある
- **網羅性最優先 + 段階表示の方針**: 「漏らさず全部提示し、スコア順で並べる」設計 (memory: project_suggestion_engine_priority)。「精度よく絞り込んで上位 3 件」ではなく、「再現率を最大化してスコア順で段階表示する」
- **コスト制約**: LLM API は高額。提案エンジン本体に LLM を毎回呼ぶと per-call 課金単価が ¥100/回 を超え、Pro プラン (¥15/回、2026-05-15 改定後。改定前 ¥30) でも採算割れ

## Decision

**Voyage AI Embedding + PostgreSQL pgvector + フェーズ分割提案** を採用する。

### 仕組みの 3 段階

1. **Phase 1 — フィルタ**: テナント境界、状態、可視性 (Knowledge/RiskIssue/Retrospective: `visibility='public'` / Memo: `visibility='public'`) で機械的に候補集合を絞る (DB クエリのみ、コストゼロ)
2. **Phase 2 — タグベースマッチ**: LLM 自動タグ抽出 (Anthropic Claude API) で各エンティティに付与したタグと、検索コンテキストのタグの一致度で絞る (タグは作成時に 1 回抽出、検索時の API コストはゼロ)
3. **Phase 3 — Embedding 類似度検索**: Voyage AI embedding (作成時に 1 回生成、`(tenantId, embedding)` 複合インデックスで pgvector cosine similarity 検索) で意味的近さでスコアリング

**Phase 3 LLM Re-ranking** は将来構想 (6/1 リリース時点では未実装、[docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §B-5)。

### コスト構造

- Embedding 生成: 作成・更新時に 1 回 (visibility='draft' は対象外 — memory: feedback_visibility_embedding)
- 検索時の API コスト: Voyage embedding (検索クエリの 1 回) + pgvector クエリ (DB のみ)

詳細コスト試算は [docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §D, §E 参照。

## Consequences

### Positive
- **意味検索により取りこぼしが激減**: 「セキュリティ要件」と「情報漏洩対策」が embedding 上で近接するため、両方が候補に上がる
- **コスト効率が高い**: LLM を毎回呼ばず、embedding と pgvector で大半の検索を処理 → per-call 単価を低く抑えられる ([ADR-0002](./0002-tenant-billing-per-api-call.md) の課金モデルと整合)
- **網羅性 + 段階表示の方針と相性が良い**: cosine similarity スコアで自然に並び、しきい値で「上位 N 件」を出すことも、「スコア降順で全件表示」もできる
- **PostgreSQL 1 つで完結**: Supabase + pgvector のため別 vector DB を立てる必要がない (運用負荷低、[ADR-0004](./0004-postgresql-prisma.md) と整合)

### Negative / Trade-off
- **Embedding 生成タイミングが業務ロジックに食い込む**: 新規作成・編集時に Voyage API を非同期呼び出しする必要があり、エラーハンドリングが複雑 (timeout / API 失敗時のリトライ / NULL embedding でも保存はする等)
- **モデル更新時の再生成コスト**: Voyage のモデルバージョンが上がった際、全エンティティの embedding 再生成が必要 (現状は手動運用、将来は Cron バッチ化)
- **ベクトル次元数とインデックスのチューニング**: pgvector の HNSW インデックスのパラメータが性能とリコール率に影響する
- **embedding 生成失敗時の fallback 設計が必要**: NULL embedding は提案エンジンに乗らないため、月初バッチで補完する運用が必要 (縮退モード設計、[ADR-0002](./0002-tenant-billing-per-api-call.md))

### Risk / 留意事項
- **Voyage AI のサービス継続性リスク**: 比較的新しいベンダーのため、サービス終了・大幅値上げのリスクがある。代替への移行容易性を確保するため、`generate-seed-embeddings.ts` 等の embedding 生成ロジックは embedding プロバイダ抽象化レイヤを通す
- **Bulk 操作は「1 業務操作 = 1 ApiCallLog」に集約**: ユーザ視点の請求単位と業務単位を揃えるため (memory: feedback_bulk_llm_call_unit)
- **embedding 生成は visibility='draft' を除外**: 提案エンジンに乗らないデータに Voyage API 課金を消費しない (memory: feedback_visibility_embedding)

## Alternatives Considered

### Alt-1: PostgreSQL の全文検索 (`tsvector` + `tsquery`)
- 概要: トークン分割と転置インデックスでキーワード検索
- メリット: 追加コストゼロ、外部依存なし
- 不採用理由: 同義語・業界用語バリエーション・意味的近さを扱えない。「セキュリティ要件」と「情報漏洩対策」が別の token になり取りこぼす。本サービスの「網羅性最優先」方針と決定的に合わない

### Alt-2: OpenAI text-embedding-3-large + 別の vector DB (Pinecone / Weaviate 等)
- 概要: 業界標準の OpenAI embedding + 専用 vector DB
- メリット: モデルの精度が高い、エコシステムが成熟
- 不採用理由: (1) コストが Voyage より高い (2) 別 vector DB を立てると Supabase + 別 DB の二重管理になり運用負荷増 (3) OpenAI は競合の Anthropic Claude (タグ抽出に使用) と SDK が分かれており依存が分散する

### Alt-3: LLM (Claude) を提案検索のたびに呼び出す (embedding 不使用)
- 概要: 検索コンテキストと候補エンティティを LLM プロンプトに入れて「関連性ありか」判定させる
- メリット: 精度は理論上最高
- 不採用理由: コストが per-call ¥100 を超え、Pro プラン (¥15/回、2026-05-15 改定後。改定前 ¥30) でも採算割れ。提案エンジンが「使うたびに金がかかる」体験になりユーザの利用頻度が落ちる。この方式は Phase 3 LLM Re-ranking として「上位候補に対してのみ」適用予定

### Alt-4: Elasticsearch / OpenSearch + kNN プラグイン
- 概要: 検索エンジンとして実績のある Elasticsearch でベクトル検索
- メリット: 大規模スケール時の運用ノウハウが豊富
- 不採用理由: 当面のテナント数・データ量では過剰スペック。Supabase + pgvector で十分対応可能 (200 テナント規模までは試算済、[docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §E-3)

## Related

- 詳細設計: [docs/design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) (全節)
- 課金モデル: [ADR-0002](./0002-tenant-billing-per-api-call.md)
- データ基盤: [ADR-0004](./0004-postgresql-prisma.md)
- セキュリティ: [docs/security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md)
- 設計方針: memory `project_suggestion_engine_priority` (網羅性 + 段階表示)
