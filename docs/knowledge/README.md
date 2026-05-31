# knowledge/ — ナレッジ・教訓集 (KDD)

本ディレクトリは、PR ごとに蓄積された **既存機能の改修パターン・過去の罠・解決事例** (Knowledge-Driven Development) を集約する。本サービスは KDD フローを採用しており、新規 PR で得た知見は必ず本ディレクトリに追記される。

## 読み方

1. まず下記の **テーマ別索引** で関心領域のエントリ (§番号) を探す。
2. 見つけた **§番号** で [KDD_PATTERNS.md](./KDD_PATTERNS.md) を検索する (例: `§5.X+202` / `5.X+202`)。本文は時系列順に並ぶため、番号での検索が最速。
3. KDD_PATTERNS.md 冒頭には可読性用の **目次 (TOC)** ブロックがあり、見出しへのアンカーリンクも辿れる (アンカーが外れても §番号テキストで検索可能)。

## ファイル一覧

| ファイル | 内容 |
|---|---|
| [KDD_PATTERNS.md](./KDD_PATTERNS.md) | KDD エントリの全体集。元 DEVELOPER_GUIDE.md §5 を **時系列で保存** (§5.1〜§5.62 の改修手順 + §5.X〜§5.X+202 の罠・教訓)。総 **271 エントリ** (内訳: §5.1〜§5.62 系 67 [サブ番号 §5.10.1/.1.5/.2・§5.11.1 含む、§5.X 単独 1 件含む] + §5.X+N 系 204 [番号 0〜202 + §5.X+24・§5.X+81 が各 2 件])。冒頭に目次 (TOC) を併設 |

> 番号体系の注意:
> - §5.1〜§5.62 のうち §5.10 系はサブ番号 (§5.10.1 / §5.10.1.5 / §5.10.2) を含む。
> - §5.X+N 系には番号重複が 2 組ある: **§5.X+24** (dependabot lock 相互コンフリクト / 集計除外 3 段) と **§5.X+81** (E2E fixture 自己完結化 / 請求金額計算バグ突合)。本索引では区別のため注記を付す。

---

## テーマ別索引 (全 271 エントリ網羅)

### 認証・セッション・ログイン
- §5.2 — 認可ルール (checkPermission マトリクス) の変更箇所
- §5.X — ログイン失敗メッセージを失敗カテゴリごとに UI 分岐
- §5.X+31 — 「ログインできない」の真因は別経路 / 防御的 server component
- §5.X+32 — invalid_password 記録だが本人正入力 + パスワードマネージャ使用 (authorize 例外でログ残らない)
- §5.X+46 — JWT 失効カウンタを自操作で increment すると同セッション即死 → 自/他操作で分ける
- §5.X+66 — NextAuth v5 + Netlify で useSession().update() の Set-Cookie がブラウザ不達 (MFA/テーマ/i18n 同時破綻)
- §5.X+67 — update() 削除 PR は E2E の session await も同時削除 + CodeQL bypass は単一出口集約
- §5.X+68 — DB 更新成功 + cookie 再署名 silent fail = 200 OK の無限ループ → 戻り値を判別 union に
- §5.X+69 — /api/auth/* カスタム route は NextAuth auto-refresh が Set-Cookie 上書き → matcher 除外
- §5.X+71 — Set-Cookie 再署名 route は全 protected path で middleware matcher 除外
- §5.X+84 — signOut の Set-Cookie 脱落 → tokenVersion increment + layout DB 照合で実質削除
- §5.X+89 — User.email global UNIQUE は再利用/複数所属で 500 → @@unique([tenantId, email]) + tenantSlug 必須化
- §5.X+90 — multi-tenant + import API で Beginner 試用 abuse 成立 → 既登録 email は払い出し不可化
- §5.X+94 — ログイン履歴 localStorage は型/形状/期限を読込時に全件検証 (XSS 改竄破棄)
- §5.X+96 — 「ログイン」含むボタン追加で getByRole substring が strict 違反 → exact 化
- §5.X+168 — chat 履歴 sessionStorage は「ログアウト clear + ユーザ ID 変化検知 + 件数上限」3 点セット
- §5.X+185 — Stripe Checkout 戻り時の session 失効を pending flag で設定画面に救済

### テナント分離・権限・可視性
- §5.14 — readOnly edit dialog の子コンポーネント fetch が認可漏洩 (403 Console)
- §5.19 — 横断ビュー (全リスク/課題/振り返り/ナレッジ) の可視性レイヤ整理
- §5.51 — 公開範囲 (visibility) と認可マトリクスの統合
- §5.61 — /api/attachments の visibility-aware 認可 + memo にコメント追加
- §5.X+13 — マルチテナント越境バグの恒久対策 + 「過去指示が反映されない」根本原因
- §5.X+14 — テナント越境バグ全網羅監査と Phase 1 修正 / Phase 2 残課題
- §5.X+18 — severity-1 セキュリティ仕様の 3 層防御テスト戦略
- §5.X+23 — super_admin で Default テナントを集計除外しても画面非表示にはしない
- §5.X+85 — UI=API 一致でハンドラ削除 → 405 を越境 E2E 期待値配列に追加
- §5.X+153 — 「他人参照不可」可視性 + 編集権限の組合せは service 層で明示拒否 (API 直叩き対策)
- §5.X+154 — 個別/bulk update の認可乖離で silent skip される行が発生
- §5.X+155 — assigneeId validator は UUID 形式のみ → service 層で tenantId 検証必須
- §5.X+61 — 「公開範囲: 自分のみ」の DB 表現が資産種別ごとに違う (Knowledge/RiskIssue/Retro は 'draft'、Memo は 'private')
- §5.X+157 — User soft-delete を assignee 検証で考慮 (退職者指定防止)
- §5.X+169 — @default(dbgenerated tenantId) は tenantId 渡し忘れを silent に Default 混入
- §5.X+184 — Server 403 ガードに対応する Client UI option disable がなく矛盾 → 二段ガード

### 課金・Stripe・請求堅牢性
- §5.X+3 — LLM 機能の本番投入には緊急停止フラグを最初から仕込む
- §5.X+24 (集計除外) — 集計除外フィルタは集計/snapshot/履歴の 3 段全部に揃える (月次 CSV に Default 混入防止)
- §5.X+47 — 課金根拠データは画面遷移時に再集計 + 手動再集計ボタン併設 (cron キャッシュ依存回避)
- §5.X+50 — Bulk LLM は withMeteredLLM を 1 度ラップ + callback 内で voyageEmbed 分割呼出
- §5.X+51 — visibility='draft' なら embedding 生成しない (提案非対象データに課金しない)
- §5.X+60 — 「1 業務操作 = 1 ApiCallLog」がエンティティ作成で抜けやすい (Beginner 上限半減枯渇)
- §5.X+62 — 提案候補化に追加条件があるエンティティは embedding 生成判定も同条件で絞る
- §5.X+63 — 全空文字入力でも LLM を呼ぶ罠 (Anthropic 課金)
- §5.X+78 — 画面表示の真値ベース化 (counter → ApiCallLog SUM) で fixture seed 整合性破壊 → 同時整合
- §5.X+79 — 月次 snapshot は ApiCallLog SUM ベースに統一 (counter ベースは過去月 drift 固定)
- §5.X+81 (請求計算バグ) — 請求金額計算ロジックのバグは「保存値 vs 再計算値」突合でしか検知不能
- §5.X+99 — Netlify Deploy Preview で Stripe Checkout 戻り先が本番 URL → NEXTAUTH_URL を context 同期
- §5.X+100 — Stripe 払い設定切替の client state 同期漏れ + 旧 server ガード残置 = 請求漏れリスク
- §5.X+101 — Netlify Deploy Preview 本番 URL リダイレクト真の根本解決 (context 分離 + trustHost)
- §5.X+103 — Stripe Checkout を sameSite='strict' cookie が壊す + paymentMethod 1 ステップ強制遷移
- §5.X+104 — Stripe 自動請求の堅牢性 多層防御 現状と段階改修ロードマップ
- §5.X+105 — Subscription cancel 直後の DB sub_id 残置が二重 Subscription エラー → 即時クリア
- §5.X+106 — idempotencyKey に paymentMethodId を含めないとカード再登録が永久に壊れる
- §5.X+107 — 複数 active Subscription 並存で二重課金リスク → setup 直前に全 active 強制 cancel
- §5.X+108 — Customer.default_payment_method ≠ Subscription 側 → Subscription を優先取得
- §5.X+109 — Customer Portal でデフォルト変更しても既存 Sub の引落カードは不変 → Checkout 直 update に統一
- §5.X+113 — ADR 採択後の dead code が UI 自動切替と API plan 強制上書きを同時並行 (Expert/Beginner 矛盾)
- §5.X+127 — 課金 featureUnit 縮小 (ADR-0019) で fixture が無料 unit 使用 → ¥0 集計破綻
- §5.X+132 — requestId の billingScope 識別は composite key 化で完全 unique 保証
- §5.X+148 — 3 レイヤ請求モデルの SKU 追加は migration/snapshot/表示/CSV の 4 経路同時 fix
- §5.X+189 — LEARNING_FREE 等の非課金 LLM 経路は check-llm-billing-bypass の ALLOWLIST_EXACT へ
- §5.X+201 — LEARNING_FREE featureUnit は UI counter に表示されない仕様 → UI で注記

### 容量・ストレージ課金ガード
- §5.X+27 — ストレージ上限を LLM プランから切離し共通ベース + add-on 独立軸 (guard サービス化)
- §5.X+29 — 個別 CRUD のストレージ Pre-check は API route 層に集約
- §5.X+130 — storage-guard が import 系のみで一般 CRUD は peak 永久 0 の隠れ穴 → daily cron で補完
- §5.X+131 — ADR-0020 $queryRawUnsafe を Prisma.sql/Prisma.raw に refactor (SAST スコア 78→98)
- §5.X+133 — circuit breaker open の手動復旧 API 欠如 (永久 write 拒否の死罠) → super_admin endpoint
- §5.X+134 — ADR-0020 4 回目検証で migration 初期化漏れ / N+1 / 認可漏れ / agent 誤検出
- §5.X+135 — ADR-0020 5 回目検証で実バグ 0 確認 (chain/wiring/precision 網羅)
- §5.X+136 — ユーザ判断で deferred 項目を本 PR に取込 (R12/drift batch/統合テスト/R19)
- §5.X+137 — ADR-0020 6 回目検証で直近追加分 3 件 (memory/dynamic import/defense-in-depth)
- §5.X+158 — 旧 DB column 撤去は schema/service/UI/JWT claim/script/docs の 6 レイヤ同時撤去
- §5.X+161 — 旧 DB column 撤去は 7 layers (6 + e2e/fixtures/) (§5.X+158 続報)
- §5.X+163 — Prisma XOR<Update,UncheckedUpdate> は excess property check 効かず tsc すり抜け

### 提案エンジン・embedding・チャット / FAQ・AIヘルプ
- §5.13 — 過去 Issue/Retrospective 提案ロジックを Knowledge と同等の tag-aware に統一
- §5.20 — 提案リストから「自プロジェクト紐付け済」を DB 除外
- §5.38 — 空白区切り OR キーワード検索の共通ヘルパ
- §5.62 — 提案エンジン v2 の設計議論と意思決定ログ
- §5.X+52 — form 入力連動 preview API は debounce + AbortController + 共通 hook
- §5.X+180 — Tier UI の Top 5 + 折りたたみ統一 (姉妹 chat-panel で先行検証、共有定数で DRY)
- §5.X+182 — 姉妹 UI 横展開時に i18n placeholder {count} セマンティクスをコピー忘れ
- §5.X+186 — Next.js after() で重い LLM 呼出を response クリティカルパス外へ (ADR-0026)
- §5.X+187 — FAQ 文言と実装の drift 検知パターン
- §5.X+188 — FAQ AI チャット ハルシネーション対策 5 点セット (ADR-0027)
- §5.X+191 — Anthropic SDK の system プロンプトに cache_control 付け忘れ (full-context コスト爆発防止)
- §5.X+192 — 既存資産流用を検討せず short-term で full-context を選んだ設計判断ミス (ADR-0027→0028)
- §5.X+193 — FAQ embedding 同期 drift 検知の 4 層防御 (ADR-0028 RAG 移行)
- §5.X+194 — 外部 LLM API 暴走防止の 7 層パターン (認証/IP rate limit/月次 hard cap/...)
- §5.X+196 — FAQ embedding 生成は手動 SOP でなく Netlify build hook で自動化 (§5.X+193 続報)

### CI・品質ゲート・セキュリティスキャン
- §5.46 — 外部提供スクリプトの導入と既存 skill 統合パターン
- §5.47 — PR ワークフローへの security-check 統合と score 90+ 維持戦略
- §5.48 — セキュリティスコア初回ブリングアップ (30→94) + CI Gate 化
- §5.X+7 — ブランチカバレッジ閾値 (70%) 維持戦略
- §5.X+15 — `tsc --noEmit` と `build` は別物、コミット前 build 必須
- §5.X+16 — CodeQL 認可 dispatch 偽陽性は switch 文で構造的に解消
- §5.X+45 — schema に User 列追加で USER_PII_FIELDS / USER_EXPORT_FIELDS 分類更新 (L-6 CI ガード)
- §5.X+48 — Client Component が @/services/* から value import で Prisma が client bundle 混入し build 失敗 → 閾値定数を純粋 config に分離
- §5.X+49 — 新規 route/page は E2E_COVERAGE.md 追記 (e2e:coverage-check が exit 1)
- §5.X+64 — 価格・定数一括変更で UI 表示文字列テストが unit grep から漏れる (Playwright toContainText が旧価格のまま fail)
- §5.X+53 — Supabase Data API は public 全テーブル anon grant 済 (Prisma 直結でも放置で全件漏洩)
- §5.X+58 — push 前セルフチェックに e2e:coverage-check を必ず含める
- §5.X+86 — security-check の SQL injection ガードはコメント内キーワードも CRITICAL 検出
- §5.X+87 — 再帰 sanitize の動的 key 書込で CodeQL prototype pollution HIGH → Object.create(null)
- §5.X+88 — Remote property injection は defineProperty でも HIGH → JSON.stringify replacer で sanitize
- §5.X+110 — bash pipe で exit code 誤判定 (ローカル PASS 錯覚) + coverage-check 漏れ
- §5.X+111 — 契約変更 + invariants test exemption 漏れの 2 件同時 CI fail
- §5.X+115 — 新規 CVE 公開日に green PR が突然 red + OSV-Scanner と pnpm-audit の判定ズレ
- §5.X+117 — CodeQL が regex validate 済を stored XSS 誤検出 + statSync→readFileSync TOCTOU
- §5.X+120 — 公開 layout の await auth() 直呼が banned-pattern fail → optionalAuthForLayout 新設
- §5.X+122 — eslint react-hooks 7.x refs-during-render + testid 3 重衝突
- §5.X+140 — package.json 編集後 pnpm install 忘れで frozen-lockfile が 7 ジョブ同時 fail
- §5.X+142 — check-llm-billing-bypass は JSDoc 内 voyageEmbed() も誤検知 → 別表記
- §5.X+143 — リテラル NULL バイト (0x00) を埋めると git が binary 判定し review 不能
- §5.X+152 — migration SQL の table 名 typo が failed entry を残し以降の deploy 全 block
- §5.X+175 — エラーマッパー wrapper は新規エラーコードを握り潰す → 新規 code 追加時は wrapper 経由の全 route を grep 同時修正
- §5.X+176 — main の test 234 型エラーは PR 範囲外で無視可 / 新規 test は型エラーゼロ徹底
- §5.X+178 — test の tsc strict エラーは `as any` でなく helper に `as` を閉じ込める
- §5.X+190 — Prisma/Anthropic SDK route には export const runtime='nodejs' を明示 (Edge crash 回避)
- §5.X+198 — recordError は DB の systemErrorLog のみ → 真因確定 catch は console.warn 併出し

### E2E・Playwright・visual regression
- §5.15 — 表示条件緩和で mobile overlap → E2E click intercept
- §5.X+5 — MFA 強制緩和で E2E アサーション + visual baseline 両更新
- §5.X+22 — 新 page/route で E2E_COVERAGE.md / UI 移管 PR で visual baseline 再生成チェックリスト
- §5.X+35 — multi-project Playwright 同 spec 並列で DB 同名行量産 → callSuffix / FK 順 cleanup / waitUntil:'commit'
- §5.X+39 — rate limit/lockout/CAPTCHA は E2E 並列実行と衝突 → env で disable 経路を最初から
- §5.X+40 — waitForURL は「終端到達」形にする (negation は redirect chain 途中で race)
- §5.X+73 — UI 変更で visual baseline 更新忘れ
- §5.X+74 — E2E fixture cleanup の FK 制約違反 flake
- §5.X+76 — dynamic segment の slug 名衝突で WebServer 起動失敗 → E2E 全停止
- §5.X+97 — ログイン UI 変更で baseline outdated → [gen-visual] で再生成
- §5.X+98 — baseline 自動 push が同時 push で FF 拒否 → artifact から PNG 手動配置 fallback
- §5.X+116 — 全ページ常時表示 UI (FAB) 追加で dashboard 系 mobile baseline 一斉 fail
- §5.X+118 — filename→slug 抽出 regex バグが E2E でしか発覚 + 単体が I/O 層素通り
- §5.X+121 — [gen-visual] 後の UI 変更で baseline stale → fullPage 12 件 fail + dialog timeout
- §5.X+123 — auto-hide ヘッダの translate-y/will-change が mobile dialog click を dead 化
- §5.X+124 — chromium-mobile DPR=3 で hit-test 誤判定 → { force: true } で bypass
- §5.X+125 — hit-test 誤判定の系統的影響 → 全 dialog click を一括 { force: true }
- §5.X+126 — 事象範囲を chromium-mobile + sticky/fixed/transform 配下 click 全般に拡大
- §5.X+128 — inline login が explicit-signout CSRF race で flake → loginAsGeneral に揃え
- §5.X+129 — inline login CSRF race を 3 visual spec へ横展開
- §5.X+138 — explicit-signout から CSRF cookie 削除を除去し MissingCSRF race を構造解消
- §5.X+139 — dropdown menuitem click microtask race を 2 段 explicit wait で解消
- §5.X+144 — 共通コンポーネント UI 追加で内包する全 dashboard baseline 連鎖 fail (transitive closure)
- §5.X+159 — AppHeader モバイル縮退 (sm:inline) で getByText.first() が hidden 拾い fail
- §5.X+162 — 機能撤去で UI ラベル簡素化 → getByText 固定マッチ spec も同時更新
- §5.X+202 — getByText substring match が見出し/タイルラベル共通文字列で strict 違反

### マイグレーション・Prisma・データモデル
- §5.12 — DB nullable 列の Zod schema は .nullable().optional() 必須
- §5.28 — Prisma migration の UPDATE 文は init migration で列存在を grep
- §5.30 — master-data.ts enum 値変更の横展開チェックリスト
- §5.40 — 派生カラムをサービス層で永続化するパターン
- §5.42 — migration を含む PR は本番手動適用必須 (PR description チェックリスト)
- §5.X+1 — schema.prisma の変更は本番 DB に自動反映されない
- §5.X+6 — 新テーブル追加で cascade 削除パスの全洗い出し必須 (本番障害例)
- §5.X+8 — 1:N → M:N への asset 紐付けモデル変更パターン
- §5.X+38 — サービス層で新ラベル literal を増やしたら型 union 側にも追加 (build/tsc で検出)
- §5.X+41 — .gitignore された generated/ がブランチ切替で別生成物混入
- §5.X+55 — is_sample_data 移動 migration は親 FK エンティティ移動漏れ注意 (Customer 残存例)
- §5.X+75 — prisma generate 忘れで tsc fail + 新 enum 値の MailParams.type 反映漏れ
- §5.X+77 — prisma migrate deploy を build script に入れると CI (dummy DB) で P1001 → 分離
- §5.X+80 — fixture の生 SQL INSERT は NOT NULL カラムを schema で確認 (型で防がれない)
- §5.X+82 — Supabase Direct connection は IPv6 のみ → Session pooler を DIRECT_URL に
- §5.X+83 — migrate deploy 失敗の finished_at=NULL 残骸で永久に同エラー fail
- §5.X+91 — 階層エンティティ重複判定は level+name でなく parent を含めたキーで
- §5.X+92 — PgBouncer で $transaction 不可 → 呼出順序非依存の idempotent recalc
- §5.X+93 — advisory lock も不可 → dry-run snapshot の updatedAt を header 経由 OCC
- §5.X+95 — DB UNIQUE 追加時は全 INSERT/UPDATE 経路で事前検知 → 400 (P2002→500 回避)
- §5.X+145 — 背景 cron の double-pickup race → atomic claim で防御
- §5.X+146 — 多段 transaction (Storage PUT→DB row) 失敗時 cleanup は全エラー対象
- §5.X+147 — Pre-signed URL concurrent finalize の重複 row → partial unique index
- §5.X+150 — テナント物理削除時の外部ストレージ cascade 漏れ (GDPR 違反 + 容量リーク)
- §5.X+156 — 新規 schema field 追加は data-export / data-import 両方に column 追加
- §5.X+171 — CSV 全文 split(/\r?\n/) 後パースで quoted multi-line cell が silent 欠落
- §5.X+172 — コメント宣言の制限値が実装/test で未担保 (csvRows>500 が 5 route 中 0 実装)
- §5.X+174 — auditLog.entityId は @db.Uuid 型 → 文字列識別子 INSERT で production PostgreSQL 型 rejection (Mocked unit test では未検知)
- §5.X+200 — Prisma select の存在しないフィールドは tsc/lint 検出されず runtime で throw

### マージコンフリクト・並行PR・KDDメタ運用
- §5.27 — 機能 deferral パターン (UI のみ削除、DB/API/service 温存)
- §5.32 — 複数 entity 横展開時の段階的汎用化パターン
- §5.50 — Stop hook の重処理 / prompt 型を skill 化して開発速度回復
- §5.X+17 — 同一ファイルを並行更新する複数 PR の merge conflict 対策
- §5.X+19 — dependabot.yml の schedule.day は weekly 限定
- §5.X+21 — .last-knowledge-check-sha の track 状態 conflict を git rm --cached + merge=ours で解消
- §5.X+30 — 長期 PR と main の KDD 末尾コンフリクトは両方残してマージ
- §5.X+33 — service conflict (片側 refactor / 片側コメント追加) は refactor 採用 + context 吸収
- §5.X+34 — merge 後 conflict zone 外の旧シグネチャ呼出を grep で全 call site verify
- §5.X+36 — infra PR と feature PR の同一 route 衝突は副作用を順序連鎖
- §5.X+37 — test 末尾 describe ブロック衝突は両側 describe を独立に閉じる
- §5.X+54 — KDD 末尾で section 番号が両ブランチ衝突 (§5.X+30 サブパターン)
- §5.X+57 — 仕様確定 docs PR を先行マージせず後追いで JSDoc コンフリクト
- §5.X+59 — 並列 docs PR が README テーブル末尾追加で確実にコンフリクト (§5.X+30/+54 再発)
- §5.X+65 — 複数 PR 並行で同一ファイル変更は事前 rebase 計画必須
- §5.X+167 — インフラ移行の docs 全面 cleanup は 2 段階 PR + 4 ステージ判断
- §5.X+173 — 外部 LP URL の 2 箇所 literal 並列は drift 温床 → config 集約 import 一本化

### インフラ・デプロイ・cron・ドメイン移行
- §5.X+2 — Supabase DIRECT_URL は Direct connection でなく Session Pooler
- §5.X+9 — ローカル必須チェック整理 (セキュリティ/パフォーマンスを CI / 都度対応へ分離)
- §5.X+10 — GitHub Actions 脆弱アクション回避、公式 install スクリプトで CI 化
- §5.X+11 — api.github.com 未認証は共有 IP の 60 req/hour 制限 → releases/latest URL
- §5.X+12 — 「常に最新を取得」設計は upstream breaking change を直撃 → メジャー跨ぎ検出
- §5.X+25 — timezone/locale はユーザ単位でなくテナント単位で持つ
- §5.X+28 — 日付計算をテナント TZ カレンダー日ベースに移行 (UTC÷24h は不一致)
- §5.X+70 — 外部 cron 移行で PUBLIC_PATHS 同期 + Stripe disabled 時 no-op ガード忘れで全滅
- §5.X+72 — cron-job.org 外部監視依存をやめアプリ内 cron 実行履歴テーブル + super_admin 可視化
- §5.X+114 — [skip netlify] の配置場所を commit message と思い込み Deploy Preview が走り続けた
- §5.X+151 — cron 新設は cron-jobs.ts への登録漏れで watchdog の死角化
- §5.X+179 — 独自ドメイン (tasukiba.com) 移行 — Cloudflare + Netlify + 4 レイヤ更新の段階手順
- §5.X+181 — cron 運用 3 罠 (409=lock 防御 / 未登録 cron は必須機能 / metadata 同時追加)
- §5.X+195 — Netlify Drawer の iframe は CSP frame-src 未定義で block
- §5.X+197 — cron-job.org 設定と CRON_JOBS metadata の drift は実態同期で潰す
- §5.X+199 — metadataBase 未設定で OG/Twitter 絶対 URL が localhost フォールバック

### UI・UX・コンポーネント
- §5.1 — バリデーション値 (文字数上限等) の変更箇所
- §5.3 — 状態遷移ルール (canTransition) の変更箇所
- §5.4 — UI レイアウトの変更箇所
- §5.5 — 色を変える (semantic token / theme-definitions.ts)
- §5.6 — 編集ダイアログの state 初期化ルール
- §5.7 — ダイアログサイズ・スクロール規約
- §5.8 — Select と SearchableSelect の使い分け
- §5.9 — レスポンシブ実装パターン
- §5.10 — フォーム送信前の事前バリデーション (エラー情報最小化)
- §5.10.1 — Base UI Combobox で {value,label} オブジェクトを items に渡す罠
- §5.10.1.5 — `<Label>` と `<Input>` の htmlFor/id ペア必須 (a11y + E2E 両立)
- §5.10.2 — タグ入力区切りは全角読点「、」も受容
- §5.11 — 編集ダイアログの save 後 close 順序とリスト列の表示漏れ
- §5.11.1 — User モデルだけ updatedBy カラムを持たない設計
- §5.16 — ダイアログ全画面トグル (useDialogFullscreen)
- §5.17 — 複数行テキストの Markdown 入力 + プレビュー + 差分表示
- §5.18 — WBS 上書きインポート (Sync by ID) 実装パターン
- §5.21 — 「○○一覧」フィルター必須型の一括更新パターン
- §5.22 — bulk update の共通 Toolbar 化 + 3 entity 展開
- §5.23 — 「全○○=参照のみ / ○○一覧=CRUD」設計違反からの原状回復
- §5.24 — TabsList のレスポンシブ集約パターン
- §5.25 — 添付対応 entity の一覧表示横展開チェック
- §5.26 — 同一機能画面間で共通部品を必ず流用する規約
- §5.29 — PR-η 永続ロック未実装バグの発見
- §5.31 — 枠数固定要件のアクション充足チェック
- §5.33 — API route の server-side i18n + vitest 共通モック
- §5.34 — アクション型 Select の選択後表示 (SelectValue children render + value="")
- §5.35 — dialog 内 component の nested form 回避
- §5.36 — dialog の readOnly 分岐パターン (行クリックで閲覧 + 作成者のみ編集)
- §5.37 — 一括編集はフィルター任意、多層防御は per-row 認可 (§5.21/22/23 を上書き)
- §5.39 — ガントチャートの曜日・祝日色分けパターン
- §5.41 — 「○○一覧」共通 UI 部品の抽出規約
- §5.43 — ガントチャートの independent tab 化 + responsive プルダウン
- §5.44 — リクエスト成功/失敗の Toast 通知パターン
- §5.45 — 既存スキーマカラムを UI のみで活かす任意入力フィールド追加
- §5.52 — バッチ API の lenient validation 設計
- §5.53 — 一覧テーブルの sticky thead 横展開パターン
- §5.55 — sticky thead と readOnly 添付セクションの hotfix
- §5.57 — 一覧画面 UX クリーンアップ + テキストフィルタの否定条件
- §5.58 — 一覧画面のカラムソート機能 横展開
- §5.X+26 — Beginner プランは「値の変動がない管理項目」を UI から消す
- §5.X+102 — 一覧画面の検索ボタン不発 + ソート client-side 化の横断調査 (残 13 画面ロードマップ)
- §5.X+112 — 検索・ソート・sticky ヘッダ横展開 (入力即フィルタ + URL 永続化)
- §5.X+119 — truncate の overflow:hidden が dropdown クリップ → createPortal で救済
- §5.X+160 — sharp .png({quality:N}) が palette PNG → Next.js Image が Content-Type:null で弾く
- §5.X+165 — 複合キャンバス PNG が fit:'contain' で FAB に「黒丸の中に小アイコン」
- §5.X+166 — FAB の panel-internal priority preload 浪費 + iOS home indicator 重なり
- §5.X+177 — middleware matcher が public/ 静的ファイルを除外せず 302 (mascot/og-image/robots)
- §5.X+183 — ガントチャート初期スクロール = 今日左端 + 日付 locale/TZ 統一

### コミュニケーション (コメント・通知・メンション)
- §5.49 — ポリモーフィックコメント機能の確立
- §5.54 — アプリ内通知機能 (in-app notifications) の MVP 実装
- §5.56 — コメントの @mention 機能
- §5.59 — 通知 deep link 全○○ auto-open + entity 別メンション認可の細粒化
- §5.60 — 通知 deep link 完成 + コメント認可 mention/plain 分離 + 編集削除ボタン投稿者限定

### 依存関係・脆弱性
- §5.X+4 — 推移的依存の脆弱性は pnpm.overrides で force-upgrade
- §5.X+20 — eslint-config-next minor 上げで react-hooks set-state-in-effect/refs が新規 enforce
- §5.X+24 (lock 相互衝突) — dependabot 複数 PR が pnpm-lock.yaml で相互コンフリクト → auto-rebase 待ち運用
- §5.X+42 — 単一 middleware に複数 security 関心統合は責務分離 + return タイミング
- §5.X+43 — Next.js 16 CSP nonce 自動付与は production 不全 → graceful degradation
- §5.X+44 — graceful degradation が機能しない時は粘らず完全 rollback する勇気
- §5.X+56 — 業務仕様と実装が乖離したら仕様書を真実とみなし実装を寄せる
- §5.X+81 (fixture 自己完結) — E2E fixture は外部 seed 非依存に (MANAGEMENT_TENANT_ID を ON CONFLICT DO NOTHING)
- §5.X+141 — xlsx@sheetjs は fix なし High CVE → exceljs に swap + pnpm.overrides で uuid fix
- §5.X+149 — 外部ファイル parser に渡す buffer は size guard 必須 (全体 memory load)
- §5.X+164 — post-PR OSV-Scanner で新規 CVE 継続発覚 (tmp@0.2.5)
- §5.X+170 — DB DEFAULT 撤去 PR は e2e/fixtures/ の raw SQL も同時 fix (本番コードのみだと全滅)

---

詳細はすべて [KDD_PATTERNS.md](./KDD_PATTERNS.md) で §番号検索により参照可能。
