# ADR-0037: WBS 上書きインポート apply のバッチ化 + WP 再計算のメモリ集計化 (Netlify 10 秒タイムアウト解消)

- **Status**: Accepted
- **Date**: 2026-06-09
- **Deciders**: PM (teppei) + Claude Code
- **Related**: [ADR-0032](./0032-task-name-uniqueness-removal-and-wbs-import-batching.md) (sync-import の CREATE を createMany バッチ化) / [ADR-0035](./0035-bulk-ops-chunked-batching-and-recalc-deferral.md) (一括削除のチャンク + 末尾再計算集約)

---

## Context (背景)

WBS（タスク）の **上書きインポートの確定実行 (apply) が 504 (Gateway Timeout)** になる事象が本番 (tasukiba.com / Netlify) で報告された。プレビュー（差分計算 / dry-run）は成功するが、確定実行のリクエストが Netlify 同期関数の **10 秒固定上限**（Personal プラン）を超えて強制終了される。

報告された 2 ケースとも同一エンドポイント `POST /tasks/sync-import` で発生:

- **ケース 1: 追加 106 件** — `createMany` 済みで追加自体は安いが、末尾の全 WP 再計算が支配的
- **ケース 2: 更新 100 件 + 追加 2 件** — 既存タスクへの per-row UPDATE が支配的（こちらがより低速）

本番では Netlify 関数 → Supabase (ap-northeast-1) への **PgBouncer 経由クロスリージョン往復が 1 回 ~200〜300ms**（ADR-0035 が「単一削除 1 件 = 9 往復で約 3 秒」と記録済）。**直列の往復回数 × ~300ms** が 10 秒を超えると 504 になる。

### 原因 1: UPDATE が per-row 逐次

`applySyncImport` の UPDATE は値が行ごとに異なるため `for...of` で **1 行ずつ `await prisma.task.update`** していた（ADR-0032 でバッチ化したのは CREATE のみ）。100 更新 = 100 往復。

### 原因 2: WP 再計算が O(WP) 逐次

末尾の `recalculateAllProjectWps` は **WP ごとに `findUnique`(子込み) + `update` を逐次実行**していた。WP 数 N に対し最大 ~2N 往復。報告 WBS は WP ~27 個 = 単体で ~16 秒に達する。

`recalculateAllProjectWps` は **共有関数**で、WBS インポートのほか **`POST /tasks/recalculate`（一括削除 finalize 経由）・外部移行インポート (`applyImportBatch`)** からも呼ばれる。`recalculate/route.ts` は `maxDuration=60` を宣言するが、コメント通り **Netlify Personal では 10 秒固定で無効**。ADR-0032 §79 が「将来 SQL 集計化」を予告済みだった。

### 両立すべき制約 (ADR-0035 と同じ)

- **Netlify Personal 同期関数 = 10 秒固定**
- **PgBouncer transaction mode**: インタラクティブ `$transaction(async tx => …)` 不可。**配列形 `$transaction([…])` は可** (ADR-0032 §29)。

---

## Decision (採用した決定)

apply の中で「行数 / WP 数に比例して増える直列往復」を、配列形 `$transaction` と「1 fetch + メモリ集計」で **ほぼ定数往復**に畳む。最終的な格納値は旧逐次実装と完全に同一。

### 1. UPDATE を `$transaction` 配列形でチャンク一括 (原因 1)

`applySyncImport` の per-row UPDATE を、**100 件ごとに 1 トランザクション**へ束ねる（`UPDATE_CHUNK = 100`）。各チャンクは原子的なので、失敗時はそのチャンクは未適用 = `updatedIds` に積まれず、既存の **スナップショット復元 rollback** は積み済み分のみ復元する（rollback 経路は不変）。CREATE は ADR-0032 の level 昇順 `createMany` を継続。FK 順序（CREATE → UPDATE）・OCC スナップショット・テナント分離も不変。

### 2. `recalculateAllProjectWps` をメモリ集計 + 一括書込 (原因 2 / 最大レバレッジ)

- プロジェクト全タスク (WP + ACT) を **1 回の `findMany`** で取得（集計に必要な列のみ）。
- メモリ上で親 → 子インデックスを構築し、**深度降順**（子 WP を先に集計 → 親はその最新集計値を読む = A 案）で `aggregateWpFromChildren` を適用。
- 現在値と一致しない WP **だけ**（`isWpAggregationEqual` = C 案）を、**`$transaction` 配列形でチャンク一括 `update`**。
- ラウンドトリップは「全タスク 1 fetch + 変更 WP のチャンク数」で **WP 数に依存しないほぼ定数**になる。

この関数は共有のため、**WBS インポート / `POST /tasks/recalculate`（一括削除 finalize）/ 外部移行インポート**の 3 経路すべてが同時に改善する。

### 3. 件数のハード上限は据え置き (DoS 安全弁)

`TASK_SYNC_IMPORT_MAX_ROWS = 2000`（超過で 413）は維持。バッチ化で往復は定数化されるが、DB が実行する文数・ペイロードは件数に比例して残るため、上限は撤廃せず安全弁として残す。

---

## Consequences (影響)

### Positive
- ✅ 報告された「更新主体の大きめ WBS」インポートが 10 秒内に完走（504 解消）。往復が WBS のサイズに依存しなくなる。
- ✅ `recalculateAllProjectWps` の改善が **一括削除 finalize / 外部移行インポート**にも波及。
- ✅ 最終的な格納値・監査内容は旧実装と同一（`aggregateWpFromChildren` / `isWpAggregationEqual` を流用）。
- ✅ ADR-0032 (CREATE) / ADR-0035 (一括削除) と一貫した「配列形 `$transaction` + メモリ集計」パターンに統一。

### Negative / Trade-off
- ⚠️ **1 トランザクション内の文数**が件数に比例する（チャンク 100 で上限化）。チャンクを跨ぐ全件原子性は無いが、apply は元々スナップショット復元 rollback 方式であり、冪等な再投入（ID 突合）で収束する。
- ⚠️ 504（強制終了）時は rollback に到達しないため部分適用が残り得る点は不変。回復は **同一 CSV の再投入（冪等）**。

### Risk / 留意事項
- **超巨大 WP の単一トランザクションサイズ**: 2000 行・多数 WP でのトランザクション文数は実測で確認（必要ならチャンクを縮小）。
- **将来の本命 = SQL 集計化**（ADR-0032 §79）: メモリ集計でも全タスク fetch は O(タスク数)。極端な規模では SQL 集計 / Background Function を検討。

### 本リリースでの適用範囲と意図的な非適用
- ✅ **WBS（task）sync-import**: 本 ADR の対象（報告バグ）。
- ✅ **`recalculateAllProjectWps`**: バッチ化（共有のため 3 経路に波及）。
- ⏸️ **他 4 エンティティ（risk / 課題 / knowledge / retrospective / memo）の sync-import**: 同型の per-row write（さらに **行ごとの所有確認 `findFirst`**）を持ち同じ 504 リスクがあるが、本リリースでは **非対応 (follow-up)**。理由: ①フラット構造で WP 再計算の乗算が無く acute 度が低い、②所有確認 `findFirst` + M:N 中間テーブル create のため batch 化に専用リファクタが要る、③リリース直前の回帰面を WBS に限定するのが安全。ADR-0035 が他エンティティを「点検 TODO」とした切り方と同じ。**次期対応**として `applySyncImport` と同じ「所有確認の事前一括取得 + `$transaction` 配列バッチ」へ寄せる。

---

## Alternatives Considered (検討した代替案)

### Alt-1: CSV をユーザが手で分割して投入
- 不採用理由: `recalculateAllProjectWps` が**全 WP 走査**のため、更新主体（既存タスク多数）のプロジェクトではどの分割でも末尾再計算が同コストで走り 504 が解消しない。回避策にならない。

### Alt-2: Background Function（非同期ジョブ + ポーリング）化
- 不採用理由: ADR-0035 Alt-2 と同じく、配列形バッチ + メモリ集計で現実規模（2000 行）は 10 秒内に収まる見込みで過剰。超巨大プロジェクトが顕在化した場合の将来 escalation に留保。

### Alt-3: UPDATE を生 SQL（`UPDATE ... FROM (VALUES …)`）で 1 文化
- 不採用理由: 往復削減効果は配列形 `$transaction` と同等で、生 SQL は型安全性・可読性・既存パターン（`bulkDeleteTasks` の配列形）との一貫性で劣る。将来さらなる高速化が必要なら再検討。

---

## Related (関連情報)

### 実装
- `src/services/task.service.ts` — `recalculateAllProjectWps` をメモリ集計 + `$transaction` 配列一括 update に全面改修（`recalculateWpOnly` は `recalculateAffectedWps` (bulk-update 経路) で継続使用）。`WpAggregationChild.plannedEffort` を `Prisma.Decimal | number` に拡張。
- `src/services/task-sync-import.service.ts` — `applySyncImport` の UPDATE を `$transaction` 配列形のチャンク一括に変更。
- テスト: `src/services/task.service.db.test.ts`（recalc バッチ化 5 ケース）/ `src/services/task-sync-import.service.test.ts`（UPDATE バッチ + rollback 2 ケース）/ `e2e/specs/06-wbs-tasks.spec.ts`（追加+大量更新の混在インポートが完走し WP 集計が再計算される golden path）。

### 関連 ADR
- [ADR-0032](./0032-task-name-uniqueness-removal-and-wbs-import-batching.md): sync-import の CREATE を createMany バッチ化（本 ADR は UPDATE / recalc を同方針で畳む続編）。
- [ADR-0035](./0035-bulk-ops-chunked-batching-and-recalc-deferral.md): 一括削除のチャンク + 末尾再計算集約（本 ADR の recalc 改善で finalize の `recalculate` も高速化）。
