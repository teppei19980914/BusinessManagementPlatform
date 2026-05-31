# ADR-0015: deleteProjectCascade / deleteCustomerCascade の冪等設計 + 段階別 transaction (2026-05-20)

- **Status**: Accepted
- **Date**: 2026-05-20
- **Deciders**: teppei

---

## Context

Project / Customer の cascade 削除は、関連エンティティが多岐にわたり (Knowledge / RiskIssue / Retrospective / Task / Estimate / Attachment / Comment / TaskProgressLog / SuggestionExplanation 等)、過去実装の `deleteProjectCascade` は 200 行超に肥大化していた。

検討時の制約・前提:

- **過去実装は完全非 transactional**: process crash や Lambda timeout で **partial cascade** が発生するリスクがあった。例: RiskIssue は削除されたが Knowledge は残った、Knowledge は消えたが Project 本体は残った等の orphan 状態
- **2 巡目検証 S1-D2 で severity-1 として識別**: orphan データは「リスクは消えたがナレッジが残った」「ナレッジは消えたが提案 explanation が残った」等の不整合を生み、提案エンジン / 監査ログ / 課金集計の全経路で副作用を起こす可能性
- **一方、全 cascade を 1 transaction に入れると Prisma default 5s timeout を超過する大規模 project が想定された**: knowledge 1000+ 件規模のテナントでは現実的でない
- **削除セマンティクスは「最終的に Project.delete が成功すること」を不変条件としたい**: 前段が部分実行で止まっても再実行で完了可能であれば UX 上許容できる
- 関連: 過去事故 KDD §5.X+6 (SuggestionExplanation の cascade 漏れによる P2003 FK 違反)

## Decision

**段階別 transaction + 全段階の冪等設計** を採用する。

### 段階別 transaction の構造

- **強制削除セクションのみ transaction で囲む**:
  - 対象: Task / Estimate / Attachment / Comment / TaskProgressLog / SuggestionExplanation / Project.delete
  - これらは Project の存在に強く依存し、partial 削除で残ると FK 違反 / orphan を直ちに引き起こすため atomic 性が必須
  - `prisma.$transaction(async (tx) => {...}, { timeout: 30_000 })` で **timeout を 30s に拡張** (default 5s では大規模 project で超過するため)
- **前段の knowledge / risk / retrospective cascade は意図的に transaction 外**:
  - 各 entity の削除は **独立に冪等**: `deletedAt` フィルタで再実行時の skip 機構を持つ (既に削除済なら no-op)
  - 1 つの transaction に入れると lock 範囲が広すぎる + timeout リスクが顕著に増える
  - 部分失敗で停止しても、再実行で残りを完了できる

### deleteCustomerCascade の冪等設計

- 各 project の `deleteProjectCascade` を try/catch で囲み、partial 失敗時は `failedProjects[]` に project_id を記録
- **customer は最後の project が成功するまで残置** (customer.delete はすべての project 削除成功後にのみ実行)
- 結果として再実行可能: 次回起動時に未削除 project から自然に再開される
- 呼出元には `failedProjects` を返却し、UI 側で「N 件失敗、再実行が必要」を表示

### 採用範囲

- **適用**: `src/services/project.service.ts` の `deleteProjectCascade`, `src/services/customer.service.ts` の `deleteCustomerCascade`
- **非適用**: 単一エンティティ削除 (Knowledge 単独削除等) は従来通り 1 文の Prisma `update` で論理削除

## Consequences

### Positive
- **partial cascade による orphan を最小化**: 強制削除セクションは atomic、前段は冪等なので再実行で必ず最終状態に収束する
- **再実行で残り完了可能**: process crash / Lambda timeout / DB 一時障害のいずれでも、リトライで完了する設計
- **大規模 project でも timeout 範囲内**: 強制削除セクションを 30s に拡張 + 前段を transaction 外にしたことで、knowledge 数百件規模までは現実的に処理可能
- **lock 範囲の最小化**: 前段の knowledge / risk / retrospective 削除は短い独立トランザクションになり、他リクエストへの blocking が少ない
- **過去事故の予防**: KDD §5.X+6 (SuggestionExplanation cascade 漏れ) を強制削除セクションに含めることで再発防止

### Negative / Trade-off
- **前段 cascade が部分実行で止まった場合 UX として「再実行が必要」と表示される**: 現状は cron / 手動でリトライ。完全な one-shot 削除を期待するユーザには不親切
- **冪等性の維持コスト**: 各 entity の削除関数が `deletedAt` フィルタで skip 機構を持つ必要があり、新規 entity 追加時のレビュー項目が増える
- **「transaction 内/外」の境界判断が必要**: cascade に新規 entity を追加する開発者は、強制削除セクションに入れるか前段に入れるかを判断する必要がある

### Risk / 留意事項
- **大規模 project (knowledge 1000+ 件) では強制削除セクションも timeout 超過リスク**: 現実装は中規模まで。長期的には batch chunk 化が必要 (Future Work 参照)
- **failedProjects[] の見落とし**: deleteCustomerCascade 呼出元が戻り値を無視すると、partial 失敗を検知できない。呼出規約として「戻り値の failedProjects.length === 0 を必ず確認」をレビュー時に強制
- **前段途中で process が落ちた場合の audit log**: 各段階の途中で落ちると、削除アクションの監査ログが「中途半端」に残る。再実行時に重複ログが追加される設計 (これは仕様として許容)

## Alternatives Considered

### Alt-A: 全 200 行を 1 transaction
- 概要: 過去の cascade 全体を `prisma.$transaction([...])` で 1 つのトランザクションに包む
- メリット: atomic 性が最も強く、partial cascade が原理的に発生しない
- 不採用理由: (1) Prisma default 5s timeout を超過する大規模 project が想定される (2) timeout を分単位に伸ばしても lock 範囲が広すぎて他リクエストを長時間 blocking する (3) 失敗時に全体ロールバックされるため、進捗を残せず再実行コストが高い

### Alt-B: 段階別 transaction + 冪等 (採択)
- 概要: 上記 Decision の通り
- メリット: orphan 最小化と timeout 回避を両立、再実行可能
- 採択理由: 大規模 / 小規模どちらの project でも安全に削除でき、運用上のリトライ経路も明確

### Alt-C: deleteProjectCascade を batch queue 化
- 概要: API 呼出では「削除予約」だけ受け付け、実際の cascade は background worker / cron で chunk 化処理
- メリット: 完全に timeout から解放され、巨大 project にも対応可能
- 不採用理由: (1) MVP 段階では UI で「削除しました」と即時応答するリアルタイム削除 UX を維持したい (2) background worker のインフラ (queue / worker / 失敗時 alert) が未整備 (3) **将来検討**: 大規模テナント増加時に再検討する (Future Work 参照)

## Future Work

- **大規模 project (knowledge 1000+ 件など) の batch chunk 化**: 現実装も timeout 超過リスクがあるため、knowledge / risk / retrospective の前段 cascade を 100 件単位の chunk 削除にする方針を Medium 優先度フォローとして検討 ([FOLLOW_UP_AFTER_PR416.md](../archive/2026-06-01-pre-ops-reorg/FOLLOW_UP_AFTER_PR416.md) §Medium-3)
- **failedProjects の自動リトライ cron**: 現状は手動再実行だが、将来的に日次 cron で `failedProjects` を自動再試行する経路を検討

## References

- **PR**: #416 (feat/crud-permission-redesign)
- **関連 ADR**: [ADR-0011](./0011-soft-delete-and-audit-log.md) (論理削除 + 監査ログ)
- **関連 KDD**: [§5.X+6](../knowledge/KDD_PATTERNS.md) (SuggestionExplanation の cascade 漏れによる P2003 過去事故)
- **影響ファイル**:
  - `src/services/project.service.ts` (`deleteProjectCascade`)
  - `src/services/customer.service.ts` (`deleteCustomerCascade`)
- **フォローアップ**: [FOLLOW_UP_AFTER_PR416.md](../archive/2026-06-01-pre-ops-reorg/FOLLOW_UP_AFTER_PR416.md) §Medium-3 (batch chunk 化検討)
