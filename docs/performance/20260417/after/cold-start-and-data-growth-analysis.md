# コールドスタート / データ増の根拠と恒久対策

- 元となった計測: `before/` と `after/` の HAR / Trace
- 先行レポート: [comparison-report.md](./comparison-report.md)・[bottleneck-and-fixes.md](./bottleneck-and-fixes.md)
- 作成経緯: PR #26 のレビューコメントで「TTFB 悪化とペイロード増加の外的要因を詳細に分析し、恒久対策まで立案する」要望を受けて作成

---

## 1. 要約

after 計測で観測された TTFB 悪化（+239 ms）とペイロード増加（+31 KB）は、改修とは**独立した 2 つの外的要因**の合算で説明できる。本プロジェクトは複数ユーザが日中継続してアクセスする業務サービスであり、**外的要因に由来するボトルネックも恒久対策で潰すべき**。本書は根拠と対策を整理する。

---

## 2. 外的要因 ①：Vercel の Function コールドスタート

### 2.1 根拠

| 証拠 | 値 / 事実 | 読み方 |
|---|---|---|
| TTFB（wait）| before 298 ms → after 537 ms（**+239 ms**）| サーバ側処理時間が 1.8 倍に。しかし after では DB クエリを 1 回減らしている（`listTasksWithTree`）ため、純粋に処理が増えるロジックは入っていない |
| 計測インターバル | before 08:35 → after 09:22（**47 分後**） | その間プロジェクトへのアクセス想定がなく、Vercel の Function が **idle→frozen→コールドスタート**を踏む条件に合致 |
| Blocked（接続確立）| before 8 ms → after 3 ms | TLS 再利用で良化。つまりネットワーク下層ではなく **Function 本体の起動**が遅延の主因 |
| Receive（本文転送）| before 2612 ms → after 2672 ms（ほぼ同等） | ダウンロード速度は帯域次第で変わらず、TTFB の変動がそのまま体感遅延に反映 |
| デプロイ直後の Lambda | after 計測は PR #25 マージ直後 | 新規 Lambda コンテナは **JIT 初期化・env 読み込み・import 解決**を実行。Prisma Client の初期化・pg Pool の new Pool など重い操作が一度だけ走る |

### 2.2 なぜ起きるのか（Vercel Runtime のしくみ）

1. Vercel は Serverless Functions（AWS Lambda 相当）上で Next.js サーバーを動かす
2. **リクエストのない時間が続くと Function がフリーズ**され、次のリクエストで以下を再実行:
   - Node.js ランタイム起動（~50〜150 ms）
   - アプリコード import（Next.js + Prisma + 認証ミドルウェアなど、数 MB のバンドル読み込み：~100〜300 ms）
   - DB コネクションプールの初期化（pg Pool + Prisma adapter 初期化：~50〜150 ms）
   - DB に初回クエリを打つ時の SSL ネゴシエーション・認証：**~100〜200 ms（Supabase Pooler 経由なのでさらに遅い）**
3. 上記を合算すると **+200〜500 ms** のレンジで TTFB が跳ねるのが典型。今回観測した +239 ms は**完全にこの範囲**

### 2.3 コードベースでの現状確認

- [`src/lib/db.ts`](../../../src/lib/db.ts): `globalThis` で Prisma Client を再利用しており、**ウォーム時は毎回初期化しない**実装になっている（OK）
- [`vercel.json`](../../../vercel.json): `crons` 未定義。**定期ウォームアップ cron は未設定**（← 改善余地あり）
- App Router の Server Component: `Suspense` / `loading.tsx` はログイン系のみ、**プロジェクト詳細では streaming 未活用**（← 改善余地あり）

---

## 3. 外的要因 ②：測定間のデータ量増加

### 3.1 根拠

| 証拠 | 値 / 事実 | 読み方 |
|---|---|---|
| ペイロード | before 149 KB → after 180 KB（**+31 KB / +21%**）| 改修で Knowledge は 100→10 件削減しているため本来は減るはず。増加分は他のデータに由来 |
| 増加幅の分布 | Knowledge 削減で期待される削減量は 1 件 ~1 KB × 90 件 = **~90 KB 減** | これが相殺されるほど増えている = **他で最低 120 KB 以上**増加していることを意味 |
| 主な被疑データ | Task（WBS ツリー: タスク 1 件あたり ~500-1000 bytes、ネスト分 2 倍）／ Retrospective（本文 Text × コメント配列）／ Risk（content・cause・response_detail 等 Text フィールド） | これらはページ内で全件取得される |
| 時間的要因 | before→after の間に 47 分経過、その間テストで追加登録された可能性が高い | WBS タブ・リスクタブ・振り返りタブの**eager 取得**が効いているため、どれが増えても RSC に乗る |

### 3.2 なぜ効いてくるのか（現行アーキテクチャの性質）

- プロジェクト詳細 `page.tsx` は**概要タブしか見ない場合でも 7 種全サービスを `Promise.all` で取得**
- Server Component から Client Component への props として全量が RSC ストリームに乗る（JSON ライク形式）
- ユーザー数 × 日次アクセス頻度で「データ量は自然に増える」ので、今のまま放置すると **半年〜1 年で数倍に膨張**しうる
- 多くの業務 SaaS で失敗するパターン: 「MVP 時は速かったが、運用半年で画面が目に見えて遅くなる」

---

## 4. 恒久対策（優先度付き）

本アプリは業務サービスで複数ユーザが継続アクセスするため、「たまにしか踏まない」ではなく「踏む前提で対策する」方針で整理する。

### 4.1 コールドスタート対策

| 優先度 | 対策 | 効果 | 工数 | リスク |
|:-:|---|---|:-:|---|
| **P0** | **Vercel Cron によるウォームアップ**。業務時間帯（例: 7:00-20:00 JST）5 分ごとに `/api/health` を叩き、Function を frozen させない | TTFB +200-400 ms の解消 | 小 | 極小 |
| P1 | `instrumentation.ts` で起動時に Prisma `$connect()` を呼び、初回リクエスト時の遅延を前倒し | +50-100 ms | 小 | 極小 |
| P1 | 認証・DB クエリの**並列化**（`page.tsx` で `auth()` と `checkMembership` を `Promise.all` に）| +50-100 ms | 小 | 小 |
| P2 | Vercel Fluid Compute / Edge Runtime 化（対応可能な箇所のみ）。Supabase 経由の Prisma は Node Runtime 必須のため**全 Edge 化は不可**、認証ミドルウェアなど限定的に Edge 化 | +50-100 ms（対象箇所のみ） | 中 | 中 |
| P3 | Prisma Accelerate（有料）導入。コネクションプーリングを CDN エッジで行い初回 DB クエリを短縮 | +50-150 ms | 中 | 中（料金発生） |

### 4.2 データ増加への耐性

| 優先度 | 対策 | 効果 | 工数 | リスク |
|:-:|---|---|:-:|---|
| **P0** | **タブ単位の lazy fetch**。`page.tsx` で eager 取得しているのは**概要タブに必要な project のみ**に絞り、他タブは Client Component で切替時に `/api/projects/[id]/tasks` 等を fetch（既に API route は存在、UI 側の繋ぎ込みだけ） | ペイロード 180 KB → 概要のみなら 5-10 KB（95% 減） | 中 | 低〜中（タブ切替時のローディング UX が変わる） |
| **P0** | **Streaming / Suspense**。`loading.tsx` と `<Suspense fallback={...}>` でタブごとに境界を置き、サーバ側で一部まだ取得できていなくても骨格だけ先に表示 | 体感 TTFB が -500ms レベル、LCP 改善 | 中 | 低 |
| P1 | **ガント・WBS の仮想化**。`react-window` / `@tanstack/virtual` でタスク 200 件超の画面を描画 | DOM 数 O(N) → O(可視行) | 中〜大 | 中（既存の展開/折り畳み UI との統合設計が必要） |
| P1 | **Retrospective の N+1 根本解消**。schema に `RetrospectiveComment.user` relation を追加 → 1 クエリ化 | TTFB -50-100 ms | 小 | 小（migration 要） |
| P1 | **ナレッジ・リスク・見積もり一覧のページネーション UI 実装**。現在 top N のみ表示で UI が無く、全量 fetch している場合がある | ペイロード線形化 | 中 | 低 |
| P2 | **フィールド射影の徹底**。Prisma `select` で DTO に必要なカラムのみ取得（`Text` 型の本文は一覧で不要、詳細画面のみで取得） | ペイロード -30〜50% | 中 | 低 |
| P2 | **revalidate / ISR**。変更頻度の低い集計系（プロジェクト状態別件数など）を `unstable_cache` で 60 秒キャッシュ | DB 負荷 -30% | 小 | 低 |

### 4.3 監視・観測可能性（パフォーマンス劣化の早期発見）

| 優先度 | 対策 | 効果 |
|:-:|---|---|
| **P0** | Vercel Analytics / Speed Insights を有効化し、TTFB / LCP / CLS を継続記録 | 本番での実測値で SLO 違反を即検知 |
| P1 | Next.js Server Timing ヘッダーを活用し、サーバ内の DB 時間・サービス時間を自動記録 | 遅延の内訳を production で把握可能 |
| P2 | Supabase の `pg_stat_statements` を有効化し、遅いクエリの自動トップ N 出力 | インデックス不足の早期発見 |

---

## 5. 次のアクション（推奨順）

1. **本書の承認**（内容の妥当性と優先度のご確認）
2. **P0 対応を別 PR で実施**:
   - PR-α: `feature/vercel-warmup-cron` — `/api/health` + `vercel.json` の crons 設定
   - PR-β: `feature/project-detail-tab-lazy-fetch` — プロジェクト詳細のタブ遅延ロード化
   - PR-γ: `feature/streaming-suspense` — プロジェクト詳細への Suspense 境界導入
3. **P1 以降は ROI を見てスプリント計画へ**

※ 本書は PR #26 の一部として追加。実装は別 PR に切り出す。

---

## 6. 参考

- Vercel Cold Start: <https://vercel.com/docs/functions/runtimes#cold-starts>
- Vercel Cron Jobs: <https://vercel.com/docs/cron-jobs>
- Next.js Streaming: <https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming>
- Prisma + Serverless（コネクション管理）: <https://www.prisma.io/docs/orm/prisma-client/deployment/serverless/deploy-to-vercel>
- @prisma/adapter-pg: <https://www.prisma.io/docs/orm/overview/databases/postgresql#pg-adapter>
