# パフォーマンス比較レポート（before / after）

- 計測日: 2026-04-17
- 対象 URL: `https://tasukiba.vercel.app/projects/5fffb178-950a-4172-aa12-cc76fb653a0b`（プロジェクト詳細画面リロード）
- before: `08:35:08 JST` 時点 / after: `09:22:52 JST` 時点（同日・約 47 分後）
- 元ファイル: HAR / Trace 計測データ (生バイナリは PR #101 で削除、本 md に要約転写済み。再計測は `performance-improvement-journey.md §「計測手順」` 参照)

---

## 1. サマリ（読む前の結論）

**レンダリング指標はすべて改善、ネットワーク指標はコールドスタート / データ増の影響で悪化に見える計測になった。**
コードレベルの改修効果はブラウザ側の Layout / Paint / ParseHTML / Script にはっきり現れており、サーバ応答の見かけの悪化は後述の外的要因に起因する可能性が高い。

| 観点 | before | after | 差分 | 判定 |
|---|---:|---:|---:|:---:|
| **Script 実行時間**（ブラウザ） | 305 ms | 283 ms | **-22 ms (-7.2%)** | ✅ 改善 |
| **Layout**（リフロー） | 18 ms | 12 ms | **-6 ms (-33.3%)** | ✅ 改善 |
| **Paint** | 3 ms | 2 ms | **-1 ms (-33.3%)** | ✅ 改善 |
| **ParseHTML** | 35 ms | 26 ms | **-9 ms (-25.7%)** | ✅ 改善 |
| **RunTask 合計** | 8342 ms | 7882 ms | **-460 ms (-5.5%)** | ✅ 改善 |
| プロジェクト詳細 RSC 応答時間 | 2919 ms | 3212 ms | +293 ms (+10.0%) | ⚠️ 外的要因で悪化 |
| 　└ TTFB（サーバ処理） | 298 ms | 537 ms | +239 ms | ⚠️ **コールドスタート疑い** |
| 　└ Receive（ダウンロード） | 2612 ms | 2672 ms | +60 ms | — |
| プロジェクト詳細 RSC ペイロード | 149 KB | 180 KB | +31 KB (+21%) | ⚠️ **データ増疑い** |
| 総リクエスト数 | 20 | 6 | -14 | ℹ️ プリフェッチ差分 |

---

## 2. ネットワーク（HAR）差分

### 2.1 プロジェクト詳細 RSC 応答の Timing 内訳

| 項目 | before | after |
|---|---:|---:|
| Total | 2919 ms | 3212 ms |
| Blocked（接続待ち） | 8 ms | 3 ms |
| Wait（TTFB） | **298 ms** | **537 ms** |
| Receive（本文ダウンロード） | 2612 ms | 2672 ms |
| Size | 149 KB | 180 KB |

**TTFB が 298 → 537 ms（+239 ms）に悪化**した点は、今回の改修内容（DB クエリ 1 回削減・Knowledge 取得削減）と矛盾する。最も有力な原因候補は次の 2 つ。

1. **Vercel Lambda のコールドスタート**
   - デプロイ直後は Function が再初期化される。after 計測は改修コミット直後で、コールドコンテナを引いた可能性が高い
   - Supabase Free への DB 接続確立も初回は遅い
2. **同一プロジェクトのデータ量増加**
   - 約 47 分の間にタスク / メンバー / 見積もり等が追加された可能性
   - ペイロードが +31 KB（+21%）増えている事実もこの仮説を支持する

**確実に効果を判定する方法**: 同一データ状態・ウォーム状態で複数回計測して中央値を取ること（後述）。

### 2.2 リクエスト数の差（20 → 6）

before では `/settings`・`/admin/*`・`/knowledge`・`/my-tasks`・`/projects` への **RSC プリフェッチ（14 件）** が記録されていたが、after では消えている。
これは Next.js App Router のサイドメニュー hover prefetch が先に走ったか否かの違いで、改修とは独立した計測時挙動。**ページ単体の体感性能評価には影響しない**。

---

## 3. レンダリング（Trace）差分

### 3.1 主要カテゴリ時間

| イベント | before | after | 改善率 |
|---|---:|---:|---:|
| Script（JS 実行） | 305 ms | 283 ms | **-7.2%** |
| Layout | 18 ms | 12 ms | **-33.3%** |
| Paint | 3 ms | 2 ms | **-33.3%** |
| ParseHTML | 35 ms | 26 ms | **-25.7%** |
| EvaluateScript（単独） | 170 ms | 143 ms | **-15.9%** |
| GPUTask | 292 ms | 174 ms | **-40.4%** |

### 3.2 改修とレンダリング改善の対応

| 改修内容 | 想定される影響先 | 実測で現れた改善 |
|---|---|---|
| **Gantt 背景を O(N×D) → O(N+D)** に変更 | Layout / Paint / DOM 要素数削減 | Layout -33% / Paint -33% ✓ |
| **TaskTreeNode を `React.memo` 化** | Script（React 再レンダリング） | EvaluateScript -16% / Script -7% ✓ |
| **Knowledge 100→10 件取得** | ParseHTML / ペイロード | ParseHTML -26% ✓（ペイロード側はデータ増と相殺） |
| **Task の DB クエリ 2→1 回** | TTFB（サーバ側）| after の TTFB 悪化によりマスクされ、効果は HAR から切り出せない |

**結論**: ブラウザ側で起きる処理に対しては期待どおり改善が観測できている。サーバ側（TTFB）はコールドスタートとデータ増の影響下で判定不能。

---

## 4. 計測値に関する注意点と再計測の推奨

以下の条件を揃えて再計測すると、改修の純粋な効果がより明確になる。

1. **ウォーム状態で計測する** — 同一 URL を 1 度リロードしてから（Lambda を温める）本計測
2. **データ量を固定する** — `pg_dump` で before と同じスナップショットを復元してから計測
3. **複数回の中央値を取る** — 連続 5 回リロードして 2〜5 回目の中央値
4. **キャッシュ無効化条件を揃える** — DevTools の "Disable cache" ON / OFF を統一

**Claude による想定値（同条件計測時）**:

| 項目 | 同条件での推定値 |
|---|---|
| プロジェクト詳細 RSC 応答時間 | 2000-2200 ms（DB クエリ 1 削減分 ≈ 200-400 ms） |
| プロジェクト詳細 RSC ペイロード | 110-120 KB（Knowledge 90% 減の効果で） |
| Gantt 描画時の Layout | 現状の半分以下（タスク数が多いほど差が開く） |

---

## 5. 付属ドキュメント

- [`bottleneck-and-fixes.md`](./bottleneck-and-fixes.md) — 今回の改修でどの問題をどう直したかの詳細説明（コード差分付き）
- [`cold-start-and-data-growth-analysis.md`](./cold-start-and-data-growth-analysis.md) — TTFB 悪化・ペイロード増加の根拠掘り下げと恒久対策プラン（Vercel Cron warm-up / タブ lazy fetch / Streaming 等）
- `docs/knowledge/KNW-002_performance-optimization-patterns.md` — 今後のコード変更時に参照する再発防止チェックリスト
- `docs/DESIGN.md` §17.6 — 設計書本体への反映版（簡易版）
