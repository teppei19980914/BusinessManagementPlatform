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

## 6. Phase C (2026-06-01) 包括対策 PR の記録

PR #477 後の Phase C として、追加調査 A-G の **対策が確立済 + 効果大** の項目を **1 PR** で
一括対応した。デグレ防止のため各実装で invariant を明示宣言し、E2E + Visual Regression +
drift 検知 cron でカバーされる範囲で集約。

### 6.1 実装範囲 (10 項目)

| ID | 内容 | 効果 | リスク | 実装場所 |
|---|---|---|---|---|
| **B-5** | `next.config.ts` の `experimental.optimizePackageImports` 追加 | bundle 縮小 | 極低 | [next.config.ts](../../../../next.config.ts) |
| **B-1+B-3** | `project-detail-client.tsx` のタブ 5 個を `dynamic(() => import(...), { ssr: false })` 化 (Estimates / Tasks / Gantt / Members / Stakeholders) | -325 KiB 初期 bundle | 極低 | [project-detail-client.tsx](../../../../src/app/(dashboard)/projects/[projectId]/project-detail-client.tsx) |
| **A-3** | Image `sizes` プロプ明示 (mascot 32+48 重複ロード抑止) | mascot 1 解像度に統一 | 極低 | [login/page.tsx](../../../../src/app/(auth)/login/page.tsx) / [chat-fab.tsx](../../../../src/components/chat-semantic-search/chat-fab.tsx) / [app-header.tsx](../../../../src/components/app-header.tsx) |
| **E** | SessionProvider に `refetchInterval={0}` + `refetchOnWindowFocus={false}` 追加 | session 4 回 fetch → 1 回 (SSR で初期化済を信用) | 中 (MFA/Theme/TZ/Locale SSR 同期 E2E でガード) | [session-provider.tsx](../../../../src/components/session-provider.tsx) |
| **F** | リスト系 `<Link>` (retrospectives/risks/knowledge/my-tasks/customer-detail) に `prefetch={false}` | 表示行ぶんの自動 RSC fetch 抑止 | 低 | 5 ファイル |
| **G-2** | `settings/tenant/page.tsx` の info + apiReconcile + degradedMode + cardSummary を **Promise.all 並列化** | 4 直列 → 1 並列 | 中 (請求 invariant 不変宣言) | [settings/tenant/page.tsx](../../../../src/app/(dashboard)/settings/tenant/page.tsx) |
| **D-1** | `/api/health` warmup を 6 常用テーブル (tenants/users/projects/risks_issues/retrospectives/knowledges) で `LIMIT 0` pre-warm | Prisma plan cache 事前 populate | 低 | [api/health/route.ts](../../../../src/app/api/health/route.ts) |
| **回帰テスト追加** | session-provider 要件テスト + health warmup 動作テスト | 将来逸脱を CI で検出 | - | session-provider.test.tsx / route.test.ts |

### 6.2 スコープ外 (skip 理由)

| ID | 理由 |
|---|---|
| **A-2-i** authEventLog INDEX | **既に実装済** ([schema.prisma:1144](../../../../prisma/schema.prisma#L1144) `idx_auth_events_email`、G2-e-1 2026-05-31 追加) |
| **A-4** Bugsnag preflight | 本コードベースに該当なし。Netlify Deploy Preview のオーバーレイ artifact のみ、本番無影響 |
| **B-2** Retrospectives + Knowledge lazy | react-markdown 遅延感のデグレリスク中 → 別 PR で個別検証 |
| **B-4** Risks (リスク/課題 共用) lazy | 先に開くタブに依存する遅延発火 → 別 PR で個別検証 |
| **Phase 3** LCP (mascot Image Optimization Lambda cold) | Lambda 経路の warmup インフラ調査が必要 → 別 PR |

### 6.3 デグレ防止 invariant 宣言 (本 PR で守った契約)

- **ApiCallLog SUM = 画面表示 = 請求金額**: G-2 で並列化したが集計ロジック・select 範囲・drift 検知 4 軸 (cost / count / display / audit) を一切変更していない
- **テナント越境防止**: F の `<Link prefetch={false}>` は visibility / viewerTenantId フィルタを通過した行のみに付与、N+1 を構造から除去するわけではなく自動 prefetch を抑止するだけ
- **セッション無効化境界**: E の SessionProvider 設定変更は middleware (tokenVersion 検証) と layout DB 照合に影響しない。明示 `useSession().update()` (テーマ変更等) は引き続き動作
- **/api/health 認証なし設計**: D-1 は同一エンドポイント内の SQL 拡張のみ、route の認証要件は不変
- **dashboard layout SSR 並列化** (PR #477) との独立性: 本 PR は project-detail-client / settings/tenant / health route で局所変更、layout 経路には触れない

### 6.4 期待される定量効果 (本番計測待ち)

| 経路 | 改善見込み | 根拠 |
|---|---|---|
| /projects/[id] 初期 bundle | **-325 KiB** | 5 タブ dynamic import (B-1+B-3) |
| /settings/tenant SSR | **-3s 強** | 4 並列化 (G-2) |
| 全 page セッション fetch | **-1.5〜2.5s** | 過剰 4 回 → 1 回 (E) |
| グローバル一覧の自動 prefetch | **-1.5s** | 表示行数ぶんの自動 RSC fetch 削減 (F) |
| /login mascot 重複ロード | **~500ms** | srcset 1 解像度固定 (A-3) |
| タブ API 初回 cold | (間接効果) | burst 数自体を E + F で削減、D-1 で Plan cache pre-warm |

### 6.5 検証手順 (マージ後)

1. Netlify Deploy Preview でログイン → /projects → 任意プロジェクト詳細 → 各タブ切替して Loading UI が出ること
2. シークレットウィンドウで本番 (`https://tasukiba.com`) を開き、Network panel で `/api/auth/session` が 1 回のみであることを確認
3. /settings/tenant の表示時間が改善されていることを確認 (DevTools Network の document time)
4. リスト系 (全○○) 画面で表示行の `<Link>` が hover 時に自動 RSC fetch していないことを確認 (Network panel)
5. CI E2E 全 PASS + Visual Regression 差分なしを最終確認

---

## 7. Phase 4 (2026-06-01 後半) — 体感差を埋める追加対策

PR #478 マージ後にシークレットウィンドウで再計測した結果、以下の体感差が残存:

| 観点 | 観測値 | 評価 |
|---|---|---|
| /settings/tenant | **6.26s → 3.40s (-46%)** | 大幅改善 ✅ |
| タブAPI cold (risks/members) | **9.12s/9.22s → 2.44s/1.76s (-73%/-81%)** | 劇的改善 ✅ |
| /api/auth/session 回数 | **4 → 1 回 (-75%)** | 改善 ✅ |
| /retrospectives | **3.31s → 2.26s (-32%)** | 改善 ✅ |
| /projects/[id] document | 3.14s → 3.63s | 🔴 微増 (page.tsx ではなく membership 重複が原因と判明) |
| /login document | 591ms → 573ms | 🟡 横ばい (既にほぼ最適) |
| 全○○ navigation | 残存 | 🔴 nav menu Link prefetch が原因と判明 |
| mascot 2 重ロード | 残存 (1.5s → 313ms) | 🟡 timing は改善、件数は残存 |

体感差を埋めるための追加 3 項目を Phase 4 として実装した。

### 7.1 Phase 4-A: checkMembership + getActualProjectRole 統合

**根本原因**: [page.tsx の Promise.all](../../../../src/app/(dashboard)/projects/[projectId]/page.tsx) は 4 service を並列実行していたが、`checkMembership` と `getActualProjectRole` が**それぞれ内部で `project_members` テーブルへ独立 query** を発行していた。非 admin で:
- Track 1 (checkMembership): `project.findUnique` → `projectMember.findFirst` (sequential, 2 round-trip)
- Track 2 (getActualProjectRole): `projectMember.findFirst` (1 round-trip、Track 1 の 2 つ目と完全重複)

**対策**: [src/lib/permissions/membership.ts](../../../../src/lib/permissions/membership.ts) に `checkMembershipWithActualRole` を新設、内部で `[project, member]` を Promise.all で並列実行。全 plan / ロールで **2 query → 1 round-trip** に統合。

**セキュリティ invariant 不変宣言**:
- テナント越境チェック (severity-1) は完全保持
- admin 短絡 (admin → projectRole='pm_tl') の挙動も同一
- 論理削除済プロジェクトの扱い (admin 閲覧可 / 非 admin 404) も同一
- actualProjectRole は admin 短絡の影響を受けない (実 row ベース) を維持
- 非 admin 視点では `actualProjectRole === projectRole` (= 実 row の値) を unit test で検証 (PR #479 で 8 件追加)

**期待効果**: 非 admin ユーザの project 詳細 SSR で 1 round-trip 削減 (warm ~50-150ms 短縮)。

### 7.2 Phase 4-B: AppHeader Nav Link prefetch=false

**根本原因**: 観測された「全振り返り遷移時の 6 つの UUID 自動 fetch」は、行 Link ではなく **ヘッダの「資産」グループ dropdown の Link が viewport 進入時に default prefetch=true で全 5 経路 (全リスク/全課題/全振り返り/全ナレッジ/全メモ) の RSC を裏で取得していた** ためと判明 ([F の修正](../../../../src/app/(dashboard)/retrospectives/all-retrospectives-table.tsx) は行 Link のみで、nav menu Link は対象外だった)。

**対策**: [src/components/app-header.tsx](../../../../src/components/app-header.tsx) の `FlatNavLink` と `GroupMenu` 内 `Link` の 2 箇所に `prefetch={false}` を付与。

**効果**:
- ヘッダ表示時の自動 RSC fetch 累計 (数百 KB) が削減
- ユーザがメニュー hover した時のクリック対象 1 件のみが on-demand 取得される
- 初回ナビは +200-500ms 遅くなるが、自動 prefetch の累計負担消去で全体 UX 向上

### 7.3 Phase 4-C: chat-fab priority 削除

**観察**: Lighthouse は `chat-fab` の `mascot-owl-chat.png` を LCP element と検出していたが、**実際の LCP element は本文 (テーブル / カード等)** で、FAB は画面右下の補助要素。FAB に `priority` を付けていたため `<link rel="preload">` が document head に注入され、本文 LCP より先に Image Optimization Lambda 起動 + mascot 取得が走る = **本文 LCP を逆に遅延** させていた。

**対策**: [chat-fab.tsx](../../../../src/components/chat-semantic-search/chat-fab.tsx) の `priority` を削除し `loading="eager"` に切替。「画面表示後すぐ取得、優先順位は本文より下」のセマンティクス。

**A-3 mascot sizes プロップの追跡**:
- A-3 で `sizes="40px"` 等を追加し、各画像の取得時間は短縮 (542ms+1.02s → 117ms+196ms)
- ただし 2 リクエスト自体は残存 = Next.js Image が `width={N}` 固定の場合、`imageSizes` から 1x + 2x の 2 entry srcset を生成し、priority preload scanner が両方 prefetch する挙動
- 完全解消には (a) inline SVG / (b) `images.imageSizes` カスタム / (c) 静的 pre-generate のいずれかが必要 → **本 PR スコープ外** (設計影響大、別 PR で検討)

### 7.4 Phase 4 実装範囲

| ID | 内容 | デグレリスク | 実装場所 |
|---|---|---|---|
| **4-A** | `checkMembershipWithActualRole` 統合 + page.tsx 適用 | 中 (テナント越境 invariant 維持必須) | [membership.ts](../../../../src/lib/permissions/membership.ts) / [projects/[projectId]/page.tsx](../../../../src/app/(dashboard)/projects/[projectId]/page.tsx) |
| **4-B** | Nav Link prefetch=false | 低 (初回 nav が +200-500ms) | [app-header.tsx](../../../../src/components/app-header.tsx) |
| **4-C** | chat-fab priority 削除 | 低 (FAB 表示は遅延、機能影響なし) | [chat-fab.tsx](../../../../src/components/chat-semantic-search/chat-fab.tsx) |
| **回帰テスト** | checkMembershipWithActualRole 8 件 + chat-fab eager 確認 | - | membership.test.ts / chat-fab.test.ts |

### 7.5 期待される定量効果 (Phase 4 単独、本番計測待ち)

| 経路 | 改善見込み | 根拠 |
|---|---|---|
| /projects/[id] document (非 admin) | -50〜150ms | Phase 4-A の 1 round-trip 削減 |
| 全○○ 系画面遷移時の累計通信 | -100〜500 KB | Phase 4-B の自動 prefetch 廃止 |
| 全 dashboard 画面の document LCP | -100〜500ms | Phase 4-C の preload <link> 競合解消 |

---

## 8. Phase 5 (2026-06-01 最終調整) — 残課題の極小一掃

PR #479 マージ後の計測結果 (シークレットウィンドウ、本番) を統合し、Phase 4-A は **/projects/[id] document 3.63s → 1.58s (-57%)**、Phase 4-B は **全○○ N+1 UUID 6 件 → 0 件 (-100%)** の劇的効果を確認。

残った最後の改善余地として、**(a) /projects 一覧の project 行 Link 自動 prefetch (10 req / ~30 kB)** と **(b) 全○○ service 内の memberships + main findMany 直列実行 (1 round-trip 余分)** を Phase 5 として一掃した。「効果極小 / UX 寄与なし」項目 (mascot 2 重ロード件数 / /login 961ms 単発変動 / credentials POST 計測のみ) は本 PR スコープ外とする方針を user 合意済。

### 8.1 Phase 5-A: /projects card Link prefetch=false

**根本原因**: PR #478 の F (全○○ 行 Link) と PR #479 の 4-B (header nav Link) を通したが、**/projects 一覧の project name 行 Link が default prefetch=true** で残存。表示 5 プロジェクトに対し layout + page の RSC が 1 件 = 2 fetch × 5 = **10 fetch / ~30 kB** が裏で発生。

**対策**: [projects-client.tsx](../../../../src/app/(dashboard)/projects/projects-client.tsx) の desktop テーブル行 + mobile card view の 2 箇所 `<Link>` に `prefetch={false}` を付与。回帰テスト ([projects-client.test.ts](../../../../src/app/(dashboard)/projects/projects-client.test.ts)) で固定。

**期待効果**: /projects 表示時の累計 10 req / ~30 kB 削減

### 8.2 Phase 5-B: 全○○ service の Promise.all 並列化

**根本原因**: `/retrospectives` 計測で 2.28s 残存。service ([listAllRetrospectivesForViewer](../../../../src/services/retrospective.service.ts)) を確認したところ、非 admin で:
1. `memberships = await prisma.projectMember.findMany(...)`
2. `retros = await prisma.retrospective.findMany(...)`

が **直列 await** で実行されており、両 query は完全に独立なのに 1 round-trip 余分。同パターンが `listAllRisksForViewer` / `listAllKnowledgeForViewer` にも存在。

**対策**: 3 service とも `Promise.all([memberships, mainFindMany])` で並列化。admin 経路は `Promise.resolve([])` で空配列即時返却。

**セキュリティ invariant 不変宣言** (3 service 共通):
- `tenantId = viewerTenantId` フィルタ (severity-1 越境防止) 保持
- `visibility='public'` フィルタ (draft 非表示) 保持
- `deletedAt: null` 保持
- `memberProjectIds` による per-link projectName マスキング (severity-1 個人情報漏洩防止 / PR #157) 保持

→ 既存 service test 166 件は全件 PASS、ロジック変更なしを担保。

**期待効果**: 非 admin ユーザの全○○ ページ document SSR で **-200〜400ms** (warm 時)

### 8.3 Phase 5 実装範囲

| ID | 内容 | デグレリスク | 実装場所 |
|---|---|---|---|
| **5-A** | /projects 行 Link prefetch=false (desktop + mobile) | 低 (初回クリック +200-500ms、Phase 0 と挙動一致しないだけ) | [projects-client.tsx](../../../../src/app/(dashboard)/projects/projects-client.tsx) |
| **5-B** | 3 service の memberships + main findMany 並列化 | 中 (テナント越境 + visibility invariant 維持必須) | [retrospective.service.ts](../../../../src/services/retrospective.service.ts) / [risk.service.ts](../../../../src/services/risk.service.ts) / [knowledge.service.ts](../../../../src/services/knowledge.service.ts) |
| **回帰テスト** | projects-client prefetch invariant 2 件 | - | projects-client.test.ts (新規) |

### 8.4 累計改善表 (Phase 0 → PR #480 後の予測)

| 画面 / 観点 | Phase 0 | PR #479 後 | **PR #480 後 (予測)** | 累計改善 |
|---|---|---|---|---|
| /projects/[id] document | 3.14s | 1.58s | 1.58s | -50% (PR #479 効果維持) |
| **/projects 表示時の auto-prefetch** | 既定 prefetch | 10 req / ~30 kB | **0 req / 0 kB** | **-100%** ⚡ |
| **/retrospectives document** | 3.31s | 2.28s | **1.9-2.1s** | **-37%** (見込み) |
| /risks / /knowledge document | (同パターン) | 同程度 | **-200〜400ms** | (新規改善) |
| /settings/tenant document | 6.26s | 3.38s | 3.38s | -46% (PR #478 維持) |
| 課題一覧 risks/members | 9.12s/9.22s | 2.39s/1.20s | 同等 | -74%/-87% |
| 全○○ N+1 UUID fetch | 6 件 | 0 件 | 0 件 | -100% (PR #479 維持) |
| /api/auth/session 回数 | 4 回 | 1 回 | 1 回 | -75% (PR #478 維持) |

### 8.5 本 PR スコープ外項目 (user 合意済)

| 項目 | 理由 |
|---|---|
| mascot 2 重ロード (件数残存) | A-3 で各画像 timing は短縮済、件数のみ残る。完全解消には inline SVG / imageSizes config / 静的 pre-generate が必要で設計影響大 |
| /login document 961ms 単発計測 | 変動可能性、複数回計測で平均化要 |
| credentials POST 3.58s | 真因切り分け (bcrypt vs DB vs cold) の instrumentation が必要、計測単体では UX 改善せず |

これらは Phase 6 以降の独立検討事項とする。

---

## 9. 関連リンク

- 前 cycle journey: [performance-improvement-journey.md](../20260417/performance-improvement-journey.md)
- 設計書: [cold-start-and-data-growth-analysis.md](../20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md)
- 教訓集約: [KDD_PATTERNS.md §5.X+205](../../../knowledge/KDD_PATTERNS.md)
- cron 設定: [DEPLOYMENT.md §6.1](../../../operations/develop/DEPLOYMENT.md)
- Phase 2 実装ブランチ: `perf/dashboard-layout-parallel-ssr` (PR #477)
- Phase C 実装ブランチ: `perf/comprehensive-perf-2026-06-01` (PR #478)
- Phase 4 実装ブランチ: `perf/phase-4-page-ssr-and-prefetch` (PR #479)
- Phase 5 実装ブランチ: `perf/phase-5-list-link-and-service-parallel` (本 PR)
