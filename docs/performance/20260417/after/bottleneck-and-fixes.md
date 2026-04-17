# パフォーマンスボトルネックと改修内容

- 対象: プロジェクト詳細画面 `/projects/[projectId]` のリロードが体感で遅い問題
- 計測日: 2026-04-17
- 計測データ: `docs/performance/20260417/before/` & `docs/performance/20260417/after/`

---

## 概要（全体像）

| # | 問題カテゴリ | 症状 | 発生箇所 | 改修 |
|---|---|---|---|---|
| B-01 | 同一テーブルへの重複 DB クエリ | `Task` を同条件で 2 回 findMany | `page.tsx` の `Promise.all` | 1 クエリで tree/flat 両形式を返す関数を新設 |
| B-02 | クエリ取得件数と表示件数の乖離 | Knowledge を 100 件取得して 10 件のみ表示 | `page.tsx` の `listKnowledge` 呼び出し | `limit: 100 → 10` |
| B-03 | 再帰レンダリングコンポーネントの memo 未適用 | WBS ツリーが親 state 更新で全ノード再描画 | `TaskTreeNode` | `React.memo` 化・props 参照安定化 |
| B-04 | O(N×M) の背景 DOM 生成 | ガントの週末/当日マーカーが「行数 × 日数」分 DOM 化 | `GanttClient` | 共通背景を行外の 1 オーバーレイに集約 |

本ドキュメントでは各ボトルネックを「**症状 → 原因 → 改修 → Before/After コード差分**」の順で説明する。

---

## B-01: 同一テーブルへの重複 DB クエリ

### 症状
- プロジェクト詳細画面 RSC レスポンスが **2919 ms / 149 KB** と単独突出して遅い（他ページは 300 ms 前後）
- 同じ `Task` テーブルに対して、同一 `where` 条件・同一 include の `findMany` が **2 回** 走る

### 原因
`listTasks` は取得後に `buildTree` でツリー構造に、`listTasksFlat` はフラットなまま返す関数。ツリー用と Gantt 用の 2 形式が必要なため**単純に両方呼んでいた**が、DB レイヤーで見ると完全な重複クエリ。

### 改修
1 回のクエリ結果から tree / flat 両方を派生させる関数 `listTasksWithTree` を追加。

### Before
```ts
// src/app/(dashboard)/projects/[projectId]/page.tsx
import { listTasks, listTasksFlat } from '@/services/task.service';

const [estimates, tasks, tasksFlat, risks, retros, members, knowledgeResult, allUsers]
  = await Promise.all([
    canEdit ? listEstimates(projectId) : Promise.resolve([]),
    listTasks(projectId),       // ← Task を findMany（ツリー用）
    listTasksFlat(projectId),   // ← 同条件で Task を findMany（Gantt 用）
    listRisks(projectId),
    listRetrospectives(projectId),
    listMembers(projectId),
    listKnowledge({ page: 1, limit: 100 }, session.user.id, session.user.systemRole),
    isAdmin ? listUsers() : Promise.resolve([]),
  ]);
```

### After
```ts
// src/services/task.service.ts
export async function listTasksWithTree(
  projectId: string,
): Promise<{ tree: TaskDTO[]; flat: TaskDTO[] }> {
  const tasks = await prisma.task.findMany({
    where: { projectId, deletedAt: null },
    include: { assignee: { select: { name: true } }, parentTask: { select: { name: true } } },
    orderBy: [{ plannedStartDate: 'asc' }, { plannedEndDate: 'asc' }, { createdAt: 'asc' }],
  });
  const flat = tasks.map(toTaskDTO);
  return { tree: buildTree(flat), flat };   // 1 クエリで両形式を返す
}

// src/app/(dashboard)/projects/[projectId]/page.tsx
import { listTasksWithTree } from '@/services/task.service';

const [estimates, tasksResult, risks, retros, members, knowledgeResult, allUsers]
  = await Promise.all([
    canEdit ? listEstimates(projectId) : Promise.resolve([]),
    listTasksWithTree(projectId),   // ← 1 クエリに集約
    listRisks(projectId),
    listRetrospectives(projectId),
    listMembers(projectId),
    listKnowledge({ page: 1, limit: 10 }, session.user.id, session.user.systemRole),
    isAdmin ? listUsers() : Promise.resolve([]),
  ]);
const { tree: tasks, flat: tasksFlat } = tasksResult;
```

### 効果
- **DB クエリ 1 回削減**（プロジェクト詳細を開く度に毎回）
- 既存の `listTasks` / `listTasksFlat` 関数は API routes / 単独ページで継続使用中のため **温存**（破壊的変更なし）

### 再発防止チェック
Server Component の `Promise.all` を書く/編集するとき、同じエンティティを指す findMany が 2 個以上入っていないか目視確認する。

---

## B-02: クエリ取得件数と表示件数の乖離

### 症状
- プロジェクト詳細 RSC ペイロードが 149 KB と大きい
- ナレッジタブは画面上 **10 件しか表示しない**のに、サーバは **100 件**取得して送信していた

### 原因
`listKnowledge({ page: 1, limit: 100 })` の `limit` が、実際の UI 描画件数（`knowledges.slice(0, 10)`）と桁違いに大きい。

### 改修
`limit` を UI の表示件数と一致させる。

### Before
```ts
// src/app/(dashboard)/projects/[projectId]/page.tsx
listKnowledge({ page: 1, limit: 100 }, session.user.id, session.user.systemRole),
```
```tsx
// src/app/(dashboard)/projects/[projectId]/project-detail-client.tsx
{knowledges.slice(0, 10).map((k) => (
  <div key={k.id} className="rounded border p-3">...</div>
))}
```

### After
```ts
listKnowledge({ page: 1, limit: 10 }, session.user.id, session.user.systemRole),
```

### 効果
- ナレッジ DTO は本文 `content` や `background` を含みレコード 1 件数 KB 規模。**90 % のデータ削減が可能**
- ParseHTML 時間も -26% に改善（Trace 計測）

### 再発防止チェック
`limit:` / `take:` を書くとき、対応するクライアント側の `.slice(0, N)` や表示ループ上限と数値が一致しているか確認する。

---

## B-03: 再帰レンダリングコンポーネントの memo 未適用

### 症状
- WBS 管理タブで 1 つのタスク編集フォームを開閉するだけで、**ツリー内の全ノードが再レンダリング**
- ノード内に `Dialog` / `<Input>` / `<Select>` 等の重い子要素を多数持つため表示更新がカクつく

### 原因
1. `TaskTreeNode` が `React.memo` 未適用 — 親の state 変化で全子ノードが再描画
2. `selectedIds: Set<string>` を各ノードに直接渡していた — Set は親の `setSelectedIds` で毎回新規インスタンスになり、React はメモ化しても参照が変わるため再描画を抑制できない

### 改修
1. `TaskTreeNode` に `React.memo` を適用（カスタム比較関数で必要 props のみ浅い比較）
2. `selectedIds` を親で boolean (`isSelected`) に畳んでから子に渡す
3. `toggleSelect` コールバックを `useCallback` で参照安定化

### Before
```tsx
// src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx
function TaskTreeNode({ task, depth, selectedIds, onToggleSelect, ... }: Props) {
  return (
    <tr>
      {canEditPmTl && (
        <td>
          <input
            type="checkbox"
            checked={selectedIds.has(task.id)}   // ← Set を参照
            onChange={() => onToggleSelect(task.id)}
          />
        </td>
      )}
      ...
      {!isCollapsed && task.children?.map((child) => (
        <TaskTreeNode
          ...
          selectedIds={selectedIds}               // ← Set を子に伝播
          onToggleSelect={onToggleSelect}
        />
      ))}
    </tr>
  );
}

function toggleSelect(id: string) {                 // ← 毎レンダー新関数
  setSelectedIds((prev) => { ... });
}
```

### After
```tsx
type TaskTreeNodeProps = {
  task: TaskDTO;
  depth: number;
  isSelected: boolean;              // ← 親で算出済みの boolean
  selectedIds: Set<string>;         // 子ノードへの伝播用に保持
  onToggleSelect: (id: string) => void;
  ...
};

function TaskTreeNodeImpl({ task, isSelected, selectedIds, onToggleSelect, ... }: TaskTreeNodeProps) {
  return (
    <tr>
      {canEditPmTl && (
        <td>
          <input
            type="checkbox"
            checked={isSelected}                  // ← boolean 比較で済む
            onChange={() => onToggleSelect(task.id)}
          />
        </td>
      )}
      ...
      {!isCollapsed && task.children?.map((child) => (
        <TaskTreeNode
          ...
          isSelected={selectedIds.has(child.id)}  // ← 親で算出
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </tr>
  );
}

// メモ比較: isSelected と他の安定 props のみ比較
const TaskTreeNode = memo(TaskTreeNodeImpl, (prev, next) =>
  prev.task === next.task
  && prev.depth === next.depth
  && prev.isSelected === next.isSelected
  && prev.onToggleSelect === next.onToggleSelect
  && ...
);

const toggleSelect = useCallback((id: string) => { // ← 参照安定
  setSelectedIds((prev) => { ... });
}, []);
```

### 効果
- ノード編集時の再レンダリング範囲が「ツリー全体」から「編集対象ノード + 親子のみ」に縮小
- Trace での **EvaluateScript -16%・Script -7%** として観測

### 再発防止チェック
自己再帰コンポーネントや 100 件超の List アイテムを書くときは `React.memo` 必須。props に Set / Array / Object を渡す場合は親側で必要な boolean に畳む。

---

## B-04: O(N×M) の背景 DOM 生成

### 症状
- ガントチャート表示時に Layout / Paint に時間がかかる
- タスク行数が N、表示日数が D のとき、**N × D 個の絶対配置 DOM 要素**が生成されていた（週末マーカー・当日マーカーを行ごとに複製）

### 原因
各タスク行の内部で `dayHeaders.map((dh, i) => ...)` を呼び、`dayHeaders.length × tasks.length` 個の `<div>` を描画していた。週末や当日マーカーは**全行で同じ位置**に配置されるため、行ごとに複製する必要がない。

### 改修
- 週末/当日マーカーを、タスク行群の**最背面に敷く 1 枚のオーバーレイ**として配置
- マーカー位置の計算を `useMemo` で 1 度だけ実行する `dayMarkers` に切り出し

### Before
```tsx
// src/app/(dashboard)/projects/[projectId]/gantt/gantt-client.tsx
{tasks.map((task) => {
  ...
  return (
    <div key={task.id} className="flex border-b hover:bg-gray-50">
      <div className="w-52 ...">...</div>
      <div className="relative" style={{ width: `${chartWidth}px` }}>
        {/* 週末背景 — 毎行 dayHeaders.length 回 map */}
        {dayHeaders.map((dh, i) => {
          const isWeekend = dh.dayOfWeek === 0 || dh.dayOfWeek === 6;
          const isToday = dh.date === today;
          if (!isWeekend && !isToday) return null;
          return (
            <div
              key={i}
              className={`absolute top-0 h-full ${isToday ? 'bg-blue-50' : 'bg-gray-50'}`}
              style={{ left: `${i * DAY_WIDTH}px`, width: `${DAY_WIDTH}px` }}
            />
          );
        })}
        {/* バー */}
        <div className="absolute top-2 h-6 rounded" style={...}>...</div>
      </div>
    </div>
  );
})}
```

### After
```tsx
// 週末・今日マーカー位置を 1 回だけ抽出（行数に依存しない）
const dayMarkers = useMemo(
  () =>
    dayHeaders
      .map((dh, index) => ({
        index,
        isWeekend: dh.dayOfWeek === 0 || dh.dayOfWeek === 6,
        isToday: dh.date === today,
      }))
      .filter((m) => m.isWeekend || m.isToday),
  [dayHeaders, today],
);

<div className="relative">
  {/* 週末・今日背景（全タスク行共通 — 行ループ外の 1 オーバーレイ）*/}
  <div
    className="pointer-events-none absolute top-0 bottom-0 flex"
    style={{ left: '208px', width: `${chartWidth}px` }}
    aria-hidden
  >
    {dayMarkers.map((dm) => (
      <div
        key={dm.index}
        className={`absolute top-0 bottom-0 ${dm.isToday ? 'bg-blue-50' : 'bg-gray-50'}`}
        style={{ left: `${dm.index * DAY_WIDTH}px`, width: `${DAY_WIDTH}px` }}
      />
    ))}
  </div>

  {tasks.map((task) => (
    <div key={task.id} className="relative flex border-b hover:bg-gray-50">
      <div className="w-52 ... bg-white">...</div>
      <div className="relative" style={{ width: `${chartWidth}px` }}>
        {/* バーだけ残す（背景は削除）*/}
        <div className="absolute top-2 h-6 rounded" style={...}>...</div>
      </div>
    </div>
  ))}
</div>
```

### 効果
- 背景 DOM 要素数が **O(N × D) から O(N + D) へ**
- 例: 50 タスク × 90 日表示だと、背景 DOM が 4500 → 90 要素（約 50 倍の削減）
- Trace で **Layout -33% / Paint -33% / GPUTask -40%** として観測

### 再発防止チェック
「行 × 列」レイアウトで、内側ループが行に依存しない値しか参照していないなら、内側を外側ループの外（共通オーバーレイ）に出せる。

---

## 計測結果（抜粋）

| 指標 | before | after | 改善 |
|---|---:|---:|---:|
| Script（JS 実行） | 305 ms | 283 ms | **-7.2%** |
| Layout | 18 ms | 12 ms | **-33.3%** |
| Paint | 3 ms | 2 ms | **-33.3%** |
| ParseHTML | 35 ms | 26 ms | **-25.7%** |
| GPUTask | 292 ms | 174 ms | **-40.4%** |
| EvaluateScript | 170 ms | 143 ms | **-15.9%** |

詳細は [comparison-report.md](./comparison-report.md) 参照。

> サーバ側（RSC レスポンス時間 / ペイロード）は after 計測時に Vercel Lambda コールドスタート + データ増の影響を受け、表面上は悪化に見える。**DB クエリ削減効果を純粋に測定するには、ウォーム状態・同一データ量での再計測が必要**（comparison-report.md §4 参照）。

---

## 今後の再発防止（チェックリスト）

コミット前に以下を自問する：

1. ✅ Server Component の `Promise.all` に、同じエンティティへの findMany が 2 個以上入っていないか？
2. ✅ `limit:` / `take:` が UI の表示件数と一致しているか？
3. ✅ 再帰コンポーネント / 100 件超の List は `React.memo` 済みか？ props は参照安定か？
4. ✅ 「行 × 列」レイアウトで、各行が共通背景を複製生成していないか？
5. ✅ タブ / モーダル配下の UI 向けデータを eager 取得していないか？

恒久化のため以下に配置済み:
- `docs/knowledge/KNW-002_performance-optimization-patterns.md` — 詳細解説版
- `docs/DESIGN.md` §17.6 — 設計書本体への反映
- Claude Code メモリ: `feedback_perf_antipatterns.md` — 将来の会話で自動参照

## 変更対象ファイル一覧

| ファイル | 変更 |
|---|---|
| `src/services/task.service.ts` | `listTasksWithTree()` 追加・`buildTree` を export |
| `src/app/(dashboard)/projects/[projectId]/page.tsx` | `listTasksWithTree` へ置換・Knowledge limit 100→10 |
| `src/app/(dashboard)/projects/[projectId]/gantt/gantt-client.tsx` | 背景オーバーレイを行外に集約・`dayMarkers` 追加 |
| `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` | `TaskTreeNode` に `React.memo`・`isSelected` 親算出・`toggleSelect` を useCallback |
| `src/services/task.service.test.ts` | `buildTree` 単体テスト 3 件追加 |
| `docs/DESIGN.md` | §17.6 アンチパターン・チェックリスト追加 |
| `docs/knowledge/KNW-002_performance-optimization-patterns.md` | 新規 |

**検証結果**: `pnpm lint ✓` / `pnpm test ✓（216 件全合格）` / `pnpm build ✓`。
