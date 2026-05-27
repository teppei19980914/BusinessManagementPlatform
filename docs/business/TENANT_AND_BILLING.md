# テナント運用と課金モデル (Business Logic)

本ドキュメントは、本サービスのマルチテナント運用フローと、3 プラン構成 (Beginner / Expert / Pro) + 従量課金 (per-API-call) のビジネスロジックを集約する。技術的な実装設計は [../design/SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md)、ユーザから見える挙動は [../specification/](../specification/) を参照。

## 🆕 最新の料金体系: ADR-0019 + ADR-0020 + ADR-0021 + ADR-0022 (2026-06-01)

**現行料金体系の確定版は [ADR-0022](../adr/0022-embedding-usage-based-billing.md) + [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md) (部分 supersede 済) + [ADR-0020](../adr/0020-db-capacity-usage-based-billing.md) + [ADR-0021](../adr/0021-file-storage-usage-based-billing.md)** です。

### LLM 課金 (ADR-0019 / 2026-05-24)

| 項目 | ADR-0002 (旧) | **ADR-0019 (現行)** |
|---|---|---|
| Expert 単価 | ¥5/call (全 API) | **¥10/call** (プロジェクト作成/更新のみ) |
| Pro 単価 | ¥15/call (全 API) | **¥15/call** (プロジェクト作成/更新 + なぜ機能、据置) |
| Beginner 上限 | 月 100 回 (全 API) | **月 50 回** (プロジェクト作成/更新のみカウント) |

### Embedding 課金 (ADR-0022 / 2026-06-01) — Embedding 機能の従量課金化

| プラン | Embedding 単価 | 対象 featureUnit | 備考 |
|---|---|---|---|
| **Beginner** | **¥0 (= 90 日完全無料訴求保全)** | knowledge/risk-issue/retrospective/memo/chat-semantic-search/external-import/attachment-embedding | Fair Use Limit (月 10,000 calls) 適用 |
| **Expert / Pro** | **¥1 / 業務操作** | 同上 | `monthlyBudgetCap` で予算上限設定可、Stripe queue 投入は cost > 0 時 |
| **全プラン** | **¥0 維持** | `*-embedding-backfill` (月初 cron 自動リカバリ、5 種) | ユーザ非起動の修復処理 = 不当請求リスク回避 |

**重要設計**: 「1 業務操作 = 1 ApiCallLog = 1 課金」集約 (CSV 100 件取込でも ¥1)。Beginner 50 件上限 / `monthlyBudgetCap` は LLM_BILLABLE のみ判定 (= 既存上限ロジック不変)。Fair Use Limit は Beginner 専用に縮小。詳細: [ADR-0022](../adr/0022-embedding-usage-based-billing.md)。
| 課金対象 | 全 LLM/Embedding 呼出 | **`BILLABLE_FEATURE_UNITS` のみ** (project-upsert / suggestion-explanation / auto-tag-extract) |
| 無料化された機能 | — | **資産入力 (Knowledge/RiskIssue/Retrospective/Memo) + チャット検索 + CSV インポート + 月初 backfill cron** |

### DB 容量課金 (ADR-0020 / 2026-05-25)

| 項目 | 旧 4 段階プラン (PR-3 / 2026-05-15) | **ADR-0020 (現行)** |
|---|---|---|
| 課金モデル | 月額固定 (Standard ¥0 / Plus ¥500 / Pro ¥1,500 / Enterprise ¥5,000) | **階段関数型従量課金** |
| 無料枠 | 20MB (Standard) | **50MB / tenant** (SI 単位) |
| 超過単価 | プラン上限超過は 7 日 Grace 後 write 拒否 | **¥50 / GB tier** (1MB 未満切上 + 1GB tier 切上) |
| 計測時点 | 現在の使用量 | **月中 peak** (= 月末削除→月初再投入の抜け道防止) |
| ハードキャップ | 各プラン上限 (20MB/220MB/1.02GB/5.02GB) | **50GB SI 一律** (= 他テナント保護の技術的安全弁) |
| 計測網羅性 | 16 テーブル SQL ハードコード (新規テーブル追加時の漏れリスク) | **動的解決** (`information_schema` 由来) + CI ガード |
| 計測対象テーブル数 | 16 | **36 テーブル** (= 旧実装の 20+ テーブルが課金漏れだった) |

請求例:
- 0-50MB → **¥0**
- 51MB-1,050MB → **¥50** (= tier 1)
- 1,051MB-2,050MB → **¥100** (= tier 2)
- 50GB (ハードキャップ到達) → **¥2,500** (= tier 50)

詳細根拠 (実コスト構造の再検証、Supabase 原価、4 層防御、circuit breaker 等) は [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md) + [ADR-0020](../adr/0020-db-capacity-usage-based-billing.md) 参照。

### ファイルストレージ課金 (ADR-0021 / 2026-05-26)

ファイル添付本体 (Supabase Storage 保存) を月中 peak ベースで階段関数型に従量課金する。設計パターンは ADR-0020 を踏襲し、計算式 / 4 層防御 / 退会時即時請求 / drift 検知 / circuit breaker / billing invariant をすべて流用。

| 項目 | 値 |
|---|---|
| 課金モデル | **階段関数型従量課金** (= ADR-0020 と同設計) |
| 無料枠 | **100MB / tenant** (SI 単位、PDF 10MB を 10 件無料イメージ) |
| 超過単価 | **¥10 / GB tier** (1MB 未満切上 + 1GB tier 切上、Supabase 原価 ¥3.20/GB の +193% マージン) |
| 計測時点 | **月中 peak** (= 月末削除→月初再投入の抜け道防止) |
| ハードキャップ | **50GB / tenant** (= 月額最大 ¥500、説明性確保) |
| ファイル上限 | **50MB / 1 ファイル** (= Supabase Free 同等、業務 PDF/Excel/画像 を十分カバー) |
| 危険拡張子 | **blacklist** (.exe / .sh / .bat / .ps1 / .vbs / .apk / .ipa / .rar / .zipx 等) |
| Egress | **当面無料** (= Supabase Pro 250GB/月 含有で十分) |

請求例:
- 0-100MB → **¥0**
- 101MB-1,100MB → **¥10** (= tier 1)
- 1,101MB-2,100MB → **¥20** (= tier 2)
- 50GB (ハードキャップ到達) → **¥500** (= tier 50)

#### Attachment Embedding (= 無料 API)

添付ファイルは自動で本文テキスト抽出 → Voyage embedding 生成され、**チャット意味検索 + 提案エンジン** の対象になります (= 無料 API 枠、運営者負担)。対応形式: PDF / Excel (xlsx/xls) / CSV / Word (docx) / テキスト (txt/md/json)。画像 / 動画 / ZIP は OCR 未対応のため 'unsupported' 扱い。

詳細根拠 (Pre-signed URL アーキテクチャ、bucket prefix 構造、RLS Policy、DoS 対策、anomaly 検知等) は [ADR-0021](../adr/0021-file-storage-usage-based-billing.md) 参照。

### 横断的な改修 (R5 退会時請求漏れ修正)

旧仕様の月初 cron は `deletedAt IS NULL` フィルタで退会済テナント除外 → 月途中退会の当月分使用量が **永久に課金されない** 抜け道があった。

ADR-0020 + ADR-0021 で **退会時即時請求集計** ([src/services/tenant-withdrawal-billing.service.ts](../../src/services/tenant-withdrawal-billing.service.ts)) を導入し、退会 API ([deleteTenant](../../src/services/super-admin.service.ts)) から呼び出して **DB 容量 + ファイルストレージ + API 利用量を抜け漏れなく請求** できる構造に。

### 単価変更ルール

将来の単価変更時 (規約変更扱い):
> 料金の値上げまたは課金体系の変更:
> **効力発生日の 30 日以上前** から ユーザ規約ページに掲示し、かつ **登録メールアドレスへ通知** する。

- 値下げの場合は即時適用可
- ADR 改訂必須 (新 ADR-002X 起票)
- 過去使用分には旧単価適用 (= 遡及課金禁止)

## ⚠️ 課金モデルの最新版は Part 5 (+ ADR-0019 で再改定)

本ドキュメントは設計議論の経緯を時系列で含むため、**Part 1〜Part 4 の一部に旧 per-token / per-seat ベースの記述が残っています** (NF-13.1 / NF-13.8 / §34.11 / §34.12 等)。これらは設計過程で議論された中間案で、**最終的な確定モデルは Part 5 (DESIGN.md §34.14、3 プラン + per-API-call) + ADR-0019 (課金対象 featureUnit 縮小)** です。実装はすべて Part 5 と ADR-0019 を参照すること。

旧モデル記述は以下の理由で完全削除せず、DEPRECATED マークを付けて保全する: (1) 設計判断の経緯を追跡可能にする (なぜ per-API-call に至ったか)、(2) 過去の commit / PR からの参照を保つ、(3) 将来同様の議論が起きたときの参考にする。

## 関連 PR / 経緯

- PR #214 (`docs/suggestion-engine-spec`): 設計議論の意思決定ログを集約 (2026-05-01〜02)
- 設計議論の経緯は [../archive/developer/DEVELOPER_GUIDE.md §5.62](../archive/developer/DEVELOPER_GUIDE.md) を参照

---

## Part 1: 要件定義 (REQUIREMENTS.md §13.6 + §13.7 から転記)

> **⚠️ DEPRECATED 注記**: 本 Part 内の §13.6 NF-13.1 (「ユーザ単位月間トークン上限」) や NF-13.8 (「テナント単位月間トークン上限」) は per-token モデル時代の記述で、**Part 5 の §13.7 / per-API-call モデルで全面的に置き換わっています**。最新の課金モデル要件は §13.7 を参照。

### 13.6 マルチテナント運用と外部公開後の動線 (T-03 補強要件)

提案エンジン v2 の設計と同時に、本サービスは外部公開後にマルチテナント SaaS として運用される前提で要件を整備する。これは本機能の経済的安全性 (悪用された場合の損失をテナント単位に閉じ込める) と、外部ユーザの心理的安全性 (運用者および他テナントから自分のデータが見えない) の両立を実現するために必須となる。設計詳細は [DESIGN.md §34.11](./DESIGN.md) を参照。

#### 13.6.1 外部公開後の運用フローに関する要件

**F-13.6 テナント分離**: システムはテナントを業務データの最上位の認可境界とし、テナント間でデータが完全に分離されなければならない。テナント A のユーザはテナント B のデータを閲覧・更新・削除できず、運用者 (admin) も他テナントの内部データにアクセスできない (相互不可視性)。これは admin の信頼性に依存しない構造的な分離 (アプリケーション層で `tenantId` フィルタを必須化) で実装する。

**F-13.7 テナント招待と初期データ投入**: 外部ユーザの利用申し込みを受けて運用者が新テナントを作成した時点で、システムは当該テナントに **初期シードデータ (資格試験事例・著名な法則の独自要約) を自動的に投入** しなければならない。これは新規ユーザがサインアップ直後から提案エンジンの価値を体験できるようにするための必須機能で、初期離脱を防ぐ役割を果たす。

**F-13.8 サブスク契約のテナント単位適用**: ユーザが Pro プランを契約した場合、その契約は当該ユーザではなく **当該テナント全体** に適用される。テナント内のすべてのユーザが Pro 機能を享受でき、契約解除時はテナント全体が Free プランに戻る。これは個人利用と組織利用の両方を統一的に扱える課金モデルとなる。

**F-13.9 利用停止時のテナント削除**: 外部ユーザが利用停止を申し出た場合、システムは当該テナントとそれに紐付く全業務データを物理削除しなければならない。これは生成 AI の悪用 (退会後の API 連打など) を防ぐ目的と、ユーザのデータ所有権 (削除権) を尊重する目的の両方を兼ねる。法的な保存義務がある特定のログ (監査ログ等) は別途匿名化して保管する例外を設ける。

#### 13.6.2 テナント単位のコスト管理に関する非機能要件

**NF-13.8 テナント単位の利用上限**: §13.3 の NF-13.1 で定めた月間トークン上限は、ユーザ単位ではなく **テナント単位** で管理する。テナント内の複数ユーザが同じ予算を共有し、契約 (=テナント) と予算管理が完全に一致する。Free テナントは月 100,000 トークン、Pro テナントは月 1,000,000 トークンを上限とする。

**NF-13.9 提案機能の多用に対するコスト保護**: ユーザが「参考」タブなど提案機能を多用することによるコスト暴発を防ぐため、システムは以下の 3 段階のコスト保護を実装しなければならない。第一に、Phase 3 の LLM Re-ranking 結果を `(tenantId, projectId, contentHash)` キーで 5〜10 分間キャッシュし、繰り返し表示時の LLM 呼び出しを抑制する。第二に、テナント単位の **日次 LLM 呼び出しキャップ** (Free 30 回 / Pro 200 回) を設定し、超過時は Phase 3 をスキップして Phase 2 (embedding ベースの並びのみ) を返す。第三に、月間トークン上限と Anthropic workspace 上限が最終防衛線として機能する。

**NF-13.10 テナント認可境界の徹底**: すべての API ルートと Server Action は、操作対象データの `tenantId` がリクエストユーザの `tenantId` と一致することを最初の行で検証しなければならない。`@/lib/permissions.ts` に `requireSameTenant(user, entity)` ユーティリティを実装し、認可ロジックの入り口として機能させる。テナント境界の越境を許容する経路は absolute admin 操作 (運用者がテナントを管理する画面) のみとし、これも厳格に admin role を要求する。

#### 13.6.3 インフラスケーラビリティに関する要件

**NF-13.11 インフラ移行可能性の維持**: システムは特定インフラ (Netlify / Supabase) に強く依存せず、将来的な AWS / Azure / GCP への移行を 1〜2 週間程度の工数で実現できる構造を維持しなければならない。Prisma による DB プロバイダ抽象化、Next.js の `output: 'standalone'` 対応、Docker 化可能な構成、を維持する。Netlify 固有の API (例: Netlify Functions の context 引数) を使う場合は、移行時の置換ポイントを明確にコード内コメントで記録する。

**NF-13.12 移行判断トリガーの明文化**: インフラ移行を判断する具体的なトリガー条件 ([DESIGN.md §34.13.3](./DESIGN.md) 参照) を運用ドキュメントに明記し、定期的に状況を評価する仕組みを設ける。早期過剰投資と判断遅延の両方を避ける。

#### 13.6.4 v1 と v1.x の段階的実装

v1 (6月1日) では、**「単一デフォルトテナント」での運用** に絞ってマルチテナント基盤を実装する。Tenant テーブルの新設、全業務エンティティへの `tenantId` カラム追加、既存データの default-tenant への migration、テナント境界を強制する認可ロジックの整備、を v1 の必達範囲とする。実質的には 1 テナントのみが存在する状態で稼働するが、コード上はマルチテナント完全対応となる。

v1.x では、テナント管理 UI (admin 専用)、新規テナント作成時のシードデータ自動投入、テナント削除時のカスケード削除、招待メール、Stripe 連携、テナント slug の URL ルーティング (path-based)、を順次追加する。これらは外部ユーザの本格的な受け入れと並行して実装する。

### 13.7 課金モデル: 3 プラン構成と従量課金 (確定版)

§13.6 で定めたテナント単位のコスト管理を、**3 プラン構成 + 従量課金 (per-API-call)** で具体化する。これは「ユーザ数ベースは集計直前のユーザ削除で誤魔化される脆弱性」「アクセスユーザベースは未使用ユーザ分のコストが運用者の損失になる構造」の両方を回避し、「使った分だけ払う」という公平性とお得感を両立させる課金モデル。設計詳細は [DESIGN.md §34.14](./DESIGN.md) を参照。

#### 13.7.1 3 プランの位置付け

**Beginner プラン**: 試験運用と小〜中規模プロジェクト向けの **無料プラン**。最大 5 席、Claude Haiku、**プロジェクト作成/更新 月 50 回まで無料** (ADR-0019、課金対象 call のみカウント)。資産入力・チャット検索は無料・無制限。上限到達時は **縮退モード**（§34.14.4 / NF-13.14、エンティティ作成・更新は継続、AI 裏方処理のみ一時停止）に切り替わる。上位プランへのアップセル誘導の入り口として機能する。

**Expert プラン**: 中〜大規模チームの本格利用向けの **席数無制限・従量課金プラン**。Claude Haiku、**プロジェクト作成/更新 1 回あたり ¥10** (ADR-0019 / 2026-05-24 改定: ¥5 → ¥10、課金対象を縮小したことに合わせて単価を補填調整)。資産入力・チャット検索は無料・無制限。月間使用量に上限なし、使った分だけ請求される。

**Pro プラン**: PMO や経営層など「助言の質」を重視するユーザ向けの **席数無制限・従量課金プラン**。Claude Sonnet、**プロジェクト作成/更新 + なぜ機能 1 回あたり ¥15** (据置)。資産入力・チャット検索は無料・無制限。Sonnet による深い説明文付きの「なぜ?」機能を享受できる最上位プラン。

#### 13.7.2 機能要件

**F-13.10 課金単位の統一**: 課金カウントの「1 回」は **ユーザに見える機能単位** で定義する。新規プロジェクト作成時の自動タグ抽出 + 初回提案生成は内部的に複数の LLM / Embedding 呼び出しを伴うが、ユーザから見える 1 操作として 1 回とカウントする。embedding 生成 (バックグラウンド処理) は課金対象外とし、運用者が吸収する。

**F-13.11 プラン変更機能**: 各テナントのシステム管理者は、自テナントの設定画面からプランを変更できなければならない。Beginner → Expert / Pro へのアップグレードは決済情報登録と同時に即時有効化、Expert ↔ Pro の切替 (上下双方向) は即時反映する。Expert / Pro → Beginner へのダウングレードは **完全に禁止** とし API 側で `BEGINNER_DOWNGRADE_FORBIDDEN` を返す (Beginner プランは初回 90 日試用限定のため、上位プランから戻すことはできない / P-B, 2026-05-08)。Beginner 退避手段が必要な場合はテナント解約フローを利用する。

**F-13.12 月次予算上限の自己設定**: 各テナントのシステム管理者は、月次予算上限を自分で設定できなければならない (例: 月最大 ¥10,000)。設定額に達した時点で **縮退モード**（§34.14.4 / NF-13.14 参照）に自動切替され、想定外の請求額発生を防ぐ。

**F-13.13 リアルタイム使用量ダッシュボード**: 各テナントのシステム管理者は、リアルタイムの使用状況 (当月の API 呼び出し回数・課金額・予算比率・日次推移グラフ・機能別内訳) を自テナントの設定画面で閲覧できなければならない。

#### 13.7.3 非機能要件

**NF-13.13 課金記録の完全性**: すべての API 呼び出しは `ApiCallLog` テーブルに記録され、 (timestamp, tenantId, userId, featureUnit, modelName, inputTokens, outputTokens, costJpy, latencyMs, requestId) を保存する。これは課金の根拠データとして法的に重要であり、ユーザクレーム対応の根拠となる。

**NF-13.14 縮退モードの優雅な動作**: API 呼び出し上限到達時 (Beginner プロジェクト作成/更新 月 50 回、または Expert/Pro の月次予算上限) は、**「業務に必要な作成・更新は継続 + AI による裏方処理のみ一時停止」** する縮退モードに切り替わる。ADR-0019 (2026-05-24) で資産入力・チャット検索を無料化したため、これらは縮退モード中も無制限利用可能。詳細仕様は §34.14.4 参照。

主な挙動：
- エンティティ作成・更新は HTTP 200 で継続（embedding = NULL で保存）
- 提案エンジンでは NULL 候補をタグ：テキスト = 5：5 の重み再配分で評価
- 月初バッチで NULL エンティティを一括補完生成（コストは新月の上限に加算）
- 完全停止のハードカット (HTTP 429) は採用しない

**NF-13.15 ダウングレード時の悪用防止**: Expert / Pro → Beginner へのダウングレードは、P-B (2026-05-08) で **完全禁止** とした。これは月末ぎりぎりにダウングレードして当月分を 0 円にする悪用 (= Beginner の月 100 回無料枠の悪用) を構造的に防ぎ、合わせて「Beginner = 初回 90 日試用」の位置付けを保つ仕組みである。Beginner 退避が必要な場合はテナント解約フローを利用する。Expert ↔ Pro 切替は per-call 課金モデルのため当月分が単価で個別記録され課金回避が成立せず、即時反映で実装される (F-13.11、2026-05-14 改修)。

#### 13.7.4 v1 と v1.x の段階的実装

v1 (6月1日) では、**データモデルと内部ロジック** を実装する。Tenant テーブルへの `plan` / `currentMonthApiCallCount` / `currentMonthApiCostJpy` / `monthlyBudgetCapJpy` 等のカラム追加、ApiCallLog テーブル新設、API 呼び出し前のプラン・使用量チェックミドルウェア、Beginner 上限チェック、月初リセットバッチを含む。v1 時点では UI 公開なし、すべてのテナントが Beginner 扱い。

v1.x では **UI と Stripe 連携** を実装する。テナント管理者設定画面、Stripe Metered Billing 連携、ダウングレード警告 UI と制約チェック、リアルタイム使用量ダッシュボード、月次請求書発行を順次追加する。

---

## Part 2: ユーザから見える挙動 (SPECIFICATION.md §26.6 + §26.7 から転記)

**観測ダッシュボード (v1.x、時期未定)**: admin 専用画面 `/admin/observability/llm` で、LLM 利用統計 (日別コスト・ユーザ別使用量・エラー率) を可視化する。これは [RELEASE_ROADMAP.md](../administrator/RELEASE_ROADMAP.md) Phase 3c の `/admin/observability` の一部として実装される。

### 26.6 マルチテナント運用におけるユーザから見える挙動

外部公開後の運用では、各外部ユーザが自身のテナント (論理コンテナ) に閉じた環境でサービスを利用する形となる。このセクションではユーザから見たマルチテナント体験を記述する。設計詳細は [DESIGN.md §34.11](./DESIGN.md)、要件は [REQUIREMENTS.md §13.6](./REQUIREMENTS.md) を参照。

**新規テナントへの招待時**: 外部ユーザが利用申し込みを行うと、運用者が新規テナントを作成し、招待メールが届く。招待メールのリンクをクリックすると、当該ユーザは自分のテナント `https://tasukiba.netlify.app/{自分のテナント名}/...` (v1.x で実装) に遷移し、テナント管理者としてサインアップを完了する。サインアップ完了時点で、テナントには既に **教科書事例・著名な法則の独自要約** がナレッジとして投入されており、最初のプロジェクト作成直後から提案機能が有意義に動作する。

**テナント間の不可視性**: ユーザは自分のテナント内のデータのみを操作でき、他テナントのデータは閲覧・更新・削除のいずれもできない。同様に、運用者 (admin) も他テナントの内部データを直接見ることはできない構造になっている。これは運用者の信頼性に依存しない仕組みで、ユーザが機密性の高い業務情報を安心して登録できる根拠となる。テナントの境界はアプリケーション層で必ず enforce されるため、URL を直接打ち込んでも他テナントには到達できない。

**Pro プランの契約と適用**: ユーザがアカウント設定画面から Pro プランへのアップグレードを選択すると、決済プロバイダ (v1.x で Stripe を統合) に遷移して契約を完了する。契約成立後、当該テナント全体が Pro プランとなり、テナント内のすべてのユーザが Sonnet 出力 (深い説明文付きの提案) を享受できるようになる。これは個人テナントでも組織テナントでも同じ仕組みで、課金単位は常に「テナント」となる。

**契約解除時の挙動**: Pro プラン契約を解除すると、当該テナントは Free プランに戻り、すべてのユーザの提案機能は Haiku ベースに縮退する。データは保持されたままで、再契約時には継続して利用できる。

**利用停止 (テナント削除)**: ユーザがサービスの利用を完全停止する場合、テナント管理者が「テナント削除」操作を行う (v1.x で実装) ことで、当該テナントとそれに紐付くすべての業務データが削除される。これは生成 AI の悪用 (退会後の API 連打など) を防ぐ目的と、ユーザのデータ所有権を尊重する目的を兼ねる。削除前に CSV エクスポートでデータを取り出すことが可能 (グレースピリオド設計の詳細は [OPERATION.md](../administrator/OPERATION.md) で別途定める)。

**テナント単位の利用上限と表示**: アカウント設定画面の「AI 利用状況」には、テナント全体での月間使用量が「今月の AI 利用状況: 12,300 / 100,000 トークン」のように表示される。これは個人ユーザの使用量ではなく、テナント内の全ユーザの合計を示し、契約 (=テナント) と予算管理が完全に一致していることをユーザに明示する。日次 LLM 呼び出しキャップ (Free 30 回 / Pro 200 回) もテナント単位で集計され、超過時は「本日の AI 詳細解析の上限に達しました。並び替えのみ表示しています」というメッセージを表示する。

**v1 リリース時点の挙動**: v1 (6月1日) リリース時点では、すべての既存ユーザが「default-tenant」という単一のテナントに所属する形で運用される。ユーザから見える挙動は変わらず、URL も従来通り `https://tasukiba.netlify.app/projects/...` のままとなる。マルチテナント関連の UI (テナント管理画面、招待メール、テナント slug を含む URL) は v1.x で順次追加される。これにより、既存ユーザは何も変更を体験せず、外部ユーザの受け入れが始まった時点でテナント機能が表面化する形となる。

### 26.7 課金モデル: 3 プラン構成と従量課金 (確定版)

§26.6 で示したテナント運用フローを、**3 プラン構成 + 従量課金 (per-API-call)** で具体化する。これは「使った分だけ払う」という公平性とお得感を両立させる課金モデルである。詳細な要件は [REQUIREMENTS.md §13.7](./REQUIREMENTS.md)、技術設計は [DESIGN.md §34.14](./DESIGN.md) を参照。

**Beginner プラン (無料)** は最大 5 席まで、Claude Haiku、月間 100 回までの API 呼び出しが可能。試験運用と小〜中規模プロジェクトでの初期利用を想定する。月間 100 回の上限に達した時点で **縮退モード**（§34.14.4 / NF-13.14）に切り替わり、月初に自動リセットされる。縮退モード中はエンティティの作成・更新は継続でき、AI 裏方処理（自動タグ抽出・embedding 生成）のみ一時停止する。月初バッチで補完生成され翌月には完全回復する。

**Expert プラン** は席数に上限なし、Claude Haiku、**プロジェクト作成/更新 1 回あたり ¥10** の従量課金 (ADR-0019 / 2026-05-24 改定: ¥5 → ¥10、課金対象を縮小したことに合わせて単価を補填調整)。資産入力・チャット検索は無料・無制限。月間使用量に上限はなく、使った分だけ請求される。中〜大規模チームで日常的に提案機能を活用するユーザを想定する。

**Pro プラン** は席数に上限なし、Claude Sonnet、**プロジェクト作成/更新 + なぜ機能 1 回あたり ¥15** の従量課金 (据置)。資産入力・チャット検索は無料・無制限。Sonnet による深い説明文付きの「なぜ?」機能を享受できる最上位プランで、PMO や経営層など「助言の質」を重視するユーザを想定する。Haiku 構成と Pro 構成の差は、検索精度の根幹ではなく説明文の文脈読解の深さに現れる。

**API 呼び出しの「1 回」は ユーザに見える機能単位** で定義する。新規プロジェクト作成時の自動タグ抽出 + 初回提案生成 = 1 回、提案画面の再表示 (キャッシュ無効後) = 1 回、リスク起票時の類似 issue サジェスト = 1 回、というカウント方法となる。内部的に複数の LLM / Embedding 呼び出しが走っても、ユーザから見える操作単位で 1 回として課金する。embedding 生成 (バックグラウンド処理) は課金対象外。これにより、ユーザは「自分のクリック数 ≒ 課金額」と直感的に予測できる。

**チャット意味検索の課金** (2026-05-23 / [CHAT_SEMANTIC_SEARCH.md](../specification/CHAT_SEMANTIC_SEARCH.md)): 全プラン共通で **1 検索 = 1 API 呼び出し** として計上する。`ApiCallLog.featureUnit = 'chat-semantic-search'` で識別。Beginner は月100回枠を書込操作と共有 (= チャット連投で書込余力が減る経済圧力)、Expert ¥5 / Pro ¥15 で書込と同単価。これは「読込操作だが Voyage への外部 API 呼出が必須発生する」性質ゆえ、書込/読込問わず「外部 AI 呼出 = 課金 1 回」という統一的計上方針による。失敗時 (rate_limited / budget_exceeded) はカウンタ進まず課金されない。詳細プラン挙動・縮退モード・コスト試算は [CHAT_SEMANTIC_SEARCH.md §3](../specification/CHAT_SEMANTIC_SEARCH.md) を参照。

**プラン変更フロー**: テナント管理者は自テナントの「システム管理者設定画面」からプラン変更を行える。Beginner → Expert / Pro へのアップグレードは決済情報登録 (Stripe) と同時に即時有効化される。**Expert ↔ Pro の切替 (上下双方向) は即時反映** され、当月の使用分は切替前後それぞれの単価 (Haiku ¥5 / Sonnet ¥15、2026-05-15 改定後) で月次請求書に内訳表示される (per-call 課金は呼出時点の plan で確定するため、月途中切替でも整合性が保たれる)。**Expert / Pro → Beginner へのダウングレードは完全禁止** (P-B / 2026-05-08): 上位プランから Beginner には戻せない仕様で、API は `BEGINNER_DOWNGRADE_FORBIDDEN` を返し UI でも該当ラジオボタン選択時にエラー表示する。Beginner 退避が必要な場合はテナント解約フローを使う。

**月次予算上限の自己設定**: テナント管理者は自テナントの月次予算上限を **自分で設定** できる (例: 「月最大 ¥10,000 まで」)。設定額に達した時点で Beginner 同様の **縮退モード**（§34.14.4 / NF-13.14）に自動切替され、想定外の請求額発生を防ぐ。これは法人ユーザの導入障壁を大きく下げる役割を果たす。

**リアルタイム使用量ダッシュボード**: テナント管理者は自テナントの設定画面から、リアルタイムの使用状況ダッシュボードを閲覧できる。第一階層に当月のサマリー (例: 「今月の使用状況: 320 回 / ¥3,200 (予算 ¥10,000 の 32%)」)、第二階層にプラン情報と席数、第三階層に日次の使用推移グラフ (棒グラフによる可視化)、第四階層に機能別の内訳 (新規プロジェクト時の提案・提案画面再表示・リスク起票時の関連検索などの分類別集計) が表示される。これにより、ユーザは月末を待たずに当月の請求予測を把握でき、また突発的な使用量増加 (異常パターン) を自分で発見できる窓口となる。

**v1 (6月1日) での見え方**: v1 リリース時点では、ユーザに見える UI 上にプラン情報や課金関連の表示は **公開されない**。すべての既存ユーザは default-tenant の Beginner プラン扱いで運用され、月間 100 回の上限に達した場合のみ縮退モードのメッセージが表示される。テナント管理者設定画面、プラン変更ボタン、Stripe 連携、リアルタイムダッシュボードは v1.x で段階的に公開される。

### 26.8 関連ドキュメント

実装計画は [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md)、要件定義は [REQUIREMENTS.md §13](./REQUIREMENTS.md)、技術設計は [DESIGN.md §34](./DESIGN.md)、脅威モデルは [docs/security/SUGGESTION_ENGINE_THREAT_MODEL.md](../security/SUGGESTION_ENGINE_THREAT_MODEL.md) を参照する。

---

## Part 3: マルチテナント アーキテクチャと運用フロー (DESIGN.md §34.11 から転記)

> **⚠️ DEPRECATED 注記**: 本 Part の Tenant データモデル例 (`current_month_token_usage` / `monthly_token_limit` / `suggestionDailyLLMCalls` 等のカラム) は per-token モデル時代の記述で、**Part 5 (§34.14.3) の最新カラム定義 (`plan` / `currentMonthApiCallCount` / `currentMonthApiCostJpy` / `monthlyBudgetCapJpy` / `pricePerCallHaiku` / `pricePerCallSonnet` 等)** で置き換わっています。実装は Part 5 を参照。

### 34.11 マルチテナント アーキテクチャ (外部公開後の運用前提)

§34.1〜§34.10 は「単一テナント前提」で記述したが、本サービスは外部公開後 **マルチテナント SaaS** として運用する設計を本セクション以降で定める。各外部ユーザ (個人または組織) ごとに **論理テナント** を割り当て、テナント間ではデータが完全に分離される構造とする。これにより、悪用された場合の影響を当該テナントに閉じ込めることができ、また他テナントのデータを誤って提案候補に混入させるリスクを構造的に排除できる。

#### 34.11.1 テナントの位置付けと運用フロー

外部ユーザが本サービスの利用を申し込んだ時点で、運用者 (admin) は新たな論理テナントを作成し、そのテナント内に当該ユーザを最初の管理者として招待する。テナント作成と同時に **初期シードデータ** (資格試験事例・著名な法則の独自要約 30〜100 件) が当該テナントに自動的に投入され、新規ユーザはサインアップ直後から提案エンジンの価値を体験できる状態になる。これは初期離脱を防ぐための仕組みで、データが空のために「このサービスは何の価値もない」と判断される時間をゼロに近付ける。

外部ユーザは自身のテナント内でサービスを利用し、データを蓄積していく。テナント間ではデータが完全に分離されているため、運用者 (私) が登録したデータを外部ユーザが閲覧・更新・削除することはなく、逆に外部ユーザが登録したデータを運用者が閲覧することもない。この相互不可視性は、**機密情報を扱う法人ユーザの導入障壁を下げる重要な設計判断** である。同時に、運用者にとっても「ユーザのデータを見たくない・触りたくない」という運用上の安全装置として機能する。

外部ユーザがサブスクリプション (Pro プラン) を契約した場合、その契約は当該テナント単位で適用され、テナント全体の `subscription_tier` が `'pro'` に変更される。これにより、テナント内のすべてのユーザが Sonnet 出力 (深い説明文付きの提案) を享受できるようになる。逆に契約解除時はテナント全体が Free プランに戻り、すべてのユーザの体験が縮退する。

利用停止時 (チャーン) は、生成 AI の悪用 (退会後の API 連打など) を防ぐためテナント自体を削除する運用とする。テナント削除時は当該テナントに紐付くすべてのデータ (ユーザ、プロジェクト、ナレッジ、リスク、振り返り、メモ、添付、コメント、メンション、通知、監査ログ等) を物理削除する。法的な保存義務がある特定のログ (例: 監査ログ) のみ、別途匿名化して保管する例外を設けるが、提案エンジンの動作に必要なデータは完全に削除する。テナント削除の運用詳細 (グレースピリオド、データエクスポート猶予、課金清算等) は OPERATION.md で別途定める。

#### 34.11.2 データモデル: Tenant エンティティの中心化

新規エンティティとして `Tenant` テーブルを追加し、これを **業務データの最上位の認可境界** とする。

```
model Tenant {
  id                       String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  slug                     String   @unique @db.VarChar(50)  // URL 識別子 (例: 'acme-corp')
  name                     String   @db.VarChar(100)         // 表示名
  subscriptionTier         String   @default("free")          // 'free' | 'pro_trial' | 'pro'
  currentMonthTokenUsage   BigInt   @default(0)
  monthlyTokenLimit        BigInt   @default(100000)
  trialEndsAt              DateTime?
  suggestionDailyLLMCalls  Int      @default(0)              // 提案多用に対する日次キャップ用
  createdAt                DateTime @default(now())
  deletedAt                DateTime?

  users        User[]
  projects     Project[]
  knowledges   Knowledge[]
  // ... 他の業務エンティティすべてが Tenant に紐付く
}
```

User テーブルには `tenantId` カラムを追加し、ユーザが所属するテナントを明示する。1 ユーザは 1 テナントにのみ所属する (シンプルさを優先、複数テナント所属は将来 Organization 化のタイミングで再検討)。同様に Project / Knowledge / RiskIssue / Retrospective / Memo / Customer / Stakeholder / Comment / Mention / Notification / Attachment / SystemErrorLog の各テーブルにも `tenantId` カラムを追加し、すべての業務データがいずれかのテナントに属することを保証する。

§34.2 で述べた `current_month_token_usage` / `monthly_token_limit` / `subscription_tier` は **User ではなく Tenant に配置** する。これによりテナント内の複数ユーザが同じ予算を共有し、コスト管理が「契約単位 = テナント単位」と完全に一致する。1 ユーザのテナントでも 100 ユーザのテナントでも、課金とコスト管理の単位は変わらない。

#### 34.11.3 テナント認可の二段階モデル

提案エンジン v2 を含むすべての業務処理において、認可は **2 段階で評価** する。

**第一段階はテナント境界の確認** で、リクエストを発行したユーザの `tenantId` と、操作対象データの `tenantId` が一致することを必ず検証する。これは API ルートの最初の行で実施する標準パターンとし、すべてのクエリの WHERE 句に `tenantId` 条件を含める。`@/lib/permissions.ts` に `requireSameTenant(user, entity)` ユーティリティを新設し、認可ロジックの入り口として機能させる。

**第二段階はテナント内の認可** で、これは既存の認可ロジック (project member / system role / visibility) をそのまま流用する。テナント内ユーザは互いの公開データを共有でき、private データは作成者のみがアクセスできる、という現在の設計はテナント内に限定して継続する。

この二段階構造により、認可ロジックの変更は **第一段階の追加** のみで完結し、既存の第二段階ロジックには手を入れずに済む。これは大規模な refactoring を避ける重要な設計判断である。

PostgreSQL Row-Level Security (RLS) を将来的なオプションとして検討する。これは DB レベルでテナント境界を強制する仕組みで、アプリケーション層のバグでテナント境界を越えてしまった場合の最終防衛線となる。ただし RLS は実装の複雑度を上げるため v1 では導入せず、アプリケーション層での `tenantId` フィルタの徹底で対処する。RLS への移行は v1.x または v2 で再検討する。

#### 34.11.4 提案エンジンの動作: テナント内に閉じる

§34.4 で述べた suggestion.service の動作を、マルチテナント前提に修正する。`suggestForProject(projectId)` は内部で当該プロジェクトの `tenantId` を取得し、候補検索の WHERE 句に `tenantId` フィルタを追加する。これにより **提案候補は必ず同じテナント内のデータのみ** に絞り込まれ、テナント間でデータが混入する経路を構造的に排除する。

embedding 検索においても、pgvector の Cosine Similarity 検索の WHERE 句に `tenantId = $1` を含める。HNSW インデックスは `(tenantId, content_embedding)` の複合インデックスで作成することで、テナント数が増えても検索性能を維持する。

初期シードデータは **テナント作成時に当該テナント内に複製** される。これは「すべてのテナントが同じ参照データを共有する」のではなく、「各テナントが独立した参照データのコピーを持つ」設計である。データ重複によるストレージ消費は微小 (1 テナントあたり ~6KB × 100 件 = ~600KB) で、Supabase Free 枠 500MB に対して 100 テナント分でも 60MB 程度に収まる。逆にこの設計の利点は、テナントがシードデータを編集・追加できる柔軟性、テナント削除時の整合性 (シードデータも一緒に消える)、テナント間の独立性の担保である。

#### 34.11.5 LLM 多用に対するコスト保護

「参考」タブなどユーザが提案を多用する経路でコストが暴発するリスクを抑制するため、**3 段階のコスト保護** を実装する。

**第一段階は積極的キャッシュ戦略** で、Phase 3 の LLM Re-ranking 結果は `(tenantId, projectId, contentHash)` をキーにして Postgres に 5〜10 分間キャッシュする。同一プロジェクトで suggestions パネルを連続で開いた場合、初回のみ LLM を呼び、以降はキャッシュから返す。これにより典型的な「タブを行き来する」操作のコストを 1 操作分に圧縮する。`contentHash` はプロジェクトの purpose/background/scope の SHA-256 で算出し、内容が変わったら自動で無効化する。

**第二段階はテナント単位の日次 LLM 呼び出しキャップ** で、`Tenant.suggestionDailyLLMCalls` カラムで 1 日あたりの Phase 3 LLM 呼び出し回数を追跡する。Free プランは日次 30 回、Pro プランは日次 200 回を上限とし、超過時は Phase 3 をスキップして Phase 2 (embedding ベースの並びのみ) を返す。これにより悪意ある「タブを連打する」攻撃や、UI バグによる無限ループでも被害が日次上限で打ち止めになる。

**第三段階は月間トークン上限と Anthropic workspace 上限** で、これは §34.3 で述べた既存の防御線をそのまま継承する。Free 10万 / Pro 100万 トークンに加え、workspace 全体で $30 (約 4500 円) のハード上限が最終防衛線となる。

これら 3 段階により、最悪ケースでも 1 テナントあたりの月間損失は数百円〜千円程度に制限され、サービス全体では workspace 上限の 4500 円を超えることはない。

#### 34.11.6 テナント識別とルーティング

外部ユーザがアクセスする URL は `https://tasukiba.netlify.app/{tenantSlug}/...` の **path-based ルーティング** を採用する。サブドメインベース (`{slug}.tasukiba.netlify.app`) も検討したが、Netlify 標準ドメインでのワイルドカード DNS 設定が煩雑、SSL 証明書の管理、サブドメイン名の制約 (DNS 仕様) などの理由で path-based を選択した。将来的な独自ドメイン化 (例: customer の独自ドメインで運用) は v2 以降で検討する。

Next.js の動的ルートとして `app/(tenant)/[tenantSlug]/...` のようなディレクトリ構造を採用するか、middleware でテナント解決してから既存のルートに転送するか、の 2 択がある。後者のほうが既存のルート構造を維持できるため、middleware でテナント slug を抽出して `request.headers` に追加し、各 API ルートで `getTenantFromRequest()` ヘルパー経由で取得する形を採る。これにより、既存のルートは最小限の変更で multi-tenant 対応できる。

セッション (NextAuth.js) には `user.tenantId` を含めるよう拡張する。これにより、ユーザがどのテナントに所属するかが session 内で常に解決でき、認可チェックが軽量化される。テナント切り替え (将来的に複数テナント所属を許す場合) は session の更新で実現する。

#### 34.11.7 v1 (6月1日) でのテナント実装範囲

リリース日厳守のため、v1 でのテナント実装は **「単一デフォルトテナントへの収容」** に絞る。具体的には以下を v1 で実装する。

Tenant テーブルの新設、User と全業務エンティティへの `tenantId` カラム追加、既存データを `default-tenant` という単一テナントに紐付ける migration、`subscription_tier` / `current_month_token_usage` / `monthly_token_limit` / `suggestionDailyLLMCalls` の Tenant への配置、すべての API ルートでの `tenantId` フィルタ追加、middleware でのテナント解決ヘルパー、提案エンジン内の WHERE 句更新、初期シードデータの当該テナントへの投入、を v1 リリースの最小スコープとする。

これにより、**v1 時点では実質的に 1 テナント (default-tenant) のみが存在し、すべてのユーザがそこに所属する** 状態となる。コード上はマルチテナント完全対応だが、運用上は単一テナントとして稼働する。これは将来のテナント追加が「テナント新設 + ユーザ招待」の運用作業のみで完結する状態を作り出すことが目的で、外部ユーザの最初の申し込みが来た時点で、admin 操作で新規テナントを作成し、招待メールを送る、という運用が可能になる。

v1.x で実装する範囲は、テナント管理 UI (admin only)、テナント作成時のシードデータ自動投入、テナント削除時のカスケード削除、テナント招待メール、テナント slug の URL ルーティング (path-based)、自己テナント設定画面 (テナント名変更等)、課金プロバイダ (Stripe) 連携、を想定する。これらは外部ユーザの本格的な受け入れと並行して実装する。

#### 34.11.8 既存データのマイグレーション戦略

v1 リリース時、既存ユーザは全員 `default-tenant` に所属することになる。この migration は破壊的でなく、`tenantId` カラムを追加して既存レコードに `default-tenant` の ID を設定するだけで完結する。`prisma migrate` で安全に実行可能で、ダウンタイム不要。

既存の visibility=public データはすべて default-tenant 内で公開された状態となり、運用者 (私) が登録した「教科書事例」などのナレッジも default-tenant 内のユーザに表示される。ここまでは v1 の動作として正常である。

外部ユーザが申し込みで新テナントが作られた時点で、その新テナントには **教科書事例の独自コピー** が新規生成される (default-tenant のレコードを clone)。これにより新テナントのユーザは、運用者の作ったコンテンツを **そのテナント内のローカルコピー** として閲覧できる。逆に運用者は新テナントの内部データを見ることができない (=テナント境界の相互不可視性が成立)。


---

## Part 4: テナント単位の課金とコスト管理 (DESIGN.md §34.12 から転記)

> **⚠️ DEPRECATED 注記**: 本 Part の Free/Pro 月間トークン上限 (Free 10万 / Pro 100万) は per-token モデル時代の記述で、**Part 5 の per-API-call モデル (Beginner 月 100 回上限 / Expert / Pro 無制限従量課金) で全面的に置き換わっています**。実装は Part 5 を参照。

### 34.12 テナント単位の課金とコスト管理

#### 34.12.1 Free プランと Pro プランの境界

Free プランのテナントは月間 100,000 トークンの上限を持ち、提案エンジンは Haiku で動作し、日次 LLM 呼び出しキャップは 30 回となる。Pro プランのテナントは月間 1,000,000 トークン (10 倍) の上限を持ち、提案エンジンは Sonnet で動作し (v1.x で有効化)、日次 LLM 呼び出しキャップは 200 回となる。

これらの数値はテナント創設時に `Tenant` テーブルにコピーされ、運用中の上限変更は admin 操作で個別テナントごとに調整可能とする (例: エンタープライズ顧客向けに 10 倍プランを提供する場合)。

#### 34.12.2 課金プロバイダとの連携 (将来計画)

v1 ではすべてのテナントが Free プランで運用され、課金は発生しない。v1.x で Stripe を統合し、Pro プランへのアップグレードを Stripe の subscription として実装する。Stripe の webhook で `subscription.created` / `subscription.deleted` イベントを受信し、`Tenant.subscriptionTier` を `'pro'` または `'free'` に更新する。webhook 受信時はシグネチャ検証を必須とし、不正な更新を防ぐ。

Stripe との連携時、テナント ID と Stripe customer ID の対応を `Tenant.stripeCustomerId` で保持する。サブスク状態の変更履歴は `subscription_tier_change_log` テーブルに記録し、不正な権限昇格を事後追跡可能にする。

#### 34.12.3 コスト可視化と admin への通知

admin はサービス内の `/admin/observability/llm` ダッシュボード (v1.x で実装) で、テナントごとの月間トークン使用量・コスト・上限到達状況を確認できる。これは Phase 3c の `/admin/observability` の一部として実装され、提案エンジン以外の LLM 利用 (将来追加されうる機能) も統合的に表示する。

異常検知は v1 から最小実装され、特定テナントの使用量が前日比 5 倍を超えた場合、特定テナントが workspace 上限の 80% に達した場合、admin にメール通知を送る。通知メールにはテナント slug と異常パターンを含め、admin が即座に対処判断できるようにする。


---

## Part 5: 課金モデル確定版: 3 プラン構成 + 従量課金 (DESIGN.md §34.14 から転記)

### 34.14 課金モデル: 3 プラン構成と従量課金 (per-API-call) の確定版

§34.11.4〜§34.12 でテナント単位のコスト管理を扱ったが、**最終的な課金モデルを 3 プラン + 従量課金 (per-API-call)** で確定する。これは「ユーザ数を基準にすると集計直前の意図的なユーザ削除で誤魔化される脆弱性」「アクセスユーザ数を基準にすると未使用ユーザ分のコストが運用者の損失になる構造」の両方を回避し、純粋に「使った分だけ払う」という公平性と「お得感」を両立させる設計判断である。

#### 34.14.1 3 プランの構造

**Beginner プラン** は **無料の試験運用プラン** で、最大 5 席までの席数制限を持ち、Claude Haiku で動作する。月間 100 回までの API 呼び出しが可能で、超過時は **縮退モード**（§34.14.4 参照、エンティティ作成・更新は継続、AI による裏方処理のみ一時停止）に切り替わる。これは小〜中規模プロジェクトでの試用と、上位プランへのアップセル誘導の入り口として機能する。Beginner の制約は「無料を維持しつつ運用者のコスト上限を担保する」という両立を実現する。

**Expert プラン** は **席数無制限の従量課金プラン** で、Claude Haiku で動作する。**プロジェクト作成/更新 1 回あたり ¥10** が課金され (ADR-0019)、資産入力・チャット検索は無料・無制限。月間使用量に上限はない (= 使った分だけ請求される)。主に中〜大規模チームで日常的に提案機能を使うユーザを想定する。

**Pro プラン** は **席数無制限の従量課金プラン** で、Claude Sonnet で動作する。**プロジェクト作成/更新 + なぜ機能 1 回あたり ¥15** が課金される (据置)。資産入力・チャット検索は無料・無制限。Sonnet による深い説明文付きの「なぜ?」機能を享受でき、PMO や経営層など「助言の質」を重視するユーザに向けた最上位プランである。

**価格改定の経緯**:
- **2026-05-15 (ADR-0002)**: 初期 ¥10 / ¥30 から **半額の ¥5 / ¥15 に改定** (=ユーザ採用ハードル削減)
- **2026-05-24 ([ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md))**: **課金対象を BILLABLE_FEATURE_UNITS (project-upsert / suggestion-explanation / auto-tag-extract) に限定**。資産入力 (knowledge / risk-issue / retrospective / memo の embedding) / チャット検索 / CSV インポート / 月初 backfill cron を全プラン無料化。Expert 単価 ¥5 → ¥10 (補填調整)、Pro ¥15 据置。実コスト構造の再検証 (Voyage 200M tokens/月無料枠等) に基づく

価格は引き続き Tenant テーブルの設定値 (`pricePerCallHaiku` / `pricePerCallSonnet`) として外出しし、運用中の柔軟な変更を可能にする。実運用データを見ながら Pro 単価をさらに下げる余地を継続検討する。

#### 34.14.2 「1 回の API 呼び出し」の定義 (課金単位)

per-API-call の「1 回」は **`featureUnit` 単位で 1 回** としてカウントする (実装: [src/lib/llm/metered.ts](../../src/lib/llm/metered.ts) L68)。**「1 業務操作 = 1 ApiCallLog」ルール** に従い、ユーザ視点での 1 操作で内部的に複数の LLM/Embedding API を呼んでも、課金単位は 1 回に集約する。実装上の `featureUnit` は以下：

- `project-upsert` — プロジェクト作成・更新（auto-tag 抽出 + embedding 生成を 1 ApiCallLog に集約 / 2026-05-15）
- `knowledge-embedding` — ナレッジ作成・更新時の embedding 生成
- `risk-issue-embedding` — リスク・課題作成・更新時の embedding 生成
- `retrospective-embedding` — 振り返り作成・更新時の embedding 生成
- `memo-embedding` — メモ作成・更新時の embedding 生成（2026-05-15 追加。Memo は visibility='public' 限定で対象）
- `external-import-embedding` — CSV/XLSX インポート時の embedding 生成（1 ファイル 1 回）
- `suggestion-explanation` — 提案説明文生成（Pro プラン限定。knowledge / issue / risk / retrospective / memo の全資産に対応 / 2026-05-15）

（旧 featureUnit `auto-tag-extract` / `project-embedding` は backfill 経路の互換のため metered.ts 上では受理されるが、新規発行はされない。）

**作成・更新時の課金単位 (1 業務操作 = 1 ApiCallLog ルール)**:
- プロジェクトの作成・更新: **1 回** （auto-tag 抽出 + embedding 生成を統合。purpose/background/scope が全空のときは **0 回** = 早期 return / 2026-05-15）
- ナレッジ・振り返り・メモの作成・更新: **1 回** （対象項目変更時のみ embedding 生成）
- **リスク・課題の作成・更新**: **1 回** （対象項目変更時のみ embedding 生成、**ただし `state='resolved'` のみ**。state='open' / 'in_progress' / 'monitoring' のときは embedding 生成しない / 2026-05-15）
- 「自分のみ」公開範囲（Knowledge/RiskIssue/Retrospective: `visibility='draft'` / Memo: `visibility='private'`）のエンティティは embedding 生成しない → 課金なし。提案エンジン対象外。

**課金対象外**:
- 各画面・提案結果の **表示・再表示** (pgvector による DB 内検索のみ、LLM 呼び出しなし)
- `SuggestionExplanation` テーブルのキャッシュヒット時の説明文返却 (再生成なし)
- エンティティの削除、ログイン、招待などの管理操作
- 「公開範囲: 自分のみ」のエンティティの作成・更新（提案エンジン対象外のため LLM 呼出なし）
- **リスク・課題で `state='resolved'` 以外の作成・更新**（提案エンジン対象外のため、解消するまで Voyage 呼出なし / 2026-05-15）
- **プロジェクト作成・更新で purpose/background/scope が全て空文字**（早期 return で `withMeteredLLM` 自体呼ばず / 2026-05-15）

**失敗時の扱い**: LLM 呼び出しが失敗した場合はカウンタを増加させない (metered.ts L226-235)。プロジェクト作成では auto-tag と embedding のどちらか 1 つでも成功すれば 1 回計上、両方失敗の場合のみ計上なし。

この定義により、ユーザは「データ書き込み = 課金、閲覧・検索 = 無料」と直感的に予測できる。実装上のキャッシュ最適化が進んでもユーザの請求額には透明性が保たれる。

#### 34.14.3 データモデルの確定

§34.11.2 で示した Tenant テーブルの設計を、課金モデル確定版に更新する。

```
model Tenant {
  id                       String   @id
  slug                     String   @unique
  name                     String
  plan                     String   @default("beginner")  // 'beginner' | 'expert' | 'pro'
  currentMonthApiCallCount Int      @default(0)
  currentMonthApiCostJpy   Int      @default(0)
  monthlyBudgetCapJpy      Int?                            // ユーザ自己設定の月次予算上限
  beginnerMonthlyCallLimit Int      @default(50)           // Beginner プランの月間上限 (default 50、ADR-0019、課金対象 call のみカウント)
  beginnerMaxSeats         Int      @default(5)            // Beginner プランの席数上限 (default 5、admin 調整可)
  pricePerCallHaiku        Int      @default(5)            // 円 (2026-05-15 改定: 10 → 5)
  pricePerCallSonnet       Int      @default(15)           // 円 (2026-05-15 改定: 30 → 15)
  lastResetAt              DateTime?
  createdAt                DateTime @default(now())
  deletedAt                DateTime?

  users        User[]
  apiCallLogs  ApiCallLog[]
  // ... 他の業務エンティティ
}
```

`subscription_tier` という名称は廃止し、より明確な `plan` に統一する。`current_month_token_usage` も `currentMonthApiCallCount` (回数) と `currentMonthApiCostJpy` (円換算額) の 2 軸で管理する。月間トークン上限の概念は撤廃し、Beginner は回数上限、Expert/Pro は無制限 (従量課金) とする。

新規テーブル `ApiCallLog` を追加する。これは個別の API 呼び出しを記録する完全な監査ログで、`(timestamp, tenantId, userId, featureUnit, modelName, llmInputTokens, llmOutputTokens, embeddingTokens, costJpy, latencyMs, requestId)` を保存する。`featureUnit` は「new-project-suggestion」「project-suggestion-refresh」「risk-creation-suggest」のような機能単位の識別子で、ユーザに見える単位と内部処理の対応を追跡可能にする。これは課金の根拠データとして法的にも重要で、ユーザクレーム対応の根拠となる。

#### 34.14.4 縮退モードの仕様 (Beginner 上限・Expert/Pro 予算上限 共通)

**確定仕様**: API 呼び出し上限（Beginner: プロジェクト作成/更新 月 50 回 [ADR-0019] / Expert・Pro: テナント管理者設定の予算上限）に達した時点で、**「縮退モード」** に切り替わる。資産入力・チャット検索は ADR-0019 で無料化されたため、これらは縮退モード中も無制限利用可能。

縮退モードの設計原則は **「業務に必要な操作はそのまま続行 + AI による裏方処理のみ一時停止」** である。完全停止のハードカット (HTTP 429) は採用せず、ユーザの業務影響を最小化する。

##### A. 縮退モード中の挙動

| 操作分類 | 挙動 | 備考 |
|---|---|---|
| ナレッジ / リスク / 課題 / 振り返り / メモ / プロジェクトの **作成・更新** | ✅ 継続（embedding = NULL で保存） | HTTP 200 + `degraded: true` フラグでレスポンス |
| CSV / XLSX インポート | ✅ 継続（embedding 生成スキップ） | 同上 |
| プロジェクトの自動タグ抽出 + embedding 生成 (`project-upsert`) | ⏸️ スキップ（タグなし・embedding NULL で保存） | 2026-05-15 統合。ユーザは手動でタグを付けられる |
| Embedding 生成（Knowledge / RiskIssue / Retrospective / Memo） | ⏸️ スキップ（NULL のまま保存） | 月初バッチで 5 テーブル全てを補完 |
| 提案説明文生成（`suggestion-explanation`、Pro のみ） | ⏸️ 新規生成スキップ、キャッシュは返却 | — |
| 既存データの閲覧・検索 | ✅ 通常通り（LLM 不使用） | — |
| プラン変更・解約・予算上限変更 | ✅ 通常通り | 縮退モード解除の唯一の能動手段 |

`withMeteredLLM` ([src/lib/llm/metered.ts](../../src/lib/llm/metered.ts)) は **`{ ok: false, reason: 'degraded' }`** を返す。呼び出し側はこれを受け取って、entity を NULL embedding で保存する経路に分岐する。

##### B. 提案エンジンでの NULL embedding 候補の扱い (重み再配分 5:5)

縮退モード中に embedding 未生成のまま保存されたエンティティを、提案エンジンが公平に扱えるよう **個別候補単位で重みを再配分** する：

| 候補の状態 | 重み配分 | 最大スコア |
|---|---|---|
| Embedding 生成済み | タグ 0.3 / テキスト 0.2 / Embedding 0.5 | 1.0 |
| **Embedding NULL（縮退モード中保存）** | **タグ 0.5 / テキスト 0.5 / Embedding 軸なし** | **1.0** |

これにより、NULL 候補が embedding あり候補と公平に比較・ランキング・tier 分類される。ただし embedding 軸が動かないため、「タグ・本文は違うが意味だけ近い」候補は検知されにくくなる（**月初バッチ補完まで一時的な妥協**）。

##### C. 月初バッチによる embedding 補完

毎月 1 日 UTC 00:00（テナント TZ 対応、PR-4 以降）の月初リセット時：

1. `currentMonthApiCallCount` / `currentMonthApiCostJpy` を 0 にリセット
2. **embedding = NULL のエンティティを一括検出し、AI で順次補完生成**
3. 補完にかかる API 呼び出し回数 / 費用は **新しい月の月間上限に加算** される（通常呼び出しと同じ扱い）

この設計により、翌月の月初には提案エンジンの精度が **完全回復** する。

##### D. ユーザへの可視化

| 対象ロール | 表示内容 | 場所 |
|---|---|---|
| テナント管理者 | 「縮退モード起動中」バッジ + 「embedding 未生成のエンティティ: N 件」 | テナント設定画面 |
| 全ユーザ | 「💡 AI 機能は一時的に制限されています」小バナー | 画面上部 or 操作完了時 |

##### E. 連鎖発火リスクの注意喚起

月初バッチで補完される件数が多いと、新しい月の上限が早期に消費され **連鎖的に縮退モード突入** するリスクがある。FAQ / ヘルプで以下を案内する：

- Beginner プランで連鎖が起きる場合 → Expert / Pro プランへのアップグレードを推奨
- Expert / Pro プランで予算上限を低めに設定中の場合 → 月次予算上限の引き上げを推奨

##### F. アップグレードによる即時解除

- Beginner → Expert/Pro のアップグレード時、即座に縮退モードが解除される
- Expert/Pro での予算上限引き上げ時、上限を下回れば即座に解除される

##### G. 月初リセットの実装

外部 cron (cron-job.org) が `/api/cron/tenant-monthly-reset` を毎月 1 日 UTC 00:00（JST 09:00）に呼び出す。`lastResetAt` が前月以前のテナントを検出して上記処理を実行する。**PR-4 以降はテナントの `timezone` に応じた月境界判定** に対応。

##### H. 実装状況 (2026-05-14 時点)

| 項目 | 状態 |
|---|---|
| 月次予算上限の予測ブロック | ✅ 実装済 (metered.ts L207-220) |
| Beginner 月間上限の判定 | ✅ 実装済 (metered.ts L196-205) |
| 失敗時非課金 | ✅ 実装済 (metered.ts L226-235) |
| キャッシュヒット非課金 | ✅ 実装済 (suggestion-explanation.service.ts L195) |
| 月初リセット | ✅ 実装済 (tenant-monthly-reset.service.ts) |
| 当月使用量 UI | ✅ 実装済 (tenant-settings-client.tsx UsageSection) |
| **A. degraded フラグ返却 + entity 保存継続** | ✅ 実装済 (PR #368 / embedding.service.ts L496-510 で recordError → return、本体は継続) |
| **B. NULL 候補の重み再配分 (5:5)** | ✅ 実装済 (PR #368 / suggestion.service.ts `combineWithDegradation` + `SUGGESTION_*_WEIGHT_DEGRADED`) |
| **C. 月初バッチでの embedding 補完** | ✅ 実装済 (PR #368 / embedding-backfill.service.ts `runMonthlyEmbeddingBackfill`) |
| **D. UI 可視化（縮退バッジ・未生成件数・バナー）** | ✅ 実装済 (PR #368 / dashboard layout 共通バナー + tenant-settings の DegradedModeSection) |
| **E. FAQ 注意喚起** | ✅ 本ドキュメントおよび [docs/public/about.md](../public/about.md) Q8 に記載 |
| **F. ロール別エラーメッセージ** (Q1) | ✅ 実装済 (PR #368 / lib/degraded-error-messages.ts、admin/general 別文言) |
| **G. 予算アラート / 異常検知メール廃止** (Q4) | ✅ 実装済 (PR #368 / usage-monitoring.service.ts から削除、admin ダッシュボードで参照) |

#### 34.14.5 月次予算上限の自己設定機能

ユーザ (テナント管理者) は自テナントの設定画面から、月次予算上限を **自分で設定** できる。例: 「Expert プランで月最大 ¥10,000 まで」と設定すると、その金額に達した時点で §34.14.4 の縮退モードに自動切替される。これは pure metered billing の最大の弱点である **「請求額の予測不可能性」** を解消する仕組みで、Stripe / Twilio など主要な従量課金 SaaS が採用する標準パターンである。

実装は `Tenant.monthlyBudgetCapJpy` に保存し、API 呼び出し前のミドルウェアで `currentMonthApiCostJpy + 次の呼び出しの予測コスト > monthlyBudgetCapJpy` をチェックして、超過する場合は縮退モードに切り替える ([metered.ts L207-220](../../src/lib/llm/metered.ts))。`monthlyBudgetCapJpy` が `NULL` の場合は上限なし (= 純粋な従量課金) として動作する。

UI 上は「予算 ¥10,000 のうち、今月 ¥3,200 を使用 (32%)」のような可視化を行い、ユーザが現在地と予算をいつでも確認できるようにする (詳細は §34.14.7 で詳述)。

#### 34.14.5b テナント払い出し時の 3 層 eligibility 判定 (ADR-0016 Revised / 2026-05-22)

公開セルフサインアップ (`/signup`) におけるテナント新規払い出しは、入力された **初期管理者メール (`initialAdminEmail`)** をキーとして以下の 3 層で判定される。判定キーは `initialAdminEmail` の 1 つのみで、`billingContactEmail` は付随情報扱いで対象外。

| 層 | 判定条件 | 払い出し | エラー / UX |
|---|---|---|---|
| **層 1: 自前テナント保有** | `users.email = initialAdminEmail` を持つ user が、いずれかの `tenants.created_by_user_id` に紐付く (論理削除/物理削除問わず) | ❌ **公開フォーム完全不可** | API: `OWNED_TENANT_EXISTS` (HTTP 409) / UI: フォーム全体 disable + 「システム管理者へお問い合わせください」+ Discord 動線 |
| **層 2: 招待 / Default 所属のみ** | `users.email = initialAdminEmail` あり、ただし層 1 ではない (= 招待された member、Default テナント所属など) | ✅ **Expert / Pro のみ** | API (`plan='beginner'` 時): `BEGINNER_REQUIRES_UPGRADE` (HTTP 409) / UI: Beginner radio disable + Expert/Pro 誘導注釈、Beginner 選択中なら自動で Expert に切替 |
| **層 3: 完全な新規** | `users.email = initialAdminEmail` が一切なし | ✅ **Beginner / Expert / Pro 全プラン可** | 制約なし |

**設計意図**:

- **abuse 防止**: 層 1 はテナント管理者の自己問合せ経由 (= super_admin 経路) を必須化することで、同一個人が「自前テナント」を雪だるま式に増やすことを阻止。複数の自前テナント保有自体は禁じないが、**ユーザ自身による公開フォームでの追加払い出しを禁止** し、必ず admin の手動審査を通すモデル。
- **false positive 抑止**: 旧 4 条件 OR 判定 (ADR-0016 オリジナル / 2026-05-20) は `billingContactEmail` の重複も Beginner 不可条件にしていたため、会計士代行 / 共有 billing email を使う正当用途で false positive が発生していた。本 Revised では `initialAdminEmail` 単一キーに絞ることで実害なく緩和。
- **defense-in-depth**: UI ヒントは `/api/auth/check-tenant-eligibility` で事前に 3 値判定を返し、サーバ最終判定は `tenant-onboarding.service.ts` の `OWNED_TENANT_EXISTS` / `BEGINNER_REQUIRES_UPGRADE` で同等の検査を行う (UI bypass されても block)。

**super_admin による手動払い出し** (`/admin/super/tenants/new`) は **SA-2** ルールにより 3 層判定を **完全スキップ** する (= `skipEligibilityCheck=true`)。これは「層 1 該当ユーザの問合せに応じて、admin 判断で例外発行する経路」を運用上の正規ルートとして提供するため。1 ユーザが super_admin 経由で複数の自前テナントを保有することは許容するが、その後ユーザ自身が公開フォームで追加するパスは依然として閉じられる。

**テナント削除** は層判定の制約外 (= 自前テナント保有ユーザでも自分のテナントを削除可能)。削除後の再払い出しは依然 admin 問合せ必須 (層 1 維持)。

**実装ファイル**:

- 判定ロジック: [src/services/tenant-onboarding.service.ts](../../src/services/tenant-onboarding.service.ts) (3 層判定 + `skipEligibilityCheck`)
- UI ヒント API: [src/app/api/auth/check-tenant-eligibility/route.ts](../../src/app/api/auth/check-tenant-eligibility/route.ts) (3 値返却: `signupAllowed` / `beginnerAvailable` / `reason`)
- サインアップ UI: [src/app/(auth)/signup/page.tsx](../../src/app/(auth)/signup/page.tsx) (層 1 でフォーム全体 disable + Discord 動線)
- DB schema: [prisma/schema.prisma](../../prisma/schema.prisma) `Tenant.createdByUserId` (migration: `20260527_tenants_created_by_user_id_tracking`)
- ADR: [ADR-0016 Revised section](../adr/0016-multi-tenant-user-membership.md#revised-2026-05-22)

#### 34.14.6 プラン変更フローと制御ロジック

テナント管理者は自テナントのシステム管理者設定画面からプランを変更できる。変更フローは方向によって異なる挙動とする。

**Beginner → Expert / Pro へのアップグレード** は、決済情報の登録 (Stripe 連携、v1.x で実装) と同時に **即時有効化** する。アップグレード後の API 呼び出しから新プランの料金体系で課金される。これは「もっと使いたい」というユーザの意欲を即座に満たす設計で、待たせる理由がない。

**Expert ↔ Pro の切替 (LLM モデル変更)** は **即時反映** する。技術的には `Tenant.plan` を見て分岐する 1 行の変更で、次の API 呼び出しから対応モデル (Haiku / Sonnet) に切り替わる。当月の使用分は切替前後それぞれの単価で集計され、月次請求書で内訳表示する。

**Expert / Pro → Beginner へのダウングレード** は **完全禁止** とする (P-B / 2026-05-08)。Beginner は「初回テナント作成から 90 日限定の試用枠」と位置付けられているため、上位プランに一度上がったテナントを Beginner に戻すことはできない。サーバは `BEGINNER_DOWNGRADE_FORBIDDEN` を返し、UI でも該当ラジオボタン選択時にエラー表示する。Beginner 退避手段が必要な場合はテナント解約フローを利用する。

**確認 UI** (Expert ↔ Pro ダウングレード時): 「ダウングレードは即時反映されます。Pro 限定機能 (「なぜ?」AI 説明) が利用できなくなり、当月以降の API 呼出単価が切替後プランの単価に変わります」を、変更操作の前段で **明示的に確認させる** UI を必須とする (旧仕様の「月末から適用」「翌月適用」注意文は 2026-05-14 改修で撤回)。

#### 34.14.7 リアルタイム使用量ダッシュボード

ユーザ (テナント管理者) は自テナントの設定画面から、リアルタイムの使用状況ダッシュボードを閲覧できる。表示する情報は以下の 4 つのレイヤーで構成する。

第一に **当月のサマリー** で、今月の API 呼び出し回数、課金額、予算 (設定されていれば) との比較、を 1 行で表示する。例: 「今月の使用状況: 320 回 / ¥3,200 (予算 ¥10,000 の 32%)」。

第二に **プラン情報と席数** で、現在のプラン名、席数 (Beginner なら N/5、Expert/Pro なら無制限)、Beginner なら月間上限残量 (例: 「残 25 回 / 100 回」)、を表示する。

第三に **日次の使用推移グラフ** で、当月の日別 API 呼び出し回数と費用を簡易な棒グラフで可視化する。これは突発的な使用量増加 (= 異常パターン) をユーザ自身が発見できる窓口となる。

第四に **機能別の内訳** で、「新規プロジェクト時の提案: N 回」「提案画面の再表示: M 回」「リスク起票時の関連 issue 検索: K 回」のように、`featureUnit` 単位で集計したテーブルを表示する。これによりユーザは「どの機能で多く使っているか」を理解し、利用パターンを最適化できる。

**※ 2026-05-14 更新**: 本セクション以下に記載のうち、**「v1.x で UI 実装」と書かれていた次の項目は v1 (6/1) 時点で既に実装済み** となっている。

- テナント管理者設定画面（`/settings/tenant`）: プラン情報表示・プラン変更・予算上限自己設定・リアルタイム使用量タイル（当月 API 呼出 / API 費用 / 月次予算上限 / 予算消化率プログレスバー）— [src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx](../../src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx)
    - **feat/tenant-settings-tabs (2026-05-22)**: 1949 行のモノリスから 3 タブ (概要 / 使用量 / 請求) 構成に再編。URL クエリ `?tab=overview|usage|billing` で active tab を持続させ、Stripe Checkout 戻り後も請求タブが選択された状態を維持する。共通ヘッダー (テナント名 / 組織 ID / 再集計ボタン / Beginner 期限バナー / 停止中バナー) はタブ外固定。請求タブ内に既存 `/settings/tenant/billing` (請求履歴) への動線リンクを併設。
- super_admin 向けの全テナント横断使用量サマリ（`/admin/super`）: 顧客テナント数 / 今月の API 呼出 / 今月の合計課金 / プラン別分布 / CSV 請求エクスポート — [src/app/(dashboard)/admin/super/](../../src/app/(dashboard)/admin/super/)
- API 利用量再集計ボタン: `POST /api/tenants/me/recalculate` で ApiCallLog の SUM から再計算

**残る v1.x の TODO**: Stripe Metered Billing 連携（月末自動請求 / Webhook 同期）、機能別 (`featureUnit`) 内訳ダッシュボード、過去 6 ヶ月の使用量履歴グラフ表示。

---

これらは段階的に実装してきており、**データ蓄積は v1 から開始済み**。Tenant テーブルの集計フィールドと `ApiCallLog` テーブルを v1 から運用しており、画面上でも当月分はリアルタイムに表示される。

#### 34.14.8 v1 と v1.x の実装範囲

**v1 (6月1日) で実装する範囲**:

- データモデル: Tenant への `plan`、`currentMonthApiCallCount`、`currentMonthApiCostJpy`、`monthlyBudgetCapJpy`、`beginnerMonthlyCallLimit`、`pricePerCallHaiku`、`pricePerCallSonnet` カラム、ApiCallLog テーブル
- 内部ロジック: API 呼び出し直前にプラン・使用量をチェックして適切に課金 / 縮退するミドルウェア（`withMeteredLLM`）、Beginner プランの月間上限チェック、外部 cron (cron-job.org) による月初リセット
- **UI（実装済み）**:
  - テナント管理者設定画面: プラン情報・プラン変更・予算上限設定・当月使用量タイル（プラン別構成: Beginner は「API 呼出 + 残数」、Expert/Pro は「API 呼出 + API 費用 + 月次予算上限 + 予算消化率」）
  - super_admin ダッシュボード: 全テナント横断の使用量サマリ + 請求業務用 CSV エクスポート

**v1.x で実装する残りの範囲**:

- **Stripe 連携 (2026-05-14 仕様確定)**: Subscription with Metered Billing、月末自動請求、Webhook 経由のプラン状態同期
  - 詳細仕様: [STRIPE_BILLING.md](./STRIPE_BILLING.md)
  - 設計判断記録: [ADR-0006](../adr/0006-stripe-metered-billing-integration.md)
  - 主要決定: デフォルト `invoice` で開始 → 顧客が任意で `credit_card` に切替 (並存方式) / 自社が手数料負担 / Stripe Tax でインボイス制度対応 / Smart Retries + PR #372 自動 suspend 連携
- **機能別 (`featureUnit`) 内訳ダッシュボード**: 「自動タグ抽出: N 回」「embedding 生成: M 回」のように、内部の課金単位ごとの集計表示
- **過去 6 ヶ月の使用量履歴**: 月初リセット時のスナップショットを月次累積したグラフ表示

Stripe の Metered Billing は本ユースケースに完全に適合する機能で、各 API 呼び出し時に Stripe にイベント送信 (`stripe.subscriptionItems.createUsageRecord`) するだけで、月末に自動で請求額が確定し、ユーザに請求書が送られる。実装パターンが業界標準なので、トラブルシューティングも容易である。
