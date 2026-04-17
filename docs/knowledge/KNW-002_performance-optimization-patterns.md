# KNW-002: Next.js App Router におけるパフォーマンス最適化パターン

## 背景と調査の出発点

2026-04-17 の Chrome DevTools 計測（`docs/performance/20260417/`）で、
「プロジェクト詳細画面（`/projects/[projectId]`）のリロードが体感で遅い」問題を分析。

- `tasukiba.vercel.app.har`: プロジェクト詳細画面の RSC レスポンスが **2.9 秒 / 149 KB**（他画面はほぼ 300ms 前後）
- `Trace-20260417T083528.json.gz`: レンダリングタブ計測

単一画面が突出して遅く、アプリ全体の体感を劣化させる典型例。

## アンチパターンと対処（再発防止用チェックリスト）

### AP-01: 同一 DB への重複 findMany（tree 版と flat 版の二重取得）

**症状**: 同じ `where` 条件で `prisma.xxx.findMany` を 2 回呼ぶ。
前者はツリー化、後者はフラット、といった「後処理だけ違うのにクエリ自体は同一」ケース。

**典型箇所**: `src/app/(dashboard)/projects/[projectId]/page.tsx` で `listTasks` と `listTasksFlat` を並列に呼ぶパターン。

**対処**: 1 回のクエリで両方の形式を返すサービス関数を用意する。
例: [listTasksWithTree](../../src/services/task.service.ts) — `{ tree, flat }` を返す。

**チェックの着眼点**: Server Component の `Promise.all` 内を見て、
同じエンティティに対する findMany が 2 個以上入っていないか目視。

### AP-02: limit が表示件数より桁違いに大きい

**症状**: DB から 100 件取得して `slice(0, 10)` で表示しているなど。
転送サイズとシリアライズ時間が無駄に膨らむ（RSC は DTO を JSON で流す）。

**典型箇所**: 旧 `page.tsx` の `listKnowledge({ limit: 100 })` ⇒ UI は `slice(0, 10)`。

**対処**: クライアント表示と同じ件数まで落とす。
ページャーがある場合は limit=pageSize、ウィジェット的な一覧なら表示件数ちょうど。

**チェックの着眼点**: `limit:` / `take:` の数値と、対応クライアントの
`.slice(0, N)` / `.map(...)` ループ上限の整合性を確認。

### AP-03: 再帰レンダリングコンポーネントの memo 未適用

**症状**: WBS のようなツリー UI で、親 state 変化 → 無関係サブツリーまで再描画。
ノード内に重い Dialog / フォームがあると表示更新がカクつく。

**典型箇所**: [TaskTreeNode](../../src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx)。

**対処**:
1. `React.memo` を適用。
2. props には **参照安定なもの**のみ渡す。
    - Set / Array / Object を直接渡すと親で新生成されて memo が無効化されるので、
      **親側で必要な boolean に畳んでから渡す**（例: `selectedIds: Set<string>` → `isSelected: boolean`）。
3. コールバックは `useCallback` で安定化。
4. メモ比較関数を明示して、必要な props だけ浅い比較する。

**チェックの着眼点**: 自己再帰しているコンポーネント / 100 件以上並ぶ List アイテムは memo 必須。

### AP-04: O(N×M) 背景 DOM 生成（ガント・タイムテーブル系）

**症状**: N 行 × M 列のグリッドで、各行が「全列の背景セル」を描画。
行数 × 日数の DOM が生成される。

**典型箇所**: `gantt-client.tsx` の旧実装。
各タスク行内で `dayHeaders.map(...)` を繰り返し、週末/当日マーカーを毎行描画していた。

**対処**: 「全行共通の背景」は**行ループの外**に 1 枚のオーバーレイとして絶対配置し、
行側には固有要素（バーなど）だけ残す。DOM 数が **O(N+D) へ削減**。

**チェックの着眼点**: `rows.map(row => cols.map(col => ...))` の二重ループで
col 側が行に依存しない値しか参照していないなら、外出し可能。

### AP-05: Server Component で「タブ配下の全データを eager fetch」

**症状**: タブ切替で表示切り替える画面なのに、初回ロードで全タブ分を DB から取得。
プロジェクト詳細が 8 サービス並列実行で重いのが代表例。

**対処（段階的）**:
- 短期: AP-01/02 のようにクエリ重複・過剰取得を潰す（今回実施範囲）
- 中期: タブ切替時に lazy fetch する（API route 経由 / Server Actions）
- 長期: タブごとに Next.js ルートを分けてサーバサイドで streaming

**今回の方針**: デグレリスクを避け、まず短期最適化のみ実施。
中期案は `listUsers()` のメンバータブ遅延取得、Retrospective の relation 追加 → N+1 完全解消など。

## 今回実施した変更一覧

| # | 変更 | ファイル |
|---|---|---|
| 1 | `listTasksWithTree()` 追加 — 1 クエリで tree+flat を取得 | [task.service.ts](../../src/services/task.service.ts) |
| 2 | `buildTree` を export（テスト容易化） | 同上 |
| 3 | プロジェクト詳細 page で `listTasks + listTasksFlat` → `listTasksWithTree` に集約（DB クエリ 1 削減） | [projects/[projectId]/page.tsx](../../src/app/(dashboard)/projects/[projectId]/page.tsx) |
| 4 | Knowledge の取得 limit 100 → 10（表示件数と一致） | 同上 |
| 5 | Gantt: 週末/当日背景を行外の共通オーバーレイに集約（O(N×D) → O(N+D)） | [gantt-client.tsx](../../src/app/(dashboard)/projects/[projectId]/gantt/gantt-client.tsx) |
| 6 | TaskTreeNode に `React.memo` 適用、`isSelected` を親で算出し props 参照安定化 | [tasks-client.tsx](../../src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx) |
| 7 | `buildTree` に対する単体テスト追加 | [task.service.test.ts](../../src/services/task.service.test.ts) |

## 計測と期待効果

| 指標 | 修正前（実測） | 修正後（期待） |
|---|---|---|
| プロジェクト詳細 RSC レスポンス | 2919 ms | 1500-2000 ms（Task findMany 1 クエリ削減 + Knowledge 90% 減） |
| プロジェクト詳細 RSC ペイロード | 149 KB | 60-80 KB（Knowledge 100→10 で大幅減） |
| Gantt 背景 DOM | O(タスク数 × 日数) | O(タスク数 + 日数) |
| WBS ツリー編集時の再描画 | 全ノード | 対象ノードと親子のみ |

**要検証**: 本番環境で再計測し、想定外のリグレッションがないかを確認すること。

## 関連する設計原則（チェック項目として今後使う）

コミット前に以下を自問する:

1. この Server Component は同じテーブルに 2 回以上クエリを投げていないか？
2. `limit` / `take` は本当に表示で使う件数か？
3. 繰り返し描画するコンポーネントは `React.memo` 済みか？ props は参照安定か？
4. 二重ループで内側が外側の値に依存していない箇所はないか？
5. タブ / モーダルなど「最初は見えない UI のデータ」を eager 取得していないか？

## 参照

- 計測データ: `docs/performance/20260417/`
- Next.js RSC ストリーミング（公式）: <https://nextjs.org/docs/app/building-your-application/rendering/server-components>
- React memo の公式ドキュメント: <https://react.dev/reference/react/memo>
