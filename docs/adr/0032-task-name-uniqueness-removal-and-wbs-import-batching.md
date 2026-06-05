# ADR-0032: タスク名称一意性の撤廃 + WBS sync-import のバッチ化 (504 解消)

- **Status**: Accepted
- **Date**: 2026-06-04
- **Deciders**: PM (teppei) + Claude Code
- **Supersedes**: [ADR-0017](./0017-wbs-import-uplift-and-task-duplicate.md) の決定 #4 (DB 部分 UNIQUE 制約) / #6 (createTask/updateTask の名称一意性ガード)

---

## Context (背景)

WBS 上書きインポート (sync-import) で、**プレビューに警告・ブロッカーが無いのにインポートが失敗する**製品バグが 2 件、立て続けに報告された。調査の結果、根本原因は独立した 2 つだった。

### 原因 1: 名称一意性のドリフト (HTTP 500 / Prisma P2002)

- ADR-0017 (PR #420, 2026-05-25) で「同一 WP 配下の同名タスク」を禁止する **DB 部分 UNIQUE インデックス** `idx_tasks_project_parent_name_unique` と、app 層の事前ガード `assertTaskNameUniqueInParent` (createTask / updateTask) を追加した。
- 翌日の PR #449 (2026-05-26) で、sync-import の**プレビュー (computeSyncDiff) は同名重複を「エラー → 警告」に格下げ**した (「ID が一意なら別タスクとして許容できる」という判断)。
- しかし **DB 制約の撤去を忘れた**ため、「プレビューは警告のみで通る → 本実行で全件 CREATE (ID 空欄) → 2 件目の同名で P2002 → catch されず HTTP 500」という最悪のドリフトが残った。
- 実例: 学習 WBS で「週内に複数日同じ学習タスク (例: SC午後1問(読む練習))」を同一週 (WP) 配下に並べた CSV (全件新規) が必ず 500 になった。

### 原因 2: 逐次 DB 往復による Netlify 関数タイムアウト (HTTP 504)

- 名称重複を解消した CSV (106 行・全件新規) を再投入したところ、今度は **504 Gateway Timeout** になった。
- `applySyncImport` は (a) 1 行ずつ `prisma.task.create` を逐次 await (106 回)、(b) WP 検出のため id ごとに `findUnique` (最大 ~212 回)、(c) 影響 WP ごとに `recalculateAncestorsPublic` を再帰呼出 (祖先を重複再計算) しており、合計 **約 400 回超の逐次 DB 往復**になっていた。
- Supabase (ap-northeast-1) への PgBouncer 経由レイテンシで、**Netlify 関数の 10 秒上限** ([netlify.toml](../../netlify.toml)) を超過。アプリは 500 行まで許可していたが、実際には数十〜100 行規模で到達不能だった (設計と実態のドリフト)。

### 制約

- **PgBouncer transaction mode**: `prisma.$transaction` 不可 (ADR-0017 と同じ)。並行制御・原子性は application-level (事前スナップショット方式 + OCC) に閉じる。
- **Netlify 関数 10 秒上限**: 同期リクエスト内で延長不可。長時間処理は往復削減か Background Function 退避が必要。
- **既存の安全性を維持**: テナント越境防止 (project.tenantId 検証) / OCC 並行編集検出 / 失敗時ロールバックは退行させない。

---

## Decision (採用した決定)

### 1. タスク名称の一意性ルールを全面撤廃 (ADR-0017 #4/#6 を supersede)

「同一 WP 配下の同名タスク」を**正式に許容**する。

- DB 部分 UNIQUE `idx_tasks_project_parent_name_unique` を DROP (migration `20260610_drop_tasks_unique_parent_name`)。
- app 層ガード `assertTaskNameUniqueInParent` を削除 (createTask / updateTask)。
- route の `TASK_NAME_DUPLICATE_IN_PARENT` → 400 マッピングを撤去 (`tasks/route.ts` / `tasks/[taskId]/route.ts`)。
- sync-import プレビューの「同一親配下の同名」警告は**維持** (注意喚起として有益。ブロックはしない)。
- 一括複製 (bulk-duplicate) の「(コピー)」自動リネームは**維持** (重複禁止目的ではなく可読性目的の UX)。

**根拠**: タスクの突合は ID (UUID) のみで行い、名前で照合する処理は存在しない (旧テンプレートインポートは廃止済)。同名でも機能は壊れず、週内に繰り返す学習タスク等の同名は業務上正当。

### 2. `applySyncImport` のバッチ化 (504 解消)

DB 往復回数を O(N) 逐次から大幅削減する。

- **新規行**: app 側で UUID を事前採番 (`Task.id` は DB default だが明示指定可) し、親 id を書込前に全行解決。**level 昇順に `createMany`** で一括 INSERT (親を先に入れて FK を満たす)。106 create → 約 3 往復。
- **WP 集計再計算**: 対象 WP の都度 findUnique と per-WP 再帰をやめ、`recalculateAllProjectWps` で**プロジェクト全 WP を深度降順に 1 パス**再計算 (一致時 skip)。
- **削除候補**: `updateMany` で一括論理削除。
- **既存行更新**: 値が行ごとに異なるため per-row update は残す (本件の all-CREATE には影響なし)。
- ロールバック (事前スナップショット) / OCC / テナント検証は不変。

### 3. ハード行数上限の撤廃 + 警告化

- sync-import の業務上限 (旧 500 件 / `computeSyncDiff` の `> 500` ブロック) を撤廃。
- `TASK_SYNC_IMPORT_WARN_ROWS` (300) を超える場合は `globalWarnings` に「処理に時間がかかる場合がある」を出すのみ (ブロックしない)。ダイアログに警告バナーを表示。
- DoS 安全弁として route 層に `TASK_SYNC_IMPORT_MAX_ROWS` (2000) を残し、超過時のみ 413 (`checkCsvRowCount` に `maxRows` 引数を追加。他 entity は従来どおり `CSV_MAX_ROWS`=500)。

---

## Consequences (影響)

### Positive

- ✅ 「警告のみなのにインポートできない」2 件の製品バグが解消 (同名許容 + タイムアウト解消)。
- ✅ 週内反復タスクなど現実的な学習/業務 WBS が、手動作成・sync-import の双方で素直に登録できる。
- ✅ 数百〜1000 行規模の WBS でも 10 秒枠で完走する見込み (要実測)。行数のハード上限が事実上不要に。
- ✅ プレビュー (dry-run) と本実行の挙動が一致 (ドリフト解消)。

### Negative / Trade-off

- ⚠️ 同名タスクが許容されるため、誤コピー (意図しない重複) はユーザが警告を見て判断する責任になる。
- ⚠️ `recalculateAllProjectWps` は対象 WP が一部でもプロジェクト全 WP を走査する (WP 数に比例)。WP 数が極端に多い巨大プロジェクトでは将来 SQL 集計化を検討。
- ⚠️ 既存行の大量更新が混在するケースは per-row update が残るため、超大量更新では依然時間がかかる (本 ADR の対象は all-CREATE の 504。将来 raw bulk update を検討)。

### Risk / 留意事項

- **巨大インポートの完走保証**: 最適化後も 10 秒超が出た場合のみ、Background Function (15 分) + 進捗ポーリング、もしくはクライアント分割送信を別途検討する (現時点は「まず最適化で様子見」)。Netlify + Next.js での Background Function 実現可否は**要公式確認**。
- **横展開**: 同型の逐次書込パターンは bulk-duplicate (上限 100) 等にも潜在。点検 TODO 化。
- **`scripts/check-task-name-duplicates.ts`**: UNIQUE 制約の本番事前確認用スクリプトは役割を終えた (obsolete)。当面は残置。

---

## Alternatives Considered (検討した代替案)

### Alt-1: 名称一意性は維持し、プレビュー側で「同名」をブロッカーに戻す

- 概要: ADR-0017 の制約を残し、computeSyncDiff の警告をエラーに戻して整合させる。
- 不採用理由: ユーザ要望「同一 WP 配下の同名 ACT は正当」に真っ向から反する。週内反復タスクが作れなくなる。

### Alt-2: P2002 を 400 にマッピングするだけ (制約は維持)

- 概要: 500 を 400 + 文言に変えるだけの対症療法。
- 不採用理由: 「プレビュー OK → 実行 NG」の体験ズレが残り、同名を作りたいユーザの根本ニーズを満たさない。

### Alt-3: 504 対策として即 Background Function 化

- 概要: 最初から非同期ジョブ + ポーリング UX に作り替える。
- 不採用理由: バッチ化最適化だけで現実的な行数は 10 秒内に収まる見込みで、ジョブ基盤の追加は過剰。Netlify+Next での実現可否も未確認。まず最適化で様子見とする (本当に超える規模が出てから再検討)。

---

## Related (関連情報)

### 実装
- `src/services/task-sync-import.service.ts` — `applySyncImport` (createMany バッチ) / `computeSyncDiff` (globalWarnings) / `TASK_SYNC_IMPORT_MAX_ROWS` / `TASK_SYNC_IMPORT_WARN_ROWS`
- `src/services/task.service.ts` — `assertTaskNameUniqueInParent` 撤去 / `recalculateAllProjectWps` 流用
- `src/lib/csv-import-helpers.ts` — `checkCsvRowCount(maxRows)`
- `src/components/dialogs/wbs-sync-import-dialog.tsx` — globalWarnings バナー
- `prisma/migrations/20260610_drop_tasks_unique_parent_name/migration.sql`

### 設計ドキュメント
- [docs/design/DATA_MODEL.md](../design/DATA_MODEL.md) §tasks (UNIQUE 撤廃)
- [docs/design/UI_PATTERNS.md](../design/UI_PATTERNS.md) §33 (WBS 上書きインポート)
- [docs/design/API_DESIGN.md](../design/API_DESIGN.md) (エラーコード)
- [docs/specification/SCREENS.md](../specification/SCREENS.md) WBS 上書きインポート仕様

### 関連 ADR
- [ADR-0017](./0017-wbs-import-uplift-and-task-duplicate.md): 本 ADR が #4/#6 を supersede する元 ADR
