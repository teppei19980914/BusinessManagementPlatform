# ADR-0026: 資産作成・更新時の embedding 生成を非同期化（Next.js `after()` 採用）

- **Status**: Accepted
- **Date**: 2026-05-29
- **Deciders**: tasukiba プロジェクト管理者

---

## Context (背景)

たすきば の 5 種の業務エンティティ（Knowledge / RiskIssue / Retrospective / Memo / Project）は、ユーザが「全メンバー（公開）」状態で作成・更新したタイミングで Voyage AI に embedding（1024 次元ベクトル）生成リクエストを送り、`embedding_search_vectors.content_embedding` に保存している。生成された embedding は提案エンジン（`suggestion.service.ts`）が pgvector で類似度検索する際の主シグナルとなる。

問題は、この embedding 生成リクエストが従来 **すべてレスポンス返却までの同期 await** で実行されていた点にある。Voyage API の HTTP 往復は典型的に 300〜800ms、Anthropic 連携を伴う Project 作成では 800〜1500ms かかる。本サービスでは資産の作成・更新が **日常的に高頻度** で行われるため、保存ボタン押下から画面復帰までの待ち時間がユーザ体感として「異様に重い」と報告されていた。

embedding 生成は提案エンジンの「全網羅性重視（高再現率）」設計（`docs/design/SUGGESTION_ENGINE.md` / メモリ `project_suggestion_engine_priority`）の根幹を成すため、生成自体を省略する選択肢はない。一方、生成タイミングが「保存と完全同期」である必要も実は無く、数秒〜のタイムラグを許容すれば UX を大幅に改善できる余地があった。

加えて、月初の `tenant-monthly-reset` cron 内で `runMonthlyEmbeddingBackfill` が `content_embedding IS NULL` の業務エンティティを一括補完する設計（`docs/business/TENANT_AND_BILLING.md §34.14.4`、`embedding-backfill.service.ts`）が既に存在しており、非同期化に伴う「保存は成功したが embedding 生成は失敗」のロングテール残骸を月次でリカバリする仕組みが整っていた。

## Decision (採用した決定)

業務エンティティ 5 種（Knowledge / RiskIssue / Retrospective / Memo / Project）の作成・更新・bulk visibility 公開化時の embedding 生成（および Project の embedding 永続化 UPDATE）を、**Next.js 16 標準 API の `after()`** で response 完了後実行に切り替える。

具体的には:

- `import { after } from 'next/server'` を service レイヤに追加
- 旧 `await generateAndPersistEntityEmbedding(...)` を `after(generateAndPersistEntityEmbedding(...).catch(logError))` に置換
- 同じく `generateAndPersistBatchEmbeddings`（bulk visibility 公開化）と `persistProjectEmbedding`（Project 専用）も `after()` 化
- bulk 系の戻り値 `embeddingsGenerated` は「同期生成数」から「スケジュール対象数（`items.length`）」に意味を変更（ユーザに見える件数は同等）
- 失敗時は `.catch` で握りつぶし + console.error にログ出力。永続的に NULL 残骸となった行は月次 backfill cron が拾う

`after()` は Next.js 15 で導入され 16.x で stable 化された API で、サーバ Function プロセスをレスポンス返却後も「コールバック完了まで」保持する。Vercel / Netlify Functions のどちらでも標準対応されており、serverless 終了で fire-and-forget が途中で切れる懸念を回避できる。

## Consequences (影響)

### Positive
- **ユーザ体感**: 公開状態での Knowledge / Risk / Retro / Memo の作成・更新が 450-950ms → 100-200ms に短縮（75-80% 短縮）。bulk visibility 公開化は 400-1700ms → 100-300ms。
- **Project**: 作成・更新の embedding 永続化 UPDATE 部分のみ async 化（LLM 呼出自体は auto-tag が同期必要のため残置）。10ms 程度の改善だが API 設計の一貫性を保つ。
- **失敗耐性向上**: 個別の Voyage API 失敗が、ユーザ向けエラーレスポンスを汚さない（保存自体は成功扱い）。
- **設計の一貫性**: 既存 `runMonthlyEmbeddingBackfill` cron が NULL 行を月次でリカバリする設計と整合。

### Negative / Trade-off
- **提案エンジン反映遅延**: 保存直後の数秒〜数十秒間は、新規データが提案エンジンに反映されない。失敗時は最悪 1 ヶ月遅延（次回 backfill cron まで）。
- **ApiCallLog 記録タイミング**: 請求ログ（`ApiCallLog`）の `createdAt` が「ユーザ操作時刻」ではなく「embedding 生成完了時刻」になる。請求 invariant（合計金額）は変わらないが、毎時集計などで秒単位のズレが発生する。
- **既存テストの修正**: 「作成直後に embedding が同期反映される」前提の単体テスト・E2E は `vi.waitFor` / Playwright wait を追加するか、`embeddingsGenerated` の意味変更に追従する必要がある。
- **FAQ 追加が必須**: ユーザに「数秒タイムラグ」の存在を明示するため、`help-client.tsx` に 3 つの Q&A を追加（PR-9 に同梱）。

### Risk / 留意事項
- **永続失敗の検知**: `after()` で実行された embedding 生成の失敗は console.error のみで、現状アラート機構と接続されていない。`runMonthlyEmbeddingBackfill` の月次成果報告に「先月積み残し件数」のメトリクスを追加する検討が PR-9 後の TODO（本 ADR の scope 外）。
- **Function 実行時間上限**: Netlify Functions の最大実行時間（無料プラン: 10s、Pro: 26s）。Voyage API が異常に遅延した場合に上限超過の可能性。通常は 1-2 秒で完了するため実害は低いが、監視対象。
- **メモリ `feedback_billing_invariant` との整合**: 請求金額は ApiCallLog の SUM で確定するため変化なし。タイミング差のみ。

## Alternatives Considered (検討した代替案)

1. **同期維持（現状）**: ユーザ体感の「異様に重い」感が解消されない。リリース直前の改善余地として却下。
2. **`Promise.then().catch()` での fire-and-forget**: Netlify / Vercel Function プロセスが response 後すぐに終了し、embedding 生成が中断される確率が高い。`after()` が同問題を解決するために用意された API のため不採用。
3. **Job キュー導入（Bull / SQS 等）**: インフラ追加が必要で、3 日間のリリース窓に間に合わない。MVP 後の拡張オプションとして温存。
4. **embedding 生成を完全に cron 任せにする（即時生成廃止）**: 反映遅延が常時 1 ヶ月発生し、提案エンジンの「全網羅性」設計と矛盾。UX 退行が大きく不採用。

## 関連

- 実装: `src/services/knowledge.service.ts` / `risk.service.ts` / `retrospective.service.ts` / `memo.service.ts` / `project.service.ts`
- 設計: `docs/design/SUGGESTION_ENGINE.md`（「embedding 生成は非同期 + 数秒タイムラグ」を追記）
- ガイド: `docs/public/chat-semantic-search-guide.md`（「資産登録直後は数秒間検索ヒットしない場合あり」を追記）
- パターン: `docs/knowledge/KDD_PATTERNS.md`（`after()` で LLM 呼出をクリティカルパスから外すパターンを追記）
- FAQ: `src/app/(dashboard)/help/help-client.tsx` Q1/Q2/Q3
- メモリ: `feedback_billing_invariant`（請求 invariant 維持）/ `feedback_billing_4layer_classification`（embedding-backfill が無料化済）
- ADR: ADR-0019（課金 featureUnit）/ ADR-0022（embedding 課金）と整合
