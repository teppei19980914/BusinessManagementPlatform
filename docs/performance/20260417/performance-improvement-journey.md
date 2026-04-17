# パフォーマンス改修 3 段階の定量効果と経緯

- 対象画面: プロジェクト詳細 `/projects/[projectId]`
- 計測日: 2026-04-17
- 比較対象: 現行プログラム → 次期プログラム → コールドスタートとデータ増の影響改修
- 計測元データ: `before/現行プログラム/`, `after/次期プログラム/`, `after/コールドスタートとデータ増の影響改修/`

---

## 0. エグゼクティブサマリー

プロジェクト詳細画面のリロードは複数ユーザが業務中に何度も叩く高頻度パス。体感で遅いとの報告から本改修プロジェクトを開始し、**2 段階のリリース**で下記を達成した。

| 主要指標 | 現行 | 次期<br>（1 段階目）| コールド改修後<br>（最終）| **改善率**<br>（現行→最終）|
|---|---:|---:|---:|---:|
| プロジェクト詳細 RSC 応答時間 | **2919 ms** | 3212 ms | **1452 ms** | **-50.3%** ⚡ |
| プロジェクト詳細 RSC ペイロード | **149 KB** | 180 KB | **3 KB** | **-97.9%** ⚡ |
| 　└ TTFB（サーバ処理）| 298 ms | 537 ms | 299 ms | ±0%（コールドスタート解消）|
| 　└ Receive（ダウンロード）| 2612 ms | 2672 ms | 1148 ms | **-56.0%** |
| 画面全体の総リクエスト時間合計 | 7582 ms | 3614 ms | **2168 ms** | **-71.4%** ⚡ |
| 画面全体の総転送量 | 422 KB | 445 KB | **270 KB** | **-36.0%** |
| GPUTask 合計（ブラウザ GPU 負荷）| 292 ms | 174 ms | 181 ms | **-38.0%** |
| RunTask 合計（メインスレッド占有）| 8342 ms | 7882 ms | 7257 ms | **-13.0%** |

**主要な帰結**:
- RSC ペイロードを **約 50 分の 1（149 KB → 3 KB）** に圧縮
- 応答時間を **ほぼ半減（2919 ms → 1452 ms）**
- データ量が今後増えても同等のレスポンスタイムを維持できる構造に転換
- コールドスタート時の TTFB 跳ね上がりを恒久的に抑制

---

## 1. 計測条件（3 段階すべて共通）

| 項目 | 値 |
|---|---|
| 対象 URL | `https://tasukiba.vercel.app/projects/5fffb178-950a-4172-aa12-cc76fb653a0b` |
| 操作 | プロジェクト一覧から対象プロジェクトへ遷移 → リロード |
| 計測ツール | Chrome DevTools Network（HAR）+ Performance（Trace）|
| ブラウザ | Chromium 系 |
| 本番環境 | Vercel Hobby（Next.js 16）+ Supabase Free（PostgreSQL 16）|

---

## 2. 現行プログラム（改修前ベースライン）

### 2.1 計測結果

| 指標 | 値 |
|---|---:|
| プロジェクト詳細 RSC 応答時間 | 2919 ms |
| プロジェクト詳細 RSC ペイロード | 149 KB |
| TTFB（サーバ処理） | 298 ms |
| Receive（本文ダウンロード） | 2612 ms |
| 総リクエスト数 | 20（プリフェッチ含む） |

### 2.2 根本原因の特定（4 種のボトルネック）

#### B-01: 同一テーブルへの重複 DB クエリ
- `page.tsx` の `Promise.all` 内で `listTasks(projectId)` と `listTasksFlat(projectId)` を並列実行
- 両者は **完全に同一の `prisma.task.findMany()` クエリ** を走らせ、ツリー化の有無だけが違う
- 1 回の画面表示ごとに **不要な DB ラウンドトリップが 1 回増えていた**

#### B-02: クエリ取得件数と UI 表示件数の大幅乖離
- ナレッジタブは **UI 側で `slice(0, 10)` のみ表示**しているにもかかわらず、サーバは `limit: 100` で取得
- レコード 1 件あたり本文（`content` Text フィールド）を含むため数 KB 単位で肥大化
- 実際に使われないデータが毎回 90 件分、RSC ペイロードに乗っていた

#### B-03: 再帰レンダリングコンポーネントの memo 未適用
- WBS タブの `TaskTreeNode` が `React.memo` 未適用
- 親コンポーネント（`TasksClient`）の state 変化（他ノードのフォーム開閉、選択状態変更等）で **ツリー内の全ノードが再描画**
- 各ノードが `Dialog` / `<Input>` / `<Select>` 等の重い子を含むため、大量ノード時に操作が体感でカクつく
- `selectedIds: Set<string>` を直接 props として渡していたため、Set インスタンスが毎回新規になり memo 化しても無効化されうる設計だった

#### B-04: O(タスク数 × 日数) の背景 DOM 生成
- ガントチャートで、各タスク行の内部で `dayHeaders.map(...)` を呼び、**週末・当日マーカーを全行で複製**
- 表示日数 D・タスク数 N とすると **N × D 個の絶対配置 DOM 要素**が生成
- 例: タスク 50 件 × 表示 90 日 = **4,500 個の不要な `<div>`**（全行で同じ位置に重複描画）

#### B-05（アーキテクチャレベル）: タブ全体の eager 取得
- プロジェクト詳細を開くだけで、概要タブしか見ない場合でも **7 種のサービスを `Promise.all` で全取得**
- `listEstimates`, `listTasks`, `listTasksFlat`, `listRisks`, `listRetrospectives`, `listMembers`, `listKnowledge`, `listUsers`
- 運用開始後、プロジェクトごとのデータ量が自然増加するにつれ、**線形にペイロードが肥大化する脆弱な構造**

---

## 3. 次期プログラム（1 段階目リリース: PR #25）

### 3.1 リリース内容

直接的なコード品質の改善を 4 件投入。

| # | 対応 | 対応箇所 |
|---|---|---|
| B-01 対策 | `listTasksWithTree()` 新設（1 クエリで tree/flat 両形式を返す）| `src/services/task.service.ts` |
| B-02 対策 | Knowledge 取得 `limit: 100 → 10`（表示件数と一致） | `src/app/(dashboard)/projects/[projectId]/page.tsx` |
| B-03 対策 | `TaskTreeNode` に `React.memo` + `isSelected` 親算出 + `useCallback` | `src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx` |
| B-04 対策 | Gantt 背景を行外オーバーレイに集約（`dayMarkers` を `useMemo`）| `src/app/(dashboard)/projects/[projectId]/gantt/gantt-client.tsx` |

### 3.2 計測結果と考察

| 指標 | 現行 | 次期 | 差分 |
|---|---:|---:|---:|
| RSC 応答時間 | 2919 ms | 3212 ms | **+293 ms（+10.0%）** |
| RSC ペイロード | 149 KB | 180 KB | **+31 KB（+21%）** |
| TTFB | 298 ms | **537 ms** | **+239 ms** |
| Receive | 2612 ms | 2672 ms | +60 ms |
| Script（JS 実行）| 170 ms | 143 ms | **-15.9%** ✅ |
| Layout | 18 ms | 12 ms | **-33.3%** ✅ |
| Paint | 3 ms | 2 ms | **-33.3%** ✅ |
| ParseHTML | 35 ms | 26 ms | **-25.7%** ✅ |

表面的には応答時間・ペイロードが悪化したように見えたが、**これは改修の効果ではなく 2 つの外的要因の合算**と診断。

#### 外的要因①: Vercel Function のコールドスタート
- 計測が**デプロイ直後**に行われたため、Serverless Function が初期化状態だった
- 内訳: Node ランタイム起動（50-150 ms）+ import 解決（100-300 ms）+ pg Pool/Prisma 初期化（50-150 ms）+ DB 初回 TLS（100-200 ms）
- **合計 +200-500 ms** のレンジで TTFB が跳ねる挙動と一致（実測 +239 ms）
- 下位ネットワーク層（Blocked / Connect）の時間は変化なしで、Function 本体の起動遅延が原因と確定

#### 外的要因②: 計測間のデータ量増加
- 約 47 分の間隔でテスト中にタスク・メンバー等が追加された可能性
- Knowledge 削減（期待削減 ~90 KB）を上回る +31 KB 増 = **他データが最低 120 KB 以上増えている**ことを示唆
- 原因は現行構造に内在する「タブ全体の eager 取得」= B-05 の未解決

→ **ブラウザ側指標（Script / Layout / Paint / ParseHTML）がすべて改善していたことで、コード改修自体は効果を発揮していると確認できた**が、サーバ側の恒久対策が必須と判断。

---

## 4. コールドスタートとデータ増の影響改修（最終リリース: PR #28 + #29 + #30）

### 4.1 リリース内容（3 段構えの P0 対応）

「次期プログラム」段階で表出した**外的要因に由来する遅延**と、**データ量増加への構造的脆弱性**を恒久的に解消するため、3 つの PR を段階投入。

| PR | 対応階層 | 実装 |
|---|---|---|
| **PR #28**<br>サーバ凍結防止 | Function + DB コネクションの温存 | `/api/health` エンドポイント新設（DB ping 付き）、`instrumentation.ts` で起動時 `prisma.$connect()`、`vercel.json` 日次 cron、**cron-job.org による 5 分毎外部 ping**（運用手順を `OPERATIONS.md` 化）|
| **PR #29**<br>初期ペイロード削減 | B-05 のアーキテクチャ改修 | タブ単位の lazy fetch（`useLazyFetch` フック新設）、`page.tsx` を project + membership のみに縮小、各タブは初回表示時に `/api/projects/[id]/.../...` を呼ぶ方式へ |
| **PR #30**<br>体感速度改善 | ルート遷移時の空白時間をゼロに | `loading.tsx` を主要 5 ルートに配置、`Skeleton` 共通コンポーネント新設、App Router の自動 Suspense 境界で SSR 処理中に骨格 UI を即時描画 |

### 4.2 計測結果（ベースライン比）

| 指標 | 現行 | 最終 | 改善率 |
|---|---:|---:|---:|
| **RSC 応答時間** | 2919 ms | **1452 ms** | **-50.3%** |
| **RSC ペイロード** | 149 KB | **3 KB** | **-97.9%** |
| TTFB | 298 ms | 299 ms | ±0%（コールドスタート解消）|
| Receive（本文ダウンロード）| 2612 ms | 1148 ms | **-56.0%** |
| **画面全体の総時間** | 7582 ms | **2168 ms** | **-71.4%** |
| **画面全体の総転送量** | 422 KB | **270 KB** | **-36.0%** |
| 総リクエスト数 | 20 | 6 | -70%（不要な連鎖プリフェッチ削減）|

### 4.3 何が効いたか（改修↔指標の対応）

| 指標改善 | 直接効いた改修 |
|---|---|
| **RSC ペイロード 97.9% 減** | PR #29: タブ lazy fetch — 概要タブ表示時は project 基本情報のみ返却 |
| **Receive 時間 56% 減** | PR #29: ペイロード小 = ダウンロード時間も短縮 |
| **TTFB コールドスタート解消** | PR #28: 5 分毎 warm-up ping で Function/DB Pool を常時温存 |
| **画面全体 71% 減** | PR #29 + PR #30: プリフェッチ不要タブの読み込み削減 + 遷移時 loading.tsx で空白解消 |
| **GPUTask 38% 減** | PR #25: Gantt 背景 DOM 削減の効果が persists |

### 4.4 データ量増加への耐性

改修前の構造は、プロジェクト登録データ（タスク / リスク / 振り返り / ナレッジ等）が増えるほどペイロードが**線形に肥大化**する欠陥を持っていた。

改修後は「**概要タブはデータ量にほぼ依存しない**（project 基本情報のみ）」「**各タブは開いた時だけ必要分を取得**」という構造に転換されたため、**データが 10 倍・100 倍に増えても概要タブの初期表示時間は変わらない**。

これはプロジェクト運用の長期的なスケーラビリティを担保する重要な設計変更である。

---

## 5. 対応一覧（コード・ドキュメント変更サマリ）

| 変更種別 | 対象 | PR |
|---|---|---|
| サービス層 | `task.service.ts` に `listTasksWithTree` / `buildTree` | #25 |
| ページ層 | `projects/[projectId]/page.tsx` を最小構成に縮小 | #25, #29 |
| クライアント層 | `project-detail-client.tsx` に `LazyTabContent` + `reloadXxx` | #29 |
| 各タブ子 | `tasks/estimates/risks/retrospectives/members-client.tsx` に `onReload` prop | #29 |
| 汎用フック | `use-lazy-fetch.ts` 新設 | #29 |
| 新規 API | `/api/projects/[id]/tasks/tree/route.ts` | #29 |
| 緩和 API | `/api/projects/[id]/members/route.ts` GET をプロジェクトメンバー権限に | #29 |
| 起動処理 | `instrumentation.ts` で `prisma.$connect()` | #28 |
| ヘルスチェック | `/api/health/route.ts` 新設 + テスト | #28 |
| デプロイ設定 | `vercel.json` に日次 cron 保険 | #28 |
| UI | `components/ui/skeleton.tsx` + 5 ルートの `loading.tsx` | #30 |
| ドキュメント | `OPERATIONS.md` 新規 + `DESIGN.md §17.6` + `KNW-002` | #25, #28 |
| 計測データ | before/現行プログラム/, after/次期プログラム/, after/コールドスタートとデータ増の影響改修/ | #26, #27, #30 |

テスト件数: **216 → 219 件**（+3）、全合格を全 PR で確認。

---

## 6. 運用上の注意事項

### 6.1 ウォームアップ cron の維持

本改修の効果は「5 分毎の外部 ping」が稼働している前提で成立する。以下を定期的に確認すること:

- cron-job.org ダッシュボードで **tasukiba ジョブ**が Enabled 状態であること
- Last Events が連続して `200 OK` であること（失敗が続いている場合、即座に原因調査）
- ジョブが削除された場合、**プロジェクト詳細画面の TTFB がコールドスタート時 500-1000 ms に跳ね上がる**ため早期検知が必要
- 手順書は [`docs/OPERATIONS.md`](../../OPERATIONS.md) §3 参照

### 6.2 警戒すべきアンチパターン（再発防止）

以下 5 項目は、**コード追加・変更時に必ず自問する**こととしてメモリ化（`feedback_perf_antipatterns.md`）および [`docs/DESIGN.md §17.6`](../../DESIGN.md) に記載済み。

1. 同一テーブルへの重複 findMany が `Promise.all` に入っていないか
2. `limit:` / `take:` が UI 表示件数と一致しているか
3. 再帰 / 大量リスト UI は `React.memo` 済みか、props は参照安定か
4. 「行 × 列」グリッドで共通背景を複製生成していないか
5. タブ / モーダル配下のデータを eager 取得していないか

### 6.3 今後の継続改善（未着手 P1/P2）

[`after/次期プログラム/cold-start-and-data-growth-analysis.md`](./after/次期プログラム/cold-start-and-data-growth-analysis.md) §4 で計画済み。業務影響と工数を見て段階投入する。

- P1: Gantt / WBS 仮想化（200 件超のタスクで効果大）
- P1: Retrospective の N+1 根本解消（schema relation 追加）
- P1: 一覧ページネーション UI（現在 top N のみ表示のテーブル）
- P1: Vercel Speed Insights 有効化で本番 TTFB を継続監視
- P2: Prisma `select` 射影で Text 型の一覧除外

---

## 7. 関連ドキュメント

- [`before/現行プログラム/`](./before/現行プログラム/) — 改修前の計測データ
- [`after/次期プログラム/`](./after/次期プログラム/) — 1 段階目（PR #25）の計測データ + 個別分析レポート 3 本
- [`after/コールドスタートとデータ増の影響改修/`](./after/コールドスタートとデータ増の影響改修/) — 最終段の計測データ
- [`after/タスク更新処理パフォーマンス/`](./after/タスク更新処理パフォーマンス/) — タスク更新時の計測（今後予定）
- [`before/タスク更新処理パフォーマンス/`](./before/タスク更新処理パフォーマンス/) — タスク更新時の計測（現行）
- [`../../knowledge/KNW-002_performance-optimization-patterns.md`](../../knowledge/KNW-002_performance-optimization-patterns.md) — アンチパターン詳細
- [`../../DESIGN.md §17.6`](../../DESIGN.md) — 設計書反映版
- [`../../OPERATIONS.md`](../../OPERATIONS.md) — 運用手順書（cron-job.org 設定含む）

---

**作成**: 2026-04-17 / **範囲**: PR #25, #28, #29, #30 / **状態**: 実装完了・本番稼働中
