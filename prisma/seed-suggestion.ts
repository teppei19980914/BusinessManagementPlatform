/**
 * 提案エンジン用シードデータ投入スクリプト (PR #6 / T-03 提案エンジン v2)
 *
 * 役割:
 *   1. **default-tenant への初期シードデータ投入**: 30 件のナレッジを `visibility='public'`
 *      で登録。新規テナントが提案機能を試した瞬間から「過去資産が結びつく体験」を提供する。
 *   2. **テナント別シーディング機構** `seedTenant(tenantId)`: 新規テナントを作成した際に
 *      default-tenant のシードナレッジを **そのテナント所属で複製** する関数。
 *      embedding カラムは元 entity から直接コピーすることで、Voyage API の再呼び出しを
 *      回避する (= 同じ内容のナレッジは同じベクトル)。
 *
 * 設計方針:
 *   - シードナレッジは **業界・職種を越えて再利用可能な汎用パターン** を選定。
 *     具体的には PMBOK の典型課題、ソフトウェア開発の古典的教訓、リスク管理の標準事例 等。
 *   - `createdBy` は **初期管理者ユーザ (INITIAL_ADMIN_EMAIL)** を使用。テナント別 seed では
 *     当該テナントの最初の admin ユーザに紐付ける。
 *   - **冪等性**: 同じ title + tenantId のナレッジが既に存在すればスキップ (再実行可能)。
 *   - **embedding 生成は seed 内で行わない**: Voyage API 依存を避けるため、一旦 NULL で
 *     INSERT する。embedding が必要なテナントには `seedTenant()` で複製する際に source
 *     ベクトルをコピーするか、別途 backfill スクリプトを使用する。
 *
 * 使い方:
 *
 *   ```bash
 *   # default-tenant にシード投入 (初回セットアップ時)
 *   pnpm db:seed:suggestion
 *
 *   # テナント別シーディング (admin から呼び出し、v1.x のテナント招待運用時)
 *   pnpm tsx prisma/seed-suggestion.ts --tenant <tenantId>
 *   ```
 *
 *   `seedTenant(tenantId)` 関数は別ファイルから import して使うことも可能。
 *
 * 関連:
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #6
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §候補絞り込み
 *   - 実装: src/services/knowledge.service.ts (createKnowledge と同じ列構成で INSERT)
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { DEFAULT_TENANT_ID } from '../src/lib/tenant';

// ================================================================
// シードナレッジ定義 (30 件、業界横断の古典的パターン)
// ================================================================

interface SeedKnowledge {
  title: string;
  knowledgeType: string;
  background: string;
  content: string;
  result: string;
  conclusion: string | null;
  recommendation: string | null;
  reusability: string | null;
  techTags: string[];
  processTags: string[];
  businessDomainTags: string[];
}

const SEED_KNOWLEDGE: SeedKnowledge[] = [
  // ---------- プロジェクト管理 (PMBOK / 古典) ----------
  {
    title: 'Brooks の法則 — 遅延プロジェクトへの人員追加は、さらなる遅延を招く',
    knowledgeType: 'lesson_learned',
    background: 'リリース直前のプロジェクトで遅延が発生し、追加メンバーの投入で挽回しようとしたが、教育コスト・コミュニケーションオーバーヘッドが先行して結果的にさらに遅延した。',
    content: '人月計算は「人」と「月」を交換可能とみなすが、実際にはチーム内のコミュニケーションパスは n(n-1)/2 で増加し、新メンバーの教育期間は既存メンバーの稼働を奪う。タスクが分割可能でない (例: アーキテクチャ設計や統合テスト) フェーズでは、人を増やすほど効率が下がる。',
    result: '人員追加によって 2 週間の遅延が 4 週間に拡大した。代わりにスコープを絞り込み、優先度の低い機能を v1.1 に延期する判断に切り替え、当初の 2 週間遅延で着地した。',
    conclusion: '遅延時はまず「スコープ調整」「並行作業の整理」「ボトルネックの特定」を試み、人員追加は最終手段とする。',
    recommendation: 'プロジェクト計画段階で「人月の幻想」を前提に置き、バッファとして人員ではなくスコープ調整余地を確保する。',
    reusability: '全業種・全規模のプロジェクトに適用可能。特にウォーターフォール型でリリース日固定のプロジェクトで顕在化しやすい。',
    techTags: [],
    processTags: ['project_management', 'risk_management'],
    businessDomainTags: [],
  },
  {
    title: 'スコープクリープ — 追加要望の累積でリリースが遅延する',
    knowledgeType: 'pattern',
    background: '要件凍結後に「ついでに XX も」という追加要望が累積し、リリース予定日が次第に後ろ倒しになった。',
    content: '小規模な追加 (1 日工数) であっても、5-10 件累積すれば 1-2 週間の遅延につながる。さらに追加要望は予期しない依存関係 (既存機能との互換性、テストの増加) を引き起こす。',
    result: '凍結後の追加 8 件で当初予定から 3 週間遅延。次プロジェクトで「凍結後の追加は v1.1 へ」のルールを導入し、遅延ゼロでリリース。',
    conclusion: '要件凍結のラインを明確にし、それ以降の要望は次バージョンへ送る。例外を作らない。',
    recommendation: 'ステークホルダーとのキックオフ時に「追加要望の取り扱いルール (=凍結後は次バージョン)」を文書化し合意を取る。',
    reusability: '全業種に適用。ステークホルダー数が多いほど (3 人以上) 効果が大きい。',
    techTags: [],
    processTags: ['project_management', 'requirements'],
    businessDomainTags: [],
  },
  {
    title: 'Conway の法則 — 組織構造がシステム構造を規定する',
    knowledgeType: 'pattern',
    background: 'マイクロサービス化を試みたが、組織が機能別 (フロント/バック/インフラ) に分かれていたため、結局モノリスに戻った。',
    content: 'システムの構造は、それを設計する組織のコミュニケーション構造を写像する (Melvin Conway, 1968)。サービス境界を引きたいなら、まず組織境界を引き直す必要がある。',
    result: 'チーム編成を「機能別」から「ドメイン別 (例: 注文/在庫/顧客)」に変更後、3 ヶ月でマイクロサービス分離が機能した。',
    conclusion: 'アーキテクチャ変更には先行して組織変更が必要。技術的決定だけでは解決しない。',
    recommendation: 'マイクロサービス化を検討する際は「逆 Conway 戦略」(=理想のアーキテクチャに合わせて組織を再編する) を最初に検討する。',
    reusability: 'ソフトウェア開発全般に適用。10 人以上の開発組織で顕著。',
    techTags: ['microservices', 'monolith'],
    processTags: ['organization', 'architecture'],
    businessDomainTags: [],
  },
  {
    title: '見積もりは 2 倍が現実 — Hofstadter の法則',
    knowledgeType: 'lesson_learned',
    background: '開発見積もりが常に楽観的で、リリース予定日に間に合った試しがない。',
    content: '「常に予想より時間がかかる、Hofstadter の法則を考慮に入れても」(Douglas Hofstadter)。見積もりは作業者の楽観バイアスと、未知の不確実性 (調査・統合・障害対応) の過小評価により、構造的に低めに出る。',
    result: '見積もりに 1.5 倍の係数を掛ける運用を 6 ヶ月続けた結果、計画と実績の乖離が ±10% に収束。',
    conclusion: '個人の見積もりに 1.3-1.5 倍の係数 (個人差ベース) を掛けて公式計画とする。',
    recommendation: '見積もり時に「楽観値・現実値・悲観値」の 3 点見積もりを採り、現実値 = (楽観 + 4×現実 + 悲観) / 6 (PERT) で計算する。',
    reusability: '全業種・全工程に適用。経験 5 年未満のメンバーには係数を 1.7 倍まで拡大する。',
    techTags: [],
    processTags: ['estimation', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'リスク登録簿の更新頻度を週次にすることで予兆を捕まえる',
    knowledgeType: 'pattern',
    background: 'プロジェクト終盤でリスクが顕在化したが、登録簿は月次更新で気付きが遅れた。',
    content: 'リスクは「発生確率の高さ」よりも「発見の遅れ」の方が事業影響を増幅する。週次の 15 分レビューで「今週新たに気付いた懸念」を吸い上げ、必要に応じて即座に対策する。',
    result: '週次運用に切り替えた 3 ヶ月で、リスク顕在化件数は変わらなかったが、対策着手の平均日数が 21 日 → 5 日に短縮し、影響度合いが大幅に低下。',
    conclusion: 'リスク登録簿は更新頻度が「予兆検知能力」と直結する。週次を最低ラインに、重要案件は日次。',
    recommendation: 'リスク登録簿の項目に「最終確認日」を追加し、1 週間更新がない項目を自動でフラグ表示する。',
    reusability: '中規模以上 (3 ヶ月超) のプロジェクト全般。',
    techTags: [],
    processTags: ['risk_management', 'project_management'],
    businessDomainTags: [],
  },

  // ---------- 技術パターン ----------
  {
    title: '冪等性 (Idempotency) — リトライ可能な API 設計',
    knowledgeType: 'pattern',
    background: '決済 API の通信エラーで、リトライによって二重課金が発生した。',
    content: 'ネットワーク通信は不確実 (タイムアウト・切断) なため、クライアントは同一リクエストを何度も送る可能性がある。サーバ側で **同じリクエストを何度受けても結果が同じ** な設計 (冪等性) にすれば、クライアントは安心してリトライできる。',
    result: '`Idempotency-Key` ヘッダーで重複検知を実装し、二重課金事故をゼロに。',
    conclusion: '副作用のある API (POST/PUT/DELETE) には冪等性キーまたは状態判定ロジックを必ず実装する。',
    recommendation: 'クライアント側で UUID を発行し `Idempotency-Key` ヘッダーで送信、サーバ側で 24 時間保持して重複判定する標準パターンを採用 (Stripe API 形式)。',
    reusability: '決済・在庫操作・通知送信など、副作用ありの API すべてに適用。',
    techTags: ['rest_api', 'reliability', 'idempotency'],
    processTags: ['design'],
    businessDomainTags: ['payment', 'finance'],
  },
  {
    title: 'N+1 クエリ問題 — ORM 使用時の典型的なパフォーマンス劣化',
    knowledgeType: 'lesson_learned',
    background: 'ユーザー一覧画面が遅く、調査したところ各ユーザーの所属部署を取得する 1+N 個のクエリが発行されていた。',
    content: 'ORM の遅延ロード (lazy loading) は便利だが、ループ内で関連データにアクセスすると 1 + N 回のクエリが発行され、N が大きいほど線形に遅くなる。Prisma なら `include`、ActiveRecord なら `includes`、SQLAlchemy なら `joinedload` で eager load する必要がある。',
    result: '100 ユーザーの一覧で 101 クエリ → 2 クエリに削減。応答時間 800ms → 50ms。',
    conclusion: 'ループ内で別エンティティにアクセスする箇所は、必ず先頭で eager load する。',
    recommendation: '開発環境で SQL ログを出力し、1 リクエストあたりのクエリ数を可視化する。閾値 (例: 10 件) を超えたら警告。',
    reusability: 'ORM 使用プロジェクトすべて。リスト表示画面で特に頻発。',
    techTags: ['orm', 'performance', 'database', 'prisma'],
    processTags: ['performance_optimization'],
    businessDomainTags: [],
  },
  {
    title: 'キャッシュ無効化の難しさ — 2 つの難問の 1 つ',
    knowledgeType: 'lesson_learned',
    background: 'マスタデータをキャッシュしたが、更新後の反映タイミングがずれて古いデータが表示される事故が発生した。',
    content: 'Phil Karlton の言葉「コンピュータサイエンスには 2 つの難問がある: キャッシュ無効化と命名」。キャッシュは速度を稼ぐが、無効化のタイミング・粒度・整合性を誤ると古いデータが永続的に残る。',
    result: '更新時に明示的に `cache.invalidate(key)` を呼ぶ実装に変更し、データ齟齬がゼロに。同時に TTL (Time-To-Live) を 5 分から 30 秒に短縮し、最悪ケースの古さを許容範囲に。',
    conclusion: 'キャッシュは「TTL ベース」「明示的 invalidate ベース」の 2 段構えで、更新検知は明示的 invalidate を主軸にする。',
    recommendation: 'キャッシュ層には常にバージョン番号 (etag) を持たせ、source of truth と照合する仕組みを併設する。',
    reusability: 'キャッシュを導入する全システム。',
    techTags: ['cache', 'redis', 'consistency'],
    processTags: ['design'],
    businessDomainTags: [],
  },
  {
    title: 'Circuit Breaker パターン — 障害の連鎖を断つ',
    knowledgeType: 'pattern',
    background: '外部 API の障害でアプリ全体がタイムアウトの嵐になり、健全なリクエストも処理できなくなった。',
    content: '外部依存先が不健全な時、それでも呼び続けると自システムのスレッドプール・コネクションプールを食い潰し、自身も不健全になる。Circuit Breaker は「失敗率が閾値超過したら一定時間呼び出しを止め、定期的にヘルスチェックして復旧したら再開」する仕組み。',
    result: '失敗率 50%、5 秒間の遮断、30 秒後リトライの設定で導入。外部 API 障害時にも自システムは健全を維持し、復旧後 30 秒以内に自動復帰。',
    conclusion: '外部依存先は必ず Circuit Breaker で守り、自システムの健全性を境界として保つ。',
    recommendation: 'Hystrix / resilience4j / opossum などの確立されたライブラリを使う。自前実装は罠が多い。',
    reusability: '外部 API・DB・キャッシュなど依存先がある全システム。マイクロサービスでは必須。',
    techTags: ['circuit_breaker', 'resilience', 'microservices'],
    processTags: ['design', 'reliability'],
    businessDomainTags: [],
  },
  {
    title: 'タイムゾーンは UTC で保存し、表示時に変換する',
    knowledgeType: 'pattern',
    background: 'DB に JST のローカル時刻を保存していたら、サマータイム導入国のユーザに表示時刻がずれた。',
    content: 'タイムゾーン変換のバグは「保存時に変換」「表示時に変換」のいずれかが抜けると発生する。**全 DB タイムスタンプを UTC で保存** し、**表示時にユーザの TZ で変換** する一方通行ルールにすれば、変換漏れがあっても DB は常に正しい状態を保てる。',
    result: '既存データを UTC に変換するマイグレーションを実施。新規コードは Date 型ではなく ISO 8601 文字列を扱う統一を実施。サマータイム関連の不具合がゼロに。',
    conclusion: 'DB は UTC、表示は TZ 変換の一方通行。Date 型 (タイムゾーン付き timestamp) を使用。',
    recommendation: 'PostgreSQL の `timestamptz` 型を使用 (`timestamp without time zone` ではない)。フロント側は Intl.DateTimeFormat で表示変換。',
    reusability: 'グローバルサービス・複数 TZ ユーザーがいるシステム全般。',
    techTags: ['timezone', 'database', 'i18n'],
    processTags: ['design', 'data_modeling'],
    businessDomainTags: [],
  },
  {
    title: '冪等性のないバッチジョブが二重実行される',
    knowledgeType: 'lesson_learned',
    background: 'Cron で起動するバッチジョブが、何らかの理由で重複起動し、課金処理が 2 重に走った。',
    content: 'Cron / Vercel Cron / GitHub Actions スケジュールいずれも、システム障害・ネットワーク再送によって稀に重複起動する。バッチジョブ自体に冪等性が無いと、データ破損につながる。',
    result: 'バッチ起動時に DB の advisory lock を取得し、二重起動時は後発をスキップする実装に変更。重複起動事故が再発ゼロに。',
    conclusion: 'バッチジョブは必ず排他制御 (advisory lock / 分散ロック) を仕込む。',
    recommendation: 'PostgreSQL なら `pg_try_advisory_lock(hashtext(\'job-name\'))` で軽量な排他を実現。Redis なら SETNX で同様。',
    reusability: '定時バッチ・cron jobs を持つ全システム。',
    techTags: ['batch', 'cron', 'database', 'lock'],
    processTags: ['reliability', 'design'],
    businessDomainTags: [],
  },
  {
    title: 'マイグレーションは前方互換 → デプロイ → 後方互換削除の 3 段階で',
    knowledgeType: 'pattern',
    background: 'カラムを「リネーム」する migration を本番に流したら、旧コードが動いていたインスタンスが壊れた。',
    content: 'ローリングデプロイ中は旧コードと新コードが同時に動く期間がある。schema 変更とコード変更を同 PR に詰めると、デプロイ中に必ず壊れる。**前方互換 (新旧両方が動く) → デプロイ → 後方互換削除** の 3 段階で進める。',
    result: 'カラムリネーム例: (1) 新カラム追加 (旧と新の両方を埋める) → (2) コードを新カラム読込に切替 → (3) 旧カラム削除。各段階を別 PR で本番反映し、ダウンタイムゼロを達成。',
    conclusion: 'schema の破壊的変更は単一 PR で行わず、3 PR に分割して各回の互換性を維持する。',
    recommendation: 'カラム削除・型変更・テーブル分割等、互換性を壊す変更は必ず 3 段階。コード変更だけのデプロイは 1 PR で OK。',
    reusability: 'ローリングデプロイ・ゼロダウンタイム志向の全システム。',
    techTags: ['database', 'migration', 'deployment'],
    processTags: ['deployment', 'design'],
    businessDomainTags: [],
  },
  {
    title: 'API は徐々に厳しくする (寛容に受け取り、厳格に返す)',
    knowledgeType: 'pattern',
    background: '既存 API のバリデーションを後から強化したら、運用中のクライアントが多数壊れた。',
    content: '「Postel の法則」: 寛容に受け取り、厳格に返す。API 開発の初期は緩く、運用とともに **少しずつ厳しくする方向** にしか変えない。緩和は安全だが厳格化はクライアント壊れる。',
    result: '新規バリデーションは v2 として並行運用に切り替え、v1 は警告 → 半年後に廃止する Deprecation スケジュールを設定。',
    conclusion: 'API の互換性ルール: 緩和 OK、厳格化は新バージョンで。',
    recommendation: 'API バージョニング (URL or header) を最初から導入し、廃止予告 (Deprecation header + 移行期間 6 ヶ月) を制度化。',
    reusability: '外部公開 API・SDK 配布のあるサービス全般。',
    techTags: ['api_design', 'versioning', 'deprecation'],
    processTags: ['design', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'ログは構造化し、検索可能にする (JSON 形式)',
    knowledgeType: 'pattern',
    background: '本番障害時、テキストログを grep するのに 30 分かかり、対応が遅れた。',
    content: '非構造化テキストログ (`[INFO] User 12345 logged in from 1.2.3.4`) は人間が読みやすいが、機械的検索・集計に向かない。JSON 構造化ログ (`{"level": "info", "user_id": 12345, "ip": "1.2.3.4", "event": "login"}`) なら、ログ集約サービス (Datadog, Sentry, CloudWatch) で「user_id=12345 のログだけ」「event=login の件数推移」が即座に出る。',
    result: '構造化ログに切替え後、本番障害の調査時間が 30 分 → 3 分に短縮。',
    conclusion: 'ログは最初から構造化する。文字列連結ではなくフィールド付きで出力。',
    recommendation: 'pino / winston / Python の structlog 等の構造化ロギングライブラリを使用。`request_id` を全エンドポイントで通し、関連ログを横串検索できるようにする。',
    reusability: '本番運用するすべてのサーバアプリケーション。',
    techTags: ['logging', 'observability'],
    processTags: ['operations', 'design'],
    businessDomainTags: [],
  },
  {
    title: '機密情報は環境変数 + secret manager で、コードに書かない',
    knowledgeType: 'lesson_learned',
    background: 'GitHub に AWS の access key を誤コミットし、数時間で攻撃者に悪用された (数十万円の損害)。',
    content: '誤コミットは git revert しても **GitHub の reflog や fork に残る**。漏洩した時点でキーは即座にローテーション必須。一次対策はコミット禁止 (.gitignore + pre-commit hook)、二次対策は環境変数経由、三次対策は secret manager (AWS Secrets Manager / Vercel env) からの動的取得。',
    result: 'pre-commit hook (gitleaks) で AWS_KEY 形式を検知して block する仕組みを導入。さらに既存コードを全件監査して secret manager に移行。',
    conclusion: 'シークレットは複数層で防御。誤コミット時の即時ローテーション手順 (Runbook) を整備しておく。',
    recommendation: 'gitleaks / TruffleHog でリポジトリスキャン。GitHub の Secret scanning も有効化。万一漏洩したら 1 時間以内のキーローテーションを SLO に。',
    reusability: 'クラウドサービス・外部 API キーを使う全プロジェクト。',
    techTags: ['security', 'secret_management', 'devops'],
    processTags: ['security', 'incident_response'],
    businessDomainTags: [],
  },

  // ---------- リスク管理 ----------
  {
    title: 'ベンダーロックイン — 単一クラウド依存のリスク',
    knowledgeType: 'pattern',
    background: '特定クラウドのマネージドサービスを多用したら、別クラウドへの移行コストが極大化した。',
    content: 'マネージドサービス (Cloud Run / Lambda / Cosmos DB 等) は便利だが、独自仕様で書かれたコードは他クラウドへ持ち運べない。単一クラウド依存はクラウド側の値上げ・ポリシー変更に逆らえない構造リスクを生む。',
    result: '抽象化レイヤー (Repository / Cache インターフェース) を挟む方針に変更。コア業務ロジックは抽象化越しに依存し、クラウド固有部分は薄い実装層に閉じ込めた。移行コストが見積もり 6 ヶ月 → 1 ヶ月に短縮 (試算)。',
    conclusion: 'クラウド固有 API は薄い実装層に閉じ込め、業務ロジックは標準 SQL / 標準プロトコルに依存させる。',
    recommendation: '初期から Postgres-compatible (RDS / Cloud SQL / Supabase 等で動く) 構成を選定し、独自データベースを避ける。',
    reusability: '中長期で運用するシステム全般。',
    techTags: ['architecture', 'cloud', 'aws', 'gcp', 'azure'],
    processTags: ['risk_management', 'architecture'],
    businessDomainTags: [],
  },
  {
    title: 'キーパーソン依存 — Bus Factor 1 のリスク',
    knowledgeType: 'lesson_learned',
    background: '中核機能を 1 人のエンジニアだけが理解しており、その人の退職で 3 ヶ月開発停止した。',
    content: '「Bus Factor」(その人がバスに轢かれたらプロジェクトが止まる人数) が 1 のシステムは、退職・休職・体調不良で即座に運用停止する構造リスクを抱える。',
    result: '中核機能ごとに「主担当 + 副担当」の 2 人体制を必須化。コードレビュー必須・ペアプログラミング週次・設計書の更新を義務化。Bus Factor が 1 → 3 に向上。',
    conclusion: '機能ごとに最低 2 人が理解している状態を運用ルールとして強制する。',
    recommendation: '退職・異動時に「引き継ぎ完了の Definition of Done」を明文化 (例: 副担当が単独で 1 機能変更 + デプロイを完遂)。',
    reusability: '5 人以上の開発組織、3 ヶ月以上運用するシステム。',
    techTags: [],
    processTags: ['risk_management', 'organization', 'documentation'],
    businessDomainTags: [],
  },
  {
    title: '本番デプロイ直前の金曜午後を避ける',
    knowledgeType: 'lesson_learned',
    background: '金曜午後に本番デプロイしたところ障害が発生し、夜間〜週末対応で消耗した。',
    content: 'デプロイ直後の障害は対応コストが最大化する時間帯がある: **金曜午後・連休前** は監視メンバーの稼働が落ち、復旧チームの召集も遅れる。',
    result: '「火〜木の午前中のみデプロイ」をルール化。緊急 hotfix を除き徹底。週末対応稼働がゼロに。',
    conclusion: 'デプロイは「事故が起きても対応できる時間帯」に限定する。',
    recommendation: 'デプロイ可能時間帯をスケジュール (例: Tue/Wed/Thu の 10:00-15:00) で明文化。CI でも該当時間外の本番デプロイを警告。',
    reusability: '本番運用する全サービス。特に小規模チーム (10 人以下) で重要。',
    techTags: ['deployment', 'devops'],
    processTags: ['operations', 'risk_management'],
    businessDomainTags: [],
  },
  {
    title: 'バックアップは取得しただけでは無価値、復元テストで価値が確定する',
    knowledgeType: 'lesson_learned',
    background: '災害対策で日次バックアップを取っていたが、復元手順を試したら失敗してバックアップ自体が破損していた。',
    content: 'バックアップ運用は「取得」「保管」「復元」の 3 段階が揃って初めて機能する。多くの組織は取得・保管しか検証せず、復元時に初めて壊れていることが発覚する (Schrodinger\'s Backup)。',
    result: '月次で本番バックアップから別環境への復元演習 (3 時間以内) を実施。3 ヶ月目に圧縮形式の不整合を発見し、修正。',
    conclusion: 'バックアップは「復元できると確認できた時点」で初めて価値を持つ。月次以上の頻度で復元演習を実施。',
    recommendation: '復元演習は「目隠しテスト」(=本番チーム以外が手順書だけで復元できるか) で実施。手順書の盲点が見つかる。',
    reusability: 'データ永続化を伴う全システム。',
    techTags: ['backup', 'disaster_recovery'],
    processTags: ['operations', 'risk_management'],
    businessDomainTags: [],
  },
  {
    title: '個人情報の取り扱い: 取得・保存・削除の 3 段階で同意を整理する',
    knowledgeType: 'pattern',
    background: 'GDPR / 個人情報保護法対応で、ユーザの「忘れられる権利」要求に応えられず処理が滞った。',
    content: '個人情報は「何を取るか (取得時の同意)」「どこに保存するか (保管期間)」「いつ消すか (削除トリガー)」の 3 段階で設計する。同意なしの保存・削除手段の不在が法的リスクを生む。',
    result: 'プライバシーポリシーに「保管期間」「削除リクエスト時の対応 SLA (30 日)」を明記。論理削除 + 30 日後物理削除のジョブを実装。',
    conclusion: '個人情報はライフサイクル設計が必須。取得 → 保存 → 削除のフローを明文化。',
    recommendation: 'GDPR / CCPA / 改正個人情報保護法に対応。法務部門との早期連携・運用フローの文書化。',
    reusability: '個人情報を扱う全サービス (BtoC・BtoB 問わず)。',
    techTags: ['privacy', 'compliance', 'security'],
    processTags: ['compliance', 'design'],
    businessDomainTags: [],
  },

  // ---------- プロセス・組織 ----------
  {
    title: 'コードレビューはマージ前ではなく PR 作成と同時に依頼する',
    knowledgeType: 'pattern',
    background: 'PR が放置されてマージ待ちが累積し、リリースが遅れる事象が続いた。',
    content: 'PR を作成したら **すぐに** レビュー依頼を出す (Slack 通知 / GitHub 自動レビュアー設定)。「自分でもう 1 回見てから依頼」と先送りすると、レビュアーの稼働もずれて 2-3 日空くことが多い。',
    result: 'PR 作成 → 自動的に Slack へレビュー依頼通知する Bot を導入。平均レビュー所要時間が 24 時間 → 4 時間に短縮。',
    conclusion: 'レビュー依頼は「自信がついてから」ではなく「動く状態になったら」即座に出す。',
    recommendation: 'GitHub Actions + Slack Webhook で「PR opened → 即通知」を自動化。レビュアーアサインも CODEOWNERS で自動化。',
    reusability: '5 人以上の開発組織、PR ベースの開発フロー全般。',
    techTags: ['github', 'code_review', 'slack'],
    processTags: ['code_review', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: '振り返り (KPT) は「Try」を 1 つに絞ると実行率が上がる',
    knowledgeType: 'pattern',
    background: '振り返りで Try が 5-10 個出るが、次の振り返りまでにほとんど実行されていなかった。',
    content: '人間の継続的な変化キャパシティは限定的。Try を 5 個出すと「全部覚えていない」「優先順位が分からない」で結局 0 個実行になる。**最重要の Try を 1 つだけ** に絞り、次の振り返りまでに必ず実施することを約束する方が実行率が高い。',
    result: '「次までの Try は 1 つだけ」ルールに変更。3 ヶ月で 12 個の Try を実施 (旧運用では 30+ 個立てて 5 個実施程度)。',
    conclusion: '振り返りの Try は数より実行率を重視。1 つに絞ることで「次までに本当にやる」コミットメントが生まれる。',
    recommendation: 'KPT に加えて「次までの Try (1 つ)」と「Try 担当者」を明記。次回振り返り冒頭で実施結果を確認するルーチンを作る。',
    reusability: 'スクラム・カンバン・ウォーターフォール問わず、定期的な振り返りを行う全チーム。',
    techTags: [],
    processTags: ['retrospective', 'agile', 'team_practice'],
    businessDomainTags: [],
  },
  {
    title: 'デイリースタンドアップは 15 分厳守 + 立ったまま',
    knowledgeType: 'pattern',
    background: 'スタンドアップが議論で 30-45 分に延び、メンバーの集中時間が削られた。',
    content: 'スタンドアップの目的は「進捗確認」「障害共有」のみで、議論はパーキングロット (別ミーティング) に分離する。15 分の物理タイマー + 立ったまま (椅子に座らない) で時間制約を体感的に強制。',
    result: 'タイマー導入 + 立ち姿勢ルール徹底後、スタンドアップ平均 12 分に収束。議論は「同期会」(別枠 30 分) で行う方針に分離。',
    conclusion: 'スタンドアップは進捗報告に徹する。議論はパーキングロット送り、別途同期会を設定。',
    recommendation: '物理タイマー (キッチンタイマー) を会議室に置く。Zoom の場合は画面共有でカウントダウンタイマーを表示。',
    reusability: 'スクラム・デイリースタンドアップを行う全チーム。',
    techTags: [],
    processTags: ['agile', 'team_practice', 'meeting'],
    businessDomainTags: [],
  },
  {
    title: 'インシデント対応は「対処 → 原因究明 → 再発防止」の 3 段で',
    knowledgeType: 'pattern',
    background: '本番障害発生時、原因究明と対処が混ざり混乱した。',
    content: 'インシデント対応は時間軸で 3 段階に分ける: **(1) 即時対処 (=ユーザ影響を止める)** → **(2) 原因究明 (落ち着いてから)** → **(3) 再発防止 (Postmortem 後の改善実装)**。混ぜると「原因が分からないまま jen 直し続ける」or「対処が遅れて被害拡大」になる。',
    result: 'Incident Commander を専任化し、対処指揮 + 原因調査担当を分離。MTTR (平均復旧時間) が 90 分 → 30 分に短縮。',
    conclusion: '本番障害時は役割を「指揮 / 復旧 / 調査 / 連絡」に分ける。',
    recommendation: 'PagerDuty / Opsgenie 等のインシデント管理ツールで Incident Commander 役割を明示化。Postmortem テンプレートを用意。',
    reusability: '本番運用する全サービス。10 人以上の組織で必須。',
    techTags: ['incident_management', 'sre'],
    processTags: ['incident_response', 'operations'],
    businessDomainTags: [],
  },

  // ---------- 業務ドメイン (汎用的なもの) ----------
  {
    title: '注文と決済の整合性 — 二相コミットの代わりに saga パターン',
    knowledgeType: 'pattern',
    background: 'EC サイトで「在庫確保 → 決済」の途中で決済失敗時、在庫が解放されず売り逃しが発生した。',
    content: '複数システムにまたがる業務処理 (在庫 + 決済 + 出荷) で 2PC (二相コミット) は可用性を犠牲にする。代わりに **Saga パターン** (= 各ステップに補償処理を用意し、失敗時は逆方向に巻き戻す) を採用する。',
    result: '注文確定時の Saga を実装: 在庫確保 → 決済 → 出荷予約。決済失敗時は在庫解放 (補償)。失敗事故の再発がゼロに。',
    conclusion: '分散システムの整合性は Saga + 結果整合性で担保する。完全な ACID は捨てる。',
    recommendation: 'Saga ステップは可視化 (workflow tool: Temporal / Step Functions) し、補償ロジックを明示的にコード化する。',
    reusability: 'EC・予約・決済を伴う全システム。',
    techTags: ['saga', 'distributed_systems', 'transaction'],
    processTags: ['design', 'architecture'],
    businessDomainTags: ['ecommerce', 'payment'],
  },
  {
    title: '在庫管理 — 楽観ロックで二重売りを防ぐ',
    knowledgeType: 'pattern',
    background: 'EC サイトで残り 1 個の商品を 2 人が同時に購入し、二重売りになった。',
    content: '在庫操作は典型的な競合状態 (race condition)。読込 → 計算 → 書込の間に他のリクエストが介入すると整合性が崩れる。楽観ロック (version 列の比較) または DB トランザクションの SELECT FOR UPDATE で排他制御する。',
    result: 'product テーブルに version 列を追加。UPDATE 時に WHERE version=? で楽観ロック。二重売りがゼロに。',
    conclusion: '在庫・座席・予約など「個数」を扱うエンティティは楽観ロックで保護する。',
    recommendation: 'Prisma なら `@@unique` で並行性を担保。または明示的な version 列で楽観ロック。書込量が多いなら Redis の atomic counter も検討。',
    reusability: 'EC・予約・座席・在庫管理を伴う全システム。',
    techTags: ['database', 'optimistic_lock', 'concurrency'],
    processTags: ['design', 'data_modeling'],
    businessDomainTags: ['ecommerce', 'inventory'],
  },
  {
    title: '請求書発行は冪等に + 改ざん不可ログ',
    knowledgeType: 'pattern',
    background: '請求書再発行時に内容が変わり、過去の請求書との整合性が取れなくなった。',
    content: '請求書は「発行時点での確定文書」であり、後から金額・宛先を変えてはいけない。発行ごとにユニークな番号を採番し、内容のハッシュを取り、改ざん不可なログ (append-only) に記録する。',
    result: 'invoice テーブルを WORM (Write Once, Read Many) 設計に変更。過去の請求書は editable=false。再発行時は新規 invoice として「N号の訂正版」と明示。',
    conclusion: '請求書・領収書・契約書は履歴改ざん不可で保管。修正は「追加発行」として履歴を残す。',
    recommendation: '電子帳簿保存法対応も視野に: タイムスタンプ + ハッシュチェーンで改ざん検知。',
    reusability: '請求・会計・契約を扱う全システム。法務・税務リスクが高い。',
    techTags: ['immutable', 'audit_log', 'compliance'],
    processTags: ['compliance', 'design'],
    businessDomainTags: ['finance', 'invoicing'],
  },
  {
    title: 'ユーザの「論理削除」と「物理削除」の使い分け',
    knowledgeType: 'pattern',
    background: 'ユーザ削除時に物理削除したら、関連レコード (注文履歴・コメント等) が一斉に消えてサービス運営に支障が出た。',
    content: '関連データを持つエンティティの削除は「論理削除 (deletedAt 列セット)」を基本とする。物理削除は (1) GDPR 等の法的要件 (2) 30 日以上の論理削除 + ユーザ確認後 にのみ実施。',
    result: 'soft-delete (論理削除) を全エンティティで採用。`deletedAt IS NOT NULL` を WHERE 条件で除外。物理削除は専用バッチで日次実行 (30 日経過後)。',
    conclusion: '即座の物理削除は事故の素。論理削除 → 一定期間後 → 物理削除 の 2 段階で運用する。',
    recommendation: 'Prisma の middleware で `findMany` 等に `deletedAt: null` を自動付与。物理削除は専用 admin 操作 + 監査ログ必須。',
    reusability: 'ユーザデータを扱う全システム。特に BtoC で重要。',
    techTags: ['database', 'soft_delete', 'compliance'],
    processTags: ['design', 'data_modeling'],
    businessDomainTags: [],
  },

  // ---------- セキュリティ ----------
  {
    title: 'OWASP Top 10: SQL インジェクションは ORM 使用でも油断するな',
    knowledgeType: 'lesson_learned',
    background: 'ORM を使っているから SQL インジェクションは起きないと思っていたが、$queryRawUnsafe で生 SQL を組んだ部分から侵入された。',
    content: 'Prisma / TypeORM 等の ORM はパラメータバインディングで SQLi を防ぐが、生 SQL を扱う API ($queryRawUnsafe / Raw ) を使うとバインディングが効かず脆弱になる。',
    result: '全コードを `$queryRaw` (タグ付きテンプレート、自動バインディング) に置換。`$queryRawUnsafe` の使用は禁止 (lint で検知)。',
    conclusion: 'ORM 使用時も生 SQL の混入経路を必ず検知・遮断する。',
    recommendation: 'pre-commit hook で `\\$queryRawUnsafe|\\$executeRawUnsafe` を grep して block。lint ルールで自動検知。',
    reusability: 'DB を持つ全システム。ORM 採用プロジェクトでも必須。',
    techTags: ['security', 'sql_injection', 'orm', 'prisma'],
    processTags: ['security', 'code_review'],
    businessDomainTags: [],
  },
  {
    title: 'API rate limit はユーザ単位 + IP 単位の二段で',
    knowledgeType: 'pattern',
    background: '攻撃者が複数 IP から低頻度でログイン試行 (credential stuffing) を行い、IP ベースのレート制限をすり抜けた。',
    content: 'rate limit は単一の指標では迂回されやすい。**ユーザ ID 単位** (=同一アカウントへの試行を制限) と **IP 単位** (=同一発信元の試行を制限) の両方を併用する。',
    result: 'IP 単位 + ユーザ単位 + 失敗カウント (= 一時ロック) の 3 段防御を実装。credential stuffing 検知率 95%。',
    conclusion: 'rate limit は単一軸では弱い。複数軸で防御を重ねる。',
    recommendation: '認証エンドポイントは特に厳格に。IP / User / Device fingerprint の 3 軸監視を推奨。',
    reusability: '認証・課金 API を持つ全システム。',
    techTags: ['security', 'rate_limit', 'authentication'],
    processTags: ['security', 'design'],
    businessDomainTags: [],
  },
];

// ================================================================
// 共通: シードデータ投入
// ================================================================

async function findInitialAdmin(prisma: PrismaClient, tenantId: string): Promise<string> {
  // 当該テナントの最初の admin (or general) ユーザを取得 (createdAt 最古)
  const user = await prisma.user.findFirst({
    where: { tenantId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!user) {
    throw new Error(
      `Tenant ${tenantId} にユーザが存在しません。先に prisma/seed.ts (初期管理者作成) を実行してください。`,
    );
  }
  return user.id;
}

async function insertSeedKnowledge(
  prisma: PrismaClient,
  tenantId: string,
  createdBy: string,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const k of SEED_KNOWLEDGE) {
    // 冪等性: 同じ tenantId + title が既に存在すればスキップ
    const existing = await prisma.knowledge.findFirst({
      where: { tenantId, title: k.title, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.knowledge.create({
      data: {
        tenantId,
        title: k.title,
        knowledgeType: k.knowledgeType,
        background: k.background,
        content: k.content,
        result: k.result,
        conclusion: k.conclusion,
        recommendation: k.recommendation,
        reusability: k.reusability,
        techTags: k.techTags,
        processTags: k.processTags,
        businessDomainTags: k.businessDomainTags,
        visibility: 'public',
        createdBy,
        updatedBy: createdBy,
      },
    });
    inserted++;
  }

  return { inserted, skipped };
}

// ================================================================
// 公開: テナント別シーディング (v1.x のテナント招待運用で呼ばれる想定)
// ================================================================

/**
 * 新規テナントへ default-tenant のシードナレッジを clone する。
 *
 * embedding 列は default-tenant の値を **そのままコピー** することで、
 * Voyage API への再呼び出しを避ける (= 同じ内容のナレッジは同じベクトル)。
 *
 * @param tenantId clone 先テナントの UUID
 * @returns 投入件数 / スキップ件数
 */
export async function seedTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<{ inserted: number; skipped: number }> {
  if (tenantId === DEFAULT_TENANT_ID) {
    throw new Error(
      'seedTenant() は default-tenant 以外を対象とする関数です。default-tenant の seed は seed-suggestion main で行ってください。',
    );
  }

  // 1. clone 先テナントの最初のユーザを取得 (createdBy として使用)
  const createdBy = await findInitialAdmin(prisma, tenantId);

  // 2. default-tenant のシードナレッジを source として読み出し
  const sources = await prisma.knowledge.findMany({
    where: {
      tenantId: DEFAULT_TENANT_ID,
      visibility: 'public',
      deletedAt: null,
      title: { in: SEED_KNOWLEDGE.map((k) => k.title) },
    },
  });

  let inserted = 0;
  let skipped = 0;

  for (const src of sources) {
    // 冪等性: 同じ tenantId + title が既に存在すればスキップ
    const existing = await prisma.knowledge.findFirst({
      where: { tenantId, title: src.title, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    // 3. 新規テナント所属で複製 (embedding は別途 raw SQL でコピー)
    const cloned = await prisma.knowledge.create({
      data: {
        tenantId,
        title: src.title,
        knowledgeType: src.knowledgeType,
        background: src.background,
        content: src.content,
        result: src.result,
        conclusion: src.conclusion,
        recommendation: src.recommendation,
        reusability: src.reusability,
        techTags: src.techTags as string[],
        devMethod: src.devMethod,
        processTags: src.processTags as string[],
        businessDomainTags: src.businessDomainTags as string[],
        visibility: 'public',
        createdBy,
        updatedBy: createdBy,
      },
    });

    // 4. content_embedding を source からコピー (同じ内容 = 同じベクトル)
    //    Prisma の Unsupported("vector(1024)") 型は通常の update では書けないため
    //    raw SQL で UPDATE する。embedding が NULL の source はスキップ。
    await prisma.$executeRaw`
      UPDATE "knowledges"
        SET "content_embedding" = (
          SELECT "content_embedding"
            FROM "knowledges"
            WHERE id = ${src.id}::uuid
        )
        WHERE id = ${cloned.id}::uuid
          AND tenant_id = ${tenantId}::uuid
    `;

    inserted++;
  }

  return { inserted, skipped };
}

// ================================================================
// メイン: コマンドライン起動
// ================================================================

/**
 * DATABASE_URL から host:port のみ抽出してマスク表示する。
 * 接続先の取り違え (ローカル vs 本番) を視覚的に確認できるようにする。
 */
function describeDatabaseTarget(): string {
  const url = process.env.DATABASE_URL ?? '(未設定)';
  // postgresql://user:pw@host:port/db?... → host:port のみ抜き出す
  const match = url.match(/@([^/?]+)/);
  return match?.[1] ?? '(URL 解析不可)';
}

/**
 * Prisma エラーが ECONNREFUSED の場合に運用者向けの分かりやすい説明を出す。
 */
function printConnectionRefusedHelp(target: string): void {
  console.error('');
  console.error('❌ DB に接続できません (ECONNREFUSED): ' + target);
  console.error('');
  console.error('原因の可能性:');
  console.error('  1. ローカル開発の DB (Docker Compose) が起動していない');
  console.error('     → 解決: `docker compose up -d` で起動');
  console.error('');
  console.error('  2. .env の DATABASE_URL が古い接続情報のまま (本番に向けたい場合)');
  console.error('     → 解決: .env.local に本番接続情報を一時設定して再実行');
  console.error('             postgresql://postgres.[ref]:[pw]@aws-1-[region].pooler.supabase.com:6543/postgres?pgbouncer=true');
  console.error('             ※ 必ず Session Pooler (aws-1-...pooler.supabase.com) を使用');
  console.error('             ※ Direct connection (db.[ref].supabase.co) は IPv6 only で Vercel 不可');
  console.error('     → 完了後は .env.local を必ず削除 (誤操作防止)');
  console.error('');
  console.error('  3. Supabase 側で firewall や network 設定が変更されている');
  console.error('     → 解決: Supabase Dashboard → Settings → Database で URL を再取得');
  console.error('');
  console.error('詳細手順: docs/operations/DB_MIGRATION_PROCEDURE.md §3.3.2');
}

/**
 * Prisma エラーが P1000 (Authentication Failed) の場合に運用者向けの分かりやすい説明を出す。
 *
 * 接続はできているが認証情報 (パスワード) が間違っている状況。
 * Supabase の場合、特殊文字を含むパスワードの URL エンコードでよく失敗する。
 */
function printAuthenticationFailedHelp(target: string): void {
  console.error('');
  console.error('❌ DB の認証に失敗しました (P1000 AuthenticationFailed): ' + target);
  console.error('');
  console.error('接続自体はできているため、パスワード or ユーザ名が間違っています。');
  console.error('');
  console.error('原因の可能性:');
  console.error('  1. パスワードに特殊文字 (`、!、$、@、# 等) が含まれており URL エンコードに失敗');
  console.error('     → 解決: Supabase Dashboard → Connect → Connection string で表示される');
  console.error('             URL を **そのまま** .env.local にコピペ (手書きの一部修正をしない)');
  console.error('     → URL エンコード例: ` (バッククォート) → %60、! → %21、$ → %24');
  console.error('');
  console.error('  2. ユーザ名が "postgres" だけになっている (Session Pooler では "postgres.[ref]" が必要)');
  console.error('     → 例: postgres.ejexwhjrnkttmmuvaxrh:[pw]@aws-1-...pooler.supabase.com');
  console.error('       ↑ "postgres" の後に "." とプロジェクト ref が必要');
  console.error('');
  console.error('  3. Supabase でパスワードがリセットされた');
  console.error('     → 解決: Supabase Dashboard → Settings → Database → Reset database password');
  console.error('             その後 Vercel 環境変数も新パスワードに更新');
  console.error('');
  console.error('  4. .env.local を作成・保存後に DB ターゲットが切り替わっていない');
  console.error('     → 解決: 同じシェルで再実行する。新しい PowerShell では .env.local を再読込する');
  console.error('');
  console.error('検証方法 (任意):');
  console.error('  psql で直接接続を試して認証を切り分け:');
  console.error('     psql "$env:DATABASE_URL"');
  console.error('  認証エラーなら URL の userinfo 部 (user:pass) を再確認');
}

async function main() {
  const args = process.argv.slice(2);
  const tenantArgIdx = args.indexOf('--tenant');
  const targetTenantId = tenantArgIdx !== -1 ? args[tenantArgIdx + 1] : DEFAULT_TENANT_ID;

  if (!targetTenantId) {
    console.error('Usage: pnpm tsx prisma/seed-suggestion.ts [--tenant <tenantId>]');
    console.error('  --tenant 省略時は default-tenant が対象');
    process.exit(1);
  }

  const dbTarget = describeDatabaseTarget();
  console.log(`🌱 Seed suggestion data → tenant: ${targetTenantId}`);
  console.log(`   DB target: ${dbTarget}`);
  console.log('');

  // ローカル接続の場合は注意喚起 (本番に対して打ちたかったケースの保険)
  if (dbTarget.startsWith('localhost') || dbTarget.includes('127.0.0.1')) {
    console.log('⚠ 警告: ローカル DB を対象としています。');
    console.log('   本番投入が目的の場合は、.env.local に本番接続情報を一時設定してから再実行してください。');
    console.log('');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    if (targetTenantId === DEFAULT_TENANT_ID) {
      // default-tenant への直接投入
      const createdBy = await findInitialAdmin(prisma, DEFAULT_TENANT_ID);
      const { inserted, skipped } = await insertSeedKnowledge(
        prisma,
        DEFAULT_TENANT_ID,
        createdBy,
      );
      console.log(`✅ default-tenant: ${inserted} 件投入 / ${skipped} 件スキップ (既存)`);
      console.log('');
      console.log('注: embedding は NULL のまま (Voyage API は seed 時に呼ばない)。');
      console.log('    必要に応じて別途 backfill スクリプトで生成してください。');
    } else {
      // 別テナントへの clone (embedding 含む)
      const { inserted, skipped } = await seedTenant(prisma, targetTenantId);
      console.log(`✅ tenant ${targetTenantId}: ${inserted} 件 clone / ${skipped} 件スキップ (既存)`);
      console.log('');
      console.log('注: source (default-tenant) に embedding があればコピー、無ければ NULL。');
    }
  } catch (error) {
    // ECONNREFUSED / P1000 (AuthenticationFailed) は典型的な誤設定なので個別に手厚く案内する
    const errMessage = error instanceof Error ? error.message : String(error);
    const errCode = (error as { code?: string }).code;
    if (errCode === 'ECONNREFUSED' || errMessage.includes('ECONNREFUSED')) {
      printConnectionRefusedHelp(dbTarget);
      process.exitCode = 1;
      return;
    }
    if (
      errCode === 'P1000' ||
      errMessage.includes('Authentication failed') ||
      errMessage.includes('AuthenticationFailed')
    ) {
      printAuthenticationFailedHelp(dbTarget);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
