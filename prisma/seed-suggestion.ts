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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
// 2026-05-09 (PR G / 設計合意 B): シードデータは管理テナントに集中する設計に変更
import { DEFAULT_TENANT_ID, MANAGEMENT_TENANT_ID } from '../src/lib/tenant';

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
  /** 'low' | 'medium' | 'high' (Knowledge.reusability の VarChar(10) enum 制約) */
  reusability: 'low' | 'medium' | 'high';
  techTags: string[];
  processTags: string[];
  businessDomainTags: string[];
}

// ================================================================
// PR-X5 (5-2 / 5-3 / 5-4): サンプルプロジェクト / 課題 / 振り返り のシード型定義
// ================================================================

/**
 * シード用のサンプルプロジェクト。
 *   default-tenant に投入され、`isSampleData=true` で隠蔽されつつ、
 *   提案エンジンの候補ソースとして利用される。
 *   各サンプルプロジェクトには関連する SeedSampleIssue / SeedSampleRetrospective が紐付く。
 */
interface SeedSampleProject {
  /** プロジェクト名 (sample であることが分かる接尾辞付きを推奨)。 */
  name: string;
  /** 紐付く Customer の名前 (なければ自動作成。default-tenant 配下) */
  customerName: string;
  purpose: string;
  background: string;
  scope: string;
  outOfScope: string | null;
  devMethod: string;
  contractType: string | null;
  businessDomainTags: string[];
  techStackTags: string[];
  processTags: string[];
  plannedStartDate: string; // 'YYYY-MM-DD'
  plannedEndDate: string;
  status: string; // 'planning' | 'in_progress' | 'completed' | etc.
}

/**
 * シード用のサンプル課題 / リスク。`parentProjectName` で SAMPLE_PROJECTS と紐付ける。
 */
interface SeedSampleIssue {
  /** どの SAMPLE_PROJECTS の name に紐付くか。投入時に親 Project の id を解決する。 */
  parentProjectName: string;
  type: 'risk' | 'issue';
  title: string;
  content: string;
  cause: string | null;
  impact: 'low' | 'medium' | 'high';
  likelihood: 'low' | 'medium' | 'high' | null;
  priority: 'low' | 'medium' | 'high';
  responsePolicy: string | null;
  responseDetail: string | null;
  state: string; // 'open' | 'in_progress' | 'resolved' | 'closed'
  result: string | null;
  lessonLearned: string | null;
  /** type='risk' のみ。'threat' | 'opportunity' */
  riskNature: 'threat' | 'opportunity' | null;
}

/**
 * シード用のサンプル振り返り。`parentProjectName` で SAMPLE_PROJECTS と紐付ける。
 */
interface SeedSampleRetrospective {
  parentProjectName: string;
  /** 'YYYY-MM-DD' */
  conductedDate: string;
  planSummary: string;
  actualSummary: string;
  goodPoints: string;
  problems: string;
  improvements: string;
  knowledgeToShare: string | null;
  state: string; // 'draft' | 'confirmed'
}

/**
 * 事前生成 embedding の JSON 構造 (prisma/seed-suggestion-embeddings.json)。
 * key は seedHashKey() で生成された SHA-256 先頭 16 hex 文字。
 */
interface SeedEmbeddingsJson {
  _meta?: {
    description?: string;
    generator?: string;
    model?: string;
    dimensions?: number;
    lastGeneratedAt?: string | null;
    lastGeneratedCommitSha?: string | null;
  };
  knowledges: Record<string, number[]>;
  issues: Record<string, number[]>;
  retrospectives: Record<string, number[]>;
  projects: Record<string, number[]>;
}

export const SEED_KNOWLEDGE: SeedKnowledge[] = [
  // ---------- プロジェクト管理 (PMBOK / 古典) ----------
  {
    title: 'Brooks の法則 — 遅延プロジェクトへの人員追加は、さらなる遅延を招く',
    knowledgeType: 'lesson',
    background: 'リリース直前のプロジェクトで遅延が発生し、追加メンバーの投入で挽回しようとしたが、教育コスト・コミュニケーションオーバーヘッドが先行して結果的にさらに遅延した。',
    content: '人月計算は「人」と「月」を交換可能とみなすが、実際にはチーム内のコミュニケーションパスは n(n-1)/2 で増加し、新メンバーの教育期間は既存メンバーの稼働を奪う。タスクが分割可能でない (例: アーキテクチャ設計や統合テスト) フェーズでは、人を増やすほど効率が下がる。',
    result: '人員追加によって 2 週間の遅延が 4 週間に拡大した。代わりにスコープを絞り込み、優先度の低い機能を v1.1 に延期する判断に切り替え、当初の 2 週間遅延で着地した。',
    conclusion: '遅延時はまず「スコープ調整」「並行作業の整理」「ボトルネックの特定」を試み、人員追加は最終手段とする。',
    recommendation: 'プロジェクト計画段階で「人月の幻想」を前提に置き、バッファとして人員ではなくスコープ調整余地を確保する。',
    reusability: 'high',
    techTags: [],
    processTags: ['project_management', 'risk_management'],
    businessDomainTags: [],
  },
  {
    title: 'スコープクリープ — 追加要望の累積でリリースが遅延する',
    knowledgeType: 'best_practice',
    background: '要件凍結後に「ついでに XX も」という追加要望が累積し、リリース予定日が次第に後ろ倒しになった。',
    content: '小規模な追加 (1 日工数) であっても、5-10 件累積すれば 1-2 週間の遅延につながる。さらに追加要望は予期しない依存関係 (既存機能との互換性、テストの増加) を引き起こす。',
    result: '凍結後の追加 8 件で当初予定から 3 週間遅延。次プロジェクトで「凍結後の追加は v1.1 へ」のルールを導入し、遅延ゼロでリリース。',
    conclusion: '要件凍結のラインを明確にし、それ以降の要望は次バージョンへ送る。例外を作らない。',
    recommendation: 'ステークホルダーとのキックオフ時に「追加要望の取り扱いルール (=凍結後は次バージョン)」を文書化し合意を取る。',
    reusability: 'high',
    techTags: [],
    processTags: ['project_management', 'requirements'],
    businessDomainTags: [],
  },
  {
    title: 'Conway の法則 — 組織構造がシステム構造を規定する',
    knowledgeType: 'best_practice',
    background: 'マイクロサービス化を試みたが、組織が機能別 (フロント/バック/インフラ) に分かれていたため、結局モノリスに戻った。',
    content: 'システムの構造は、それを設計する組織のコミュニケーション構造を写像する (Melvin Conway, 1968)。サービス境界を引きたいなら、まず組織境界を引き直す必要がある。',
    result: 'チーム編成を「機能別」から「ドメイン別 (例: 注文/在庫/顧客)」に変更後、3 ヶ月でマイクロサービス分離が機能した。',
    conclusion: 'アーキテクチャ変更には先行して組織変更が必要。技術的決定だけでは解決しない。',
    recommendation: 'マイクロサービス化を検討する際は「逆 Conway 戦略」(=理想のアーキテクチャに合わせて組織を再編する) を最初に検討する。',
    reusability: 'medium',
    techTags: ['microservices', 'monolith'],
    processTags: ['organization', 'architecture'],
    businessDomainTags: [],
  },
  {
    title: '見積もりは 2 倍が現実 — Hofstadter の法則',
    knowledgeType: 'lesson',
    background: '開発見積もりが常に楽観的で、リリース予定日に間に合った試しがない。',
    content: '「常に予想より時間がかかる、Hofstadter の法則を考慮に入れても」(Douglas Hofstadter)。見積もりは作業者の楽観バイアスと、未知の不確実性 (調査・統合・障害対応) の過小評価により、構造的に低めに出る。',
    result: '見積もりに 1.5 倍の係数を掛ける運用を 6 ヶ月続けた結果、計画と実績の乖離が ±10% に収束。',
    conclusion: '個人の見積もりに 1.3-1.5 倍の係数 (個人差ベース) を掛けて公式計画とする。',
    recommendation: '見積もり時に「楽観値・現実値・悲観値」の 3 点見積もりを採り、現実値 = (楽観 + 4×現実 + 悲観) / 6 (PERT) で計算する。',
    reusability: 'high',
    techTags: [],
    processTags: ['estimation', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'リスク登録簿の更新頻度を週次にすることで予兆を捕まえる',
    knowledgeType: 'best_practice',
    background: 'プロジェクト終盤でリスクが顕在化したが、登録簿は月次更新で気付きが遅れた。',
    content: 'リスクは「発生確率の高さ」よりも「発見の遅れ」の方が事業影響を増幅する。週次の 15 分レビューで「今週新たに気付いた懸念」を吸い上げ、必要に応じて即座に対策する。',
    result: '週次運用に切り替えた 3 ヶ月で、リスク顕在化件数は変わらなかったが、対策着手の平均日数が 21 日 → 5 日に短縮し、影響度合いが大幅に低下。',
    conclusion: 'リスク登録簿は更新頻度が「予兆検知能力」と直結する。週次を最低ラインに、重要案件は日次。',
    recommendation: 'リスク登録簿の項目に「最終確認日」を追加し、1 週間更新がない項目を自動でフラグ表示する。',
    reusability: 'medium',
    techTags: [],
    processTags: ['risk_management', 'project_management'],
    businessDomainTags: [],
  },

  // ---------- 技術パターン ----------
  {
    title: '冪等性 (Idempotency) — リトライ可能な API 設計',
    knowledgeType: 'best_practice',
    background: '決済 API の通信エラーで、リトライによって二重課金が発生した。',
    content: 'ネットワーク通信は不確実 (タイムアウト・切断) なため、クライアントは同一リクエストを何度も送る可能性がある。サーバ側で **同じリクエストを何度受けても結果が同じ** な設計 (冪等性) にすれば、クライアントは安心してリトライできる。',
    result: '`Idempotency-Key` ヘッダーで重複検知を実装し、二重課金事故をゼロに。',
    conclusion: '副作用のある API (POST/PUT/DELETE) には冪等性キーまたは状態判定ロジックを必ず実装する。',
    recommendation: 'クライアント側で UUID を発行し `Idempotency-Key` ヘッダーで送信、サーバ側で 24 時間保持して重複判定する標準パターンを採用 (決済サービス API 形式)。',
    reusability: 'medium',
    techTags: ['rest_api', 'reliability', 'idempotency'],
    processTags: ['design'],
    businessDomainTags: ['payment', 'finance'],
  },
  {
    title: 'N+1 クエリ問題 — ORM 使用時の典型的なパフォーマンス劣化',
    knowledgeType: 'lesson',
    background: 'ユーザー一覧画面が遅く、調査したところ各ユーザーの所属部署を取得する 1+N 個のクエリが発行されていた。',
    content: 'ORM の遅延ロード (lazy loading) は便利だが、ループ内で関連データにアクセスすると 1 + N 回のクエリが発行され、N が大きいほど線形に遅くなる。Prisma なら `include`、ActiveRecord なら `includes`、SQLAlchemy なら `joinedload` で eager load する必要がある。',
    result: '100 ユーザーの一覧で 101 クエリ → 2 クエリに削減。応答時間 800ms → 50ms。',
    conclusion: 'ループ内で別エンティティにアクセスする箇所は、必ず先頭で eager load する。',
    recommendation: '開発環境で SQL ログを出力し、1 リクエストあたりのクエリ数を可視化する。閾値 (例: 10 件) を超えたら警告。',
    reusability: 'high',
    techTags: ['orm', 'performance', 'database', 'prisma'],
    processTags: ['performance_optimization'],
    businessDomainTags: [],
  },
  {
    title: 'キャッシュ無効化の難しさ — 2 つの難問の 1 つ',
    knowledgeType: 'lesson',
    background: 'マスタデータをキャッシュしたが、更新後の反映タイミングがずれて古いデータが表示される事故が発生した。',
    content: 'Phil Karlton の言葉「コンピュータサイエンスには 2 つの難問がある: キャッシュ無効化と命名」。キャッシュは速度を稼ぐが、無効化のタイミング・粒度・整合性を誤ると古いデータが永続的に残る。',
    result: '更新時に明示的に `cache.invalidate(key)` を呼ぶ実装に変更し、データ齟齬がゼロに。同時に TTL (Time-To-Live) を 5 分から 30 秒に短縮し、最悪ケースの古さを許容範囲に。',
    conclusion: 'キャッシュは「TTL ベース」「明示的 invalidate ベース」の 2 段構えで、更新検知は明示的 invalidate を主軸にする。',
    recommendation: 'キャッシュ層には常にバージョン番号 (etag) を持たせ、source of truth と照合する仕組みを併設する。',
    reusability: 'medium',
    techTags: ['cache', 'redis', 'consistency'],
    processTags: ['design'],
    businessDomainTags: [],
  },
  {
    title: 'Circuit Breaker パターン — 障害の連鎖を断つ',
    knowledgeType: 'best_practice',
    background: '外部 API の障害でアプリ全体がタイムアウトの嵐になり、健全なリクエストも処理できなくなった。',
    content: '外部依存先が不健全な時、それでも呼び続けると自システムのスレッドプール・コネクションプールを食い潰し、自身も不健全になる。Circuit Breaker は「失敗率が閾値超過したら一定時間呼び出しを止め、定期的にヘルスチェックして復旧したら再開」する仕組み。',
    result: '失敗率 50%、5 秒間の遮断、30 秒後リトライの設定で導入。外部 API 障害時にも自システムは健全を維持し、復旧後 30 秒以内に自動復帰。',
    conclusion: '外部依存先は必ず Circuit Breaker で守り、自システムの健全性を境界として保つ。',
    recommendation: 'Hystrix / resilience4j / opossum などの確立されたライブラリを使う。自前実装は罠が多い。',
    reusability: 'medium',
    techTags: ['circuit_breaker', 'resilience', 'microservices'],
    processTags: ['design', 'reliability'],
    businessDomainTags: [],
  },
  {
    title: 'タイムゾーンは UTC で保存し、表示時に変換する',
    knowledgeType: 'best_practice',
    background: 'DB に JST のローカル時刻を保存していたら、サマータイム導入国のユーザに表示時刻がずれた。',
    content: 'タイムゾーン変換のバグは「保存時に変換」「表示時に変換」のいずれかが抜けると発生する。**全 DB タイムスタンプを UTC で保存** し、**表示時にユーザの TZ で変換** する一方通行ルールにすれば、変換漏れがあっても DB は常に正しい状態を保てる。',
    result: '既存データを UTC に変換するマイグレーションを実施。新規コードは Date 型ではなく ISO 8601 文字列を扱う統一を実施。サマータイム関連の不具合がゼロに。',
    conclusion: 'DB は UTC、表示は TZ 変換の一方通行。Date 型 (タイムゾーン付き timestamp) を使用。',
    recommendation: 'PostgreSQL の `timestamptz` 型を使用 (`timestamp without time zone` ではない)。フロント側は Intl.DateTimeFormat で表示変換。',
    reusability: 'medium',
    techTags: ['timezone', 'database', 'i18n'],
    processTags: ['design', 'data_modeling'],
    businessDomainTags: [],
  },
  {
    title: '冪等性のないバッチジョブが二重実行される',
    knowledgeType: 'lesson',
    background: 'Cron で起動するバッチジョブが、何らかの理由で重複起動し、課金処理が 2 重に走った。',
    content: 'Cron / 外部 cron (cron-job.org) / Gitホスティング Actions スケジュールいずれも、システム障害・ネットワーク再送によって稀に重複起動する。バッチジョブ自体に冪等性が無いと、データ破損につながる。',
    result: 'バッチ起動時に DB の advisory lock を取得し、二重起動時は後発をスキップする実装に変更。重複起動事故が再発ゼロに。',
    conclusion: 'バッチジョブは必ず排他制御 (advisory lock / 分散ロック) を仕込む。',
    recommendation: 'PostgreSQL なら `pg_try_advisory_lock(hashtext(\'job-name\'))` で軽量な排他を実現。Redis なら SETNX で同様。',
    reusability: 'medium',
    techTags: ['batch', 'cron', 'database', 'lock'],
    processTags: ['reliability', 'design'],
    businessDomainTags: [],
  },
  {
    title: 'マイグレーションは前方互換 → デプロイ → 後方互換削除の 3 段階で',
    knowledgeType: 'best_practice',
    background: 'カラムを「リネーム」する migration を本番に流したら、旧コードが動いていたインスタンスが壊れた。',
    content: 'ローリングデプロイ中は旧コードと新コードが同時に動く期間がある。schema 変更とコード変更を同 PR に詰めると、デプロイ中に必ず壊れる。**前方互換 (新旧両方が動く) → デプロイ → 後方互換削除** の 3 段階で進める。',
    result: 'カラムリネーム例: (1) 新カラム追加 (旧と新の両方を埋める) → (2) コードを新カラム読込に切替 → (3) 旧カラム削除。各段階を別 PR で本番反映し、ダウンタイムゼロを達成。',
    conclusion: 'schema の破壊的変更は単一 PR で行わず、3 PR に分割して各回の互換性を維持する。',
    recommendation: 'カラム削除・型変更・テーブル分割等、互換性を壊す変更は必ず 3 段階。コード変更だけのデプロイは 1 PR で OK。',
    reusability: 'medium',
    techTags: ['database', 'migration', 'deployment'],
    processTags: ['deployment', 'design'],
    businessDomainTags: [],
  },
  {
    title: 'API は徐々に厳しくする (寛容に受け取り、厳格に返す)',
    knowledgeType: 'best_practice',
    background: '既存 API のバリデーションを後から強化したら、運用中のクライアントが多数壊れた。',
    content: '「Postel の法則」: 寛容に受け取り、厳格に返す。API 開発の初期は緩く、運用とともに **少しずつ厳しくする方向** にしか変えない。緩和は安全だが厳格化はクライアント壊れる。',
    result: '新規バリデーションは v2 として並行運用に切り替え、v1 は警告 → 半年後に廃止する Deprecation スケジュールを設定。',
    conclusion: 'API の互換性ルール: 緩和 OK、厳格化は新バージョンで。',
    recommendation: 'API バージョニング (URL or header) を最初から導入し、廃止予告 (Deprecation header + 移行期間 6 ヶ月) を制度化。',
    reusability: 'medium',
    techTags: ['api_design', 'versioning', 'deprecation'],
    processTags: ['design', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'ログは構造化し、検索可能にする (JSON 形式)',
    knowledgeType: 'best_practice',
    background: '本番障害時、テキストログを grep するのに 30 分かかり、対応が遅れた。',
    content: '非構造化テキストログ (`[INFO] User 12345 logged in from 1.2.3.4`) は人間が読みやすいが、機械的検索・集計に向かない。JSON 構造化ログ (`{"level": "info", "user_id": 12345, "ip": "1.2.3.4", "event": "login"}`) なら、ログ集約サービス (監視SaaS, エラー監視SaaS, クラウド監視) で「user_id=12345 のログだけ」「event=login の件数推移」が即座に出る。',
    result: '構造化ログに切替え後、本番障害の調査時間が 30 分 → 3 分に短縮。',
    conclusion: 'ログは最初から構造化する。文字列連結ではなくフィールド付きで出力。',
    recommendation: 'pino / winston / Python の structlog 等の構造化ロギングライブラリを使用。`request_id` を全エンドポイントで通し、関連ログを横串検索できるようにする。',
    reusability: 'high',
    techTags: ['logging', 'observability'],
    processTags: ['operations', 'design'],
    businessDomainTags: [],
  },
  {
    title: '機密情報は環境変数 + secret manager で、コードに書かない',
    knowledgeType: 'lesson',
    background: 'Gitホスティングに パブリッククラウドの access key を誤コミットし、数時間で攻撃者に悪用された (数十万円の損害)。',
    content: '誤コミットは git revert しても **Gitホスティングの reflog や fork に残る**。漏洩した時点でキーは即座にローテーション必須。一次対策はコミット禁止 (.gitignore + pre-commit hook)、二次対策は環境変数経由、三次対策は secret manager (パブリッククラウド Secrets Manager / ホスティングサービス env) からの動的取得。',
    result: 'pre-commit hook (gitleaks) で クラウドアクセスキー 形式を検知して block する仕組みを導入。さらに既存コードを全件監査して secret manager に移行。',
    conclusion: 'シークレットは複数層で防御。誤コミット時の即時ローテーション手順 (Runbook) を整備しておく。',
    recommendation: 'gitleaks / TruffleHog でリポジトリスキャン。Gitホスティングの Secret scanning も有効化。万一漏洩したら 1 時間以内のキーローテーションを SLO に。',
    reusability: 'high',
    techTags: ['security', 'secret_management', 'devops'],
    processTags: ['security', 'incident_response'],
    businessDomainTags: [],
  },

  // ---------- リスク管理 ----------
  {
    title: 'ベンダーロックイン — 単一クラウド依存のリスク',
    knowledgeType: 'best_practice',
    background: '特定クラウドのマネージドサービスを多用したら、別クラウドへの移行コストが極大化した。',
    content: 'マネージドサービス (Cloud Run / サーバレス関数 / Cosmos DB 等) は便利だが、独自仕様で書かれたコードは他クラウドへ持ち運べない。単一クラウド依存はクラウド側の値上げ・ポリシー変更に逆らえない構造リスクを生む。',
    result: '抽象化レイヤー (Repository / Cache インターフェース) を挟む方針に変更。コア業務ロジックは抽象化越しに依存し、クラウド固有部分は薄い実装層に閉じ込めた。移行コストが見積もり 6 ヶ月 → 1 ヶ月に短縮 (試算)。',
    conclusion: 'クラウド固有 API は薄い実装層に閉じ込め、業務ロジックは標準 SQL / 標準プロトコルに依存させる。',
    recommendation: '初期から Postgres-compatible (マネージドRDB / Cloud SQL / Supabase 等で動く) 構成を選定し、独自データベースを避ける。',
    reusability: 'high',
    techTags: ['architecture', 'cloud', 'aws', 'gcp', 'azure'],
    processTags: ['risk_management', 'architecture'],
    businessDomainTags: [],
  },
  {
    title: 'キーパーソン依存 — Bus Factor 1 のリスク',
    knowledgeType: 'lesson',
    background: '中核機能を 1 人のエンジニアだけが理解しており、その人の退職で 3 ヶ月開発停止した。',
    content: '「Bus Factor」(その人がバスに轢かれたらプロジェクトが止まる人数) が 1 のシステムは、退職・休職・体調不良で即座に運用停止する構造リスクを抱える。',
    result: '中核機能ごとに「主担当 + 副担当」の 2 人体制を必須化。コードレビュー必須・ペアプログラミング週次・設計書の更新を義務化。Bus Factor が 1 → 3 に向上。',
    conclusion: '機能ごとに最低 2 人が理解している状態を運用ルールとして強制する。',
    recommendation: '退職・異動時に「引き継ぎ完了の Definition of Done」を明文化 (例: 副担当が単独で 1 機能変更 + デプロイを完遂)。',
    reusability: 'high',
    techTags: [],
    processTags: ['risk_management', 'organization', 'documentation'],
    businessDomainTags: [],
  },
  {
    title: '本番デプロイ直前の金曜午後を避ける',
    knowledgeType: 'lesson',
    background: '金曜午後に本番デプロイしたところ障害が発生し、夜間〜週末対応で消耗した。',
    content: 'デプロイ直後の障害は対応コストが最大化する時間帯がある: **金曜午後・連休前** は監視メンバーの稼働が落ち、復旧チームの召集も遅れる。',
    result: '「火〜木の午前中のみデプロイ」をルール化。緊急 hotfix を除き徹底。週末対応稼働がゼロに。',
    conclusion: 'デプロイは「事故が起きても対応できる時間帯」に限定する。',
    recommendation: 'デプロイ可能時間帯をスケジュール (例: Tue/Wed/Thu の 10:00-15:00) で明文化。CI でも該当時間外の本番デプロイを警告。',
    reusability: 'high',
    techTags: ['deployment', 'devops'],
    processTags: ['operations', 'risk_management'],
    businessDomainTags: [],
  },
  {
    title: 'バックアップは取得しただけでは無価値、復元テストで価値が確定する',
    knowledgeType: 'lesson',
    background: '災害対策で日次バックアップを取っていたが、復元手順を試したら失敗してバックアップ自体が破損していた。',
    content: 'バックアップ運用は「取得」「保管」「復元」の 3 段階が揃って初めて機能する。多くの組織は取得・保管しか検証せず、復元時に初めて壊れていることが発覚する (Schrodinger\'s Backup)。',
    result: '月次で本番バックアップから別環境への復元演習 (3 時間以内) を実施。3 ヶ月目に圧縮形式の不整合を発見し、修正。',
    conclusion: 'バックアップは「復元できると確認できた時点」で初めて価値を持つ。月次以上の頻度で復元演習を実施。',
    recommendation: '復元演習は「目隠しテスト」(=本番チーム以外が手順書だけで復元できるか) で実施。手順書の盲点が見つかる。',
    reusability: 'high',
    techTags: ['backup', 'disaster_recovery'],
    processTags: ['operations', 'risk_management'],
    businessDomainTags: [],
  },
  {
    title: '個人情報の取り扱い: 取得・保存・削除の 3 段階で同意を整理する',
    knowledgeType: 'best_practice',
    background: 'GDPR / 個人情報保護法対応で、ユーザの「忘れられる権利」要求に応えられず処理が滞った。',
    content: '個人情報は「何を取るか (取得時の同意)」「どこに保存するか (保管期間)」「いつ消すか (削除トリガー)」の 3 段階で設計する。同意なしの保存・削除手段の不在が法的リスクを生む。',
    result: 'プライバシーポリシーに「保管期間」「削除リクエスト時の対応 SLA (30 日)」を明記。論理削除 + 30 日後物理削除のジョブを実装。',
    conclusion: '個人情報はライフサイクル設計が必須。取得 → 保存 → 削除のフローを明文化。',
    recommendation: 'GDPR / CCPA / 改正個人情報保護法に対応。法務部門との早期連携・運用フローの文書化。',
    reusability: 'high',
    techTags: ['privacy', 'compliance', 'security'],
    processTags: ['compliance', 'design'],
    businessDomainTags: [],
  },

  // ---------- プロセス・組織 ----------
  {
    title: 'コードレビューはマージ前ではなく PR 作成と同時に依頼する',
    knowledgeType: 'best_practice',
    background: 'PR が放置されてマージ待ちが累積し、リリースが遅れる事象が続いた。',
    content: 'PR を作成したら **すぐに** レビュー依頼を出す (ビジネスチャット 通知 / Gitホスティング 自動レビュアー設定)。「自分でもう 1 回見てから依頼」と先送りすると、レビュアーの稼働もずれて 2-3 日空くことが多い。',
    result: 'PR 作成 → 自動的に ビジネスチャットへレビュー依頼通知する Bot を導入。平均レビュー所要時間が 24 時間 → 4 時間に短縮。',
    conclusion: 'レビュー依頼は「自信がついてから」ではなく「動く状態になったら」即座に出す。',
    recommendation: 'Gitホスティング Actions + ビジネスチャット Webhook で「PR opened → 即通知」を自動化。レビュアーアサインも CODEOWNERS で自動化。',
    reusability: 'high',
    techTags: ['github', 'code_review', 'slack'],
    processTags: ['code_review', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: '振り返り (KPT) は「Try」を 1 つに絞ると実行率が上がる',
    knowledgeType: 'best_practice',
    background: '振り返りで Try が 5-10 個出るが、次の振り返りまでにほとんど実行されていなかった。',
    content: '人間の継続的な変化キャパシティは限定的。Try を 5 個出すと「全部覚えていない」「優先順位が分からない」で結局 0 個実行になる。**最重要の Try を 1 つだけ** に絞り、次の振り返りまでに必ず実施することを約束する方が実行率が高い。',
    result: '「次までの Try は 1 つだけ」ルールに変更。3 ヶ月で 12 個の Try を実施 (旧運用では 30+ 個立てて 5 個実施程度)。',
    conclusion: '振り返りの Try は数より実行率を重視。1 つに絞ることで「次までに本当にやる」コミットメントが生まれる。',
    recommendation: 'KPT に加えて「次までの Try (1 つ)」と「Try 担当者」を明記。次回振り返り冒頭で実施結果を確認するルーチンを作る。',
    reusability: 'high',
    techTags: [],
    processTags: ['retrospective', 'agile', 'team_practice'],
    businessDomainTags: [],
  },
  {
    title: 'デイリースタンドアップは 15 分厳守 + 立ったまま',
    knowledgeType: 'best_practice',
    background: 'スタンドアップが議論で 30-45 分に延び、メンバーの集中時間が削られた。',
    content: 'スタンドアップの目的は「進捗確認」「障害共有」のみで、議論はパーキングロット (別ミーティング) に分離する。15 分の物理タイマー + 立ったまま (椅子に座らない) で時間制約を体感的に強制。',
    result: 'タイマー導入 + 立ち姿勢ルール徹底後、スタンドアップ平均 12 分に収束。議論は「同期会」(別枠 30 分) で行う方針に分離。',
    conclusion: 'スタンドアップは進捗報告に徹する。議論はパーキングロット送り、別途同期会を設定。',
    recommendation: '物理タイマー (キッチンタイマー) を会議室に置く。Zoom の場合は画面共有でカウントダウンタイマーを表示。',
    reusability: 'medium',
    techTags: [],
    processTags: ['agile', 'team_practice', 'meeting'],
    businessDomainTags: [],
  },
  {
    title: 'インシデント対応は「対処 → 原因究明 → 再発防止」の 3 段で',
    knowledgeType: 'best_practice',
    background: '本番障害発生時、原因究明と対処が混ざり混乱した。',
    content: 'インシデント対応は時間軸で 3 段階に分ける: **(1) 即時対処 (=ユーザ影響を止める)** → **(2) 原因究明 (落ち着いてから)** → **(3) 再発防止 (Postmortem 後の改善実装)**。混ぜると「原因が分からないまま jen 直し続ける」or「対処が遅れて被害拡大」になる。',
    result: 'Incident Commander を専任化し、対処指揮 + 原因調査担当を分離。MTTR (平均復旧時間) が 90 分 → 30 分に短縮。',
    conclusion: '本番障害時は役割を「指揮 / 復旧 / 調査 / 連絡」に分ける。',
    recommendation: 'PagerDuty / Opsgenie 等のインシデント管理ツールで Incident Commander 役割を明示化。Postmortem テンプレートを用意。',
    reusability: 'high',
    techTags: ['incident_management', 'sre'],
    processTags: ['incident_response', 'operations'],
    businessDomainTags: [],
  },

  // ---------- 業務ドメイン (汎用的なもの) ----------
  {
    title: '注文と決済の整合性 — 二相コミットの代わりに saga パターン',
    knowledgeType: 'best_practice',
    background: 'EC サイトで「在庫確保 → 決済」の途中で決済失敗時、在庫が解放されず売り逃しが発生した。',
    content: '複数システムにまたがる業務処理 (在庫 + 決済 + 出荷) で 2PC (二相コミット) は可用性を犠牲にする。代わりに **Saga パターン** (= 各ステップに補償処理を用意し、失敗時は逆方向に巻き戻す) を採用する。',
    result: '注文確定時の Saga を実装: 在庫確保 → 決済 → 出荷予約。決済失敗時は在庫解放 (補償)。失敗事故の再発がゼロに。',
    conclusion: '分散システムの整合性は Saga + 結果整合性で担保する。完全な ACID は捨てる。',
    recommendation: 'Saga ステップは可視化 (workflow tool: Temporal / Step Functions) し、補償ロジックを明示的にコード化する。',
    reusability: 'medium',
    techTags: ['saga', 'distributed_systems', 'transaction'],
    processTags: ['design', 'architecture'],
    businessDomainTags: ['ecommerce', 'payment'],
  },
  {
    title: '在庫管理 — 楽観ロックで二重売りを防ぐ',
    knowledgeType: 'best_practice',
    background: 'EC サイトで残り 1 個の商品を 2 人が同時に購入し、二重売りになった。',
    content: '在庫操作は典型的な競合状態 (race condition)。読込 → 計算 → 書込の間に他のリクエストが介入すると整合性が崩れる。楽観ロック (version 列の比較) または DB トランザクションの SELECT FOR UPDATE で排他制御する。',
    result: 'product テーブルに version 列を追加。UPDATE 時に WHERE version=? で楽観ロック。二重売りがゼロに。',
    conclusion: '在庫・座席・予約など「個数」を扱うエンティティは楽観ロックで保護する。',
    recommendation: 'Prisma なら `@@unique` で並行性を担保。または明示的な version 列で楽観ロック。書込量が多いなら Redis の atomic counter も検討。',
    reusability: 'medium',
    techTags: ['database', 'optimistic_lock', 'concurrency'],
    processTags: ['design', 'data_modeling'],
    businessDomainTags: ['ecommerce', 'inventory'],
  },
  {
    title: '請求書発行は冪等に + 改ざん不可ログ',
    knowledgeType: 'best_practice',
    background: '請求書再発行時に内容が変わり、過去の請求書との整合性が取れなくなった。',
    content: '請求書は「発行時点での確定文書」であり、後から金額・宛先を変えてはいけない。発行ごとにユニークな番号を採番し、内容のハッシュを取り、改ざん不可なログ (append-only) に記録する。',
    result: 'invoice テーブルを WORM (Write Once, Read Many) 設計に変更。過去の請求書は editable=false。再発行時は新規 invoice として「N号の訂正版」と明示。',
    conclusion: '請求書・領収書・契約書は履歴改ざん不可で保管。修正は「追加発行」として履歴を残す。',
    recommendation: '電子帳簿保存法対応も視野に: タイムスタンプ + ハッシュチェーンで改ざん検知。',
    reusability: 'medium',
    techTags: ['immutable', 'audit_log', 'compliance'],
    processTags: ['compliance', 'design'],
    businessDomainTags: ['finance', 'invoicing'],
  },
  {
    title: 'ユーザの「論理削除」と「物理削除」の使い分け',
    knowledgeType: 'best_practice',
    background: 'ユーザ削除時に物理削除したら、関連レコード (注文履歴・コメント等) が一斉に消えてサービス運営に支障が出た。',
    content: '関連データを持つエンティティの削除は「論理削除 (deletedAt 列セット)」を基本とする。物理削除は (1) GDPR 等の法的要件 (2) 30 日以上の論理削除 + ユーザ確認後 にのみ実施。',
    result: 'soft-delete (論理削除) を全エンティティで採用。`deletedAt IS NOT NULL` を WHERE 条件で除外。物理削除は専用バッチで日次実行 (30 日経過後)。',
    conclusion: '即座の物理削除は事故の素。論理削除 → 一定期間後 → 物理削除 の 2 段階で運用する。',
    recommendation: 'Prisma の middleware で `findMany` 等に `deletedAt: null` を自動付与。物理削除は専用 admin 操作 + 監査ログ必須。',
    reusability: 'high',
    techTags: ['database', 'soft_delete', 'compliance'],
    processTags: ['design', 'data_modeling'],
    businessDomainTags: [],
  },

  // ---------- セキュリティ ----------
  {
    title: 'OWASP Top 10: SQL インジェクションは ORM 使用でも油断するな',
    knowledgeType: 'lesson',
    background: 'ORM を使っているから SQL インジェクションは起きないと思っていたが、$queryRawUnsafe で生 SQL を組んだ部分から侵入された。',
    content: 'Prisma / TypeORM 等の ORM はパラメータバインディングで SQLi を防ぐが、生 SQL を扱う API ($queryRawUnsafe / Raw ) を使うとバインディングが効かず脆弱になる。',
    result: '全コードを `$queryRaw` (タグ付きテンプレート、自動バインディング) に置換。`$queryRawUnsafe` の使用は禁止 (lint で検知)。',
    conclusion: 'ORM 使用時も生 SQL の混入経路を必ず検知・遮断する。',
    recommendation: 'pre-commit hook で `\\$queryRawUnsafe|\\$executeRawUnsafe` を grep して block。lint ルールで自動検知。',
    reusability: 'high',
    techTags: ['security', 'sql_injection', 'orm', 'prisma'],
    processTags: ['security', 'code_review'],
    businessDomainTags: [],
  },
  {
    title: 'API rate limit はユーザ単位 + IP 単位の二段で',
    knowledgeType: 'best_practice',
    background: '攻撃者が複数 IP から低頻度でログイン試行 (credential stuffing) を行い、IP ベースのレート制限をすり抜けた。',
    content: 'rate limit は単一の指標では迂回されやすい。**ユーザ ID 単位** (=同一アカウントへの試行を制限) と **IP 単位** (=同一発信元の試行を制限) の両方を併用する。',
    result: 'IP 単位 + ユーザ単位 + 失敗カウント (= 一時ロック) の 3 段防御を実装。credential stuffing 検知率 95%。',
    conclusion: 'rate limit は単一軸では弱い。複数軸で防御を重ねる。',
    recommendation: '認証エンドポイントは特に厳格に。IP / User / Device fingerprint の 3 軸監視を推奨。',
    reusability: 'high',
    techTags: ['security', 'rate_limit', 'authentication'],
    processTags: ['security', 'design'],
    businessDomainTags: [],
  },

  // ================================================================
  // PR-X5 (5-5 拡張): プロジェクト運営・要件定義・テスト等の汎用ナレッジ (新規追加)
  // ================================================================
  {
    title: '要件定義の合意形成 — ステークホルダ認識違いを早期検出する',
    knowledgeType: 'best_practice',
    background:
      '要件定義フェーズで「合意した」と思っていたものが、実装段階で「そんな認識ではなかった」と覆る事態が複数プロジェクトで連続発生。仕様変更コストが見積の 30-50% 超過するケースもあり、要件確定の品質向上が必須となった。',
    content:
      'ステークホルダ間の認識違いは、抽象的な言葉 (「使いやすく」「効率的に」「将来拡張可能に」等) で合意した時点で潜在化する。具体化のための 3 つの仕掛けを併用する: (1) 画面モック / プロトタイプを早期に作成して視覚的に共有、(2) 受入条件を機能ごとに「○○ができる、△△の場合は××する」形で明文化、(3) ステークホルダ各人に「この要件で何が解決される / 何が解決されない」を口頭で説明してもらう (理解度確認)。3 番目が最も効果的だが時間を要する。',
    result:
      '画面モックとプロトタイプを早期作成 + 受入条件文書化 + ステークホルダ口頭確認 の 3 点セットを導入後、4 プロジェクトで仕様変更コストが平均 35% → 8% に低減。',
    conclusion:
      '要件定義の合意は「言葉での合意」では不十分。視覚化 + 文書化 + 口頭確認の 3 段階で具体化する。',
    recommendation:
      '受入条件は「Given-When-Then」形式で書き、テスト工程の入力にもなるよう設計する。プロトタイプは Figma / ローコード基盤 等で 1 週間以内に作成可能なツールを選ぶ。',
    reusability: 'high',
    techTags: ['figma', 'prototyping'],
    processTags: ['requirements', 'project_management', 'stakeholder_management'],
    businessDomainTags: [],
  },
  {
    title: 'プロジェクトキックオフの設計 — 期待値・成功基準・リスクを明示する',
    knowledgeType: 'best_practice',
    background:
      'キックオフ会議を「メンバ紹介と概要説明」だけで済ませるプロジェクトが多く、3 ヶ月後に「期待していたものと違う」「成功基準が共有されていなかった」との認識相違が発覚するケースが続発。',
    content:
      'キックオフは「全員の認識合わせ」の最重要マイルストーン。以下 5 点を必ず明示する: (1) このプロジェクトが解決する事業課題、(2) 成功基準 (定量 KPI と定性的な状態目標)、(3) スコープ境界 (やる/やらないの明示)、(4) 主要リスクとその扱い、(5) 意思決定者と意思決定プロセス。資料を事前配布し、当日は質疑応答中心の構成にする。',
    result:
      'キックオフ設計を改善した 5 プロジェクトで、3 ヶ月時点での認識相違による手戻りがほぼゼロに低減。プロジェクトメンバの主体性も向上し、課題が早期に挙げられるようになった。',
    conclusion:
      'キックオフは「人を集めて挨拶する場」ではなく、「全員の前提認識を揃える場」と位置付ける。',
    recommendation:
      'キックオフ後 1 週間以内に、参加者に「キックオフ内容の理解度アンケート」を実施し、認識ずれを早期検出する。',
    reusability: 'high',
    techTags: [],
    processTags: ['project_management', 'kickoff', 'stakeholder_management'],
    businessDomainTags: [],
  },
  {
    title: '開発手法の選定 — Waterfall / Agile / DevOps の使い分け',
    knowledgeType: 'best_practice',
    background:
      '「Agile 流行だから Agile」「過去の経験で Waterfall」と判断するプロジェクトが多く、プロジェクトの性質に合わない手法選定で混乱・遅延が発生する事例が多発。',
    content:
      '開発手法の選定は「要件確定度」「変化の頻度」「組織の成熟度」の 3 軸で判断する: (1) 要件が確定し変更が稀なら Waterfall (例: 規制対応・基幹システム刷新)、(2) 要件が探索的で変更頻度が高ければ Agile (例: 新規 SaaS / B2C アプリ / 業務改善)、(3) リリース頻度を最大化したく組織が成熟していれば DevOps (例: 既に Agile 運用が定着したチーム)。「Agile = 自由」「Waterfall = 厳格」は誤解で、Agile も明確な作業ルール (sprint / retrospective / definition of done) を要求する。',
    result:
      '3 軸での手法選定マトリクスを導入後、プロジェクト方式に対する不満が大幅に低減。Agile 採用判断が「要件不明確」のみで決まらず、「組織の成熟度」もチェックされるようになり、未熟チームでの Agile 失敗事例がゼロに。',
    conclusion:
      '開発手法は「流行」ではなく「プロジェクトの性質」で選定する。Agile / Waterfall / DevOps の中庸 (ハイブリッド) も有効。',
    recommendation:
      '組織の成熟度が低い場合、まず Waterfall 寄りで進めつつ、retrospective + sprint review だけ Agile から取り入れる「ハイブリッド」が現実的。',
    reusability: 'high',
    techTags: [],
    processTags: ['project_management', 'methodology', 'agile', 'waterfall', 'devops'],
    businessDomainTags: [],
  },
  {
    title: 'ベンダー選定の評価軸 — 5 観点の総合評価',
    knowledgeType: 'best_practice',
    background:
      'ベンダー選定で「価格の安さ」のみで決定し、後から品質・サポート不足が発覚するケースが頻発。逆に「ブランド」のみで選定し過大投資になるケースもあり、評価の標準化が求められた。',
    content:
      'ベンダー選定は 5 観点で総合評価する: (1) 技術力 (該当領域の専門性 / 過去事例)、(2) コスト (初期 + 運用 + 拡張時の総コスト)、(3) サポート品質 (応答時間 / 営業時間 / 担当者継続性)、(4) 組織安定性 (財務状況 / 役員交代頻度 / 主要取引先)、(5) 文化的相性 (コミュニケーション速度・意思決定プロセスの相性)。各 10 点満点で評価し、合計 / 重み付け合計の双方を比較する。価格のみの評価は厳禁。',
    result:
      '5 観点評価を 8 プロジェクトで採用し、ベンダー選定後の重大トラブル (品質・サポート問題) がほぼゼロに。コスト超過事例も大幅減少。',
    conclusion:
      'ベンダー選定は単一軸 (価格・ブランド) ではなく多軸評価で行う。文化的相性の評価軸を入れることが特に重要。',
    recommendation:
      '評価表を提案依頼時 (RFP) にベンダー側にも開示し、「何で評価されるか」を理解した上で提案させる。透明性が選定品質を上げる。',
    reusability: 'high',
    techTags: [],
    processTags: ['vendor_management', 'procurement', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'データ移行の 6 ステップフレームワーク',
    knowledgeType: 'best_practice',
    background:
      'データ移行を「データを移すだけ」と楽観視し、実際に始めると重複・欠損・整合性問題が発覚して大幅遅延するケースが続発。標準フレームワークが必要となった。',
    content:
      'データ移行は以下 6 ステップで進める: (1) 元データの実態調査 (件数 / 重複率 / 欠損率 / 文字コード)、(2) 目標スキーマと元スキーマのマッピング設計、(3) 正規化 / クレンジングルールの策定 (表記揺れ統一・重複判定基準)、(4) 移行スクリプトの実装と単体テスト、(5) 本番相当のデータ量での性能テスト (本番切替時間の実測)、(6) ダウンタイム最小化のための段階移行 / 並行運用設計。Step 1 と 5 を省略するプロジェクトが多いが、これが事故源。',
    result:
      '6 ステップを導入した 7 プロジェクトで、移行関連の重大事故 (データ消失・重複登録・本番切替時間超過) がほぼゼロに。事前の実態調査でリスクを早期検出できる体制が確立。',
    conclusion:
      'データ移行は「移行スクリプト実装」だけでは不十分。事前調査 + 性能テスト + 段階移行の 6 ステップ全てを計画に含める。',
    recommendation:
      '本番切替時間は計画値の 1.5-2 倍を見込む。ERP / 商用データベース 等の大規模 ERPでは 1 ヶ月の Mock-Run を 2-3 回実施する。',
    reusability: 'high',
    techTags: ['data_migration', 'etl'],
    processTags: ['migration', 'data_management', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'UAT (ユーザ受入テスト) の運営 — シナリオベースで合意形成',
    knowledgeType: 'best_practice',
    background:
      'UAT で「OK」と承認したものの、本番運用後に「実は使えない」「業務が回らない」との不満が出るケースが多発。UAT が形骸化していた。',
    content:
      'UAT は「画面操作のテスト」ではなく「業務シナリオの実行確認」と位置付ける。具体的には: (1) ユーザの 1 日 / 1 週間 / 1 ヶ月の業務フローをシナリオ化、(2) シナリオごとに「実行可能か」「想定時間内か」「他業務への影響は」を確認、(3) UAT 期間中はユーザ自身の通常業務でシステムを実際に使ってもらう (Shadow Production)、(4) 検出された問題は「Show Stopper / Major / Minor」で分類し、Show Stopper はリリース判定で必ず解消する。',
    result:
      'シナリオベース UAT を 5 プロジェクトで導入後、本番リリース後の重大不満がほぼ解消。UAT で発見できなかった問題は Minor レベルのみとなり、運用での影響を最小化できた。',
    conclusion:
      'UAT の品質は「シナリオの網羅性」で決まる。業務の現実を反映したシナリオを協働で作成する。',
    recommendation:
      'UAT シナリオはユーザ + 業務担当者 + 開発者の 3 者で作成する。1 人で作成すると視点が偏る。',
    reusability: 'high',
    techTags: [],
    processTags: ['testing', 'uat', 'requirements', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'パフォーマンステストの計画 — 負荷・耐久・スパイクの 3 種',
    knowledgeType: 'best_practice',
    background:
      'リリース直後の本番障害 (応答遅延・タイムアウト・サービス停止) が頻発し、原因の多くが「想定外の負荷」だった。テスト段階で見つけられなかった事象が本番で表面化していた。',
    content:
      'パフォーマンステストは 3 種類を必ず実施する: (1) 負荷テスト (想定ピーク負荷で SLO を達成するか)、(2) 耐久テスト (想定平均負荷で 24-72 時間連続稼働してメモリリーク等が発生しないか)、(3) スパイクテスト (短時間で想定の 2-3 倍の負荷が来た時に縮退動作するか)。テストデータは本番相当の量・分布を使用 (テストデータ 100 件で 100 万件想定の本番をテストするのは無意味)。テスト結果は SLO に対する目標値と実測値で記録し、リリース判定の input にする。',
    result:
      '3 種パフォーマンステストを必須化した 6 プロジェクトで、リリース直後の性能関連障害がほぼゼロに。メモリリークも事前検出され、修正してからリリースできる体制が確立。',
    conclusion:
      'パフォーマンステストは「負荷テスト」だけでは不十分。負荷 / 耐久 / スパイクの 3 種を組み合わせて初めて本番運用に耐える信頼性が得られる。',
    recommendation:
      'k6 / JMeter / Gatling 等の OSS ツールで CI に組み込む。本番のメトリクス (応答時間 P95 / エラー率 / リソース使用率) を監視ダッシュボードで継続観測。',
    reusability: 'high',
    techTags: ['performance', 'testing', 'k6', 'jmeter', 'gatling'],
    processTags: ['testing', 'performance_testing', 'reliability'],
    businessDomainTags: [],
  },
  {
    title: '教育プログラムの設計 — 実践 60% + 座学 40% のハイブリッド',
    knowledgeType: 'best_practice',
    background:
      'システム導入時の教育を「画面操作の説明」だけで済ませるプロジェクトが多く、本番運用後に「結局使えない」「忘れた」との苦情が頻発。教育の本質的な失敗が原因。',
    content:
      '教育は「座学 60% + 実践 40%」が一般的だが、業務システム導入時は「実践 60% + 座学 40%」に逆転させる。具体的には: (1) 自分の業務シナリオを想定した実機操作を繰り返す、(2) 座学は「なぜこのシステムを使うのか」「何を達成するのか」の動機付けに集中、(3) 教育後 1 週間後 / 1 ヶ月後にフォローアップを実施 (理解度確認 + 質問対応)、(4) リーダー層教育を一般教育の 2 週間前倒し。リーダーが先に習熟することで、現場教育時にリーダーが補助できる体制を作る。',
    result:
      '実践 60% + 座学 40% のハイブリッド教育を 6 プロジェクトで実施後、本番運用 1 ヶ月時点の利用率が平均 60% → 90% に向上。リーダー層先行教育の効果も大きく、現場混乱が大幅減少。',
    conclusion:
      '業務システム教育は「実機操作中心 + 動機付けの座学」のハイブリッドが最適。教育順序は「リーダー → 一般」が鉄則。',
    recommendation:
      '教育内容は「業務シナリオ」を軸にカスタマイズする。一律の汎用教材は効果が薄い。フォローアップを必ず計画に含める。',
    reusability: 'high',
    techTags: [],
    processTags: ['training', 'change_management', 'organization'],
    businessDomainTags: [],
  },
  {
    title: 'ドキュメント整備の優先順位 — 運用・障害対応・引継ぎの 3 観点',
    knowledgeType: 'best_practice',
    background:
      'リリース後にドキュメントを書こうとして「結局書かれない」「書かれても使われない」状態に陥るケースが多発。ドキュメントの優先順位と作成タイミングが曖昧だった。',
    content:
      'ドキュメントは「誰が、いつ、何のために使うか」で優先順位を決める。最優先は次の 3 種: (1) 運用手順書 (日次 / 月次 / 障害時の操作手順)、(2) 障害対応 Runbook (典型障害シナリオへの対処手順)、(3) 引継ぎ資料 (設計判断の経緯・トレードオフ・将来の拡張余地)。これらはリリース前 (= 開発者の記憶が新鮮なうち) に書く。設計書・実装書は二次優先で、コードコメント + ADR (Architecture Decision Record) で代替可能な部分は省略する。',
    result:
      '優先順位を明確化した 4 プロジェクトで、運用フェーズの障害対応時間が大幅短縮 (平均 90 分 → 30 分)。引継ぎ時のキャッチアップ時間も短縮 (平均 1 ヶ月 → 1 週間)。',
    conclusion:
      'ドキュメントは「すべてを完璧に」ではなく「優先順位に従って必要な分だけ」整備する。Runbook + ADR は最優先。',
    recommendation:
      'Runbook は障害シナリオごとに 1 ページで完結する形式 (検知 / 影響範囲 / 対処手順 / エスカレーション先)。ADR は意思決定ごとに 1 文書で残す。',
    reusability: 'high',
    techTags: ['documentation', 'runbook', 'adr'],
    processTags: ['documentation', 'operations', 'project_management'],
    businessDomainTags: [],
  },
  {
    title: 'ベンダーロックイン回避の段階的アプローチ',
    knowledgeType: 'best_practice',
    background:
      'クラウド固有 API・パッケージ固有機能を多用した結果、別環境への移行コストが極大化するケースが多発。「最初から汎用設計」は工数高すぎて現実的ではない。',
    content:
      'ベンダーロックイン回避は「全か無か」ではなく「段階的アプローチ」で進める: (1) コア業務ロジックは標準技術 (標準 SQL / REST API / OSS フレームワーク) に依存、(2) クラウド固有部分は薄い実装層に閉じ込める (Repository パターン / Adapter パターン)、(3) パッケージ固有機能はカスタムを最小化し、標準機能で代替できる部分は標準利用、(4) 移行コスト試算を年次で更新し、依存度を可視化する。完全な汎用化は不要だが、「移行コスト試算が分かる状態」を保つことが重要。',
    result:
      '段階的アプローチを採用した 5 プロジェクトで、5 年後の移行コスト試算が平均 「全面再開発レベル」 → 「数ヶ月の移行プロジェクト」 に圧縮。クラウド料金交渉でも「移行可能」をカードとして使えるようになった。',
    conclusion:
      'ベンダーロックインは構造的に発生する。段階的アプローチで「依存はあるが移行可能」な状態を維持する。',
    recommendation:
      '初期から Postgres-compatible (マネージドRDB / Cloud SQL / Supabase 等で動く) 構成を選定。独自データベース (マネージドNoSQL / Cosmos DB 等) は「ロックイン承知の上で採用」を意識する。',
    reusability: 'high',
    techTags: ['architecture', 'cloud', 'aws', 'gcp', 'azure', 'vendor_neutral'],
    processTags: ['architecture', 'risk_management', 'project_management'],
    businessDomainTags: [],
  },

  // ================================================================
  // PR-X5 (5-5 拡張): 業務ドメイン特化ナレッジ (経理・人事・営業・マーケ・物流・医療・教育・顧客対応 等)
  // ================================================================
  {
    title: '月次クローズ業務の早期化 — 5 営業日 → 3 営業日への短縮アプローチ',
    knowledgeType: 'best_practice',
    background:
      '経理部の月次決算が 5-7 営業日かかっており、経営判断が遅延。経営層からの早期化要求が複数年継続していた。',
    content:
      '月次クローズ早期化の鍵は「並行処理」と「事前処理」の 2 軸。具体的には: (1) 月末待ちでない処理 (請求書発行・経費承認・在庫棚卸の準備) を月中に分散実行、(2) 月末締日のシステム処理 (会計仕訳・連結処理) を並行実行可能な構造に再設計、(3) 担当者間の依存を最小化 (部門ごとの independent close)、(4) 例外処理 (特殊取引・調整仕訳) を事前ルール化して属人化排除。データ基盤としては DWH 連携で日次の予実差分も可視化し、月末まで待たず early warning ができる体制が望ましい。',
    result:
      '上記アプローチで 5 営業日 → 3 営業日に短縮した複数事例あり。経営判断の早期化と経理部の残業削減を両立。さらにデータドリブン経営の入り口にもなる。',
    conclusion:
      '月次クローズ早期化はシステム改修と業務プロセス改革の両輪。システムだけ早くしても業務手順が並行化されないと意味がない。',
    recommendation:
      '改善は段階的に: まず「並行処理可能な業務」を分析 → ボトルネック特定 → 1-2 営業日短縮を 6 ヶ月単位で実現する。一気に 5 → 3 営業日は組織が追いつかない。',
    reusability: 'high',
    techTags: ['accounting', 'erp', 'dwh'],
    processTags: ['operations', 'business_process_redesign', 'project_management'],
    businessDomainTags: ['経理', '会計', '月次決算', '業務改善'],
  },
  {
    title: 'マイナンバー収集の運用設計 — 多段階リマインドと特殊ケース対応',
    knowledgeType: 'best_practice',
    background:
      '人事システム刷新やマイナンバー法対応で、全従業員からマイナンバー収集が必要となるが、メール 1 通の依頼では返信率 50-60% 止まりで遅延の常連となる事象が発生。',
    content:
      'マイナンバー収集は (1) 多段階リマインド (初回メール → 1 週間後リマインド → 2 週間後個別電話 → 3 週間後郵送)、(2) 特殊ケース別フロー (海外赴任者は PDF 暗号化メール、休職中は人事個別フォロー)、(3) 提出方法の多様化 (オンライン Web フォーム + 郵送 + 手交)、(4) 提出状況の自動可視化 (誰が未提出か即座に分かる) の 4 点を最初から計画する。提出期限は法令要件 (社会保険手続きの締切等) から逆算し、収集期間 1.5 ヶ月以上を確保する。',
    result:
      '多段階アプローチを実施した複数組織で、最終収集率 100% を達成 (期間内 95% / 期間延長 5%)。人事部の従業員問合せ対応も標準スクリプト化で負荷軽減。',
    conclusion:
      '個人情報収集は「メール 1 通で完了」とは想定しない。多段階リマインド + 個別フォロー + 特殊ケース対応の 3 点を最初から計画する。',
    recommendation:
      '提出状況可視化は社員番号 × 提出済み/未提出のシンプルな表で十分。ビジネスチャットで人事部内に日次共有することで意識化が進む。',
    reusability: 'high',
    techTags: ['hr', 'mynumber'],
    processTags: ['operations', 'compliance', 'hr_process'],
    businessDomainTags: ['人事', '労務', 'マイナンバー', 'コンプライアンス'],
  },
  {
    title: '営業案件管理の入力習慣化 — リーダー先行 + 業務埋込み戦略',
    knowledgeType: 'lesson',
    background:
      'CRM (SFA/CRMツール / MA/CRMツール 等) を導入しても、営業現場での入力が習慣化せず 表計算ソフトに逆戻りする事例が多発。せっかく導入したシステムが形骸化していた。',
    content:
      '営業の入力習慣化には組織的アプローチが不可欠。失敗の主因は「画面操作の研修だけで動機付けが不足」と「入力項目が多すぎる」と「マネージャ層が CRM を業務に組み込んでいない」の 3 点。対策: (1) 必須項目を最小限に絞る (案件名 / 顧客 / 金額 / クローズ予定日 / フェーズの 5 項目程度)、(2) マネージャ層が CRM ベースで週次レビュー会議を実施 (= 部下の入力動機が継続)、(3) 入力データから自動でフィードバックを返す (例: 「あなたの案件は平均より早期にクローズ」等)。',
    result:
      '上記対策を実施したプロジェクトで、入力率 60% → 92% に改善。営業マネージャの集計業務時間も週 8 時間 → 1 時間に短縮し、戦略業務に集中できる体制に。',
    conclusion:
      'CRM の成否は「リーダー層の利用」と「入力項目の最小化」で決まる。リーダーが 表計算ソフト メールで指示すると部下も追従する。',
    recommendation:
      '営業 30 名以上の組織では、リーダー教育を一般教育の 2 週間前倒しで実施。利用率の月次モニタリング + 部署別フィードバックで継続改善。',
    reusability: 'high',
    techTags: ['crm', 'salesforce', 'hubspot'],
    processTags: ['change_management', 'training', 'sales_operations'],
    businessDomainTags: ['営業', 'CRM', '組織変革', '教育'],
  },
  {
    title: 'マーケティング施策の効果測定設計 — Attribution と LTV の両軸',
    knowledgeType: 'best_practice',
    background:
      'マーケ施策 (広告 / メール / SEM / コンテンツマーケ) の効果測定が「総 CV 数」のみで評価され、施策ごとの貢献度や顧客 LTV が見えていない事例が多発。',
    content:
      'マーケ施策の効果測定は 2 軸が必要: (1) Attribution (どの施策がどれだけ獲得に貢献したか) — Last-touch / Multi-touch / Data-driven の 3 種を理解した上でモデル選択。Multi-touch が現実的な妥協案、(2) LTV (Customer Lifetime Value) — 獲得時のコスト効率だけでなく、その後の継続利用・追加購買による収益も含めた評価。両軸での評価により「短期 CV は高いが LTV が低い施策」と「短期 CV は低いが LTV が高い施策」を区別でき、予算配分の精度が向上する。BI ツール (BIツール / BIツール) で両軸を統合ダッシュボード化することが標準。',
    result:
      'Attribution + LTV の両軸を導入した EC・SaaS で、マーケ予算の効率が 20-40% 改善 (=同予算で獲得数 / LTV 増加)。',
    conclusion:
      '単一指標 (CV 数 / CPA) ではマーケ施策の真価が見えない。Attribution + LTV の両軸で総合評価する。',
    recommendation:
      'Multi-touch Attribution は アクセス解析ツール 4 の標準機能 (data-driven attribution) で十分実用的。LTV 計算は BI 側で 6-12 ヶ月の継続データで実装。',
    reusability: 'medium',
    techTags: ['analytics', 'ga4', 'tableau', 'looker', 'attribution'],
    processTags: ['marketing', 'data_analysis', 'measurement'],
    businessDomainTags: ['マーケティング', '広告', 'EC', 'SaaS', 'データ分析'],
  },
  {
    title: '在庫管理の精度向上 — リアルタイム同期と棚卸標準化',
    knowledgeType: 'best_practice',
    background:
      '物流 / 小売の在庫精度が 90-95% と低く、欠品 (機会損失) と過剰在庫 (キャッシュ拘束) の両方が発生する事象が多発。',
    content:
      '在庫精度向上は (1) リアルタイム同期 (POS / EC / 倉庫 WMS の在庫数を 1 分以内に同期する基盤、Kafka 等のイベントストリーム)、(2) 棚卸標準化 (月次の全数棚卸ではなく、ABC 分析で A 品目は週次・B 品目は月次・C 品目は四半期と階層化)、(3) 不一致原因分析 (盗難・破損・誤入力・システムバグ等のカテゴリ化)、(4) 棚卸結果の自動反映 (手作業の差分入力は誤入力の原因) の 4 点を組み合わせる。精度目標は 99% 以上 (95-99% の差は事業利益で数千万円～数億円規模の差を生む)。',
    result:
      'リアルタイム同期 + 階層化棚卸を導入した小売チェーンで、在庫精度が 92% → 99.3% に向上。欠品による機会損失が年数億円減、過剰在庫の在庫負担も大幅軽減。',
    conclusion:
      '在庫精度は「単発の改善」ではなく「継続的な仕組み」で向上する。リアルタイム同期 + 棚卸標準化 + 不一致分析の 3 点セットが必須。',
    recommendation:
      'ABC 分析で対象品目を分類 (A: 売上の 70%、B: 25%、C: 5%)。A 品目に経営資源を集中させる。',
    reusability: 'high',
    techTags: ['wms', 'pos', 'kafka', 'inventory_system'],
    processTags: ['operations', 'business_process_redesign', 'data_quality'],
    businessDomainTags: ['物流', '在庫管理', '小売', '製造', 'EC', 'SCM'],
  },
  {
    title: '規制業界 (医療・金融) のシステム改修 — Day 1 Legal Engagement',
    knowledgeType: 'best_practice',
    background:
      '医療 / 金融 / 公共などの規制業界でシステム改修プロジェクトを進める際、規制対応 (薬機法 / 金融商品取引法 / 個人情報保護法 等) の検討が遅れて手戻り発生する事例が多発。',
    content:
      '規制業界のシステム改修は要件定義段階から法務 / 倫理委員会 / 規制対応部門と連携する (Day 1 Legal Engagement)。具体的には: (1) 要件定義に「規制要件 review」工程を必ず組み込む、(2) 設計段階で「監査ログ / 改ざん検知 / アクセス制御」の規制最低水準を確認、(3) 開発段階で「テスト環境への本番データ流出」を防ぐ匿名化ルールを規制対応部門と合意、(4) リリース判定で「規制対応チェックリスト」を完了させる。法務との連携を後回しにすると要件凍結後の根本見直しになる。',
    result:
      'Day 1 Legal Engagement を実施した複数の規制業界プロジェクトで、規制対応起因の手戻りがほぼゼロに。リリース判定もスムーズに進み、本番投入後の規制違反インシデントもなし。',
    conclusion:
      '規制業界は「技術 + 業務 + 規制」の 3 軸が同時並行で進む。1 軸でも遅れると全体が手戻りする。Day 1 から法務 / 規制対応部門を巻き込む。',
    recommendation:
      '医療業界では IRB (倫理委員会)、金融業界ではコンプライアンス部門、公共では監査法人と早期に連携体制を構築する。',
    reusability: 'medium',
    techTags: ['compliance', 'audit', 'security'],
    processTags: ['compliance', 'project_management', 'risk_management', 'legal'],
    businessDomainTags: ['医療', '金融', '公共', '規制業界', 'コンプライアンス', 'GDPR', '個人情報保護'],
  },
  {
    title: '教育プログラムの効果測定 — Kirkpatrick 4 段階評価',
    knowledgeType: 'best_practice',
    background:
      '教育プログラム実施後の評価が「アンケート満足度」のみで、本当に業務に活用されているかが見えない事象が多発。',
    content:
      '教育プログラムの効果測定は Kirkpatrick の 4 段階評価が標準: (1) Reaction (反応 / 満足度) — 受講直後のアンケート、(2) Learning (学習効果) — 受講後テストで知識定着を確認、(3) Behavior (行動変容) — 受講後 1-3 ヶ月で実務での適用度を確認、(4) Results (組織結果) — 受講後 6-12 ヶ月で業務 KPI 改善を確認。Level 1 のみで止まる組織が多いが、Level 3-4 まで測定して初めて教育投資の真価が見える。Level 3-4 の測定には事前に「変化を期待する行動・KPI」を明文化することが必須。',
    result:
      'Kirkpatrick 4 段階評価を導入した複数の組織で、教育プログラムの ROI が可視化。低 ROI のプログラムを廃止し、高 ROI に予算集中することで、組織全体の人材育成効率が大幅向上。',
    conclusion:
      '教育の評価は「満足度」だけでは不十分。行動変容と業務 KPI 改善まで追跡することで真の効果が見える。',
    recommendation:
      'Level 3-4 の測定は教育プログラム設計段階で「測定対象行動」を明文化して始める。後付けの測定は精度が落ちる。',
    reusability: 'medium',
    techTags: [],
    processTags: ['training', 'change_management', 'measurement', 'hr'],
    businessDomainTags: ['人事', '教育', '組織開発', 'HR'],
  },
  {
    title: '顧客サポートの問合せ削減策 — Self-Service と Context-Awareness',
    knowledgeType: 'best_practice',
    background:
      'サブスクサービスの顧客サポート問合せが急増し、サポートチームの人員が不足。問合せ対応コストが事業利益を圧迫する事例が多発。',
    content:
      '顧客サポート問合せ削減は 2 軸で進める: (1) Self-Service の充実 (FAQ / ヘルプセンター / アプリ内ガイド / チャットボット)、ただし「自己解決させる」だけでなく「ユーザがすぐに答えに辿り着ける UX」が重要、(2) Context-Awareness による事前対応 (「アプリ内で何度も同じ画面を行き来している」「エラーに遭遇した直後」のタイミングで proactive にヘルプを提示)。SFA/CRMツール / Intercom / Zendesk 等の SaaS で実装可能。サブスク解約 UX のように「サポートを必要とする」状況を構造的に減らす設計も併せて検討。',
    result:
      'Self-Service + Context-Awareness を導入した SaaS で、サポート問合せが 30-50% 削減。同時に NPS (Net Promoter Score) も向上 (=ユーザは「すぐに解決した」体験を価値と感じる)。',
    conclusion:
      'サポート問合せ削減は「サポートを減らす」のではなく「ユーザがサポートを必要としない体験を作る」。',
    recommendation:
      '問合せログを月次で分析し、Top 10 の問合せ内容を Self-Service 化。ChatGPT 等の AI による自動応答も併用すると効率が更に向上。',
    reusability: 'medium',
    techTags: ['intercom', 'zendesk', 'chatbot', 'ai', 'analytics'],
    processTags: ['operations', 'customer_support', 'ux'],
    businessDomainTags: ['顧客サポート', 'カスタマーサクセス', 'SaaS', 'B2C', 'CX'],
  },
  {
    title: '経営ダッシュボードの設計 — 役員視点 / 部門マネージャ視点 / 現場視点の 3 階層',
    knowledgeType: 'best_practice',
    background:
      'BI ダッシュボードを「全員一律の画面」で作ると、役員には情報過多 / 現場には粒度不足の両方の不満が出る事例が多発。階層別設計が必要となった。',
    content:
      '経営ダッシュボードは 3 階層で設計する: (1) 役員視点 (Executive View) — KPI 5-7 個 / トレンド線 / 異常検知のアラート / 1 画面で 30 秒で俯瞰可能、(2) 部門マネージャ視点 (Manager View) — 担当領域の詳細 KPI / 部下別の状況 / 部門間比較、(3) 現場視点 (Operator View) — 自分の業務に直結する数値 / アクション可能な情報のみ。各階層で「何を見て何を判断するか」を明確化することが設計の本質。一律の画面はどの階層にも刺さらない。',
    result:
      '3 階層設計を導入した複数の組織で、ダッシュボード活用率が 30% → 80% に向上。経営会議の効率化 (集計時間 8 時間 → 1 時間) も実現。',
    conclusion:
      'ダッシュボードは「見たい人」と「見せたいデータ」の組合せで階層化する。「全員に同じ画面」は失敗のテンプレート。',
    recommendation:
      '各階層のユーザインタビューで「何を判断するか」を聞き出してから設計に入る。技術設計の前に業務設計を行う。',
    reusability: 'high',
    techTags: ['bi', 'tableau', 'powerbi', 'looker', 'dashboard'],
    processTags: ['data_analysis', 'requirements', 'ux', 'design'],
    businessDomainTags: ['経営支援', 'BI', 'データ分析', 'ダッシュボード', '経営判断'],
  },
  {
    title: 'データ品質管理の継続改善 — 6 次元評価フレームワーク',
    knowledgeType: 'best_practice',
    background:
      'データ品質を「正確性」だけで評価するケースが多く、その他の側面 (完全性・一貫性・最新性 等) で問題があるとデータ活用に支障が出る事例が多発。',
    content:
      'データ品質は 6 次元で評価する (DAMA フレームワーク): (1) 正確性 (Accuracy) — データが事実と一致しているか、(2) 完全性 (Completeness) — 必要なデータが揃っているか、(3) 一貫性 (Consistency) — 複数システム間でデータが整合しているか、(4) 最新性 (Timeliness) — データが業務上必要な時点で更新されているか、(5) 一意性 (Uniqueness) — 重複が許容範囲内か、(6) 妥当性 (Validity) — フォーマット / 値域が業務ルールに合致しているか。各次元で目標値を設定し、月次でモニタリング。',
    result:
      '6 次元評価を導入した DWH 運用組織で、データ起因の業務トラブル (数値間違い / 集計ずれ) がほぼ解消。データガバナンスの基盤として機能。',
    conclusion:
      'データ品質は「正確性」だけでは捉えきれない。6 次元で多面的に評価し、継続的に改善する。',
    recommendation:
      'Great Expectations / ELTツール tests 等のデータ品質テストフレームワークで自動化。テスト失敗時は ビジネスチャット 通知でデータ運用者に即座に共有。',
    reusability: 'high',
    techTags: ['data_quality', 'great_expectations', 'ELTツール', 'dwh', 'data_governance'],
    processTags: ['data_management', 'governance', 'operations'],
    businessDomainTags: ['データ品質', 'データガバナンス', 'BI', 'DWH', 'データ分析'],
  },
];

// ================================================================
// PR-X5 (5-2 / 5-3): SAMPLE_PROJECTS / SAMPLE_ISSUES / SAMPLE_RETROSPECTIVES
//
// サンプルデータは default-tenant に投入され、`isSampleData=true` で隠蔽 (一覧/詳細/横断 view)
// しつつ、提案エンジンの候補ソースとして利用される。本セクションは PR-X5 で順次追加。
// ================================================================

export const SAMPLE_PROJECTS: SeedSampleProject[] = [
  // ================================================================
  // Sample Project A: ローコード基盤 業務アプリ (経理 / 中小企業向け業務改善)
  // ================================================================
  {
    name: '請求書承認ワークフロー構築 (サンプル)',
    customerName: 'サンプル A 商事',
    purpose:
      '紙ベースの請求書承認業務を ローコード基盤で自動化し、月次クローズ業務の負荷を軽減する。経理担当者の請求書回付に関する作業時間を月 40 時間 → 8 時間に削減し、月次決算の早期化 (現状 5 営業日 → 目標 3 営業日) を実現する。',
    background:
      '月末に発生する請求書の承認作業が紙の物理回付で 3-5 営業日要しており、月次決算を圧迫していた。担当者の 8 割が紙の物理的な追跡 (どこで止まっているかの確認) に時間を費やしており、本来の経理判断業務 (仕訳精査・残高確認等) に集中できない状態が常態化。さらに在宅勤務との両立が困難で、月末は出社必須となるなど業務継続性にも課題があった。',
    scope:
      'ローコード基盤によるモバイル対応の承認画面、業務自動化ツールによる回付・通知の自動化、ドキュメント管理ツールによる電子保管 (改ざん防止)、メール・予定表ツール 連携によるメール通知、ビジネスチャット 連携によるチャット通知。承認権限マトリクス (金額帯 × 部門) は 表計算ソフト マスタを取り込む形で柔軟性を確保。承認履歴は監査要件のため最低 7 年保管。',
    outOfScope:
      'ERPとの直接連携 (会計仕訳起票は別プロジェクト)、外部取引先からの電子請求書受領 (PDF アップロードのみ対応、e-Invoice 標準対応は次フェーズ)、AI による自動仕訳推定。',
    devMethod: 'low_code_no_code',
    contractType: '準委任',
    businessDomainTags: ['経理', '請求業務', '会計', '業務改善', '社内承認'],
    techStackTags: [
      'ローコード基盤',
      '業務自動化ツール',
      'ドキュメント管理ツール',
      'メール・予定表ツール',
      'ビジネスチャット',
    ],
    processTags: ['仕様検討', '設計検討', '開発', 'テスト', '受け入れ'],
    plannedStartDate: '2026-04-01',
    plannedEndDate: '2026-09-30',
    status: 'closed',
  },

  // ================================================================
  // Sample Project B: パブリッククラウド マルチアカウントによるクラウドインフラ構築 (SaaS スタートアップ)
  // ================================================================
  {
    name: '新規 SaaS 基盤のパブリッククラウド マルチアカウント構築 (サンプル)',
    customerName: 'サンプル B Tech',
    purpose:
      '新規ローンチする B2B SaaS の本番運用基盤を パブリッククラウド マルチアカウント構成で構築し、初期トラフィック (DAU 1,000) から成長期 (DAU 10 万) まで耐えうるスケーラブルな基盤を確立する。同時に、SOC 2 Type 2 取得を見据えたセキュリティガバナンスとコスト管理の自動化を組み込む。',
    background:
      'スタートアップが PoC から本格ローンチへ移行する段階で、PoC 構成 (シングルアカウント・手動構築・コンソール操作中心) では本番運用に耐えない状況。複数環境 (dev/staging/prod) の分離、IAM ガバナンス、コスト可視化、再現可能なインフラ構築が必須となり、エンジニア 5 名規模のチームでも運用可能な仕組みが求められた。創業期のため将来的な人員拡張も見越し、新人エンジニアでも安全に変更を加えられる教育性を持たせることも要件に含まれた。',
    scope:
      'パブリッククラウド Organizations / Service Control Policies (SCPs) によるアカウント分離 (root/security/log-archive/dev/staging/prod の 6 アカウント構成)、IaCツール Cloud による IaC 化と remote state 管理、マネージドコンテナ基盤 サーバレスコンテナ + マネージドRDB PostgreSQL の本番アーキテクチャ、CDN + パブリッククラウド WAF の Web 配信層、Gitホスティング Actions による CI/CD pipeline (PR レビュー → staging deploy → prod deploy approval gate)、クラウド監視 + 監視SaaS による監視 (SLO 設定込み)、災害対策 (RTO 4 時間 / RPO 1 時間)、SOC 2 準備の最低限ベースライン (CloudTrail / GuardDuty / Config / 鍵管理サービス 暗号化)。',
    outOfScope:
      '機械学習基盤 (SageMaker)、特定リージョン以外への展開 (US 拡張は V2)、コンプライアンス監査本番 (SOC 2 取得は別プロジェクト)、Multi-Region Active-Active 構成。',
    devMethod: 'scratch',
    contractType: '請負',
    businessDomainTags: ['SaaS', 'クラウド運用', 'セキュリティ', 'インフラ', 'スタートアップ'],
    techStackTags: [
      'パブリッククラウド',
      'IaCツール',
      'マネージドコンテナ基盤',
      'サーバレスコンテナ',
      'マネージドRDB',
      'PostgreSQL',
      'CDN',
      'WAF',
      'CI/CDツール',
      'クラウド監視',
      '監視SaaS',
      '鍵管理サービス',
    ],
    processTags: ['アーキテクチャ設計', '構築', '移行', 'テスト', '本番リリース', '運用設計'],
    plannedStartDate: '2026-03-15',
    plannedEndDate: '2026-08-31',
    status: 'closed',
  },

  // ================================================================
  // Sample Project C: SFA/CRMツールによる営業組織の可視化・標準化 (大企業向けコンサル)
  // ================================================================
  {
    name: 'SFA/CRMツールによる営業活動可視化 (サンプル)',
    customerName: 'サンプル C 商事',
    purpose:
      '部門ごとに属人化した営業活動を SFA/CRMツール SFA/CRMツールで可視化し、商談状況・案件確度・顧客接点を全社共通基盤で管理する。営業マネージャーが週次の案件レビューを 表計算ソフト 集計から脱却させ、データドリブンな営業組織への変革を 6 ヶ月で完遂させる。',
    background:
      '既存営業は 表計算ソフト + メール・予定表ツール + 個人ノートで案件管理しており、商談状況の社内共有が口頭ベースで行われていた。マネージャーは案件状況を把握するのに毎週 8 時間以上の集計作業が発生し、戦略的判断 (どの案件に経営層を投入すべきか) が後手に回っていた。役員からは「営業の見える化」が経営課題として明示されており、トップダウンでの導入決定。営業 30 名のうち約 20 名が IT ツールに苦手意識を持っており、現場抵抗の緩和も成功要件に含まれた。',
    scope:
      'SFA/CRMツール SFA/CRMツールのテナント初期設定、リード / 商談 / 取引先のデータモデル設計、既存 表計算ソフト データ (約 5,000 件) の移行、3 拠点 (東京・大阪・名古屋) の営業 30 名への教育プログラム実施、ダッシュボード設計 (役員ビュー / マネージャビュー / 担当者ビューの 3 種)、運用ルール策定 (商談ステージ遷移基準・データ品質基準)、最低 6 ヶ月の運用伴走支援、カスタムロジック によるカスタム入力チェック (任意項目の必須化等)。',
    outOfScope:
      'Marketing Cloud (リード獲得自動化)、Service Cloud (顧客サポート)、CPQ (見積自動化)。これらは V2 で 2027 年度の検討候補。',
    devMethod: 'package',
    contractType: 'SES',
    businessDomainTags: ['営業', 'CRM', 'コンサルティング', 'データ統合', '組織変革', '教育'],
    techStackTags: ['SFA/CRMツール', 'カスタムロジック', 'クエリ言語', 'データ移行ツール', 'BIツール'],
    processTags: ['要件定義', '設計検討', 'データ移行', '教育', '運用設計', '伴走支援'],
    plannedStartDate: '2026-02-01',
    plannedEndDate: '2026-07-31',
    status: 'closed',
  },

  // ================================================================
  // Sample Project D: ERPパッケージ 導入 (製造業 / 基幹システム刷新)
  // ================================================================
  {
    name: 'ERPパッケージへの基幹システム移行 (サンプル)',
    customerName: 'サンプル D 製造',
    purpose:
      '老朽化したオンプレ ERP (ERP ECC 6.0) を ERPパッケージに移行し、サポート切れ前 (2027 年末) に基盤刷新を完遂する。同時に在庫・原価計算・財務会計の業務プロセスを標準化し、5 工場のグループガバナンスを強化する。連結原価計算の手動 表計算ソフト 集計 (2 週間) を 3 営業日に短縮することを KPI とする。',
    background:
      '自動車部品製造の中堅企業 (年商 300 億)。基幹システムが 15 年以上稼働しており、ベンダーサポート切れの問題に加えて、5 工場それぞれが独自カスタマイズを行ってきたためマスタ統一すらできていない。本社の連結原価計算が手動 表計算ソフト 集計で 2 週間かかる状態が常態化し、月次決算の早期化が長年の経営課題だった。ERP 刷新と同時に基幹業務プロセスの標準化を行わないと、システムだけ新しくしても効果が出ない構造的問題を抱えていた。',
    scope:
      'ERPパッケージ Cloud (private edition) への移行。スコープ: 財務会計 (FI) / 管理会計 (CO) / 在庫管理 (MM) / 生産計画 (PP)。マスタ統一プロジェクトを並行 (品目マスタ約 15 万件・取引先マスタ約 8,000 件)。ERPアドオン言語 カスタム機能は現行の 3 割に削減 (標準機能で代替できるものは標準利用)。業務UIフレームワーク UI 採用で UX 刷新。データ移行は データ連携ツール (System Landscape Transformation) によるダウンタイム最小化アプローチ (本番切替時間 48 時間以内)。',
    outOfScope:
      '営業 (SD) は別フェーズ、人事 (HCM) は対象外、グループ各社の海外子会社展開は V2',
    devMethod: 'package',
    contractType: '請負',
    businessDomainTags: ['ERP', '会計', '原価管理', '在庫管理', '生産管理', '製造業', '基幹システム', 'マスタ統合', '月次決算'],
    techStackTags: ['ERP', 'ERPパッケージ', 'ERPアドオン言語', '業務UIフレームワーク', 'インメモリDB', 'データ連携ツール'],
    processTags: ['要件定義', 'Fit&Gap分析', 'マスタ統合', 'データ移行', 'ERPアドオン開発', 'テスト', '教育', '本番リリース'],
    plannedStartDate: '2026-01-01',
    plannedEndDate: '2027-06-30',
    status: 'closed',
  },

  // ================================================================
  // Sample Project E: ローコード基盤 導入 (中小企業 / 業務統合 / DX)
  // ================================================================
  {
    name: 'ローコード基盤による業務アプリ統合プラットフォーム構築 (サンプル)',
    customerName: 'サンプル E 物産',
    purpose:
      '部署ごとに乱立した 表計算ソフト 管理 (見積管理 / 受注管理 / 在庫管理 / 顧客台帳 / 経費精算など 30+ 個) を ローコード基盤に統合し、情報の二重管理と転記ミスを解消する。中小企業の限られた IT 人員 (情シス 1 名 + 兼任 2 名) でも持続可能な仕組みを構築する。手作業の二重入力時間を月 80 時間 → 10 時間に削減することを目標とする。',
    background:
      '食品商社 50 名規模企業。長年 表計算ソフト + Access + メールで業務が回っていたが、コロナ禍のテレワーク移行で「ファイル共有・バージョン管理・同時編集」の問題が一斉に顕在化。手作業の二重入力と顧客情報の散在で月次決算が遅れ、経営判断のスピードを阻害していた。過去にスクラッチ開発を試みたが情シス人員不足で頓挫した経緯があり、今回はベンダーロックイン回避と運用持続可能性を最重要視している。',
    scope:
      'ローコード基盤標準アプリ + JavaScript カスタマイズで 12 アプリを構築 (見積 / 受注 / 在庫 / 顧客 / 経費 / 勤怠 / 日報 / 出張申請 / 契約管理 / 取引先 / 商品マスタ / プロジェクト管理)。オフィススイート (メール・予定表ツール / ビジネスチャット / ドキュメント管理ツール) 連携。業務自動化ツール / 業務自動化ツールによる外部 SaaS 連携 (会計 クラウド会計ソフト、CRM MA/CRMツール)。情シス担当 1 名で保守可能なシンプル設計を最優先 (高度なカスタマイズは原則禁止、避けられない場合は徹底的に文書化)。',
    outOfScope:
      '倉庫の WMS、専用ハンドヘルダー連携、需要予測 AI、外部取引先との直接データ連携',
    devMethod: 'low_code_no_code',
    contractType: '準委任',
    businessDomainTags: ['業務統合', '受発注', '在庫管理', '顧客管理', '経費管理', '中小企業', 'DX', '業務改善', 'ローコード'],
    techStackTags: ['ローコード基盤', 'JavaScript', 'オフィススイート', 'メール・予定表ツール', 'ビジネスチャット', '業務自動化ツール', 'クラウド会計ソフト', 'MA/CRMツール'],
    processTags: ['要件ヒアリング', '業務フロー整理', 'アプリ設計', '構築', '教育', '伴走支援'],
    plannedStartDate: '2026-04-01',
    plannedEndDate: '2026-12-31',
    status: 'closed',
  },

  // ================================================================
  // Sample Project F: モノリス → マイクロサービス分割 (技術負債解消 / アーキテクチャ刷新)
  // ================================================================
  {
    name: 'EC サイト基幹システムのマイクロサービス化 (サンプル)',
    customerName: 'サンプル F 通販',
    purpose:
      '12 年運用してきた Java モノリス (約 200 万行) のリリース速度低下と障害影響範囲の広さを解消するため、注文 / 在庫 / 会員 / 決済の 4 ドメインをマイクロサービス化する。リリース頻度を月 1 回 → 週 5 回に向上し、新機能投入のリードタイムを短縮する。同時に障害影響範囲を「全サイト停止」から「特定機能のみ縮退」に限定し、可用性 SLO を 99.5% → 99.9% に引き上げる。',
    background:
      '年商 50 億円の通販事業者。EC ピーク (Black Friday / 年末セール) のたびにシステム全体障害でサービス停止が発生し、原因特定に 4 時間以上かかる事態が年 2-3 回起きていた。新機能投入も「全体テスト 2 ヶ月」が必須で競合 (Amazon / 楽天) に対するスピード劣後が経営課題。CTO 交代を機にアーキテクチャ刷新が経営方針として承認された。社内エンジニア 15 名のうち 5 名がモノリス保守でほぼ専任化しており、新人エンジニアの離職率も高い状態が続いていた。',
    scope:
      '注文ドメイン / 在庫ドメイン / 会員ドメイン / 決済ドメインの 4 マイクロサービス化。Strangler Fig パターンで段階的に分離 (12 ヶ月計画の Phase 1: 注文ドメイン)。Spring Boot + Kotlin、PostgreSQL、Kafka (イベント駆動)、Kubernetes (マネージドKubernetes)。CI/CD 整備 (Gitホスティング Actions + ArgoCD)、DDD 採用、サービスメッシュ (Istio)、分散トレーシング (Jaeger)、契約テスト (Pact)。データベース分割は段階的アプローチ (まずスキーマ分離 → 物理 DB 分離)。',
    outOfScope:
      '商品マスタ管理 (CMS 系)、レコメンド AI、フロントエンド改修、配送・物流連携',
    devMethod: 'scratch',
    contractType: '請負',
    businessDomainTags: ['EC', '注文管理', '在庫', '会員管理', '決済', '通販', 'B2C', 'マイクロサービス'],
    techStackTags: ['Java', 'Kotlin', 'SpringBoot', 'PostgreSQL', 'Kafka', 'Kubernetes', 'マネージドKubernetes', 'Istio', 'Jaeger', 'Docker', 'ArgoCD', 'CI/CDツール'],
    processTags: ['アーキテクチャ設計', 'DDD設計', '段階的移行', 'リファクタリング', 'テスト自動化', '本番切替', 'リリース運用'],
    plannedStartDate: '2026-03-01',
    plannedEndDate: '2027-02-28',
    status: 'closed',
  },

  // ================================================================
  // Sample Project G: データ分析基盤 (クラウドDWH + BI / 小売業)
  // ================================================================
  {
    name: '全社データ統合 + BI ダッシュボード構築 (サンプル)',
    customerName: 'サンプル G リテール',
    purpose:
      '店舗 POS / EC / 顧客管理 / 在庫の 4 系統に分散したデータを クラウドDWH DWH に統合し、経営層が日次で全社状況を把握できる BIツール ダッシュボードを構築する。データドリブンな意思決定文化を醸成し、機会損失 (欠品 / 過剰在庫) を年 5 億円削減する。経営会議の追加質問に「翌営業日まで持ち帰り」状態を解消する。',
    background:
      'アパレル小売 (200 店舗 + EC) の中堅企業。データは各システムに閉じておりサイロ化、月次レポートは情シスが手動 ETL で 3 営業日かけて作成。経営会議での「商品 X の地域別売れ行きは?」のような追加質問に翌日まで答えられない。データアナリスト不在で BI ツール導入の試みも過去に 2 度失敗している。今回は経営層の強いコミットメント (CEO 直轄プロジェクト) と社内データアナリスト育成プログラムを並行することで、3 度目の正直として推進。',
    scope:
      'クラウドDWH DWH 構築、ELTツール によるデータ変換層、データ連携ツール による各 SaaS からの ELT (SFA/CRMツール / ECプラットフォーム / 在庫システム)、BIツール Cloud によるダッシュボード (経営層 / 店舗マネージャ / バイヤ向け 3 系統)、データガバナンス (アクセス権限 / マスタ管理 / 履歴保存 / GDPR 対応)、データアナリスト 2 名の社内育成プログラム (6 ヶ月の OJT)、ビジネスチャット 連携によるアラート通知 (在庫切れ予兆等)。',
    outOfScope:
      'ML/AI 予測モデル (V2 で需要予測検討)、オンプレ既存システムリプレース、海外店舗データ統合',
    devMethod: 'package',
    contractType: '準委任',
    businessDomainTags: ['データ分析', 'BI', 'DWH', '小売', 'POS', 'EC', '在庫管理', '経営支援', 'マーケティング'],
    techStackTags: ['クラウドDWH', 'ELTツール', 'データ連携ツール', 'BIツール', 'SFA/CRMツール', 'ECプラットフォーム', 'SQL', 'Python', 'ビジネスチャット'],
    processTags: ['要件定義', 'データモデリング', 'ETL設計', 'ダッシュボード設計', 'データガバナンス', '教育', '運用伴走'],
    plannedStartDate: '2026-04-01',
    plannedEndDate: '2026-12-31',
    status: 'closed',
  },

  // ================================================================
  // Sample Project H: 電子カルテ機能追加 (医療 / 規制業界 / 既存システム拡張)
  // ================================================================
  {
    name: '電子カルテへの服薬指導記録機能追加 (サンプル)',
    customerName: 'サンプル H 病院',
    purpose:
      '既存の電子カルテシステムに服薬指導記録機能を追加し、薬剤師業務の電子化と監査対応 (薬機法 / 医薬品医療機器等法) を実現する。手書きの記録による紛失リスク・保管コストを削減し、医師との情報連携をリアルタイム化する。記録時間を 1 件 5 分 → 2 分に短縮し、薬剤師 1 人あたりの 1 日処理件数を 30 件 → 50 件に増やすことを KPI とする。',
    background:
      '200 床規模の総合病院。電子カルテ (院内開発の Java EE システム、稼働 8 年) は順調に運用中だが、薬剤部門だけ紙の指導記録を継続している。直近 2 年で監査での指摘 (記録の追跡可能性不足、保管期限管理の不備) が複数回発生し、抜本的な電子化が必須となった。患者への説明責任 (服薬指導記録の開示請求対応) も増加傾向にあり、紙ベースでは要求に応えられないケースが顕在化。医療情報技師の常駐は院内 IT 部門 (3 名) のみで、外部ベンダー依存度が高い構造。',
    scope:
      '既存電子カルテへの服薬指導モジュール追加 (薬剤師ログイン → 患者検索 → 処方確認 → 指導記録入力 → 医師通知)。HL7 FHIR 準拠のデータ構造、医師カルテとの自動紐付け、改ざん検知 (タイムスタンプ + ハッシュチェーン)、監査ログ 7 年保管、医療情報システム安全管理ガイドライン (厚労省) 準拠、3 省 2 ガイドライン対応。既存 UI (Java Servlet/JSP) との整合維持、シングルサインオン継続。',
    outOfScope:
      '患者向けアプリ、外来予約システム連携、保険診療レセプト対応、薬局チェーン連携',
    devMethod: 'scratch',
    contractType: '請負',
    businessDomainTags: ['医療', '電子カルテ', '薬剤管理', '服薬指導', '監査対応', '規制業界', 'コンプライアンス', '個人情報保護'],
    techStackTags: ['Java', 'JavaEE', 'Spring', '商用データベース', 'HL7', 'FHIR'],
    processTags: ['要件定義', '規制対応', '設計', '実装', 'テスト', '監査対応', '本番リリース'],
    plannedStartDate: '2026-05-01',
    plannedEndDate: '2026-12-31',
    status: 'closed',
  },

  // ================================================================
  // Sample Project I: HR / 勤怠 / 給与 SaaS 統合 (人事 DX / 大企業)
  // ================================================================
  {
    name: '人事 / 勤怠 / 給与システムの SaaS 統合刷新 (サンプル)',
    customerName: 'サンプル I コーポレート',
    purpose:
      '別ベンダーの 3 システム (人事マスタ / 勤怠管理 / 給与計算) を 人事労務SaaS + KING OF TIME + 給与計算ソフトクラウド に統合し、人事業務の二重入力 (毎月 200 件超の手動データ移送) を解消する。法改正対応の運用負荷を 1 担当者から外部 SaaS 提供側に移管し、人事部の戦略業務 (人材開発・組織開発) への集中を可能にする。',
    background:
      '1,200 名規模の企業。人事マスタは 20 年前から自社開発の Lotus Notes 系で運用、勤怠は別ベンダー、給与は税理士事務所連携の昔のパッケージ。3 系統間で社員情報を毎月人手で同期しており、人事部 3 名のうち 1 名が完全にこの作業に張り付いている状態。働き方改革 / フレックス制導入で勤怠ロジックも複雑化が必要となり、現状システムでは対応コストが膨らむ一方。法改正 (年末調整デジタル化、社会保険手続きのオンライン化) も既存システムでは追従できず、刷新のタイミングが熟した。',
    scope:
      '人事労務SaaS (人事マスタ・労務手続き) + KING OF TIME (勤怠) + 給与計算ソフトクラウド (給与計算) の 3 SaaS 連携構成。連携ハブを ローコード基盤で構築し、社員情報の Single Source of Truth を 人事労務SaaS に集約。マイナンバー収集・年末調整・社会保険手続きも自動化。データ移行は 1,200 名分 + 過去 3 年の勤怠 / 給与履歴 (約 50 万レコード)。フレックス勤務 / 裁量労働制 / 在宅勤務手当 の複雑な勤怠ロジック設計。',
    outOfScope:
      '採用管理 (ATS) / タレントマネジメント / 人事評価 / 福利厚生プラットフォーム',
    devMethod: 'package',
    contractType: '準委任',
    businessDomainTags: ['人事', '労務', '勤怠管理', '給与計算', 'マイナンバー', 'コンプライアンス', '働き方改革', '社会保険'],
    techStackTags: ['人事労務SaaS', '勤怠管理SaaS', '給与計算ソフト', 'ローコード基盤', 'API連携'],
    processTags: ['要件定義', 'SaaS選定', 'データ移行', '連携設計', '教育', '運用設計'],
    plannedStartDate: '2026-04-01',
    plannedEndDate: '2026-10-31',
    status: 'closed',
  },

  // ================================================================
  // Sample Project J: B2C モバイルアプリ新規開発 (スタートアップ / ヘルスケア)
  // ================================================================
  {
    name: 'B2C ヘルスケアアプリの新規開発 (サンプル)',
    customerName: 'サンプル J Health',
    purpose:
      '健康管理 (歩数 / 体重 / 食事 / 睡眠) を一元化する B2C iOS / Android アプリを新規開発し、3 ヶ月で MAU 1 万、半年で 5 万を達成する。フリーミアムモデルで収益化 (有料プラン: 栄養士オンライン相談)。Pre-Series A 資金 1 億円の Runway 内に有料転換率 5% を達成し、Series A 調達につなげることが事業目標。',
    background:
      'ヘルステック領域に参入する 5 名のスタートアップ。創業者は元医療従事者で「個人の健康データを AI で分析・コーチング」のビジョンを持つが、エンジニアリングは外部受託で進める方針。資金は Pre-Series A (1 億円) で、12 ヶ月の Runway 内に有料転換率 5% を達成しないと次回調達が困難という時間制約あり。市場には類似アプリが既に複数存在しており、UX の magic moment (使い始めて 1 週間以内に習慣化させる体験) で差別化することが必須要件。',
    scope:
      'React Native による iOS / Android 同時開発、モバイルバックエンド(BaaS) Authentication / マネージドNoSQL のサーバレスバックエンド、健康データ連携 / 健康データ連携連携、決済サービス 決済、push 通知 (継続率向上施策)、簡易 AI コーチング機能 (LLMプロバイダ 大規模言語モデル(LLM) Mini)、アプリストア Optimization / アプリストア 公開、初期ユーザ 1,000 名のクローズドベータ運営、グロース支援 (PMF 検証 + KPI 設計)。',
    outOfScope:
      'ウェアラブル独自開発、医療機器認証、薬機法に該当する機能 (診断・治療提案)、オンライン診療連携',
    devMethod: 'scratch',
    contractType: '請負',
    businessDomainTags: ['ヘルスケア', 'モバイル', 'B2C', 'スタートアップ', 'AI', 'ウェアラブル連携', 'サブスクリプション', 'グロース'],
    techStackTags: ['ReactNative', 'TypeScript', 'モバイルバックエンド(BaaS)', 'マネージドNoSQL', '健康データ連携', '決済サービス', 'LLMプロバイダ', '大規模言語モデル(LLM)', 'アプリストア'],
    processTags: ['要件定義', 'UI/UX設計', '開発', 'クローズドベータ', 'リリース', 'グロース支援', 'KPI設計'],
    plannedStartDate: '2026-04-15',
    plannedEndDate: '2026-12-31',
    status: 'closed',
  },
];

export const SAMPLE_ISSUES: SeedSampleIssue[] = [
  // ================================================================
  // Project A (ローコード基盤 請求書承認) 配下の課題
  // ================================================================
  {
    parentProjectName: '請求書承認ワークフロー構築 (サンプル)',
    type: 'issue',
    title: 'ローコード基盤 一覧画面で大量データ表示時に応答が 5 秒以上に劣化',
    content:
      '請求書承認画面の一覧で過去 1 年分 (約 3,000 件) を表示した際、初回表示に 5-8 秒かかりユーザビリティが大きく低下した。営業日初日の朝の混雑時間帯にはタイムアウト (30 秒) でエラー表示されるケースも複数発生。承認待ち件数の確認が困難となり、結果として承認フローが滞留する事態が起きていた。',
    cause:
      'ローコード基盤 Gallery コントロールが ドキュメント管理ツール 全件を取得し、クライアント側でフィルタリングしていたためクエリが Delegation 制限 (デフォルト 500 件) を超えて警告が出るも、開発時に「2,000 件まで」に上限を引き上げて対処していた。当時はテストデータが 500 件だったため見逃していた。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'ドキュメント管理ツール側で Indexed Column を設定し、ローコード基盤の Filter 関数を Delegation 対応関数 (StartsWith / =) のみに絞り込む。',
    responseDetail:
      'Status / 担当者 / 月次フィルタの 3 つを Indexed Column 化。ローコード基盤の Search() 関数を StartsWith() に置換。さらに「未承認のみ表示」「自分宛のみ」のクイックフィルタを上部に配置し、デフォルトは未承認 + 自分宛のみ表示するよう変更 (件数を 50 件以下に絞る)。',
    state: 'resolved',
    result:
      'デフォルト表示の応答時間が 5-8 秒 → 0.5 秒に改善。タイムアウトエラーはゼロに。承認フロー滞留もほぼ解消した。',
    lessonLearned:
      'ローコード基盤での大量データは「クライアント側全件取得 + 絞込」ではなく「サーバ側絞込 + 必要分のみ取得」が鉄則。Delegation 制限は警告ではなく禁止と捉え、警告を無視して上限引き上げで凌ぐのは将来的な技術負債になる。',
    riskNature: null,
  },
  {
    parentProjectName: '請求書承認ワークフロー構築 (サンプル)',
    type: 'issue',
    title: '業務自動化ツール ループフロー誤動作で承認者に同一メールが 800 件送信',
    content:
      '夜間バッチで動作させていた「未承認リマインダ送信フロー」が誤動作し、特定の承認者 1 名に同じ請求書のリマインダメールが 800 件以上送信される事故が発生。受信者の メール・予定表ツール がフリーズし、業務開始時のメール確認に 1 時間以上を要した。本人からの苦情後 5 分以内にフロー停止の対応をとった。',
    cause:
      '「未承認の請求書を取得して各承認者に通知」する Apply to each フロー内で、誤って外側のループ内に「未承認件数を再取得する分岐」を埋め込んでしまっていた。N 件あるとき 1 件目処理後に件数が変わらない (= 未承認のまま) ため、ループの終了条件に到達せず再取得 → 再通知が反復された。テスト時は 2 件のテストデータしかなく、ループ性質を見逃した。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'フロー内の冪等性を担保し、同一通知の二重送信を防ぐガードを設置する。',
    responseDetail:
      '通知送信履歴を ドキュメント管理ツールに記録し、「送信済みなら再送しない」のガードを追加。さらに 1 ユーザあたり 1 時間以内の同一通知は最大 3 件までに制限。Apply to each ループの設計レビューを必須化し、ネスト 2 段以上のループは設計書面でレビュー承認を取得するルールを導入。',
    state: 'resolved',
    result:
      '誤送信再発はゼロ。設計レビューフローも稼働しており、その後発見された別フローの誤設計 2 件をリリース前に修正できた。',
    lessonLearned:
      '業務自動化ツールのループフローは少量テストデータでは挙動を見抜けない。本番投入前に「終了条件が確実に到達するか」を時系列で図示確認することと、副作用ある操作 (送信・更新) には必ず冪等性ガードを入れるのが必須。',
    riskNature: null,
  },
  {
    parentProjectName: '請求書承認ワークフロー構築 (サンプル)',
    type: 'issue',
    title: 'ドキュメント管理ツールのアクセス権継承で他部門にも請求書情報が閲覧可能に',
    content:
      'リリース 3 週間後、経理部門以外のユーザ (営業部) から「請求書の閲覧 URL がメンバ全員に共有されているグループに通知され、ファイルアクセスを試したら閲覧できた」との指摘。請求書には取引先別の単価情報が含まれており、営業情報の漏洩リスクが顕在化した。',
    cause:
      'ドキュメント管理ツールの親グループから List がアクセス権を継承していた。承認フロー設計時に「サイトメンバーが承認操作するため」List 全体を Edit 権で公開しており、閲覧範囲を絞っていなかった。設計書には「経理のみ閲覧」と記載されていたが、実装時に ドキュメント管理ツール標準機能の継承の理解が浅く、明示的に阻止していなかった。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'List のアクセス権継承を切り、明示的に経理部門のみ Edit、それ以外を権限なしに設定。',
    responseDetail:
      'シェルスクリプトで全リストのアクセス権を一括見直し。継承を切り Owner / Member / Visitor の 3 グループに対し Read/Edit を明示割り当て。さらに四半期に 1 回の権限棚卸プロセスを導入。',
    state: 'resolved',
    result:
      '不要なアクセス権を全テリトリーで撤去。情報漏洩は閲覧された痕跡のみで、機密データのダウンロードや外部送信は確認されなかった。',
    lessonLearned:
      'ドキュメント管理ツールの権限は「継承デフォルト ON」を前提に設計する。設計書に「経理のみ」と書くだけではなく、実装でも明示的に継承を切ることが必須。リリース前のセキュリティテストとして、開発者以外のユーザによる「他部門アカウントでアクセスを試す」検証ステップを必ず入れる。',
    riskNature: null,
  },
  {
    parentProjectName: '請求書承認ワークフロー構築 (サンプル)',
    type: 'issue',
    title: 'メール・予定表ツール 通知メールがスパム判定で承認者に届かない',
    content:
      '承認依頼の通知メールが特定の取引先 (大手 1 社) のみに届かない事象が発生。原因調査の間に承認遅延が累積し、月次クローズが 2 営業日遅延した。',
    cause:
      '業務自動化ツールから送信される通知メールは送信者が「ノーリプライ用の汎用アドレス」になっていた。受信側の Office 365 ではこのドメインからの大量同種メールがスパム検知ルールで自動隔離されていた。送信側 (社内側) ではメール送信ログ上「送信成功」となっており、不達に気付けなかった。',
    impact: 'medium',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      '送信ドメインを正規の業務ドメインに変更し、SPF / DKIM 認証を整備する。',
    responseDetail:
      '業務自動化ツールの通知送信を メール・予定表ツール コネクタから「Send an email V2」(認証付き) に変更。送信元を担当者のメールアドレスに切り替えた。さらに送信ドメインに SPF / DKIM レコードを設定し、受信側の信頼度を向上。受信確認の自動チェック (Webhook 監視) を追加して不達を即座検知できるようにした。',
    state: 'resolved',
    result:
      'スパム判定はゼロに。受信確認モニタリングで以降の送信状況を可視化できるようになった。',
    lessonLearned:
      '自動送信メールの不達は「送信側ログでは見えない」。受信確認の自動監視を運用初期から設計に組み込む。送信ドメインの認証 (SPF / DKIM / DMARC) は B2B システムの必須インフラ。',
    riskNature: null,
  },

  // ================================================================
  // Project B (パブリッククラウド マルチアカウント) 配下の課題
  // ================================================================
  {
    parentProjectName: '新規 SaaS 基盤のパブリッククラウド マルチアカウント構築 (サンプル)',
    type: 'issue',
    title: 'マネージドRDB マネージドRDB フェイルオーバー演習で復旧 12 分 (SLO 8 分を超過)',
    content:
      '本番リリース 2 週間前の災害対策演習で、マネージドRDB の Writer 強制フェイルオーバを試行。Writer 切替自体は 30 秒で完了したが、アプリ側のコネクションプールが古い Writer を保持し続け、リトライで全コネクション再確立に 11 分かかった。SLO 「障害復旧 8 分」を 4 分超過した。',
    cause:
      'アプリの DB クライアント (Spring HikariCP) のコネクション取得タイムアウトを 60 秒、再接続間隔を 10 秒で設定していた。Writer 切替時に既存コネクションは閉じられないため、HikariCP が「使用中」と判断し新規接続発行を遅らせた。設計時に マネージドRDB の フェイルオーバ挙動を理解しておらず、「再接続するから大丈夫」と楽観視していた。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'マネージドRDB フェイルオーバ時に既存コネクションを即座に切断・再確立する設計に変更。',
    responseDetail:
      'HikariCP の `connectionInitSql` で `SELECT 1` を毎回確認し、Read/Write 不整合検知時に強制 evict。さらに マネージドRDB Proxy を導入して Writer 切替を Proxy 側で吸収するアーキテクチャに変更。マネージドRDB Failover Test を CI 自動化し、毎週フェイルオーバ → 復旧時間計測。',
    state: 'resolved',
    result:
      '復旧時間が 12 分 → 90 秒に短縮 (SLO 8 分以内)。CI 自動化で以降のフェイルオーバ動作の劣化を継続監視。',
    lessonLearned:
      'マネージド DB の「フェイルオーバ自動」は DB 内のみ。アプリ層の挙動を別途検証しないと SLO 違反する。災害対策は本番リリース前の必須演習であり、SLO 達成までやり込む。',
    riskNature: null,
  },
  {
    parentProjectName: '新規 SaaS 基盤のパブリッククラウド マルチアカウント構築 (サンプル)',
    type: 'issue',
    title: 'マネージドコンテナ基盤 サーバレスコンテナ タスクが起動直後のヘルスチェック失敗で再起動ループ',
    content:
      'staging 環境への新バージョンデプロイ時、マネージドコンテナ基盤 タスクが起動 → ヘルスチェック失敗 → 強制終了 → 再起動を繰り返すループに陥った。10 分以上 staging が利用不能となり、開発者の動作確認待ちが発生した。',
    cause:
      'ALB Target Group のヘルスチェックパスが `/health` (即時応答) ではなく `/api/v1/users` (DB アクセスあり) を指していた。アプリ起動直後は DB コネクションプール初期化中で、最初の数秒は応答が 502 を返す。ヘルスチェック許容失敗回数が 2 回・間隔 10 秒だったため、起動 30 秒以内に Healthy に至らずタスクが Kill された。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'ヘルスチェックパスを軽量な `/health` に変更し、DB チェックは別 endpoint `/health/deep` に分離する。',
    responseDetail:
      '`/health` は外部依存なしで 200 を即座返却。`/health/deep` は DB / 外部 API 接続確認を行うが、ヘルスチェック対象外。マネージドコンテナ基盤 の `startPeriod` を 60 秒に伸ばし、起動直後の grace period を確保。',
    state: 'resolved',
    result:
      'タスクの再起動ループは解消。staging のデプロイ時ダウンタイムも 10 分 → 30 秒未満に。',
    lessonLearned:
      'コンテナのヘルスチェックは「最低限のシグナル」を返すパスにする。重い依存チェックは別 endpoint に分離。`startPeriod` の調整は マネージドコンテナ基盤 / Kubernetes 両方の必須運用ポイント。',
    riskNature: null,
  },
  {
    parentProjectName: '新規 SaaS 基盤のパブリッククラウド マルチアカウント構築 (サンプル)',
    type: 'issue',
    title: 'IaCツール state ロック競合で 3 人同時作業時にデプロイ失敗',
    content:
      '開発チーム 3 人が同時に IaCツール apply を実行したところ、後発 2 人がロックエラーで失敗。状態ファイルが古いまま残り、次回 apply で「想定外の差分」を検出して停止する事態となった。本番リリース直前の修正タイミングで発生し、緊急対応で 3 時間遅延。',
    cause:
      'state ファイルを オブジェクトストレージ に置く構成だったが、マネージドNoSQL ロックテーブルを設定していなかった。複数人での開発を想定せず、初期構築時に「1 人で apply するから不要」と判断していた。',
    impact: 'medium',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'マネージドNoSQL ベースの state ロックを導入し、CI/CD でしか apply できないよう運用ルール化する。',
    responseDetail:
      'IaCツール Cloud に移行 (state 管理 + ロック + 履歴可視化を一括解決)。手元の terraform apply を禁止し、PR マージ後の Gitホスティング Actions 経由のみで apply される運用に変更。drift detection を週次で動作させ、想定外の手動変更を検知。',
    state: 'resolved',
    result:
      'ロック競合事故ゼロ。手動変更の検知も週次で複数件発生したものを早期に修正できる体制に。',
    lessonLearned:
      'IaC は 1 人運用前提で組むと必ず複数人で破綻する。Day 1 から「同時 apply できる前提」(ロック + 履歴 + CI 経由必須) で構築する。',
    riskNature: null,
  },
  {
    parentProjectName: '新規 SaaS 基盤のパブリッククラウド マルチアカウント構築 (サンプル)',
    type: 'issue',
    title: 'CDN キャッシュ設定誤りで API レスポンスが他ユーザに混入',
    content:
      'リリース 1 週間後、ユーザから「ログインしたら他人の名前が表示された」との報告。調査の結果、特定の API レスポンスが CDN でキャッシュされ、別ユーザにも同じレスポンスが返却されていた。個人情報を含むレスポンスのため即座にロールバック対応した。',
    cause:
      'CDN のデフォルトキャッシュビヘイビアが「すべてのリクエストをキャッシュ可能」になっていた。API パス `/api/*` に対して個別の Cache-Control を考慮しておらず、`Cache-Control: public, max-age=300` が誤って付与されたエンドポイントが他ユーザにも返却された。',
    impact: 'high',
    likelihood: 'low',
    priority: 'high',
    responsePolicy:
      'API パス全体を CDN キャッシュ対象外とし、個別に Cache-Control を設計してから対象化する。',
    responseDetail:
      '`/api/*` への CDN ビヘイビアを「No-Cache」に変更。バックエンドのレスポンス Cache-Control は `private, no-store` をデフォルト化。明示的にキャッシュ可能なパス (静的アセット) のみ別ビヘイビアで対応。さらにレスポンスヘッダ検査の自動テストを CI に追加。',
    state: 'resolved',
    result:
      'キャッシュ誤動作はゼロに。個人情報が混入したのは検知から 12 分以内に対応開始 (15 ユーザ影響範囲) で大事に至らず。',
    lessonLearned:
      'CDN のキャッシュは「デフォルト OFF + 個別 ON」の方針で組む。「デフォルト ON + 個別 OFF」は事故源。レスポンスヘッダの自動チェックを CI に組み込み、Cache-Control の意図しない設定を検知する。',
    riskNature: null,
  },

  // ================================================================
  // Project C (SFA/CRMツール CRM) 配下の課題
  // ================================================================
  {
    parentProjectName: 'SFA/CRMツールによる営業活動可視化 (サンプル)',
    type: 'issue',
    title: 'データ移行で顧客マスタの重複 (3,000 件中 800 件が重複登録)',
    content:
      '既存 表計算ソフトから SFA/CRMツールへ顧客マスタを移行した結果、3,000 社のうち 800 社 (約 27%) が重複登録となった。営業担当が「同じ会社が 3 つ表示される」と気付いて発覚。データクレンジングに 2 週間を要し、本稼働開始が 2 週間遅延。',
    cause:
      '元 表計算ソフトの顧客名フィールドが入力者によって表記揺れ (株式会社 vs 株, 全角 vs 半角, スペース有無) があり、それぞれ異なるレコードとして登録されていた。移行時に「SFA/CRMツール側で重複検知ルール (Duplicate Rule) を後から設定する」想定でクレンジングをスキップしていた。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'データ移行の前に必ず正規化 (表記統一・重複検知) を行い、移行後のクレンジングは最小化する。',
    responseDetail:
      '移行スクリプト中に SFA/CRMツール Duplicate Rule + Matching Rule を実行する事前検証ステップを追加。表記揺れは Python の正規化スクリプトで「株式会社/株/有限会社 → 株式会社」「全角 → 半角」等を統一。住所と業種の組合せでも重複判定を強化。',
    state: 'resolved',
    result:
      '重複は 0 件に統一。本稼働 2 週間遅延したが、移行品質は十分に確保され、運用後のデータクレンジング工数は当初想定より大幅に削減。',
    lessonLearned:
      'パッケージ機能 (SFA/CRMツール Duplicate Rule) は「移行後のクリーンアップ」用ではなく「移行プロセスに組み込むべき検証ステップ」。表記揺れを前提に Pre-Migration Cleansing は必須工程として工数見積に必ず含める。',
    riskNature: null,
  },
  {
    parentProjectName: 'SFA/CRMツールによる営業活動可視化 (サンプル)',
    type: 'issue',
    title: '営業 30 名のうち 10 名が研修後も 表計算ソフト 併用を続け SFA/CRMツールが形骸化',
    content:
      '導入研修を全営業 30 名に実施し本稼働開始したが、3 ヶ月後の利用状況調査で 10 名が「結局 表計算ソフトが早い」と SFA/CRMツール 入力をしておらず、データの完全性が崩れた。営業マネージャの可視化ダッシュボードも信頼性が低下し、経営層から「SFA/CRMツール 入れた効果は」との詰問が発生。',
    cause:
      '研修内容が「画面操作の説明」中心で、「なぜ SFA/CRMツールを使うか」の動機付けが弱かった。さらに UI が 12 項目の入力を要求し、現場感覚では 表計算ソフトの 3-4 項目で済んでいた業務に対して負荷が重い設計になっていた。マネージャ層も SFA/CRMツール ダッシュボードの活用を業務に組み込んでいなかったため、現場の入力動機が継続しなかった。',
    impact: 'high',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      '入力項目を最低限に絞り、現場の業務フローに組み込む形でマネージャ層が能動利用する仕組みを構築。',
    responseDetail:
      '必須項目を 12 → 5 に削減 (商談名 / 顧客 / 金額 / クローズ予定日 / フェーズのみ)。残りは任意化。マネージャ層の週次案件レビュー会議を SFA/CRMツール ダッシュボード前提で実施するルール変更。マネージャから現場へのフィードバックも SFA/CRMツール上で行うことでデータが「見られている」ことを実感させる。',
    state: 'in_progress',
    result:
      '6 ヶ月後の利用率調査で入力率 60% → 92% に改善。継続的な現場ヒアリングで入力フォーム改善を継続中。',
    lessonLearned:
      'システム導入の成功は「画面操作の研修」ではなく「業務プロセスを変えること」で決まる。入力項目数とユーザの抵抗感は比例関係で増える。マネージャ層がツール上で業務を行う = 部下も入力する。',
    riskNature: null,
  },
  {
    parentProjectName: 'SFA/CRMツールによる営業活動可視化 (サンプル)',
    type: 'issue',
    title: 'カスタムロジック Trigger の bulk 処理で governor limit (クエリ言語 100 件) を超過',
    content:
      'データ移行スクリプトで 5,000 件の商談を一括 INSERT した際、関連する 取引先のステータス更新を行う カスタムロジック Trigger が実行され「Too many クエリ言語 queries: 101」エラーで全ロールバック。原因調査・修正・再移行で 3 営業日遅延した。',
    cause:
      'カスタムロジック Trigger 内で取引先 ID ごとに `SELECT FROM Account WHERE Id = :id` を呼び出す for ループ実装になっていた。SFA/CRMツール標準の governor limit (1 トランザクションで クエリ言語 100 件まで) を超過。bulk 処理を想定した実装になっていなかった。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'カスタムロジック Trigger を bulk-safe (1 クエリ言語 で複数 ID を IN 句取得) なパターンにリファクタする。',
    responseDetail:
      'Trigger 内のループを廃止し、Trigger.new から ID を集約 → 1 回の クエリ言語 で全件取得 → Map で関連付け → 1 回の DML で更新する標準パターンに変更。さらに カスタムロジック 単体テストで 200 件の bulk 投入をテストケース化。Trailhead の カスタムロジック Best Practice モジュールをチームで履修。',
    state: 'resolved',
    result:
      'governor limit エラーゼロ。本稼働後の大量データ操作 (月次集計など) でも安全動作。',
    lessonLearned:
      'SFA/CRMツール カスタムロジック は「常に bulk 前提」で書く。クエリ言語 を for ループ内に書くことは原則禁止。カスタムロジック 単体テストの実装データは少なくとも 200 件 (bulk 動作を想定) で実施する。',
    riskNature: null,
  },
  {
    parentProjectName: 'SFA/CRMツールによる営業活動可視化 (サンプル)',
    type: 'risk',
    title: 'ダッシュボード権限設計でセールスマネージャに他部署データ表示の懸念',
    content:
      'ダッシュボード設計レビューで、セールスマネージャ向けダッシュボードが「自部署データ + 全社平均」を表示する仕様だったが、クエリ言語 の WHERE 句が抜けると他部署の個別案件まで見える設計になっていた。本番リリース前にセキュリティチームから差し戻し。',
    cause:
      'ダッシュボード作成時に SFA/CRMツールのレポート絞り込みを「ユーザ自身の部署」で設定していたが、その後の改修でフィルタが意図せず外れた。Sharing Rules / Role Hierarchy 設定との連動を考慮しておらず、データ可視範囲が想定外に拡大していた。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'Sharing Rules + Role Hierarchy + ダッシュボードフィルタの 3 層で多重に絞り込む設計に変更。',
    responseDetail:
      'Sharing Rule で「営業マネージャは自部署 + 直下メンバの案件のみアクセス可」を強制。ダッシュボードフィルタはバックアップとして併用。リリース前に「権限テスト用ダミーユーザ 5 名」で各画面を実際に確認する手順を追加。',
    state: 'resolved',
    result:
      'リリース時点でデータ可視範囲を確実に確認済み。マネージャ層の不必要なデータアクセスは構造的に阻止された。',
    lessonLearned:
      'パッケージの権限機能は「単一層では不十分」。Sharing Rules + Role + Profile + ダッシュボード絞込みの 4 層多重防御で組む。リリース前のダミーユーザ動作確認は権限境界の確認に必須。',
    riskNature: 'threat',
  },

  // ================================================================
  // Project D (ERPパッケージ) 配下の課題
  // ================================================================
  {
    parentProjectName: 'ERPパッケージへの基幹システム移行 (サンプル)',
    type: 'issue',
    title: '5 工場の品目マスタ統合で同一品目が異なるコードで 1.2 万件重複登録',
    content:
      '5 工場のマスタ統合作業で、各工場が独自の品目コード命名ルールを持っていたため、同じネジ・部品でも異なるコードで登録されていた。マッピング作業で 15 万件中 1.2 万件 (8%) が重複と判明。クレンジング作業の見積より 2 ヶ月遅延した。',
    cause:
      'プロジェクト発足時に各工場の品目マスタの「内容」だけ調査し、「同一品目の判定基準」を決めていなかった。工場 A は「材質_寸法_色」、工場 B は「カタログ番号_メーカー」といった命名で、機械的なマッチングができない構造。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      '統一マスタの命名ルールを先に確定し、各工場の旧コードと新コードのマッピングテーブルを作成する。',
    responseDetail:
      '統一命名ルール (材質-形状-寸法-メーカー の 4 軸) を策定。各工場から品目台帳の現物撮影 (2,000 件サンプル) を取得し画像 + 仕様で機械学習による同一判定 (社内エンジニアと外部 AI ベンダーで併用)。最終確認はベテラン購買担当 3 名が手動で実施。',
    state: 'in_progress',
    result:
      '1.2 万件中 9,000 件は機械的に統合判定済み。残り 3,000 件は手作業確認中。プロジェクト 2 ヶ月遅延だが、その後のリリース時点でマスタ品質を確実に担保できる見込み。',
    lessonLearned:
      'マスタ統合は「データ統合」より「定義統合」が先。各組織の命名ルール・判定基準の共通化なく統合は不可能。AI 活用は補助手段として有効だが、最終判定はドメイン熟練者の目視確認が必須。',
    riskNature: null,
  },
  {
    parentProjectName: 'ERPパッケージへの基幹システム移行 (サンプル)',
    type: 'issue',
    title: 'ERPアドオン言語 カスタム機能の 30% が ERPパッケージ で動作不能 (廃止 API 使用)',
    content:
      '既存 ECC 6.0 から ERPパッケージ 移行時のコード互換性検証で、800 本の ERPアドオン言語 カスタムプログラムのうち 240 本 (30%) が廃止 API を使用していると判明。代替 API への置換作業に追加 4 ヶ月の工数見積が発生。',
    cause:
      '移行計画策定時に ERPの Custom Code Migration Cockpit による事前互換性チェックを実施していなかった。営業 (SD) スコープ外の領域もチェック対象に含むべきだったが、対象外領域とされ未実施。実装に入って初めて廃止 API 使用が大量発覚。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'Custom Code Migration Cockpit で全コードを再診断し、置換可能なものは Quick Fix で自動置換、不可能なものは個別開発計画。',
    responseDetail:
      'Custom Code Migration Cockpit を全社 ERPアドオン言語 コードに実行。240 本のうち 180 本は標準 Quick Fix で置換可能と判定。残り 60 本は手動で代替実装が必要。さらに「廃止 API を新規開発で使わない」社内ルールを ERPアドオン言語 開発ガイドラインに追加。',
    state: 'in_progress',
    result:
      '180 本は 1 ヶ月で置換完了。残り 60 本も計画通り 3 ヶ月で対応中。プロジェクト全体の遅延は 4 ヶ月 → 2 ヶ月に圧縮見込み。',
    lessonLearned:
      'ERPのメジャーバージョンアップは「コード互換性チェック」を要件定義段階で必ず実施する。ベンダーが提供する診断ツール (ERP Custom Code Migration Cockpit / 商用データベース Database Migration Assistant 等) は Day 1 で実行して工数見積に反映。',
    riskNature: null,
  },
  {
    parentProjectName: 'ERPパッケージへの基幹システム移行 (サンプル)',
    type: 'issue',
    title: 'データ連携ツール データ移行検証で予定 24 時間が実測 52 時間 (本番切替時間の予算超過)',
    content:
      '本番切替リハーサル (Mock-Run) で データ連携ツール (System Landscape Transformation) によるデータ移行が予定 24 時間 → 実測 52 時間。本番では計画 48 時間ダウンタイム枠を超過するため切替不可と判明。',
    cause:
      '移行対象データの量見積が不正確だった (購買履歴 7 年分 + 過去取引先別単価マスタが想定外に重く、見積の 3 倍)。さらに インメモリDB インデックス作成中の並列度設定が未調整で、シングルスレッド近い状態で動作していた。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      '移行データを必須・任意で分類し、必須は本番切替時、任意は段階移行に分割する。同時に インメモリDB の並列処理設定を最適化。',
    responseDetail:
      '購買履歴を 3 年分のみ本番切替時に移行 (4-7 年前は読み取り専用 archive システムで参照)。インメモリDB インデックス作成の並列度を CPU 数の 70% に設定。並列処理設定後の Mock-Run で 18 時間に短縮。本番切替を計画 48 時間枠内に収められる見込み。',
    state: 'in_progress',
    result:
      'Mock-Run で 18 時間短縮済み。残課題として archive 環境の構築を本番切替前 1 ヶ月で完了予定。',
    lessonLearned:
      '大規模データ移行は「全データ移行前提」で計画すると本番切替時間を超過する。必須/任意で分割する設計を初期段階から検討する。データベースのチューニング (並列度・インデックス・パーティション) は 移行検証段階で必ず実測して最適化する。',
    riskNature: null,
  },
  {
    parentProjectName: 'ERPパッケージへの基幹システム移行 (サンプル)',
    type: 'issue',
    title: '業務UIフレームワーク UI のテストでベテランオペレーターから「使えない」評価',
    content:
      '本社経理部のベテラン 5 名にて 業務UIフレームワーク UI の受入テストを実施したところ、3 名から「現行 ERP GUI のキー操作が体に染み付いており、新 UI では作業効率が半減する」との否定的評価。プロジェクト計画上の重要マイルストーンであるユーザ受入が 1 ヶ月遅延した。',
    cause:
      '従業員の現行 ERP GUI 習熟度を考慮せず、業務UIフレームワーク UI へ全面移行する計画になっていた。20 年以上 ERP GUI を使い続けるベテラン層にとって、UI 大幅変更による生産性低下は致命的だった。教育プログラムも「業務UIフレームワーク の良さ」中心で、現行操作との対応マッピングが不十分。',
    impact: 'high',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      '業務UIフレームワーク と ERP GUI の併用期間を設け、ベテラン層は段階的に 業務UIフレームワーク 移行する。教育プログラムを現行操作とのマッピング軸で再設計。',
    responseDetail:
      '本番リリース後 6 ヶ月は ERP GUI と 業務UIフレームワーク の併用可。業務UIフレームワーク 強制切替は新人・若手から段階移行。教育コンテンツは「現行の T-code XX-YY → 業務UIフレームワーク の○○タイル」と現行操作の代替マッピング形式に再構成。本社経理ベテラン 5 名にはマンツーマン指導 (40 時間/人) を実施。',
    state: 'resolved',
    result:
      '6 ヶ月の併用期間を経て、ベテラン 5 名のうち 4 名は 業務UIフレームワーク 移行に成功。1 名は退職予定のため ERP GUI 利用継続を許容。生産性低下リスクは大幅に緩和された。',
    lessonLearned:
      '基幹システム刷新時の UI 大幅変更は、長年利用者にとって「学習しなおし」の心理的ハードルが極めて高い。併用期間 + マンツーマン指導 + 現行操作とのマッピング教育の 3 点セットで対応する。教育予算を初期計画より厚く確保することが必須。',
    riskNature: null,
  },

  // ================================================================
  // Project E (ローコード基盤 業務統合) 配下の課題
  // ================================================================
  {
    parentProjectName: 'ローコード基盤による業務アプリ統合プラットフォーム構築 (サンプル)',
    type: 'risk',
    title: '情シス担当 1 名で 12 アプリの保守は持続不可能と判明',
    content:
      'リリース 3 ヶ月後、情シス担当者 1 名がアプリ追加・修正・問い合わせ対応に 1 日の 80% を費やし、本来の業務 (PC キッティング、ヘルプデスク) が滞る状況。担当者から「持続不可能」との SOS が経営層に。',
    cause:
      'プロジェクト計画時に「情シス 1 名 + 兼任 2 名」で運用可能と楽観視していた。実際には ローコード基盤のカスタム JavaScript 修正、新業務追加、ユーザからの「使い方教えて」問合せが想定の 3 倍発生。兼任 2 名は本業優先のため実質サポートできなかった。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      '管理者役を社内に分散させ、情シス専任を「最終エスカレーション」のみに役割再定義する。',
    responseDetail:
      '各部署 1 名 (合計 5 名) の「アプリ管理者 (Citizen Developer)」を任命し、サイボウズの公式トレーニングを受講させる (各 8 時間)。日常的な追加項目・ビュー作成・簡易修正は管理者が担当。情シス専任は「複雑な JavaScript / 連携 / トラブル」のみ担当。月 1 回の管理者会議でナレッジ共有。',
    state: 'in_progress',
    result:
      '6 ヶ月後の運用調査で情シス担当者の業務時間配分が 80% → 25% に改善。本業 (PC キッティング等) も復活。アプリ管理者 5 名のうち 4 名は積極的に新規アプリを自走で作るレベルに到達。',
    lessonLearned:
      'ローコードツールの真価は「Citizen Developer」(現場の管理者) を育成して初めて発揮される。情シス専任 1 名で全運用は持続しない。導入時から「ユーザ側に管理者を作る」教育投資を計画に含める。',
    riskNature: 'threat',
  },
  {
    parentProjectName: 'ローコード基盤による業務アプリ統合プラットフォーム構築 (サンプル)',
    type: 'issue',
    title: '早期に書いた JavaScript カスタムが他者には読めない構造で技術負債化',
    content:
      'プロジェクト初期に開発者 A が独自パターンで書いた JavaScript カスタム (受注アプリの単価自動計算) を、A の異動後に B が修正しようとしたところ、コードの構造理解に 3 日要し、修正自体に 1 週間かかった。全 12 アプリ中 4 アプリが同様の状態と判明。',
    cause:
      'ローコード基盤 カスタマイズの社内コーディング規約・命名規約・コメント規約が存在しなかった。開発者 A は jQuery 系の旧パターン + 独自 utility 関数で実装し、B は最新の async/await + Vue を学んでいたためギャップが大きかった。コードレビューもなかった。',
    impact: 'medium',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      'ローコード基盤 カスタマイズの社内コーディング規約を整備し、リファクタリング期間を確保する。',
    responseDetail:
      'ローコード基盤 カスタマイズ規約を策定 (TypeScript 採用 / async/await 統一 / 公式 SDK 利用 / コメント必須項目 4 つ)。既存 4 アプリのコードを 6 週間でリファクタリング。プルリクエストレビュー必須化、複雑度 (cyclomatic complexity > 10) 警告の lint 導入。',
    state: 'resolved',
    result:
      'リファクタリング完了後、コード理解時間が平均 3 日 → 半日に短縮。新規追加開発も担当者間の引継ぎがスムーズに。',
    lessonLearned:
      'ローコードツールの「自由さ」は技術負債の原因にもなる。Day 1 でコーディング規約・レビュー文化を整備する。技術負債を放置するとローコードのメリット (低コスト保守) を失う。',
    riskNature: null,
  },
  {
    parentProjectName: 'ローコード基盤による業務アプリ統合プラットフォーム構築 (サンプル)',
    type: 'issue',
    title: '表計算ソフト データ移行で絵文字・機種依存文字が約 500 件で文字化け',
    content:
      '既存 表計算ソフト データ (顧客台帳・案件メモ等) を ローコード基盤に移行した結果、約 500 件で「♡」「☆」「①」等の文字が「??」「?」に化け、コミュニケーション履歴が判別不能となった。営業現場から「過去のやりとりが分からない」との苦情多発。',
    cause:
      '移行スクリプトで CSV 出力時の文字コード指定 (UTF-8) を行っていたが、表計算ソフト側でファイルを開くと自動的に Shift_JIS で再保存される問題を見逃した。さらに ローコード基盤の文字エンコーディング処理の前提を確認しておらず、絵文字 (Unicode 高サロゲート) は ローコード基盤 API の制約で受け入れ不可だった。',
    impact: 'medium',
    likelihood: 'medium',
    priority: 'medium',
    responsePolicy:
      '移行データを 表計算ソフト 経由ではなく Python スクリプトで直接 UTF-8 export し、絵文字 / 機種依存文字を事前に判定・置換する。',
    responseDetail:
      'Python の openpyxl で 表計算ソフトを直接読込み、UTF-8 で ローコード基盤 API に POST する移行スクリプトに切り替え。絵文字検知ロジックを追加し、検知した場合はテキスト末尾に [絵文字あり] と注釈を追加 (元の意味を可能な限り保持)。化けた 500 件は手作業で原本確認・修正。',
    state: 'resolved',
    result:
      '化けは全件解消。ローコード基盤への移行データは UTF-8 ベースで一貫処理され、新規データも問題なく登録できる体制に。',
    lessonLearned:
      '表計算ソフト 経由のデータ移行は「文字コードの罠」が必ずある。Python / スクリプトで直接 export するパターンが安全。絵文字・機種依存文字の事前判定は移行スクリプトの必須機能。',
    riskNature: null,
  },
  // ================================================================
  // Project F (マイクロサービス分割) 配下の課題
  // ================================================================
  {
    parentProjectName: 'EC サイト基幹システムのマイクロサービス化 (サンプル)',
    type: 'issue',
    title: '共有 DB のスキーマ分離で旧モノリス側のクエリが破綻',
    content:
      '注文ドメインを切り出した後、注文テーブルを別スキーマに移動。旧モノリスからの集計クエリ (取引先ダッシュボード) が JOIN で参照していた箇所が複数あり、リリース後に集計画面が真っ白になる事象が発生。本番障害として 4 時間ダウンタイム。',
    cause:
      'モノリス側のコードベースで「注文テーブルを参照している全箇所」を網羅的に洗い出していなかった。grep ベースの確認だったが、ORM の動的クエリ (HQL や JPQL の文字列連結) が grep ですり抜けていた。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      '依存関係の網羅検出を grep ではなく実行時トレースに切り替え、旧スキーマへのアクセスを段階的に検出して移行する。',
    responseDetail:
      '本番環境で `pg_stat_statements` を有効化し、注文テーブルへのクエリパターンを 1 週間ログ収集。アプリケーション側でも DB 接続のラベリングを行い、旧モノリスからの注文テーブル参照を可視化。発見した 14 箇所のクエリを順次マイクロサービス API 経由に切り替え。',
    state: 'resolved',
    result:
      '依存箇所を確実に発見・移行できた。集計画面の障害も復旧後に再発なし。',
    lessonLearned:
      'マイクロサービス分割時の依存洗い出しは、静的検索 (grep) では不十分。動的クエリは見つけられない。本番のクエリログ + アプリ側ラベリングで実行時依存を可視化する。Strangler Fig パターンでは「依存洗い出し → 切替」を繰り返す前提で計画する。',
    riskNature: null,
  },
  {
    parentProjectName: 'EC サイト基幹システムのマイクロサービス化 (サンプル)',
    type: 'issue',
    title: 'Kafka 経由の注文 → 在庫イベント連携で 0.1% に不整合',
    content:
      '注文確定時に Kafka へ「在庫減算イベント」を送信、在庫サービスが消費する設計でリリース。負荷試験 (10,000 注文/日) で約 10 件 (0.1%) の在庫がマイナス値になる現象を発見。本番投入を 1 ヶ月延期。',
    cause:
      '同一商品への同時注文時、注文サービス側で在庫を確認せずに Kafka へイベントを送信していた。在庫サービスは順次処理だが、注文サービスは並列処理のため「在庫 1 個に対し 2 注文確定」が稀に発生。Saga パターンの補償ロジックも未実装で、不整合は補正されないまま放置されていた。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      '在庫の一意性は同期 API で先に確保し、Kafka はその後の通知用とする。さらに Saga パターンで補償ロジックを実装する。',
    responseDetail:
      '注文確定フローを「同期 API で在庫確保 → 成功時のみ注文確定 → Kafka でイベント配信」の順に変更。在庫確保失敗時は注文側に明示的にエラー応答。さらに Saga として「決済失敗時は在庫を解放する補償」を実装。負荷試験を再実施し不整合ゼロを確認。',
    state: 'resolved',
    result:
      '不整合事象は再発ゼロ。Saga 補償ロジックも稼働し、決済失敗による売り逃しも防げる体制に。',
    lessonLearned:
      'マイクロサービス間の整合性は「Eventually Consistent」を盲目的に採用すると事故源になる。一意性が必要な操作 (在庫・座席・予約) は同期 API で確保し、Kafka は通知用に限定する。Saga パターンの補償ロジックは「実装する前提」で工数見積に必ず含める。',
    riskNature: null,
  },
  {
    parentProjectName: 'EC サイト基幹システムのマイクロサービス化 (サンプル)',
    type: 'issue',
    title: 'サービス間 RPC のタイムアウト設定不整合でエラー連鎖',
    content:
      '在庫サービスが一時的に応答遅延した際、注文サービスはタイムアウト前にエラーを返さず長時間待ち続け、結果として注文サービス自体のスレッドプールを食い潰し、無関係な「商品閲覧 API」までも応答不能となった。',
    cause:
      'サービス間 RPC のタイムアウト・リトライ・サーキットブレーカ設定が個別実装で、全社統一されていなかった。注文 → 在庫呼出のタイムアウトが 60 秒、リトライ 3 回 (= 最大 3 分待ち) と過剰に長い設定だった。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'サービスメッシュ (Istio) でタイムアウト・リトライ・サーキットブレーカを集中管理する。',
    responseDetail:
      'Istio の VirtualService / DestinationRule で全サービス間 RPC のタイムアウト 5 秒・リトライ 1 回・サーキットブレーカ (50% 失敗で 30 秒切断) を統一設定。各サービスの個別実装は廃止。OpenTelemetry でレイテンシ可視化を強化。',
    state: 'resolved',
    result:
      '一部サービス遅延時の連鎖障害がゼロに。サービスメッシュ層で resilience を一元管理することで、新規サービス追加時も同じ標準が適用される。',
    lessonLearned:
      'マイクロサービスの resilience は「各サービスで実装する」と必ず不整合する。サービスメッシュで横断的に管理する設計が必須。タイムアウト・リトライの設計値は「ユーザの許容待ち時間」から逆算する (60 秒は通常 NG、上限 3-5 秒目安)。',
    riskNature: null,
  },
  {
    parentProjectName: 'EC サイト基幹システムのマイクロサービス化 (サンプル)',
    type: 'risk',
    title: '開発チーム分割によるリリース調整コスト増のリスク',
    content:
      '4 ドメインそれぞれにチームを分割した結果、リリースのタイミング調整・他チームの API 互換維持・障害時の問題切り分けに想定以上の時間がかかる懸念が出始めた。リリース頻度を月 1 → 週 5 に上げる KPI に対し、現状は月 3 程度に留まっている。',
    cause:
      'Conway の法則どおり「組織がアーキテクチャを規定する」ため、4 チームに分割しても コミュニケーションパスは増える。さらに API 互換性維持のための合同会議や、障害時の Incident Commander 不在で意思決定遅延が発生。',
    impact: 'high',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      'API 契約テスト (Pact) を導入して互換性問題を CI で検知。Incident Commander 役を専任化し、障害時の意思決定を高速化する。',
    responseDetail:
      'Pact テスト基盤を構築し、各サービスは「自分が提供する契約」「自分が依存する契約」を明示。CI で互換性違反を検知し、リリース前に問題を発見可能に。Incident Commander を Platform チーム内に専任で配置。Postmortem テンプレートも策定。',
    state: 'in_progress',
    result:
      'Pact テスト導入後 3 ヶ月で API 互換性違反事故ゼロ。リリース頻度は月 3 → 週 3 に向上中 (目標週 5 に向け継続改善)。',
    lessonLearned:
      'マイクロサービスは技術ではなく組織の課題が最大ボトルネック。API 契約テスト + 専任 Incident Commander + Postmortem 文化の 3 点セットで対応する。リリース頻度向上は「技術 < 組織 < 文化」で時間がかかると認識する。',
    riskNature: 'threat',
  },

  // ================================================================
  // Project G (クラウドDWH + BI) 配下の課題
  // ================================================================
  {
    parentProjectName: '全社データ統合 + BI ダッシュボード構築 (サンプル)',
    type: 'issue',
    title: '初回 ETL で クラウドDWH クレジット消費が想定の 5 倍',
    content:
      '初回データ移行で クラウドDWH のクレジット消費が想定 1,000 USD → 実測 5,200 USD に。月次コストが想定外に膨張し、財務部からプロジェクト一時停止の指示が出る寸前まで行った。',
    cause:
      'ELTツール の incremental 設定をしておらず、毎回フル再構築が走っていた。さらに Warehouse サイズが Large 固定で、軽い変換でも巨大なリソースを使っていた。クエリの実行プランも検証されておらず、不要な JOIN が複数あった。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'ELTツール incremental + Warehouse 自動サイズ変更 + クエリ最適化の 3 点でコスト圧縮する。',
    responseDetail:
      'ELTツール model に `materialized = "incremental"` 設定を順次導入。Warehouse は X-Small ベースで自動スケール (auto-suspend 60 秒)。EXPLAIN PLAN を全 50 model で確認し、不要 JOIN・redundant CTE を整理。クラウドDWH の Resource Monitor で日次予算上限を設定し、超過時はクエリ実行停止。',
    state: 'resolved',
    result:
      '月次コストが 5,200 USD → 800 USD (約 85% 削減) に低減。ELTツール CI/CD で incremental 設定を必須化し、新規 model 追加時の事故も防止。',
    lessonLearned:
      'クラウド DWH は「設定の妥当性」がコスト直結。Warehouse サイズ・auto-suspend・incremental 設定・実行プランの 4 点を初期設計でしっかり詰める。Resource Monitor は Day 1 で必須設定。',
    riskNature: null,
  },
  {
    parentProjectName: '全社データ統合 + BI ダッシュボード構築 (サンプル)',
    type: 'issue',
    title: 'ELTツール model の依存グラフが 50 モデル超で変更影響範囲が見えない',
    content:
      'ELTツール model の追加・変更を続けた結果、依存関係が複雑化。1 モデル変更時に下流の何が壊れるかが直感的に分からず、リリース前テストに 1 日以上要するように。新規モデル追加スピードが大幅に低下。',
    cause:
      '初期設計で「とりあえず作って後で整理」する方針だったため、レイヤ (raw / staging / intermediate / mart) の責務分離があいまいに。ELTツール の docs / lineage 機能も活用しておらず、変更影響を頭で追っていた。',
    impact: 'medium',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      'レイヤ責務を明確化 (raw / staging / intermediate / mart) し、各レイヤ内のみで依存を許可。ELTツール docs を活用して lineage を可視化。',
    responseDetail:
      'ELTツール project structure を 4 レイヤに再構成。staging は raw のみ参照、intermediate は staging のみ、mart は intermediate のみ参照のルールを CI で強制 (yamllint カスタムチェック)。ELTツール docs を社内ポータルにデプロイし、誰でも lineage を確認可能に。',
    state: 'resolved',
    result:
      '変更影響の特定時間が 1 日 → 30 分に短縮。新規モデル追加もレイヤ規約に従って迷わず実施可能に。',
    lessonLearned:
      'データ変換層も「設計」が必要。レイヤ分離なくモデルを書き続けると必ず依存地獄になる。ELTツール docs / dataform / SQLMesh などの lineage 可視化ツールは Day 1 で導入する。',
    riskNature: null,
  },
  {
    parentProjectName: '全社データ統合 + BI ダッシュボード構築 (サンプル)',
    type: 'issue',
    title: 'BI ユーザが個人情報を含む raw テーブルを直接参照',
    content:
      'BIツールの自由探索機能で、本来 mart 層 (匿名化済み) のみ見せるべきユーザが raw 層 (顧客個人情報含む) を参照している事象を発見。GDPR 対応の観点で重大なインシデントとして扱われた。',
    cause:
      'クラウドDWH のロール設計で「BIツール 用ロール」が広く権限を持っており、raw / staging / mart 全てに SELECT 権を持っていた。アクセス制御の最小権限原則 (Principle of Least Privilege) が徹底されていなかった。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'ロール体系を 4 層 (raw / staging / intermediate / mart) で再設計し、BI ユーザは mart のみ参照可とする。',
    responseDetail:
      'クラウドDWH のロール体系を再設計。`bi_user` ロールは mart スキーマのみ SELECT 可。raw / staging は `dbt_engineer` のみ。Row Access Policy で部署別データ可視化も実装 (営業マネージャは自部署のみ)。Audit Log で全クエリを クラウドDWH → 監視SaaS に転送し monitoring。',
    state: 'resolved',
    result:
      'ロール再設計後、不正アクセスゼロ。GDPR 対応も legal team の最終承認を取得し、本番運用に問題なし。',
    lessonLearned:
      'データ基盤は Day 1 で「ロール体系 + 最小権限原則」を設計する。後付けでの権限縮小は混乱を生む。GDPR / 個人情報保護法対応は「データ可視範囲の構造的制限」が一番堅牢。',
    riskNature: null,
  },
  {
    parentProjectName: '全社データ統合 + BI ダッシュボード構築 (サンプル)',
    type: 'risk',
    title: 'データアナリスト育成の進捗遅延 (6 ヶ月計画 → 12 ヶ月見込み)',
    content:
      '社内データアナリスト 2 名の育成プログラム (6 ヶ月) を進めていたが、実務との両立が難しく進捗が遅延。SQL の習得は順調だが、ビジネス文脈での仮説立案・ダッシュボード設計のスキルが思うように育っていない。',
    cause:
      '育成プログラムが「技術スキル中心」で、ビジネス文脈での思考力・データから経営判断につなげる視点を扱っていなかった。さらに既存業務との両立で学習時間が確保できないメンバが多く、業務内 OJT の比重が低かった。',
    impact: 'medium',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      '育成プログラムを「技術 + ビジネス文脈」の 2 軸に再構成し、業務内 OJT 比重を増やす。',
    responseDetail:
      '育成プログラムを再設計。技術 (クラウドDWH / SQL / ELTツール / BIツール) は外部 Udemy 等で自学習、社内研修はビジネスケース (例: 売上低下要因の分析、商品 X の需要予測等) に集中。週 1 回のシニアアナリストによるメンタリングを必須化。OJT 比重を 30% → 70% に。',
    state: 'in_progress',
    result:
      '研修開始から 9 ヶ月時点で、2 名とも独力でダッシュボード設計 + 経営層への提案ができるレベルに到達 (再設計後 3 ヶ月で大幅改善)。',
    lessonLearned:
      'データアナリスト育成は「技術習得」と「ビジネス文脈習得」が両輪。後者は座学では学べず、業務内 OJT + メンタリングが必須。育成プログラムは進捗が想定より遅れる前提で 1.5-2 倍の期間を計画する。',
    riskNature: 'threat',
  },

  // ================================================================
  // Project H (電子カルテ機能追加 / 医療規制業界) 配下の課題
  // ================================================================
  {
    parentProjectName: '電子カルテへの服薬指導記録機能追加 (サンプル)',
    type: 'issue',
    title: '医師の本番投入後、ログイン応答が 8 秒以上 → 診療業務に支障',
    content:
      '本番リリース直後、医師から「ログインに 8 秒以上かかる、患者の前で待たせている」と複数の苦情。診療スループットが影響を受け、IT 部門への問い合わせが急増。リリース当日の夕方に緊急対応会議が招集された。',
    cause:
      '新機能 (服薬指導モジュール) のメニュー追加に伴い、ログイン時に全モジュールの初期化処理を逐次実行する設計だった。既存 8 モジュール + 新規 1 モジュールの合計初期化が 6-8 秒かかる。テスト環境では問題なかったが、本番の ログ DB 容量が大きくキャッシュロード時間が伸びていた。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'モジュール初期化を遅延ロード (lazy load) に変更し、ログインは認証のみに絞る。',
    responseDetail:
      'ログイン処理から全モジュール初期化を撤去。各モジュールはユーザがメニュー選択した瞬間に初期化する lazy load 方式に変更。さらに認証のみに 1.5 秒以内の応答を SLO として設定。本番モニタリングを 監視SaaS で追加 (応答時間 P95)。',
    state: 'resolved',
    result:
      'ログイン応答が 8 秒 → 1.2 秒に短縮。医師からの苦情はゼロに復旧。SLO モニタリングも継続稼働。',
    lessonLearned:
      '既存システムへの機能追加は「既存処理に影響しない設計」を最優先する。テスト環境のデータ量と本番のデータ量の差は大きいため、性能テストは本番相当のデータ量で実施する。lazy load は「とりあえず eager」より優先する設計判断。',
    riskNature: null,
  },
  {
    parentProjectName: '電子カルテへの服薬指導記録機能追加 (サンプル)',
    type: 'issue',
    title: '監査ログのストレージコストが想定の 5 倍',
    content:
      '監査要件で 7 年保管が必須の監査ログを 商用データベース 同 DB に保存する設計だったが、リリース 3 ヶ月で容量が想定の 5 倍となり、ストレージコストが急増。財務部から構造見直しの指示。',
    cause:
      '監査ログの 1 レコードあたりサイズ見積が過小評価。実際にはユーザ操作ログ (画面表示・検索) も全て記録対象で、想定の「データ変更ログのみ」よりはるかに多かった。商用データベース はストレージコストが高く、監査ログ保管には不向き。',
    impact: 'medium',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      '監査ログを 商用データベースから オブジェクトストレージ (Glacier 階層) に分離し、ストレージコストを 1/10 に削減する。',
    responseDetail:
      '直近 3 ヶ月の監査ログは 商用データベース 残置 (高速検索用)。3 ヶ月超は オブジェクトストレージ Standard、12 ヶ月超は オブジェクトストレージ Glacier に自動移行 (Lifecycle Policy)。検索画面は 2 経路 (商用データベース 即時 / オブジェクトストレージ 非同期) を提供。',
    state: 'resolved',
    result:
      'ストレージコストが月 50 万円 → 8 万円 に低減 (約 85% 削減)。監査時の検索も非同期で 1 時間以内に対応可能。',
    lessonLearned:
      '監査ログは「保管期間の長さ × 容量」で必ずコストが膨らむ。階層化ストレージ (Hot / Warm / Cold) を設計に組み込む。OLTP DB に長期保管する設計は避ける。',
    riskNature: null,
  },
  {
    parentProjectName: '電子カルテへの服薬指導記録機能追加 (サンプル)',
    type: 'issue',
    title: '既存 SSO 連携で薬剤師アカウントが認証遅延',
    content:
      '本番投入後、薬剤師が初回ログイン時に 30 秒以上待たされる事象が発生。続けて 2 回目以降は通常応答だが、毎日朝の業務開始時に同じ遅延が再発。',
    cause:
      'SSO (SAML) 連携で、薬剤師グループは Active Directory の OU 階層が深く、グループメンバーシップ取得に時間を要していた。さらにキャッシュ TTL が短すぎ (1 時間)、業務開始タイミングに集中して再認証が走るパターンだった。',
    impact: 'medium',
    likelihood: 'medium',
    priority: 'medium',
    responsePolicy:
      'SSO のグループメンバーシップ取得を最適化し、キャッシュ戦略を見直す。',
    responseDetail:
      'AD のグループ取得を「OU 直下」のみに最適化 (深い階層は事前にフラット化)。SSO キャッシュ TTL を 8 時間に延長。さらに認証アサーションのキャッシュ層を Redis に追加し、同一ユーザのアサーションを再利用。',
    state: 'resolved',
    result:
      '初回ログイン応答が 30 秒 → 2 秒に短縮。業務開始時の認証集中時間帯でも遅延ゼロ。',
    lessonLearned:
      'SSO は「テスト環境では速い」が、本番環境のディレクトリ階層・ユーザ数で挙動が変わる。本番相当のディレクトリ構造で性能テストを実施する。SSO キャッシュ戦略は組織のログイン時間帯パターンに合わせる。',
    riskNature: null,
  },
  {
    parentProjectName: '電子カルテへの服薬指導記録機能追加 (サンプル)',
    type: 'risk',
    title: 'テスト環境構築で本番カルテデータの匿名化漏れの懸念',
    content:
      'テスト環境構築のため本番カルテデータを匿名化してコピーする運用だが、匿名化スクリプトが「氏名」「生年月日」のみ対象としており、住所 / 電話番号 / 既往歴の匿名化が漏れていた。プライバシー観点で重大インシデント候補に。',
    cause:
      '匿名化スクリプトの対象項目を要件定義段階で「氏名と生年月日」に絞っていた。住所が部分的に診療判断に使われる (例: 地域別感染傾向) ため「研究用に残す」判断となり、テスト環境にも残ったままになっていた。個人特定可能な PII (Personally Identifiable Information) の概念整理が不十分だった。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      '匿名化対象を PII 全項目 (氏名・生年月日・住所・電話・メール・保険証番号など) に拡大し、研究用は別途承認プロセスを設ける。',
    responseDetail:
      '匿名化対象を 12 項目に拡大。住所は「都道府県のみ」に粒度を落として保持 (研究用)。匿名化スクリプトを CI で自動実行し、本番データを直接テスト環境にコピーする経路を遮断。研究用データ利用は IRB (倫理委員会) 承認必須のフローに変更。',
    state: 'resolved',
    result:
      '匿名化テスト環境への切替完了。プライバシーインシデントは発生せず未然防止。研究プロセスも構造的に整備された。',
    lessonLearned:
      '医療業界の匿名化は「氏名・生年月日のみ」では不十分。PII の概念で全特定可能項目を対象とする。研究目的のデータ利用は IRB 等の専門委員会の承認をフローに組み込む。Day 1 で legal team / 倫理委員会と連携する。',
    riskNature: 'threat',
  },

  // ================================================================
  // Project I (HR / 勤怠 / 給与 SaaS) 配下の課題
  // ================================================================
  {
    parentProjectName: '人事 / 勤怠 / 給与システムの SaaS 統合刷新 (サンプル)',
    type: 'issue',
    title: '人事労務SaaS と KING OF TIME の社員 ID 連携でズレ',
    content:
      '人事労務SaaS を Single Source of Truth として社員情報を管理する設計だったが、KING OF TIME 側の社員 ID マスタが手動メンテナンス時のミスで 100 名以上ズレ。給与計算時にデータ不整合が発生。',
    cause:
      '人事労務SaaS と KING OF TIME の双方向連携を 業務自動化ツールで組んでいたが、双方向ゆえに「どちらが master」が運用上あいまいになっていた。結果として KING OF TIME での手動編集 (退職者を消すなど) が 人事労務SaaS に反映されず、ID 体系がズレていった。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      '人事労務SaaS を完全な master とし、KING OF TIME は片方向 (人事労務SaaS → KING OF TIME) の連携のみに変更する。',
    responseDetail:
      'KING OF TIME での社員 ID 直接編集を禁止 (権限剥奪)。人事労務SaaS から KING OF TIME への片方向同期 (1 時間ごと) に変更。差分があれば 人事労務SaaS を正と見なして KING OF TIME を上書き。整合性チェック cron を毎日実行し、不整合検知時に ビジネスチャット 通知。',
    state: 'resolved',
    result:
      '同期完了後、社員 ID のズレはゼロに。整合性チェック cron も以降の運用で異常なし。',
    lessonLearned:
      'マスタデータの「双方向同期」は運用が破綻しやすい。Single Source of Truth を 1 つに定め、それ以外は片方向同期のみ許可する設計が鉄則。直接編集は権限で防ぐ。',
    riskNature: null,
  },
  {
    parentProjectName: '人事 / 勤怠 / 給与システムの SaaS 統合刷新 (サンプル)',
    type: 'issue',
    title: 'フレックス勤務 / 裁量労働制ロジックを SaaS 標準で表現できず',
    content:
      'KING OF TIME の標準機能では「コアタイム + フレキシブルタイム」のフレックス勤務、「みなし時間 + 健康確保措置」の裁量労働制を完全に表現できず、月次集計に手動補正が必要な状態が続いた。給与計算時の不整合が懸念。',
    cause:
      '日本の労働法に基づく多様な勤務形態 (フレックス・裁量・変形労働時間制) は、SaaS の標準機能では表現に限界がある。導入前のフィット&ギャップ分析で「99% カバー」と評価したが、その 1% が経営層含む幹部 200 名に該当する重要パターンだった。',
    impact: 'high',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      'KING OF TIME の API を活用し、月次のカスタム集計を ローコード基盤上で実装。差異を給与計算ソフトに渡す前に補正する。',
    responseDetail:
      'ローコード基盤に「勤怠補正アプリ」を構築。KING OF TIME から API で生データを取得し、フレックス・裁量 のロジックを ローコード基盤 カスタム JavaScript で実装。補正後の確定値を給与計算ソフトクラウドの API で投入。各従業員には ローコード基盤上で勤怠サマリを確認・承認する画面を提供。',
    state: 'resolved',
    result:
      '月次給与計算のずれはゼロ。さらに補正ロジックは ローコード基盤で社内エンジニアが保守可能となり、ベンダー依存を回避。',
    lessonLearned:
      'パッケージ SaaS のフィット&ギャップで「99% OK」とされる残り 1% は、組織の重要層 (経営層・専門職) に該当することが多い。1% の重要度を見極め、必要なら拡張ロジックを別途設計する。SaaS と独自実装のハイブリッドは現実的な解。',
    riskNature: null,
  },
  {
    parentProjectName: '人事 / 勤怠 / 給与システムの SaaS 統合刷新 (サンプル)',
    type: 'risk',
    title: '給与計算ソフトクラウドの仕様変更で連携 break のリスク',
    content:
      '給与計算ソフトクラウドが過去 1 年で 3 回の API 仕様変更 (フィールド追加・削除・型変更) を実施。連携実装はその度に修正が必要となり、変更通知が直前 (リリース 2 週間前等) に来るケースもあった。今後の運用継続性に懸念。',
    cause:
      '給与計算特化の SaaS は法改正への追従で頻繁に仕様変更が発生する。ベンダー側のリリースノート購読は登録していたが、API 仕様変更まで詳細に把握していなかった。連携層 (ローコード基盤 カスタム JavaScript) の自動テストも整備されておらず、変更検知が手動依存。',
    impact: 'medium',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      'API 連携層を契約テスト + 自動回帰テストで保護し、ベンダー仕様変更時の影響を CI で即座検知する。',
    responseDetail:
      'ローコード基盤 カスタム JavaScript に Jest 単体テスト整備。API レスポンスのスキーマ検証を Zod で実装。さらに給与計算ソフトのステージング環境を契約し、ベンダー仕様変更時の事前検証ができる体制に。月次で給与計算ソフトのリリースノートを確認するチェック手順を運用ルール化。',
    state: 'in_progress',
    result:
      '体制構築 4 ヶ月で、過去 2 回のベンダー仕様変更を CI で事前検知し、本番影響ゼロで対応完了。運用継続性のリスクは大幅に低下。',
    lessonLearned:
      'SaaS 連携は「ベンダー側の仕様変更」が継続的に発生する前提で設計する。契約テスト + スキーマ検証 + ベンダーのステージング環境利用 の 3 点セットで保護する。法改正対応が頻繁な業務 (給与・税務) は特に変更頻度が高い。',
    riskNature: 'threat',
  },
  {
    parentProjectName: '人事 / 勤怠 / 給与システムの SaaS 統合刷新 (サンプル)',
    type: 'issue',
    title: 'マイナンバー収集で従業員からの返信遅延でリリース 1 ヶ月延期',
    content:
      '人事労務SaaS への切替時にマイナンバー再収集が必要となり、全社員 1,200 名から収集を開始。しかし返信率は 1 ヶ月で 60% 止まり、人事労務SaaS 切替リリースが 1 ヶ月延期となった。',
    cause:
      '従業員への依頼メール 1 通で済ませていた。マイナンバー収集の重要性・期限・返信方法の周知が不十分。海外赴任中の社員、休職中の社員等の特殊ケースも考慮していなかった。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      'マイナンバー収集を多段階リマインド + ハイブリッド (オンライン + 郵送) で実施し、特殊ケース別の専用フローを準備する。',
    responseDetail:
      '初回メール → 1 週間後リマインド → 2 週間後個別電話 → 3 週間後郵送依頼 のステップを実装。海外赴任者には PDF 暗号化メールでの収集を提供。休職中社員は人事部からの個別フォローアップ。最終収集率を 100% 達成するまでフォロー継続。',
    state: 'resolved',
    result:
      '計画より 1 ヶ月遅れたが、最終的に 1,200 名全員から収集完了。人事労務SaaS への切替が完了。',
    lessonLearned:
      '従業員からの個人情報収集は「メール 1 通」で完了しない。多段階リマインド + 個別フォロー + 特殊ケース対応 の 3 点を最初から計画する。返信率は「1 通で 50%」程度と見積もり、フォローのバッファを確保する。',
    riskNature: null,
  },

  // ================================================================
  // Project J (B2C ヘルスケアアプリ) 配下の課題
  // ================================================================
  {
    parentProjectName: 'B2C ヘルスケアアプリの新規開発 (サンプル)',
    type: 'issue',
    title: 'iOS 17 リリース直後の 健康データ連携 権限挙動変化で機能失敗',
    content:
      'リリース 2 週間後、iOS 17 がリリースされ 健康データ連携 権限の取得 UX が変更。ユーザの 60% が初回権限ダイアログで「許可しない」を選択し、歩数・心拍数の取得不能に。MAU が想定の 40% で停滞。',
    cause:
      'iOS 17 では 健康データ連携 権限ダイアログのデフォルトボタンが「許可しない」に近い位置に変更された。さらに 1 度「許可しない」を選ぶと、設定アプリから手動許可が必要となり再依頼の UX も劣化。リリース前の OS バージョンチェックで対応していなかった。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      '権限依頼前に「なぜ必要か」を説明する画面を挟む onboarding を実装し、ユーザの理解度を上げてから権限ダイアログを表示する。',
    responseDetail:
      'アプリ起動時に「健康データの活用方法」を 3 ステップで説明する onboarding を追加。各ステップで「これに同意しますか?」のミニ確認を入れ、ユーザの心理的準備を整える。健康データ連携 権限ダイアログはこの後で表示。さらに iOS の開発者向けカンファレンス のリリースノートを毎年 6 月に確認する運用を新設。',
    state: 'resolved',
    result:
      '改修後の権限取得率が 40% → 78% に向上。MAU も想定通りの推移に復帰。',
    lessonLearned:
      'モバイルアプリは OS のメジャーアップデート時に挙動が変わる。iOS の開発者向けカンファレンス / Android の開発者向けカンファレンス のリリースノートを定期確認し、Beta 版での動作テストを習慣化する。プライバシー権限は「依頼の文脈」で取得率が大きく変わる。',
    riskNature: null,
  },
  {
    parentProjectName: 'B2C ヘルスケアアプリの新規開発 (サンプル)',
    type: 'issue',
    title: 'アプリストアのレビュー却下 (機能の不明確さを指摘)',
    content:
      '本番リリース前の アプリストア 審査で「機能の説明が不十分で、有料プランの内容が分かりにくい」との理由で 3 回連続却下。リリースが 3 週間遅延し、初期マーケティング施策との連動が崩れた。',
    cause:
      'アプリストアの Guideline 3.1.2 (Subscriptions) に詳述される要件 (有料プラン期間・自動更新・解約方法の明示) を満たしていなかった。プロダクト説明文も技術視点で書かれており、ユーザ向けの分かりやすさに欠けていた。',
    impact: 'high',
    likelihood: 'medium',
    priority: 'high',
    responsePolicy:
      'アプリストア Guideline 3.1.2 を逐条確認し、有料プラン関連の表記を完全準拠に修正する。',
    responseDetail:
      '有料プラン購入画面に「期間 (1 ヶ月 / 1 年)」「自動更新」「解約方法 (アプリストアの購読管理から)」を明記。プロダクト説明文をユーザ視点で書き直し (技術用語を平易な言葉に置換)。アプリストア Connect の Reviewer Notes に「テスト用アカウント」「主要機能の動作確認手順」を詳細記載。',
    state: 'resolved',
    result:
      '次回審査で 1 回目で承認。リリース 3 週間遅延だが、その後の施策には影響を最小化。',
    lessonLearned:
      'アプリストア / アプリストアの Guideline は「個別事例」より「条文の精査」を最初に実施する。有料プラン関連の要件は特に厳格。Reviewer Notes には Reviewer がスムーズに動作確認できる情報を詳細に書く。',
    riskNature: null,
  },
  {
    parentProjectName: 'B2C ヘルスケアアプリの新規開発 (サンプル)',
    type: 'issue',
    title: 'push 通知の opt-in 率が想定 50% → 実測 18%',
    content:
      'push 通知でユーザの継続率を上げる戦略だったが、初回権限ダイアログでの opt-in 率が想定の 50% を大きく下回り 18% に。継続率 (D7 retention) が目標 25% に対して 12% と振るわず、グロース戦略の見直しが必要に。',
    cause:
      'アプリ起動直後 (= ユーザが価値を実感する前) に push 通知の権限ダイアログを表示していた。多くのアプリで「すぐ通知許可を求める」が嫌われる傾向にあるため、ユーザは反射的に「許可しない」を選択していた。',
    impact: 'high',
    likelihood: 'high',
    priority: 'high',
    responsePolicy:
      '権限ダイアログ表示のタイミングを、ユーザが「初めての健康記録を完了した直後」に変更する。',
    responseDetail:
      'onboarding で「歩数記録を試してみる」ステップを追加。記録完了 → 「成果が出ましたね!次回も忘れないようにリマインダ送りますか?」のメッセージ後に push 通知の権限ダイアログを表示。さらに権限拒否したユーザには 7 日後にアプリ内で再依頼の機会を設ける。',
    state: 'resolved',
    result:
      '改修後の opt-in 率が 18% → 62% に向上。D7 retention も 12% → 28% に改善し、目標達成。',
    lessonLearned:
      'モバイル B2C は「権限ダイアログ表示のタイミング」がユーザ獲得を決める。ユーザが価値を実感した直後 (Aha Moment) で依頼する。グロース最適化の小さな UX 改善が KPI を倍にすることがある。',
    riskNature: null,
  },
  {
    parentProjectName: 'B2C ヘルスケアアプリの新規開発 (サンプル)',
    type: 'issue',
    title: '決済サービス サブスク決済の解約 UX が分かりにくく顧客サポート負荷急増',
    content:
      '有料プラン解約方法が分かりにくく、顧客サポートへの「解約方法」「返金してほしい」問い合わせが日 30 件以上。Pre-Series A の小規模チーム (5 名) で対応しきれず、創業者が深夜まで返信する状況が続いた。',
    cause:
      '解約は アプリストアの購読管理 (iOS) または アプリストアの定期購入管理 (Android) からのみ可能。アプリ内に「解約方法」の説明がなく、ユーザは「どこで解約できるか分からない」状態。さらに自動更新の通知タイミングが事前に十分通知されておらず、「気づかず課金された」苦情も多発。',
    impact: 'high',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      'アプリ内に解約方法の明示画面を追加し、自動更新の事前通知 (3 日前) を実装する。',
    responseDetail:
      '設定画面に「サブスク管理」項目を追加。解約方法 (アプリストア / アプリストアへの遷移リンク + 手順の説明) を明示。自動更新 3 日前に push + メール通知を送る。さらに解約理由のアンケート機能も追加し、改善ポイントを発見。',
    state: 'resolved',
    result:
      '顧客サポート問い合わせが日 30 件 → 5 件に減少。チームの本業 (プロダクト改善) に集中できる体制に。',
    lessonLearned:
      'B2C サブスクの解約 UX は「明示と事前通知」が必須。日本の特定商取引法 / 米国の FTC ガイドライン等の法令もこの方向で要求。解約しにくくする設計は短期収益のために長期信頼を失う。Day 1 から「解約しやすさ」を Customer Experience の指標に組み込む。',
    riskNature: null,
  },

  // ================================================================
  // 既存の最後の entry の継続 (Project E の最後の entry)
  // ================================================================
  {
    parentProjectName: 'ローコード基盤による業務アプリ統合プラットフォーム構築 (サンプル)',
    type: 'issue',
    title: '教育後 1 ヶ月で 30% のユーザが 表計算ソフトに逆戻り',
    content:
      '全社員 50 名にユーザ教育 (各 2 時間) を実施し本稼働開始したが、1 ヶ月後の利用ログ調査で 15 名 (30%) が ローコード基盤をほぼ利用せず 表計算ソフトに戻っていた。リーダー層も 表計算ソフト メールで業務指示しており「ローコード基盤を使う動機」が現場で消えていた。',
    cause:
      '教育内容が画面操作中心で、表計算ソフトとの比較で「ローコード基盤を使うメリット」が伝わっていなかった。さらにリーダー層の教育を後回しにしていたため、リーダーが 表計算ソフト ベースで業務指示するパターンが残った。',
    impact: 'high',
    likelihood: 'high',
    priority: 'medium',
    responsePolicy:
      'リーダー層を最初に教育し、リーダーが ローコード基盤で業務指示することで部下の入力動機を作る。',
    responseDetail:
      'リーダー層 8 名に再教育 (各 4 時間、業務シナリオ別の活用方法中心)。リーダーから部下への業務依頼は ローコード基盤上のレコード作成で行うルールを徹底。表計算ソフト メール添付による業務指示を禁止 (3 ヶ月の猶予期間あり)。月次の利用率レポートを部署別に経営層に提示。',
    state: 'in_progress',
    result:
      '3 ヶ月後の利用率調査で 70% → 95% に改善。リーダー層の積極利用が部下にも波及する好循環が確立。',
    lessonLearned:
      'システム導入の成否は「リーダー層の利用」で決まる。リーダーが旧ツール (表計算ソフト) を使い続けると部下も追従する。教育順序は「リーダー → 一般」が鉄則。導入後の利用率モニタリングを月次で行い、低い部署にはピンポイント対応する。',
    riskNature: null,
  },
];

export const SAMPLE_RETROSPECTIVES: SeedSampleRetrospective[] = [
  // ================================================================
  // Project A (ローコード基盤 請求書承認) の振り返り
  // ================================================================
  {
    parentProjectName: '請求書承認ワークフロー構築 (サンプル)',
    conductedDate: '2026-06-15',
    planSummary:
      '4 月着手から 2 ヶ月、要件定義と設計を完了させ、6 月中に ローコード基盤 画面の 80% を完成、業務自動化ツール 主要フロー 5 本のうち 3 本を実装完了することを計画していた。経理部 3 名のキーパーソンとの週次レビューで要件の歪みを早期発見する仕組みも設計の段階で組み込んでいた。',
    actualSummary:
      '要件定義は計画通り 5 月末に完了したが、設計フェーズで「承認権限マトリクス」(金額帯 × 部門 × 役職の 3 軸) の合意が想定以上に紛糾し、2 週間遅延。さらに月末タイミングで経理部キーパーソンが多忙でレビューが取れず、設計確定が 6 月 10 日にずれ込んだ。ローコード基盤の画面は 60% 完成、業務自動化ツール は 2 本完成と計画より 20% 進捗ビハインド。',
    goodPoints:
      '週次レビューが機能し、3 度の要件追加 (代理承認・差戻し・期日リマインダ) を設計確定前に取り込めた。業務自動化ツールのループ問題 (過去事例: 同一メール大量送信) を意識した冪等性ガードを最初から実装し、テスト時の事故ゼロ。経理部からの信頼を獲得しキーパーソンが積極的にプロジェクトに関与する関係性を構築できた。',
    problems:
      '承認権限マトリクスの合意が紛糾した最大要因は、「現状の慣習」(金額帯による暗黙の承認者判断) を明文化していなかったため、議論の土台が共有できなかったこと。月末タイミングのキーパーソン不在は予想可能だったが、リスク登録簿に乗せていなかった。ローコード基盤の画面開発が想定より時間を要したのは、Delegation 制限の理解不足で複数回リファクタリングしたことによる。',
    improvements:
      '次フェーズに向け、(1) 業務ルール (承認・例外処理) は要件定義段階で必ず明文化、(2) キーパーソンの繁忙期 (月末・四半期末) を計画初期にカレンダー化しレビュー時間を別途確保、(3) ローコード基盤の Delegation 対応関数リストを開発開始前に共有 — の 3 点を実施する。スケジュールバッファとして ローコード基盤 画面工程に + 30% を見込む。',
    knowledgeToShare:
      'ローコード基盤 開発で最初に学ぶべきは Delegation 制限と対応関数リスト。ドキュメント管理ツール 大量データを扱う案件は、データ件数の本番想定値で性能テストを設計フェーズに必須項目化する。承認権限マトリクスは「現状ヒアリング」だけでなく「文書化 + 経理部全員の合意」をリリース前に必ず取得する。',
    state: 'confirmed',
  },
  {
    parentProjectName: '請求書承認ワークフロー構築 (サンプル)',
    conductedDate: '2026-10-31',
    planSummary:
      '9 月末本番リリース後の運用 1 ヶ月で、月次クローズ業務時間の 75% 削減 (40 時間 → 10 時間)、紙の物理回付ゼロ、ユーザ満足度 80% を達成することを KPI に置いていた。',
    actualSummary:
      '月次クローズ業務時間は 40 時間 → 12 時間 (70% 削減) に到達。紙の物理回付はゼロ達成。ただしユーザ満足度調査では満足度 65% 止まりで、KPI 未達。具体的には「ローコード基盤の応答速度」と「通知メールがスパム化」の 2 点で苦情多発。両方ともリリース後 2 週間以内に対処済みだが、初期体験の悪さが満足度に影響した模様。',
    goodPoints:
      '紙の物理回付廃止という業務プロセス変革を完遂。経理部のキーパーソンが新システムを推進する社内ヒーローとして認知された。リリース直後の問題に対する 24 時間以内の対応スピードを評価され、次フェーズ (会計連携) も継続契約の見込み。',
    problems:
      '本番想定外のデータ量で発生したパフォーマンス劣化と、メール送信ドメインの SPF/DKIM 未設定によるスパム判定 — どちらも「本番環境特有」の事象で、テスト環境では再現不可能だった。リリース前の段階で「本番相当のデータ量での性能テスト」「メール認証の事前設定」を計画に組み込めていなかった。',
    improvements:
      '次フェーズ (会計連携) に向けて、(1) 本番投入前の性能テストは本番データ量の 100% で実施 (95% 等の縮小は不可)、(2) メール / 通知 / 外部連携の事前設定は計画に明文化されたチェックリストで実施、(3) リリース後 1 ヶ月のサポート体制を「24 時間対応 → 通常 SLA」へ段階移行する。',
    knowledgeToShare:
      'リリース直後の問題は「ユーザ満足度」に長期的影響を与える。技術的には対処可能でも、ユーザの初期印象は覆りにくい。本番環境特有の問題 (データ量・ドメイン認証・ネットワーク経路) を踏まえた事前テストを計画する。リリース後 1 ヶ月の集中サポートは初期不満を抑える鍵。',
    state: 'confirmed',
  },

  // ================================================================
  // Project B (パブリッククラウド マルチアカウント) の振り返り
  // ================================================================
  {
    parentProjectName: '新規 SaaS 基盤のパブリッククラウド マルチアカウント構築 (サンプル)',
    conductedDate: '2026-05-30',
    planSummary:
      'パブリッククラウド Organizations による 6 アカウント構成 (root/security/log-archive/dev/staging/prod/backup) の確定、IaCツール Cloud による IaC 基盤、マネージドコンテナ基盤 サーバレスコンテナ + マネージドRDB の本番アーキテクチャを 2 ヶ月で確定する計画。SOC 2 対応の最低限ベースライン (CloudTrail / GuardDuty / Config) も同時整備。',
    actualSummary:
      'アカウント構成は計画通り 6 アカウント完成。IaCツール 基盤も初期構築完了。マネージドコンテナ基盤 サーバレスコンテナ 本番アーキテクチャは確定したが、マネージドRDB のフェイルオーバ挙動でアプリ側の対応漏れが演習で発覚し、設計を見直すことに。さらに IaCツール state ロック競合の事故が 2 件発生。SOC 2 ベースラインは予定通り完了。',
    goodPoints:
      'マルチアカウント設計を最初に確定したことで、各環境のリソース分離が明確に。SOC 2 ベースライン (CloudTrail / GuardDuty / Config) を初期構築段階に組み込んだことで、後追いコストを抑えられた。監視SaaS 監視も初期から設定したため、マネージドRDB フェイルオーバ問題を発見できた。',
    problems:
      'IaCツール Cloud への移行を「あとで」と先送りした結果、state ロック競合事故が発生した。マネージドRDB フェイルオーバはマネージド任せで「アプリ側で対応不要」と楽観視していた認識が誤り。両者とも「初期構築段階での未検証事項」が後の事故につながった。',
    improvements:
      'IaC は「複数人作業前提」で Day 1 に環境整備 (state ロック / CI/CD / drift detection)。マネージドサービスのフェイルオーバ挙動は「ドキュメント確認 + 実機検証」を設計フェーズで実施。本番リリース前のフェイルオーバ演習を必須マイルストーンとして計画に組み込む。',
    knowledgeToShare:
      'パブリッククラウド 環境構築は「セキュリティ・運用 + 開発」の両輪を最初から組み込まないと後追いコストが膨らむ。IaCツールの state ロック・CI/CD 連携は Day 1 の必須準備項目。マネージド DB の信頼性は「DB 単体」で評価せず「アプリ含む End-to-End」で検証する。',
    state: 'confirmed',
  },
  {
    parentProjectName: '新規 SaaS 基盤のパブリッククラウド マルチアカウント構築 (サンプル)',
    conductedDate: '2026-09-30',
    planSummary:
      '8 月本番リリース後 1 ヶ月の運用安定性確認、SLO (可用性 99.9%、応答時間 P95 200ms) 達成、月次 パブリッククラウド コスト目標 8,000 USD 以内、災害対策演習 (DR Drill) の月次実施を計画。',
    actualSummary:
      '可用性は 99.92% で SLO 達成。応答時間 P95 は 180ms で SLO 達成。月次コストは 7,200 USD で予算内。災害対策演習は月 1 回実施し、復旧時間 90 秒以内を継続維持。1 ヶ月運用で計画外障害は 1 回 (CDN キャッシュ汚染、12 分ダウンタイム) のみ。',
    goodPoints:
      'マネージドサービス (マネージドコンテナ基盤 / マネージドRDB / CDN) の安定性が予想を上回り、運用負荷が想定の半分。監視SaaS 監視 + ビジネスチャット アラート連携で、潜在的な問題を本番影響前に察知できる体制が機能。災害対策演習が習慣化したことで、本番障害発生時 (CDN 事故) も冷静に Incident Commander が指揮を取り、ユーザ影響を最小化。',
    problems:
      'CDN キャッシュ汚染事故は「キャッシュビヘイビアのデフォルト ON」設計が原因で、リリース前の検証不足。新人エンジニアが「CDN の挙動を理解していない状態」でデプロイできてしまった点も組織的課題。応答時間 P95 が想定より良好 (200ms 目標 → 180ms 実測) は予想外で、当初の マネージドRDB インスタンスサイズが過剰だった可能性。',
    improvements:
      '次フェーズに向けて、(1) CDN / WAF / 認証の挙動はリリース前の自動レスポンスヘッダ検査を CI に追加、(2) 新人エンジニアのオンボーディング教材に「クラウドサービスの基本挙動」モジュールを追加、(3) マネージドRDB インスタンスサイズの最適化検証 (1 サイズダウンしてもパフォーマンス維持できるか) で月次コスト削減を試算。',
    knowledgeToShare:
      'CDN / キャッシュ層は「デフォルト OFF + 個別 ON」が原則。デフォルト ON は事故源。レスポンスヘッダ検査は CI で自動化。クラウドのインスタンスサイズは「リリース後の実測」で最適化する。監視SaaS / ビジネスチャット 連携は本番運用の必須インフラ。',
    state: 'confirmed',
  },

  // ================================================================
  // Project C (SFA/CRMツール) の振り返り
  // ================================================================
  {
    parentProjectName: 'SFA/CRMツールによる営業活動可視化 (サンプル)',
    conductedDate: '2026-04-30',
    planSummary:
      '既存 表計算ソフト 顧客マスタ 3,000 件の SFA/CRMツール 移行、データクレンジング、Duplicate Rule 設定を 1 ヶ月で完了させる計画。並行して営業現場の利用シナリオヒアリングも完了し、ダッシュボード設計の前提を確定する。',
    actualSummary:
      'データ移行は 2 週間遅延。原因は 表計算ソフトの表記揺れによる重複登録 (3,000 件中 800 件) で、後処理クレンジングに想定の 3 倍の工数が必要となった。営業現場ヒアリングは計画通り完了し、ダッシュボード設計の前提も確定。',
    goodPoints:
      '営業現場ヒアリングを計画通り進められたことで、ダッシュボード要件が明確化。プロジェクト全体の遅延を吸収する余地が生まれた。データクレンジングを通じて、顧客マスタの実態 (重複・表記揺れ) を可視化でき、運用ルール策定にもつながった。',
    problems:
      'データ移行の見積りが甘かった。SFA/CRMツール Duplicate Rule に依存した「移行後クレンジング」設計は、表記揺れの大量重複には機能しなかった。移行前の Pre-Migration Cleansing を必須工程として位置付けていれば回避できた事象。',
    improvements:
      'データ移行は (1) 元データの実態調査 (重複率・表記揺れ・欠損率) を先に実施、(2) 必要な正規化処理を移行スクリプトに組み込む、(3) SFA/CRMツール 機能 (Duplicate Rule) は「補助」として使う — の 3 段階で計画する。次フェーズ (カスタムロジック Trigger 開発) では bulk-safe な実装パターンを最初から導入する。',
    knowledgeToShare:
      'パッケージ製品の機能 (SFA/CRMツール Duplicate Rule など) は「補助手段」であり「主軸」ではない。データ移行の主軸は移行スクリプトでの正規化処理。元データの実態調査 (重複率調査・表記揺れ調査) は移行計画策定の必須工程。',
    state: 'confirmed',
  },
  {
    parentProjectName: 'SFA/CRMツールによる営業活動可視化 (サンプル)',
    conductedDate: '2026-07-15',
    planSummary:
      '営業 30 名への研修プログラム実施 (各 4 時間)、本稼働開始、リリース 1 ヶ月後の利用率 90% 達成を目標。マネージャ層 (8 名) には事前に追加研修 (各 4 時間) を実施し、SFA/CRMツール ベースの週次案件レビュー文化を醸成。',
    actualSummary:
      '研修プログラムは計画通り実施。リリース 1 ヶ月後の利用率調査では入力率 92% に達し、目標を達成。ただし研修直後 (3 ヶ月時点) は 60% で、マネージャ層の利用習慣化に伴い改善した経緯。SFA/CRMツール ベースの週次案件レビュー文化は定着し、マネージャの集計業務時間が週 8 時間 → 1 時間に減少。',
    goodPoints:
      'マネージャ層を最初に教育する戦略が機能した。マネージャが SFA/CRMツール上で業務を行うことで、現場の入力動機が継続。週次案件レビュー文化の定着で「データを見て判断する」経営判断のスピードが向上し、経営層からの評価も高い。',
    problems:
      '研修直後 (1 ヶ月時点) の利用率が 60% と低かったのは、初期教育内容が「画面操作中心」で「業務との関連性」が伝わりにくかったため。マネージャ層の追加研修・週次レビュー文化醸成までの 2 ヶ月間は試行錯誤期間で、現場からの不満も少なくなかった。',
    improvements:
      '次プロジェクトでは (1) 教育内容を「業務シナリオ × 画面操作」のハイブリッドに改善、(2) リーダー教育を 2 週間前倒しでマネージャ層の習熟期間を確保、(3) 利用率の月次モニタリング + 部署別フィードバックを Day 1 で計画に組み込む。',
    knowledgeToShare:
      '組織変革プロジェクトの成功は「リーダー層の利用」で決まる。リーダーが旧ツール (表計算ソフト) を使い続けると部下も追従する。教育順序は「リーダー → 一般」が鉄則。利用率は「導入直後 60% → 3 ヶ月後 90%」のような曲線を描くことが多く、初期の不安を抱え込まず計画通りに継続する。',
    state: 'confirmed',
  },

  // ================================================================
  // Project D (ERPパッケージ) の振り返り
  // ================================================================
  {
    parentProjectName: 'ERPパッケージへの基幹システム移行 (サンプル)',
    conductedDate: '2026-04-30',
    planSummary:
      '1 月着手から 4 ヶ月、Fit&Gap 分析を完了し、ERPアドオン言語 カスタム機能の現行/移行方針を確定する計画。マスタ統合 (品目 15 万件・取引先 8 千件) の方針も確定し、本格的な移行作業に入るためのマイルストーン。',
    actualSummary:
      'Fit&Gap 分析は計画通り完了。ただし ERPアドオン言語 カスタム機能の互換性チェック (Custom Code Migration Cockpit) で 30% (240 本) が廃止 API 使用と判明し、想定より大規模な置換作業が必要に。マスタ統合は品目重複問題で 2 ヶ月遅延の見込み。プロジェクト全体は計画より 2-3 ヶ月遅延の見通し。',
    goodPoints:
      'Custom Code Migration Cockpit による事前互換性チェックを実施したことで、本格移行前に問題を発見できた。マスタ統合の品目重複問題も、AI + 熟練者目視のハイブリッドで対応方針を確立。手戻りを最小化する基盤が整った。',
    problems:
      '初期計画段階で Custom Code Migration Cockpit を実施していなかった。マスタ統合の方針 (命名ルール・判定基準) を先に確定しなかったため、データクレンジング工数が 2 倍になった。両者ともリスクとして登録簿に上げていれば早期に対応できた。',
    improvements:
      '次フェーズ (本格移行) に向けて、(1) ERPアドオン言語 廃止 API 置換は Quick Fix と手動実装のハイブリッドで進める、(2) マスタ統合の最終確認は購買担当ベテランの目視確認で品質を担保、(3) 月次マイルストーン進捗を可視化 (Burn-down chart) し、想定外遅延を早期検知する仕組みを導入。',
    knowledgeToShare:
      'ERPのメジャーバージョンアップは「コード互換性チェック」を要件定義段階で必ず実施。ベンダーの診断ツール (Custom Code Migration Cockpit / Database Migration Assistant) は Day 1 で実行する。マスタ統合は「データ統合」より「定義統合」が先。命名ルール・判定基準の合意なく統合は不可能。',
    state: 'confirmed',
  },

  // ================================================================
  // Project E (ローコード基盤) の振り返り
  // ================================================================
  {
    parentProjectName: 'ローコード基盤による業務アプリ統合プラットフォーム構築 (サンプル)',
    conductedDate: '2026-09-30',
    planSummary:
      '12 アプリ全構築完了、社員 50 名の研修プログラム実施、本稼働開始 (10 月 1 日) を 4 月着手から 6 ヶ月で達成する計画。情シス担当 1 名 + 兼任 2 名で運用可能な持続性を確保。',
    actualSummary:
      '12 アプリの構築は計画通り完了。研修プログラムも 50 名全員に実施。ただし運用フェーズで「情シス 1 名で全保守は持続不可能」「JavaScript カスタムが他者に読めない」「ユーザ 30% が 表計算ソフトに逆戻り」などの問題が顕在化し、追加対応に 3 ヶ月を要した。',
    goodPoints:
      '12 アプリの構築自体は ローコード基盤のローコード性により計画通り完成。各部署の業務を統一プラットフォーム上に集約できた点は事業価値として大きい。Citizen Developer 育成 (各部署 1 名 = 計 5 名) を後追いで実施し、運用持続性を確保できた。',
    problems:
      'プロジェクト計画段階で「運用持続性」を技術面のみで評価し、「組織面 (Citizen Developer 育成)」を考慮していなかった。早期の JavaScript カスタムにコーディング規約・コードレビューがなく技術負債化。教育内容が画面操作中心で、リーダー層の利用率が低かったことで部下の利用率にも影響。',
    improvements:
      '次プロジェクトでは (1) ローコード導入時から Citizen Developer 育成を計画に組み込む、(2) JavaScript カスタムは Day 1 で規約 + レビュー文化を整備、(3) リーダー層教育を最初に実施し、リーダーが新ツールで業務を行うことで部下の利用率を確保する。',
    knowledgeToShare:
      'ローコードツールの真価は「Citizen Developer」育成で初めて発揮される。情シス専任 1 名で全運用は持続しない。導入時から「ユーザ側に管理者を作る」教育投資を計画に含める。コーディング規約・レビュー文化はローコードでも必須。',
    state: 'confirmed',
  },

  // ================================================================
  // Project F (マイクロサービス) の振り返り
  // ================================================================
  {
    parentProjectName: 'EC サイト基幹システムのマイクロサービス化 (サンプル)',
    conductedDate: '2026-08-31',
    planSummary:
      '12 ヶ月計画の Phase 1 (注文ドメイン分離) を 6 ヶ月で完了させる計画。Strangler Fig パターンで段階移行、Spring Boot + Kotlin + Kafka + Kubernetes の本番アーキテクチャを確立。',
    actualSummary:
      '注文ドメイン分離は予定通り 6 ヶ月で完了。本番リリース後 2 ヶ月で安定稼働。リリース頻度は月 1 回 → 月 3 回に向上 (目標週 5 には未達)。Phase 2 (在庫ドメイン) の準備に着手したが、共有 DB スキーマ分離時の依存検出問題と Kafka イベント整合性問題で当初設計の見直しが発生。',
    goodPoints:
      'Strangler Fig パターンによる段階移行が機能し、本番影響を最小化。Spring Boot + Kotlin + Kafka + Kubernetes のアーキテクチャは安定稼働。サービスメッシュ (Istio) によるリトライ・タイムアウト集中管理が機能し、サービス間連鎖障害を防止できた。',
    problems:
      'Phase 1 で発生した問題 (DB 依存検出漏れ・Kafka 整合性問題) の根本原因はマイクロサービス特有の「分散システム」の難しさ。Conway の法則どおり、組織の調整コスト (4 チーム間の API 互換性) も想定以上で、リリース頻度の目標 (週 5) には到達できなかった。',
    improvements:
      'Phase 2 以降に向けて、(1) DB 依存検出は静的検索 + 動的トレースのハイブリッドで網羅、(2) Kafka イベント連携には Saga 補償ロジックを最初から実装、(3) 組織側の調整 (Pact 契約テスト・Incident Commander 専任化・Postmortem 文化) を Phase 2 開始前に整備する。',
    knowledgeToShare:
      'マイクロサービスは技術ではなく組織の課題が最大のボトルネック。リリース頻度向上は「技術 < 組織 < 文化」で時間がかかる。Saga 補償ロジックは「実装する前提」で工数見積に必ず含める。共有 DB の分離時は動的トレースで実行時依存を可視化する。',
    state: 'confirmed',
  },

  // ================================================================
  // Project G (クラウドDWH DWH) の振り返り
  // ================================================================
  {
    parentProjectName: '全社データ統合 + BI ダッシュボード構築 (サンプル)',
    conductedDate: '2026-08-31',
    planSummary:
      '4 月着手から 5 ヶ月、クラウドDWH DWH 構築、ELTツール による変換層構築、BIツール ダッシュボード 3 系統 (経営/マネージャ/担当者) を完成させ、9 月本稼働開始を計画。',
    actualSummary:
      'クラウドDWH DWH と BIツール ダッシュボードは計画通り完成し、9 月本稼働開始。ただし初回 ETL でクレジット消費が想定の 5 倍となり、コスト最適化作業に 1 ヶ月を要した。ELTツール model の依存グラフが複雑化し、レイヤ分離リファクタリングも追加実施。BI ユーザの権限設計問題も発見・修正済み。',
    goodPoints:
      '計画通りの本稼働を達成。経営層からの追加質問に「翌営業日まで持ち帰り」が解消され、リアルタイムでデータドリブンな判断ができる体制を構築。データアナリスト 2 名の社内育成も並行して進行。',
    problems:
      'クラウドDWH のコスト管理は「設定の妥当性」が直結する事を、初期構築時に深く理解していなかった。ELTツール model の設計も「とりあえず作って後で整理」スタンスで、レイヤ責務分離を最初に決めなかった結果、依存地獄になった。BI ユーザの権限設計も クラウドDWH のロール体系を初期から設計しなかったため、後で大幅見直しが必要に。',
    improvements:
      '次プロジェクトでは (1) クラウド DWH は Day 1 で Resource Monitor / Warehouse 自動サイズ変更 / ELTツール incremental を必須設定、(2) ELTツール model は 4 レイヤ (raw/staging/intermediate/mart) の責務分離を初期設計で確定、(3) ロール体系 (BI ユーザ / ELTツール エンジニア等) は Day 1 で最小権限原則で設計する。',
    knowledgeToShare:
      'クラウド DWH は「設定の妥当性」がコスト直結。Warehouse サイズ・auto-suspend・incremental 設定・実行プランの 4 点を初期設計で詰める。データ変換層もアーキテクチャ設計が必要 (レイヤ分離なくモデルを書き続けると依存地獄)。データ基盤は Day 1 で「ロール体系 + 最小権限原則」を設計する。',
    state: 'confirmed',
  },

  // ================================================================
  // Project H (電子カルテ) の振り返り
  // ================================================================
  {
    parentProjectName: '電子カルテへの服薬指導記録機能追加 (サンプル)',
    conductedDate: '2026-12-15',
    planSummary:
      '5 月着手から 7 ヶ月、服薬指導モジュール開発、HL7 FHIR 準拠データ構造、医療情報システム安全管理ガイドライン対応、12 月本番リリースを計画。',
    actualSummary:
      'モジュール開発は計画通り完了。本番リリースは予定通り 12 月実施。リリース 2 週間後の運用調査で、薬剤師 1 人あたりの 1 日処理件数が 30 件 → 50 件に向上 (KPI 達成)。ただしリリース直後にログイン応答遅延・監査ログコスト・SSO 認証遅延の 3 件の運用問題が連続発生し、対応に 3 週間を要した。',
    goodPoints:
      'KPI (薬剤師の処理件数 50 件) を達成。HL7 FHIR 準拠の設計は将来の他システム連携 (薬局チェーン等) への拡張性を確保。医療情報システム安全管理ガイドラインも legal team の最終承認を取得し、コンプライアンス上の懸念ゼロでリリース。',
    problems:
      'リリース直後の 3 連続問題は「本番環境特有の事象」だった。テスト環境ではデータ量・ディレクトリ構造・ストレージコストが本番と乖離しており、本番投入で初めて発覚。事前テスト計画の「本番相当性」が不十分だった。',
    improvements:
      '次フェーズ (薬局チェーン連携) に向けて、(1) テスト環境は本番相当のデータ量・ディレクトリ構造で構築、(2) 監査ログ・ログ保管・コスト計画を Day 1 で詳細設計、(3) リリース後 1 ヶ月の集中サポート体制を計画に明記する。',
    knowledgeToShare:
      '医療業界のシステム改修は「規制対応」「監査対応」が最優先。Day 1 で legal team / 倫理委員会と連携する。テスト環境は「本番相当性」を要件で定義しないと運用フェーズで事故が頻発する。監査ログは保管期間 × 容量で必ずコストが膨らむため、階層化ストレージを設計に組み込む。',
    state: 'confirmed',
  },

  // ================================================================
  // Project I (HR / 勤怠 / 給与 SaaS) の振り返り
  // ================================================================
  {
    parentProjectName: '人事 / 勤怠 / 給与システムの SaaS 統合刷新 (サンプル)',
    conductedDate: '2026-09-30',
    planSummary:
      '4 月着手から 6 ヶ月、人事労務SaaS + KING OF TIME + 給与計算ソフトクラウド の 3 SaaS 統合構成、データ移行 1,200 名分、フレックス勤務ロジック実装、10 月切替リリースを計画。',
    actualSummary:
      'SaaS 連携基盤は計画通り完成。データ移行はマイナンバー収集の遅延で 1 ヶ月延期 (11 月リリースへ)。フレックス勤務ロジックは SaaS 標準で表現できず ローコード基盤 カスタムでの補完実装に。人事労務SaaS と KING OF TIME の社員 ID ズレ問題も発見・修正済み。',
    goodPoints:
      'SaaS 3 社統合という非自明な構成を実現できた。ローコード基盤を連携ハブとする設計は、フレックス勤務ロジックなどのカスタムを社内エンジニアで保守可能とし、ベンダー依存を回避。法改正対応も SaaS 提供側に移管されることで、人事部の運用負荷が大幅に低減する見込み。',
    problems:
      'マイナンバー収集の見積りが甘かった (1 通の依頼メールで完了する想定)。フレックス勤務ロジックを「99% 標準で OK」と評価したが、残り 1% が経営層含む幹部 200 名に該当する重要パターンだった。社員 ID 連携も「双方向同期で OK」と判断したが運用上破綻。',
    improvements:
      'リリース後の運用に向けて、(1) 給与計算ソフトクラウドの API 仕様変更を継続的に監視、(2) フレックス勤務ロジックの社内ドキュメントを整備し、保守可能性を担保、(3) Single Source of Truth の原則を全マスタデータに適用する。',
    knowledgeToShare:
      'SaaS 統合は「Single Source of Truth」を 1 つに定め、それ以外は片方向同期のみ許可するのが鉄則。フィット&ギャップで「99% OK」とされる残り 1% は組織の重要層に該当することが多く、軽視できない。マイナンバー収集など個人情報依頼は多段階リマインドが必須。',
    state: 'confirmed',
  },
  {
    parentProjectName: '人事 / 勤怠 / 給与システムの SaaS 統合刷新 (サンプル)',
    conductedDate: '2026-12-15',
    planSummary:
      '11 月切替リリース後 1 ヶ月の運用安定性確認、給与計算の正確性 100%、人事部担当者の二重入力業務時間ゼロ達成を目標。',
    actualSummary:
      '11 月の切替リリースは無事完了。12 月の給与計算も 人事労務SaaS + KING OF TIME + 給与計算ソフト の連携で正常動作。人事部担当者の二重入力業務はゼロに。ただし給与計算ソフトクラウドの API 仕様変更が 11 月末に発生し、連携層に修正対応が必要となった。事前検知できたためインシデント化せず対応完了。',
    goodPoints:
      '切替リリースが無事完了。給与計算の正確性 100% を達成。人事部担当者 1 名分の業務時間 (二重入力) を完全に削減でき、戦略業務 (人材開発・組織開発) への集中が可能に。給与計算ソフト API 仕様変更も契約テスト + ステージング環境契約で事前検知できた。',
    problems:
      '給与計算ソフトクラウドの API 仕様変更は今後も継続的に発生する見込みで、運用負荷が読みにくい。フレックス勤務ロジックの ローコード基盤 カスタムは現状動作中だが、保守者が 1 名のみで属人化リスク。',
    improvements:
      '長期運用に向けて、(1) 給与計算ソフトクラウドの API 仕様変更は月次でリリースノート確認 + 契約テスト自動化を継続、(2) ローコード基盤 カスタムの保守可能者を 2 名に増やす (バス係数 1 → 2)、(3) 法改正対応の運用フローを文書化。',
    knowledgeToShare:
      'SaaS 連携は「ベンダー側の仕様変更」が継続的に発生する前提で運用設計する。契約テスト + スキーマ検証 + ベンダーのステージング環境契約 の 3 点セットで保護する。法改正対応が頻繁な業務 (給与・税務) は特に変更頻度が高い。属人化対策は最低 2 名での保守体制を Day 1 で確保する。',
    state: 'confirmed',
  },

  // ================================================================
  // Project J (B2C ヘルスケアアプリ) の振り返り
  // ================================================================
  {
    parentProjectName: 'B2C ヘルスケアアプリの新規開発 (サンプル)',
    conductedDate: '2026-08-31',
    planSummary:
      '4 月着手から 4 ヶ月、React Native iOS/Android アプリ開発、モバイルバックエンド(BaaS) Auth + マネージドNoSQL バックエンド、健康データ連携 / 健康データ連携連携、決済サービス サブスク決済、9 月本番リリースを計画。クローズドベータ 1,000 名運営。',
    actualSummary:
      'アプリ開発は計画通り完了。クローズドベータも 1,000 名で完了し、フィードバック収集 + 改善も実施。本番リリースは アプリストア 審査の連続却下で 3 週間遅延 (9 月 → 10 月) になる見込み。push 通知 opt-in 率が想定 50% → 実測 18% で、グロース戦略も並行で見直し中。',
    goodPoints:
      'クローズドベータでユーザフィードバックを早期に収集できたことで、本番投入前に多くの UX 改善 (onboarding 順序・記録画面のシンプル化等) を実施できた。モバイルバックエンド(BaaS) + React Native の構成は小規模チームで開発効率が高く、6 名で 4 ヶ月での実装を達成。',
    problems:
      'アプリストア 審査の連続却下は、Guideline 3.1.2 (Subscriptions) の要件確認不足。push 通知 opt-in 率の想定値 (50%) が楽観的すぎた。両者とも「事前リサーチ不足」が原因で、ベータ段階で気付けなかった。',
    improvements:
      '本番リリースに向け、(1) アプリストア / アプリストアの Guideline 関連項目を逐条チェックリスト化、(2) push 通知の権限ダイアログ表示タイミングを Aha Moment 後に変更、(3) 決済サービス サブスクの解約 UX 改善を Day 1 で実装。',
    knowledgeToShare:
      'モバイル B2C は「権限ダイアログ表示のタイミング」がユーザ獲得を決める。ユーザが価値を実感した直後 (Aha Moment) で依頼する。アプリストア / アプリストアの Guideline は条文の精査を最初に実施する。クローズドベータは「ユーザフィードバック収集」のための最重要マイルストーンとして位置付ける。',
    state: 'confirmed',
  },
  {
    parentProjectName: 'B2C ヘルスケアアプリの新規開発 (サンプル)',
    conductedDate: '2026-12-15',
    planSummary:
      '10 月本番リリース後 2 ヶ月、MAU 1 万 + 有料転換率 5% の達成、D7 retention 25% 維持、決済サービス サブスクの解約率 5% 以下を目標。',
    actualSummary:
      'MAU は 12 月時点で 1.2 万に到達 (目標達成)。有料転換率は 4.8% (目標 5% にわずか未達、改善継続中)。D7 retention は改修後 28% で目標達成。サブスク解約率は 4% で目標内。決済サービス サブスク解約 UX 改善で顧客サポート問い合わせも日 30 件 → 5 件に減少。',
    goodPoints:
      'MAU・retention・解約率の主要 KPI を達成し、Series A 調達への足場を構築。健康データ連携 権限取得率の改善 (40% → 78%) と push 通知 opt-in 率の改善 (18% → 62%) はそれぞれグロースに大きく貢献。決済サービス サブスク解約 UX 改善で顧客サポート負荷を大幅軽減し、本業 (プロダクト改善) に集中できる体制に。',
    problems:
      '有料転換率が目標 5% に対して 4.8% でわずか未達。iOS 17 リリース直後の 健康データ連携 権限挙動変化など、外部要因によるトラブル対応で 2 週間以上を消費。スタートアップの Runway 制約上、外部要因対応の計画的バッファが不足していた。',
    improvements:
      'Series A 調達後のフェーズに向けて、(1) 有料転換率向上のため有料プランの差別化強化、(2) iOS / Android のメジャーアップデート対応バッファを四半期計画に明記、(3) ユーザインタビュー定常化で UX 改善の継続的なネタ確保。',
    knowledgeToShare:
      'B2C モバイルアプリは「外部要因 (OS update / ストア審査基準変更 / プライバシー規制変化)」を継続的に踏まえる必要がある。Runway 制約のあるスタートアップでは、外部要因対応のバッファを四半期計画に必ず確保する。Aha Moment 設計とサブスク UX は B2C アプリの最重要 KPI ドライバ。',
    state: 'confirmed',
  },
];

// ================================================================
// PR-X5 (5-7): 事前生成 embedding JSON 統合
// ================================================================

const SEED_EMBEDDINGS_PATH = join(__dirname, 'seed-suggestion-embeddings.json');
const EMBEDDING_DIMENSIONS = 1024;

/**
 * シードデータ用の安定キー生成。同一の identifier (title 等) からは同じハッシュを返すため、
 * シード内容を後から修正しても、JSON 側に同 key の embedding があれば再利用可能。
 *
 * @param identifier ハッシュ対象の文字列 (例: knowledge.title, issue.title 等)
 */
export function seedHashKey(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 16);
}

export function knowledgeKey(k: { title: string }): string {
  return seedHashKey(k.title);
}

export function issueKey(i: { title: string; parentProjectName: string }): string {
  // 同じタイトルでも親プロジェクトが違えば別 issue として扱う (sample data 内重複対策)
  return seedHashKey(`${i.parentProjectName}|${i.title}`);
}

export function retroKey(r: {
  parentProjectName: string;
  conductedDate: string;
  planSummary: string;
}): string {
  // 同 project の同日付の振り返りはそうそう無いが、planSummary を加えてさらに固有化
  return seedHashKey(`${r.parentProjectName}|${r.conductedDate}|${r.planSummary.slice(0, 200)}`);
}

export function sampleProjectKey(p: { name: string }): string {
  return seedHashKey(p.name);
}

/**
 * seed-suggestion-embeddings.json を読み込んで構造を返す。
 * ファイル不在 / JSON parse エラー時は空構造を返す (= embedding なしで seed を投入する縮退モード)。
 */
export function loadSeedEmbeddings(): SeedEmbeddingsJson {
  try {
    const raw = readFileSync(SEED_EMBEDDINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SeedEmbeddingsJson>;
    return {
      _meta: parsed._meta,
      knowledges: parsed.knowledges ?? {},
      issues: parsed.issues ?? {},
      retrospectives: parsed.retrospectives ?? {},
      projects: parsed.projects ?? {},
    };
  } catch (error) {
    console.warn(
      `⚠ seed-suggestion-embeddings.json の読込に失敗: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    console.warn('   → embedding なしで seed 投入を継続します (縮退モード)');
    return {
      knowledges: {},
      issues: {},
      retrospectives: {},
      projects: {},
    };
  }
}

/**
 * 事前生成 embedding を該当行へ書き込む helper。
 *   - JSON に該当 key がない場合は console.warn して NULL のままスキップ (= 後追い再生成で復旧可能)
 *   - 寸法が EMBEDDING_DIMENSIONS と異なる場合はエラーで終了 (=破損 JSON は早期検知)
 *
 * SQL injection 対策: tableName は呼出側で固定文字列指定、自動 parametrized binding で値を bind。
 */
async function applyEmbedding(
  prisma: PrismaClient,
  table: 'knowledges' | 'risks_issues' | 'retrospectives' | 'projects',
  rowId: string,
  tenantId: string,
  embedding: number[] | undefined,
  identifier: string,
): Promise<void> {
  if (!embedding) {
    console.warn(`   ⚠ embedding 不在: table=${table}, key 由来=${identifier} → NULL で投入`);
    return;
  }
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding 寸法異常: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length} (${identifier})`,
    );
  }
  const vectorText = `[${embedding.join(',')}]`;
  // テーブル名は呼出側で固定の string literal なので injection リスクなし。
  // 実装上は switch で SQL を分岐して identifier を動的補間しない。
  switch (table) {
    case 'knowledges':
      await prisma.$executeRaw`UPDATE "knowledges" SET "content_embedding" = ${vectorText}::vector WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid`;
      return;
    case 'risks_issues':
      await prisma.$executeRaw`UPDATE "risks_issues" SET "content_embedding" = ${vectorText}::vector WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid`;
      return;
    case 'retrospectives':
      await prisma.$executeRaw`UPDATE "retrospectives" SET "content_embedding" = ${vectorText}::vector WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid`;
      return;
    case 'projects':
      await prisma.$executeRaw`UPDATE "projects" SET "content_embedding" = ${vectorText}::vector WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid`;
      return;
    default: {
      const _exhaustive: never = table;
      throw new Error(`Invalid table: ${String(_exhaustive)}`);
    }
  }
}

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
  embeddings: SeedEmbeddingsJson,
): Promise<{ inserted: number; skipped: number; embeddingApplied: number }> {
  let inserted = 0;
  let skipped = 0;
  let embeddingApplied = 0;

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

    const created = await prisma.knowledge.create({
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
        // 2026-05-08: SEED_KNOWLEDGE は全ナレッジ画面で非表示にするためのフラグ。
        //   提案エンジンは候補として表示、super_admin は bypass で編集可能。
        isSampleData: true,
        createdBy,
        updatedBy: createdBy,
      },
      select: { id: true },
    });

    // PR-X5 (5-7): 事前生成 embedding を JSON から引いて書込。不在時は NULL のまま継続。
    const key = knowledgeKey(k);
    const vec = embeddings.knowledges[key];
    if (vec) {
      await applyEmbedding(prisma, 'knowledges', created.id, tenantId, vec, `knowledge:${k.title}`);
      embeddingApplied++;
    }

    inserted++;
  }

  return { inserted, skipped, embeddingApplied };
}

// ================================================================
// PR-X5 (5-2 / 5-3 / 5-4): サンプルプロジェクト / 課題 / 振り返り の投入
// ================================================================

/**
 * SAMPLE_PROJECTS をテナントへ投入。Customer は name で重複チェックし、なければ自動作成。
 * Project は `isSampleData=true` で投入され、画面では非表示・提案エンジンでは候補対象。
 *
 * @returns Map<projectName, projectId> (後続の SAMPLE_ISSUES / SAMPLE_RETROSPECTIVES の親解決に使用)
 */
async function insertSeedSampleProjects(
  prisma: PrismaClient,
  tenantId: string,
  createdBy: string,
  embeddings: SeedEmbeddingsJson,
): Promise<{
  projectIdByName: Map<string, string>;
  inserted: number;
  skipped: number;
  embeddingApplied: number;
}> {
  const projectIdByName = new Map<string, string>();
  let inserted = 0;
  let skipped = 0;
  let embeddingApplied = 0;

  for (const p of SAMPLE_PROJECTS) {
    // 冪等性: 同じ tenantId + name + isSampleData=true が既に存在すればスキップ
    const existing = await prisma.project.findFirst({
      where: { tenantId, name: p.name, isSampleData: true, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      projectIdByName.set(p.name, existing.id);
      skipped++;
      continue;
    }

    // Customer 自動作成 (なければ作成)
    let customer = await prisma.customer.findFirst({
      where: { tenantId, name: p.customerName },
      select: { id: true },
    });
    if (!customer) {
      customer = await prisma.customer.create({
        data: { tenantId, name: p.customerName, createdBy, updatedBy: createdBy },
        select: { id: true },
      });
    }

    const created = await prisma.project.create({
      data: {
        tenantId,
        name: p.name,
        customerId: customer.id,
        purpose: p.purpose,
        background: p.background,
        scope: p.scope,
        outOfScope: p.outOfScope,
        devMethod: p.devMethod,
        contractType: p.contractType,
        businessDomainTags: p.businessDomainTags,
        techStackTags: p.techStackTags,
        processTags: p.processTags,
        plannedStartDate: new Date(p.plannedStartDate),
        plannedEndDate: new Date(p.plannedEndDate),
        status: p.status,
        isSampleData: true,
        createdBy,
        updatedBy: createdBy,
      },
      select: { id: true },
    });

    // 事前生成 embedding を JSON から引いて書込
    const key = sampleProjectKey(p);
    const vec = embeddings.projects[key];
    if (vec) {
      await applyEmbedding(prisma, 'projects', created.id, tenantId, vec, `sample-project:${p.name}`);
      embeddingApplied++;
    }

    projectIdByName.set(p.name, created.id);
    inserted++;
  }

  return { projectIdByName, inserted, skipped, embeddingApplied };
}

/**
 * SAMPLE_ISSUES を投入。`parentProjectName` で親 Project の id を解決する。
 * 親 Project が見つからない場合はそのエントリをスキップ + warning。
 */
async function insertSeedSampleIssues(
  prisma: PrismaClient,
  tenantId: string,
  createdBy: string,
  projectIdByName: Map<string, string>,
  embeddings: SeedEmbeddingsJson,
): Promise<{ inserted: number; skipped: number; embeddingApplied: number }> {
  let inserted = 0;
  let skipped = 0;
  let embeddingApplied = 0;

  for (const issue of SAMPLE_ISSUES) {
    const parentId = projectIdByName.get(issue.parentProjectName);
    if (!parentId) {
      console.warn(`   ⚠ 親 Project 未解決: ${issue.parentProjectName} → issue スキップ`);
      skipped++;
      continue;
    }

    // 冪等性: 同じ projectId + title が既に存在すればスキップ
    const existing = await prisma.riskIssue.findFirst({
      where: { tenantId, projectId: parentId, title: issue.title, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const created = await prisma.riskIssue.create({
      data: {
        tenantId,
        projectId: parentId,
        type: issue.type,
        title: issue.title,
        content: issue.content,
        cause: issue.cause,
        impact: issue.impact,
        likelihood: issue.likelihood,
        priority: issue.priority,
        responsePolicy: issue.responsePolicy,
        responseDetail: issue.responseDetail,
        state: issue.state,
        result: issue.result,
        lessonLearned: issue.lessonLearned,
        riskNature: issue.riskNature,
        visibility: 'public',
        reporterId: createdBy,
        createdBy,
        updatedBy: createdBy,
      },
      select: { id: true },
    });

    const key = issueKey(issue);
    const vec = embeddings.issues[key];
    if (vec) {
      await applyEmbedding(prisma, 'risks_issues', created.id, tenantId, vec, `sample-issue:${issue.title}`);
      embeddingApplied++;
    }

    inserted++;
  }

  return { inserted, skipped, embeddingApplied };
}

/**
 * SAMPLE_RETROSPECTIVES を投入。`parentProjectName` で親 Project の id を解決する。
 */
async function insertSeedSampleRetrospectives(
  prisma: PrismaClient,
  tenantId: string,
  createdBy: string,
  projectIdByName: Map<string, string>,
  embeddings: SeedEmbeddingsJson,
): Promise<{ inserted: number; skipped: number; embeddingApplied: number }> {
  let inserted = 0;
  let skipped = 0;
  let embeddingApplied = 0;

  for (const retro of SAMPLE_RETROSPECTIVES) {
    const parentId = projectIdByName.get(retro.parentProjectName);
    if (!parentId) {
      console.warn(`   ⚠ 親 Project 未解決: ${retro.parentProjectName} → retrospective スキップ`);
      skipped++;
      continue;
    }

    // 冪等性: 同じ projectId + conductedDate が既に存在すればスキップ
    const conductedDate = new Date(retro.conductedDate);
    const existing = await prisma.retrospective.findFirst({
      where: { tenantId, projectId: parentId, conductedDate, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const created = await prisma.retrospective.create({
      data: {
        tenantId,
        projectId: parentId,
        conductedDate,
        planSummary: retro.planSummary,
        actualSummary: retro.actualSummary,
        goodPoints: retro.goodPoints,
        problems: retro.problems,
        improvements: retro.improvements,
        knowledgeToShare: retro.knowledgeToShare,
        state: retro.state,
        visibility: 'public',
        createdBy,
        updatedBy: createdBy,
      },
      select: { id: true },
    });

    const key = retroKey(retro);
    const vec = embeddings.retrospectives[key];
    if (vec) {
      await applyEmbedding(prisma, 'retrospectives', created.id, tenantId, vec, `sample-retro:${retro.parentProjectName}/${retro.conductedDate}`);
      embeddingApplied++;
    }

    inserted++;
  }

  return { inserted, skipped, embeddingApplied };
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

  // PR-X5 (5-7): サンプルプロジェクト + 課題 + 振り返りも新規テナントへ投入。
  //   embedding は事前生成 JSON から引いて書込 (default-tenant のものとは独立)。
  //   各 entry は新規テナント所属の row として独立 (Project / Customer / RiskIssue / Retrospective)。
  const embeddings = loadSeedEmbeddings();
  const projectStats = await insertSeedSampleProjects(prisma, tenantId, createdBy, embeddings);
  console.log(
    `   📁 サンプルプロジェクト: ${projectStats.inserted} 件投入 / ${projectStats.skipped} 件スキップ / embedding 付き ${projectStats.embeddingApplied} 件`,
  );
  const issueStats = await insertSeedSampleIssues(
    prisma,
    tenantId,
    createdBy,
    projectStats.projectIdByName,
    embeddings,
  );
  console.log(
    `   ⚠ サンプル課題: ${issueStats.inserted} 件投入 / ${issueStats.skipped} 件スキップ / embedding 付き ${issueStats.embeddingApplied} 件`,
  );
  const retroStats = await insertSeedSampleRetrospectives(
    prisma,
    tenantId,
    createdBy,
    projectStats.projectIdByName,
    embeddings,
  );
  console.log(
    `   🔁 サンプル振り返り: ${retroStats.inserted} 件投入 / ${retroStats.skipped} 件スキップ / embedding 付き ${retroStats.embeddingApplied} 件`,
  );

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
  console.error('             ※ Direct connection (db.[ref].supabase.co) は IPv6 only で Netlify 不可');
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
  console.error('             その後 Netlify 環境変数も新パスワードに更新');
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
  // 2026-05-09 (PR G / 設計合意 B): シードデータの実体は管理テナントに集中。
  //   従来の default-tenant 既定は廃止。明示指定なき場合は管理テナント (MANAGEMENT_TENANT_ID)
  //   へ投入する。default 等の他テナントへ shoehorn 投入したい場合は --tenant <id> で指定。
  // feat/starter-data-import (2026-06-05): この管理テナントへのシード投入は **引き続き必要**。
  //   役割が「提案エンジンの越境参照元」から「各テナントのスターターデータ取込元 (クローン元)」に変わった。
  //   提案/チャットは自テナントのみを参照する単一テナント化済みのため管理シードを参照しなくなったが、
  //   テナント設定の「スターターデータ取込」(src/services/sample-clone.service.ts) が isSampleData=true の
  //   この行を複製元にするため、db:seed での投入は維持する。
  const targetTenantId = tenantArgIdx !== -1 ? args[tenantArgIdx + 1] : MANAGEMENT_TENANT_ID;

  if (!targetTenantId) {
    console.error('Usage: pnpm tsx prisma/seed-suggestion.ts [--tenant <tenantId>]');
    console.error('  --tenant 省略時は管理テナント (MANAGEMENT_TENANT_ID) が対象');
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
    // PR-X5 (5-7): 事前生成 embedding を JSON から読込 (ファイル不在時は空構造で縮退)
    const embeddings = loadSeedEmbeddings();
    const knowledgeEmbeddingCount = Object.keys(embeddings.knowledges).length;
    if (knowledgeEmbeddingCount === 0) {
      console.log('⚠ seed-suggestion-embeddings.json に knowledge embedding 未収録 → NULL 投入。');
      console.log('   開発者環境で `pnpm seed:generate-embeddings` 実行して JSON を更新してください。');
      console.log('');
    } else {
      console.log(`📦 事前生成 embedding 読込: knowledges=${knowledgeEmbeddingCount} 件`);
      console.log('');
    }

    // 2026-05-09 (PR G / 設計合意 B): 直接投入の対象は管理テナント (default 廃止) に変更。
    //   ただし `--tenant <DEFAULT_TENANT_ID>` を明示すれば従来動作 (default 直接投入) も可能。
    if (targetTenantId === MANAGEMENT_TENANT_ID || targetTenantId === DEFAULT_TENANT_ID) {
      // 直接投入 (管理テナント or default)
      // 2026-05-09 (PR G): findInitialAdmin はテナント内の最初の admin を取る。
      //   管理テナントには super_admin だけが居るため彼を createdBy として採用。
      const createdBy = await findInitialAdmin(prisma, targetTenantId);
      const tenantLabel = targetTenantId === MANAGEMENT_TENANT_ID ? 'management-tenant' : 'default-tenant';

      // 1. ナレッジ
      const { inserted, skipped, embeddingApplied } = await insertSeedKnowledge(
        prisma,
        targetTenantId,
        createdBy,
        embeddings,
      );
      console.log(
        `✅ ${tenantLabel} knowledges: ${inserted} 件投入 / ${skipped} 件スキップ (既存) / ${embeddingApplied} 件 embedding 付き`,
      );

      // 2. サンプルプロジェクト
      const projectStats = await insertSeedSampleProjects(
        prisma,
        targetTenantId,
        createdBy,
        embeddings,
      );
      console.log(
        `✅ ${tenantLabel} サンプルプロジェクト: ${projectStats.inserted} 件投入 / ${projectStats.skipped} 件スキップ / embedding 付き ${projectStats.embeddingApplied} 件`,
      );

      // 3. サンプル課題 (親 Project が必要なため projects 投入後に実行)
      const issueStats = await insertSeedSampleIssues(
        prisma,
        targetTenantId,
        createdBy,
        projectStats.projectIdByName,
        embeddings,
      );
      console.log(
        `✅ ${tenantLabel} サンプル課題: ${issueStats.inserted} 件投入 / ${issueStats.skipped} 件スキップ / embedding 付き ${issueStats.embeddingApplied} 件`,
      );

      // 4. サンプル振り返り
      const retroStats = await insertSeedSampleRetrospectives(
        prisma,
        targetTenantId,
        createdBy,
        projectStats.projectIdByName,
        embeddings,
      );
      console.log(
        `✅ ${tenantLabel} サンプル振り返り: ${retroStats.inserted} 件投入 / ${retroStats.skipped} 件スキップ / embedding 付き ${retroStats.embeddingApplied} 件`,
      );

      console.log('');
      const totalInserted = inserted + projectStats.inserted + issueStats.inserted + retroStats.inserted;
      const totalEmbedded = embeddingApplied + projectStats.embeddingApplied + issueStats.embeddingApplied + retroStats.embeddingApplied;
      if (totalInserted > totalEmbedded) {
        console.log(`⚠ ${totalInserted - totalEmbedded} 件は embedding=NULL で投入されました。`);
        console.log('   `pnpm seed:generate-embeddings` で JSON を更新後、必要なら手動で再投入してください。');
        console.log('');
      }
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
