# ADR-0035: 一括削除の「チャンク分割送信 + サーバ側バッチ化 + 再計算末尾集約」(Netlify 10 秒タイムアウトと性能の両立)

- **Status**: Accepted
- **Date**: 2026-06-05
- **Deciders**: PM (teppei) + Claude Code
- **Related**: [ADR-0032](./0032-task-name-uniqueness-removal-and-wbs-import-batching.md) 決定 #2 (sync-import の createMany バッチ化) を WBS 画面の一括削除へ横展開する

---

## Context (背景)

WBS 画面の **一括削除が極端に遅い**。15 件の一括削除で「1 件あたり 3〜4 秒」が観測され、実用に耐えない。原因は独立した 2 つ。

### 原因 1: クライアント側の逐次ループ + 一括削除 API の不在

`handleBulkDelete` は選択 ID を `for...of` で **1 件ずつ `await fetch(DELETE)`** していた。一括更新 (`bulk-update`) や複製 (`bulk-duplicate`) は専用エンドポイントでサーバ側にまとめているのに、**削除だけ専用エンドポイントが無く** 個別 `DELETE /tasks/[taskId]` を直列で叩いていた。15 件 = 15 リクエストの直列待ち。

### 原因 2: 1 件の DELETE が約 9 回の逐次 DB 往復

`DELETE /tasks/[taskId]` 1 回で、認証 (`user.findUnique`) → 権限 (`project.findUnique` + `projectMember.findFirst`) → `getTask` (before 取得) → `deleteTask` 内の所有確認 (getTask とほぼ同一行の二重 fetch) → `$transaction`(task/attachment/comment) → `recalculateAncestors` (祖先をルートまで再帰) → `recordAuditLog` と、**約 9 回の逐次 DB 往復**を踏む。Supabase (ap-northeast-1) への PgBouncer 経由レイテンシで 1 件 ~3 秒に達する。さらに同じ WP 配下の兄弟を 15 件消すと、**同一 WP の再計算が 15 回** (毎回ルートまで遡って) 重複実行される。

### この設計になった経緯と、両立すべき制約

現状の「1 件ずつ」は、インポートの Netlify タイムアウト (504) 対策の名残と推測される。ただし ADR-0032 が示すとおり、インポート側の正解は「1 件ずつ」ではなく **createMany バッチ化 + 全 WP 一括再計算** だった。WBS 画面の一括削除にはこの最適化が **横展開されず**、旧パターンが残存していた。

ここで素朴に「全件を 1 リクエストに集約」すると、今度は大量データで **Netlify 10 秒上限を再超過**する。両立が必要:

- **Netlify Personal 同期関数 = 10 秒固定** (Pro で 26 秒、延長は Background Function 15 分のみ)。`recalculate/route.ts` のコメント / netlify.toml。
- **PgBouncer transaction mode**: インタラクティブ `$transaction(async tx => …)` 不可。配列形 `$transaction([…])` は可 (ADR-0032 §29)。
- **`recalculateAllProjectWps` は O(WP) の逐次往復**。WP 数が多い巨大プロジェクトでは再計算単体で 10 秒に迫る (ADR-0032 §79 が SQL 集計化を将来課題として予告済)。

---

## Decision (採用した決定)

タイムアウトと性能を両立する **2 つの独立レバー**を分離して両方適用する。

```
レバー A【往復削減 / バッチ】 1 リクエスト内で N×(認証+権限+per-row) → 1×認証 + 1×権限 + updateMany
レバー B【分割送信 / チャンク】 1 リクエストあたりの件数を K で上限化 → 各リクエストを確実に 10 秒内に収める
```

A だけ (全件 1 リクエスト) では大量データで 10 秒再超過。B だけ (現状) では遅い。両方で初めて「速い かつ 落ちない」が成立する。

### 1. `bulk-delete` エンドポイント新設 (レバー A)

`POST /api/projects/[projectId]/tasks/bulk-delete` を新設し、`{ taskIds: string[] }` を 1 リクエストでバッチ削除する。サービス `bulkDeleteTasks` の処理:

- 認証・権限チェック **1 回** (現状は ID ごとにくり返していた)。`task:delete` (admin / pm_tl)。
- 対象タスクを `findMany({ id: { in }, projectId, deletedAt: null, project: { tenantId } })` で **1 回まとめて取得 + テナント越境/別プロジェクト/既削除を除外**。
- `$transaction([ task.updateMany, attachment.updateMany, comment.updateMany ])` で **一括論理削除** (`entityId: { in: ownedIds }`)。
- 監査ログは `recordBulkAuditLogs` (createMany) で **一括** (entityId は実 UUID。0 件削除時は記録しない)。
- **このエンドポイント内では再計算しない** (決定 3)。

往復は **件数 K に依存せず約 5〜6 回で固定** (認証 2-3 + findMany 1 + transaction 1 + audit 1)。

### 2. クライアント共有ユーティリティ `runChunkedBulk` (レバー B)

`src/lib/run-chunked-bulk.ts` を新設。`runChunkedBulk(ids, sender, { chunkSize, concurrency, onProgress, finalize })`。

- **チャンクサイズ K = 100**、**並列度 = 3**。各チャンクが触れる ID は互いに素なので **並列実行は安全** (同一行の競合なし)。
- 進捗を `onProgress(done, total)` で通知 (進捗バー UI は将来。util は capability を保持)。
- **部分失敗をチャンク単位で集計** (`failedIds`)。論理削除は `deletedAt: null` 条件付き updateMany で **冪等**なので、`failedIds` のみの再送が安全。
- `finalize` は「全チャンク完了後に 1 回だけ」実行する後処理 (決定 3)。`succeeded > 0` のときのみ呼ぶ。

### 3. 再計算は「全チャンク完了後に 1 回だけ」(レバー A の肝)

`recalculateAllProjectWps` は O(WP) 逐次往復で、**チャンクごとに走らせると O(WP) 走査がチャンク数だけ重複**して 10 秒に迫る。したがって:

- 削除チャンクのリクエスト内では再計算を一切しない。
- クライアントは `runChunkedBulk` の `finalize` で **`POST /tasks/recalculate` を 1 回だけ**呼ぶ (既存エンドポイント流用)。
- 認可: `task:delete` 保持ロール (admin / pm_tl) は `task:update` も持つため、削除フローからの `recalculate` 呼び出しは常に認可される。

### 4. 単一 CRUD の冗長 fetch / 無条件 write の削減 (micro-opt、本リリースで実施)

一括削除に加え、単一操作にも残っていた冗長性を、デグレを出さない範囲で解消した。

- **単一削除の二重 fetch 解消**: 旧実装は route の `getTask` (before 取得) と `deleteTask` 冒頭の所有確認 `findFirst` で同一行を二重 fetch していた。`deleteTask` を「**所有確認 + 論理削除 + before(TaskDTO) 取得を 1 回の `findFirst` (includes 付き) で兼ねて返す**」形に変更し (`projectId` 引数を追加して越境/別 project を 1 query で除外)、route 側の `getTask` を撤去。**監査 before-value は従来同様 `toTaskDTO` の結果**を返すため、監査内容は完全に同一 (フォーマット regression なし)。削除権限は所有者非依存 (`task:delete` に owner 引数なし) のため、before を権限判定に使う必要がなく安全に統合できる。
- **単一更新の冗長 fetch 解消**: `updateTask` は冒頭の所有確認 `findFirst` (select id) と、status 整合性正規化のための `findUnique` (現在値) で同一行を二重 fetch していた。所有確認 `findFirst` の select に `status / progressRate / actualStartDate / actualEndDate` を**含めて現在値も同時取得**し、`findUnique` を撤去。route の `getTask` は member 権限ゲート (`before.assigneeId`) で必要なため残す (これは正当な用途)。
- **`recalculateAncestors` の無条件 write 削減**: 集計値が現在値と一致するなら自身の update をスキップし上位伝播も止める「一致時 skip」最適化を追加 (兄弟関数 `recalculateWpOnly` / `recalculateAllProjectWps` と同じ C 案)。旧実装は祖先を無条件 update + 必ずルートまで再帰していた。**最終的な格納値は同一**で、変化のない祖先への write を省くだけ (create / update / delete の再計算すべてに効く)。

---

## Consequences (影響)

### Positive
- ✅ 15 件の一括削除が「数十秒」→「1〜2 秒」。1 件あたり 9 往復×15 件 = ~135 往復 → 1 リクエスト ~5-6 往復 + 末尾 recalc 1 回に集約。
- ✅ 件数を K で上限化するため、**大量データでも各リクエストが構造的に 10 秒を超えない**。
- ✅ インポート (ADR-0032) と一貫したバッチ + 末尾全 WP 再計算パターンに統一。
- ✅ 共有 util `runChunkedBulk` で将来の一括操作のドリフトを予防。部分失敗は失敗チャンクのみ冪等再試行で回復可能。

### Negative / Trade-off
- ⚠️ **チャンクを跨ぐ全件原子性は提供できない** (PgBouncer transaction mode + 分割送信)。冪等 updateMany + 失敗 ID 集約で「最終的に全件成功へ収束」を担保する。
- ⚠️ 再計算をクライアントが末尾 (`finalize`) で呼ぶ責務になる。呼び忘れを防ぐため recalc は util の `finalize` に組み込み、呼び出し側が個別に書かない設計とした。

### Risk / 留意事項
- **再計算の O(WP) スケーリング**: 末尾 1 回でも巨大プロジェクトでは 10 秒リスクが残る (決定 7 = SQL 化が将来の本命)。**→ [ADR-0037](./0037-wbs-import-apply-batching-and-recalc-in-memory.md) (2026-06-09) で `recalculateAllProjectWps` を「全タスク 1 fetch + メモリ集計 + 変更 WP のみ `$transaction` 一括 update」に畳み、往復を WP 数非依存化。この共有改善により本 ADR の `finalize` → `POST /tasks/recalculate` も同時に高速化された (この残リスクは大幅に緩和)。**
- **並列度 3 と PgBouncer プール**: 同時 3 リクエスト×(チャンク内 ~5-6 往復) で接続プールを消費。Supabase Free のプール枠で問題ないか実測で確認。過負荷なら並列度を 2 へ。
- **横展開漏れ**: 同型の逐次書込はリスク/課題/振り返り/ナレッジの bulk にも潜在。本 ADR は WBS タスク削除を対象とし、他エンティティは点検 TODO 化。

### 本リリースでの適用範囲と意図的な非適用 (実装時の判断)
- ✅ **一括削除**: 本 ADR の対象。新設。
- ✅ **一括更新 (bulk-update)**: 本体 `updateMany` は既に 1 リクエスト 1 クエリでバッチ済のため**据え置き**。ただし**再計算の末尾処理に潜在ボトルネックが残っていたため改修した**:
  1. 旧実装は `for (parentId of uniqueParentIds) await recalculateAncestors(parentId)` と、親ごとにルートまで再帰していた。これは共有祖先 (例: 共通ルート) を親の数だけ再 update し、**横広な一括更新 (多数の別 WP にまたがる) でユニーク親数 × 深さの逐次往復**になり 10 秒に迫り得た (件数は 100 上限で限定的だが、横に広い WBS で顕在化)。
  2. **新ヘルパ `recalculateAffectedWps`** に置換: 影響 WP 集合 (親 ∪ 祖先) を 1 回の findMany からメモリ構築し、**重複なく深度降順で 1 回ずつ** `recalculateWpOnly`。共有祖先の重複再計算を排除。**最終的な WP 集計値は旧実装と同一**。
  3. なお `recalculateAllProjectWps` (全 WP 走査) への置換は**採らなかった**: 狭い更新 (少数親) を巨大プロジェクト (多数 WP) で実行した場合に O(全 WP) の逐次 findUnique となり**退行する**ため。影響集合に限定する本方式は、横広更新で改善・狭い更新で非退行 (追加コストは WP id 一覧の findMany 1 本のみ)。
  4. 認可モデルは不変: 再計算は引き続き**認可済みの同一リクエスト内**で行う (member が `task:update_progress` で実行する実績系一括更新でも成立)。`recalculate` (要 `task:update`) を別途叩く bulk-delete 方式は権限上 bulk-update には使えないが、本改修はそれを必要としない。
- ✅ **単一 CRUD の冗長 fetch / 無条件 write 削減**: 決定 4 のとおり実施 (単一削除の二重 fetch 解消 / 単一更新の `findUnique` 撤去 / `recalculateAncestors` の一致時 skip)。いずれも監査内容・最終格納値を変えない範囲のリファクタ。
- ⏸️ **進捗バー UI**: `runChunkedBulk` は `onProgress` を備えるが、可視化 UI は別途。現行は既存の loading overlay (全画面ブロック) を流用。K=100 の単一チャンクで完了する通常ケースでは不要。

---

## Alternatives Considered (検討した代替案)

### Alt-1: 全件を 1 リクエストに集約するだけ (分割送信なし)
- 概要: `bulk-delete` を作り全 ID を 1 リクエストで処理。レバー A のみ。
- 不採用理由: 件数上限が無く、大量データ + O(WP) 再計算で Netlify 10 秒を再超過。ADR-0032 が踏んだ 504 を別経路で再発させる。

### Alt-2: 即 Background Function 化 (非同期ジョブ + ポーリング)
- 概要: 最初から 15 分枠のジョブ基盤に載せる。
- 不採用理由: ADR-0032 Alt-3 と同じく、チャンク + バッチで現実的規模は 10 秒内に収まる見込みで過剰。Netlify + Next での実現可否も未確認。将来 escalation に留保 (巨大プロジェクトの WP 再計算が 10 秒超になった場合のみ、SQL 集計化または Background Function を検討)。

### Alt-3: 現状の個別 DELETE を `Promise.all` で並列化するだけ
- 概要: クライアント逐次ループを並列 fetch に変えるだけ (サーバ無改修)。
- 不採用理由: 1 件あたり 9 往復 + 同一 WP の重複再計算は不変で、15 並列が DB / Function の同時負荷スパイクになる。部分失敗管理も弱く、根治にならない。

---

## Related (関連情報)

### 実装
- `src/lib/run-chunked-bulk.ts` — `runChunkedBulk` / `chunkArray` (+ `.test.ts`)
- `src/lib/validators/task.ts` — `bulkDeleteTaskSchema` (max 2000 = 外側防波堤、件数 200 ガードは route)
- `src/services/task.service.ts` — `bulkDeleteTasks` 新規 / `deleteTask` 単一 fetch 化 (`projectId` 引数 + `TaskDTO` 返却) / `updateTask` の `findUnique` 撤去 (owned に現在値統合) / `recalculateAncestors` 一致時 skip / `recalculateAffectedWps` 新規 (bulk-update の親ごと逐次 recalc を影響 WP 集合の重複なし 1 パスに置換) (+ `task.service.db.test.ts`)
- `src/app/api/projects/[projectId]/tasks/bulk-delete/route.ts` — 新規 (200 件超 413) (+ `route.test.ts`)
- `src/app/api/projects/[projectId]/tasks/[taskId]/route.ts` — DELETE が新 `deleteTask` を使い `getTask` 二重 fetch を撤去
- `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` — `handleBulkDelete` を runChunkedBulk + 末尾 recalculate に置換

### 設計ドキュメント
- [docs/design/API_DESIGN.md](../design/API_DESIGN.md) (bulk-delete / 413)

### 関連 ADR
- [ADR-0032](./0032-task-name-uniqueness-removal-and-wbs-import-batching.md): sync-import の createMany バッチ化。本 ADR はそのパターンを WBS 画面の一括削除へ横展開する。
- [ADR-0017](./0017-wbs-import-uplift-and-task-duplicate.md): WBS インポート / タスク複製の起点。
