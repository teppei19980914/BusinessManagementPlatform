# パフォーマンス調査と対策の経緯 (2026-06-01)

- **計測者**: user (teppei09141998@gmail.com)
- **支援**: Claude Code (perf/dashboard-layout-parallel-ssr ブランチ)
- **前回の経緯**: [docs/archive/performance/20260417/performance-improvement-journey.md](../20260417/performance-improvement-journey.md) (静的解析中心)
- **関連設計**: [docs/archive/performance/20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md](../20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md)
- **教訓集約**: [docs/knowledge/KDD_PATTERNS.md §5.X+205](../../../knowledge/KDD_PATTERNS.md)

---

## 1. 経緯サマリ

前回 (2026-04-17) は静的解析・コード review ベースのパフォーマンス改善が中心だった。今回 (2026-06-01) は **ブラウザ DevTools** (Lighthouse / Network / Performance) を用いた**実測フェーズ**で、生産環境 (Netlify Personal + Supabase Free) での体感遅延の真因を切り分けた。

実測は user が担当。本ドキュメントは計測値・分析・実装変更を時系列で残し、次回の改善サイクルで根拠として再利用できるよう保存する。

---

## 2. 計測手法と前提条件

### 2.1 環境

| 項目 | 値 |
|---|---|
| 対象環境 | https://tasukiba.netlify.app (本番) |
| ホスティング | Netlify Personal ($9/月) — region 単一 |
| DB | Supabase Free (ap-northeast-1) |
| 計測クライアント | Chrome 最新 (Edge ベース) |
| 計測モード | **シークレットウィンドウ + 拡張機能オフ** |
| 計測ツール | DevTools Lighthouse / Network / Performance / Treemap |

### 2.2 計測時の罠 (教訓 1)

通常ウィンドウで初回計測した際、**Bitwarden 拡張機能の content script (1.5 MiB)** が転送サイズに混入し、ペイロード分析を歪めていた (Treemap で `nngceckbapebfimnlniiiahkandclblb` の chunk が上位入り)。

**シークレットモードでも、拡張機能側で "Allow in incognito" が許可されているとオフにならない**ため、計測前に `chrome://extensions/` で個別 OFF を確認した。これは [KDD_PATTERNS.md §5.X+205 教訓 1](../../../knowledge/KDD_PATTERNS.md) に集約済。

---

## 3. Phase 1: cron schedule 修正 (warmup の実体化)

### 3.1 問題発見

設計書 ([cold-start-and-data-growth-analysis.md §4.1 P0](../20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md)) には「業務時間帯 7:00-20:00 JST、5 分ごと」と記載されていたが、本番 cron-job.org の実設定は **`0 9 * * *` (日次 9:00 AM のみ)**。

`/api/health` route 自体は存在し、cron 登録もされていたため CRON_JOBS metadata では「設定済」扱い。**スケジュール文字列まで実体と照合しないと warmup として機能していないことに気付けない**。

### 3.2 対応

cron-job.org 側で `*/2 * * * *` (2 分間隔 24/7) に変更。

- Netlify Functions の warm 保持時間 (5-15 分) より十分短い
- 業務時間外アクセスにも warm を維持
- Netlify Free 枠 (125k invocations/月) への影響: 21,600/月 = **17%** で許容範囲

### 3.3 検証結果

シークレットウィンドウで `/projects` document 取得を計測:

| 指標 | 変更前 (cold) | 変更後 (warm 維持) | 差分 |
|---|---|---|---|
| TTFB | **4.21s** | **1.94s** | **-54%** |

→ Phase 1 は明確に効果あり。残り ~700ms は Layout SSR の直列 DB チェーン (= Phase 2 の対象)。

### 3.4 ドキュメント更新

- [docs/operations/develop/DEPLOYMENT.md](../../../operations/develop/DEPLOYMENT.md) §6.1: `/api/health` のスケジュールを `*/2 * * * *` に更新、目的を「Netlify Function + Prisma warmup + Supabase wake、認証なし、17% Free quota」に明文化
- [cold-start-and-data-growth-analysis.md §4.1](../20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md): 2026-06-01 実装ノート callout を P0-P3 表の直下に追加

---

## 4. Phase 2: dashboard layout SSR の Promise.all 並列化

### 4.1 問題発見

Phase 1 後、warm 状態でも /projects の TTFB が ~1.94s。layout SSR を計測した結果、以下の **直列 await チェーン** が判明:

1. `requireAuthForLayout()` — tokenVersion 検証のため `prisma.user.findUnique` (~150ms region latency)
2. `getDegradedModeState(tenantId)` — `prisma.tenant.findFirst` + `countNullEmbeddings` (5 テーブル COUNT(*) UNION) を内部で逐次実行 (~58ms warm、cold 時はさらに膨らむ)

EXPLAIN ANALYZE で確認: `countNullEmbeddings` (projects/knowledges/risks_issues/retrospectives/memos の `tenant_id` + `deleted_at` + `content_embedding IS NULL` filter) は warm 58ms。しかし **layout は dashboard 配下の全画面で毎リクエスト走る** = 毎回 dead work が積み上がる。

### 4.2 設計判断

**2 関数構成に分離**:

| 関数 | 用途 | 含む集計 |
|---|---|---|
| `getDegradedModeBannerState(tenantId)` | layout banner 判定用 (軽量) | tenant 単発のみ |
| `getDegradedModeState(tenantId)` | `/settings/tenant` 詳細表示用 | banner + `countNullEmbeddings` (Promise.all で並列) |

型は `DegradedModeState extends DegradedModeBannerState` で後方互換。layout 側は banner 版を呼び、その上で **`requireAuthForLayout` と並列** で実行する:

```tsx
const session = await getCachedAuth();
if (!session) redirect(LOGIN_ROUTE);
const [user, degradedMode] = await Promise.all([
  requireAuthForLayout(),
  getDegradedModeBannerState(session.user.tenantId).catch(() => null),
]);
```

`getCachedAuth` は `React.cache(auth)` で wrap されているため、layout 先頭での先取り + `requireAuthForLayout` 内での再呼出は **同 request 内で 1 回しか JWT 復号しない** (same-request memoization)。

### 4.3 実装変更ファイル

| ファイル | 変更内容 |
|---|---|
| [src/services/degraded-mode.service.ts](../../../../src/services/degraded-mode.service.ts) | `DegradedModeBannerState` 型と `getDegradedModeBannerState` 関数を新規 export、`getDegradedModeState` を Promise.all 化 |
| [src/services/degraded-mode.service.test.ts](../../../../src/services/degraded-mode.service.test.ts) | テスト 8 件追加 (4 reason + active=false + null tenant + countNullEmbeddings 未呼出 + nullEmbeddings 非含有) — 計 17 PASS |
| [src/app/(dashboard)/layout.tsx](../../../../src/app/(dashboard)/layout.tsx) | `getCachedAuth` + Promise.all 並列化 |

### 4.4 品質チェック

| ゲート | 結果 |
|---|---|
| `pnpm tsc --noEmit` | EXIT 0 |
| `pnpm lint` | 0 errors (pre-existing 23 warnings) |
| `pnpm test src/services/degraded-mode.service.test.ts` | 17 PASS |
| `pnpm test` (全 suite) | 3869 PASS |
| `pnpm e2e:coverage-check` | OK (新規 route/page なし) |
| `pnpm build` | EXIT 0 |

### 4.5 期待される効果 (実測待ち)

- warm 時: ~58ms 削減 (countNullEmbeddings 除外) + 並列化で SSR 直列短縮分
- cold 時: 並列化の効果がより大きく出る (各 DB round-trip の cold 加算が直列に積み上がらない)

---

## 5. 残存課題 (Phase 3 以降)

### 5.1 [Phase 3] LCP 遅延の真因切り分け

Lighthouse で LCP element として `img.h-full.w-full.object-cover` (チャット FAB の `mascot-owl-chat.png`) が推定された。しかし `chat-fab.tsx` には PR #452 で既に `priority` プロパティが設定済、`<link rel="preload">` も発火している。

**仮説**: Netlify Image Optimization Lambda が **別 Lambda インスタンス** として cold start している (= `/api/health` warmup は Functions のみを温める)。

**次アクション**: Performance tab で Long Tasks + Network waterfall を timeline で確認し、document 取得後にどのリソースが critical path を作っているか視覚化する。Image Optimization 経路の warmup 必要性を判断。

### 5.2 [追加調査-A] credentials POST 2.90s

ログイン画面 → プロジェクト一覧遷移時、`POST /api/auth/callback/credentials` が **2.90s** を計上。bcrypt cost + JWT 署名 + Set-Cookie 構築の合計だが、cold start 連鎖の可能性も高い。

**次アクション**: Network timeline で POST credentials 前後の Function inferred ID (X-Nf-Request-Id) を比較し、cold start かログイン処理自体かを切り分ける。

### 5.3 [追加調査-B] /projects/[id] 3.14s

プロジェクト詳細画面の TTFB 3.14s。Lighthouse Treemap でクライアント bundle が **~880 KiB** と判明 (一覧画面 ~381 KiB に対し +500 KiB)。

主要チャンク内訳 (Treemap text データ、2026-05-31 計測):

| Chunk | サイズ | 推定 |
|---|---|---|
| `14x9e.u-fihl0.js` | 227.4 KiB | Next.js framework |
| `0jcsvr0vk56zw.js` | **174.2 KiB** | 詳細ページ固有最大 |
| `01412ebc1wqil.js` | 64.4 KiB | 詳細ページ固有 |
| `0j03tbtdrr5fn.js` | 60.9 KiB | 共通 |
| `09-w2_an40ud3.js` | 56.7 KiB | タブ系 (risks/members fetch を発火) |
| その他多数 (1-45 KiB) | ~250 KiB | タブ別コンポーネント群 |

**仮説**: 全タブ (概要 / 見積 / WBS / ガント / リスク / 課題 / 振り返り / ナレッジ / 参考 / メンバー / ステークホルダー) のコードを初回ロードで一括取得している。[cold-start-and-data-growth-analysis.md §4.2 P0](../20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md) で既に提案されている「タブ単位の lazy fetch」が裏付けられた。

**次アクション**: タブコンポーネントを `dynamic(() => import(...), { ssr: false })` で分離、初期 bundle を概要タブのみに絞る。

### 5.4 [追加調査-D] タブ API route の cold start 連鎖

課題一覧 (`/projects/[id]/issues` 相当) の Network 計測で、以下のような連鎖を観測 (2026-05-31):

| Name | Size | Time | Initiator |
|---|---|---|---|
| `risks` | 14.4 kB | **9.12s** | 09-w2_an40ud3.js |
| `members` | 1.5 kB | **9.22s** | 09-w2_an40ud3.js |
| `batch` | 1.1 kB | 1.17s | 01412ebc1wqil.js |

**観察**: サイズが 14.4kB と 1.5kB と桁違いに違うのに wait がほぼ同じ (9.12s / 9.22s) = ネットワーク帯域ではなく **サーバ側で同時にブロックされている**。後続 `batch` は 1.17s = Function が温まった結果。

**真因**: `/api/health` warmup は document route の Function を温めるが、`/api/projects/[id]/risks` / `/members` などのタブ API は **別 Function インスタンス** で cold のまま。

**次アクション**: warmup 対象を主要 API route 群 (`/api/projects/*` / `/api/auth/session` 等) に拡張するか、SSR 段階で必要データを Server Component 側で取得してタブ初回 fetch を減らす。

### 5.5 [追加調査-F] 全○○ ページ (グローバル一覧) の SSR + N+1 fetch 遅延

「全振り返り」 (`/retrospectives`) への遷移時に観測 (2026-05-31):

| 種類 | Name | Size | Time |
|---|---|---|---|
| **page RSC** | `retrospectives?_rsc=...` | 9.3 kB | **3.31s** |
| header reload | `announcements/projects?_rsc=...` | 1.2-5.1 kB | 396-485ms |
| **batch** | `batch` | 1.1 kB | **1.74s** |
| **UUID fetches** | `<projectId>?_r...` × 6 | 1.4-3.7 kB | 370-431ms |

**観察**:
- 1 page SSR (RSC fetch) が **3.31s** — 表示プロジェクト数だけ DB を叩いている可能性
- **UUID 単位の fetch が 6 回** — 表示中のプロジェクト ID と一致 = **N+1 クエリ / N+1 fetch パターン**
- `batch` 1.74s は cold start 連鎖 ([追加調査-D] と同じ問題)

**「全○○」と「○○一覧」は別問題**:
- ○○一覧 (per-project tabs): タブごとに別 Function インスタンス、cold start 連鎖が主因
- 全○○ (global list): 1 SSR の中で **N 個のプロジェクトを個別 fetch** している = ORM 設計の問題

**次アクション**:
- `/retrospectives` の service (例: `listAllRetrospectivesForViewer`) を Grep し、内部で **プロジェクトごとの追加 fetch がループ実行されていないか** 確認
- 解決パターン: `include: { project: true }` で 1 JOIN に集約 / `groupBy` + `where: { projectId: { in: [...] } }` の単発取得 / DataLoader 風バッチング
- N+1 解消後に再計測 (3.31s → ~500ms を目標)

### 5.6 [追加調査-G] テナント設定画面 (/settings/tenant) の SSR 多重直列

`/settings/tenant` への遷移で観測 (2026-05-31):

| Name | Size | Time |
|---|---|---|
| `tenant?_rsc=...` | 9.3 kB | **6.26s** |
| `icon.png` | 108 kB | 294ms |

この画面の SSR には以下が含まれる (推定):
1. `getDegradedModeState` (詳細版) — Phase 2 で内部 Promise.all 化済
2. DB 容量集計 (キャッシュ禁止原則のため毎回再集計)
3. API 利用量 (`currentMonthApiCallCount` 等)
4. storage / counter / プラン情報 など

**仮説**: Phase 2 で `getDegradedModeState` 内は並列化したが、上記の **他サービス間がまだ直列** で、各経路の 1-2 秒が積み上がり 6.26s に。

**制約事項**:
- [feedback_billing_data_realtime](../../../../C:/Users/SF02512/.claude/projects/c--Users-SF02512-GitHub-Private-BusinessManagementPlatform/memory/feedback_billing_data_realtime.md): 課金根拠データは **キャッシュ依存を避け毎回再集計** が原則 (誤請求リスク予防)
- → 「集計をスキップする」改善は不可

**次アクション**:
- page.tsx の service 呼出を Promise.all で並列化 (banner / capacity / usage / storage / counter を同時実行)
- 個別 service 内のクエリ最適化 (フィールド射影・INDEX 利用確認・1 クエリへの集約)
- 並列化後の実測値で「DB 集計コストの実費」が見えてから、これ以上の短縮余地を判断

### 5.7 [追加調査-E] /api/auth/session の過剰フェッチ

同一ページ表示中に `/api/auth/session` が **4 回 fetch** されることを観測 (2026-05-31):

| # | Size | Time | 備考 |
|---|---|---|---|
| 1 | 2.5 kB | 476 ms | 初回 |
| 2 | 2.5 kB | 383 ms | 連続 |
| 3 | 3.3 kB | **1.72s** | 🔴 cold 1 回挟まる |
| 4 | 2.5 kB | 396 ms | 再 warm |

累計 ~3 秒、同内容。NextAuth クライアント側 `useSession()` の挙動 (`refetchInterval` / `refetchOnWindowFocus` / 子コンポーネントの多重 hook) が原因と推測。

**次アクション**: `SessionProvider` で `refetchInterval={0}` + `refetchOnWindowFocus={false}` を設定。SSR で取得済み session を信用する。子コンポーネントの `useSession()` 多重呼出箇所も Grep で洗い出す。

---

## 6. 関連リンク

- 前 cycle journey: [performance-improvement-journey.md](../20260417/performance-improvement-journey.md)
- 設計書: [cold-start-and-data-growth-analysis.md](../20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md)
- 教訓集約: [KDD_PATTERNS.md §5.X+205](../../../knowledge/KDD_PATTERNS.md)
- cron 設定: [DEPLOYMENT.md §6.1](../../../operations/develop/DEPLOYMENT.md)
- 実装ブランチ: `perf/dashboard-layout-parallel-ssr`
