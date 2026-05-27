# ドメイン用語辞書 (Glossary)

本ドキュメントは、たすきば Knowledge Relay の **業務用語・ドメイン概念** を一覧化した辞書です。
顧客フィードバックや要件議論で出てきた用語の意味を素早く確認し、機能追加や仕様変更の判断に使えます。

> **使い方**: 「顧客が言っている『○○』ってどの機能のこと?」と思ったら、本辞書で用語の正式名と
> リンク先を確認 → 詳細仕様や設計を辿る。

---

## 1. プロジェクト運営

### プロジェクト (Project)

本サービスの中心概念。企画から振り返りまで一気通貫で管理される業務単位。
1 つのテナントが複数のプロジェクトを持つ。

詳細: [PROJECT_LIFECYCLE.md](./PROJECT_LIFECYCLE.md)

### プロジェクト状態 (Project Status)

プロジェクトが取りうる 7 つの状態。状態によって可能な操作が制限される。

| 状態 | 英名 | 意味 |
|---|---|---|
| 企画中 | planning | プロジェクト概要・目的を整理中。WBS 未確定 |
| 見積中 | estimating | 見積もりを作成中。過去ナレッジを参照 |
| 計画中 | scheduling | WBS / タスクのスケジュールを確定中 |
| 実行中 | in_progress | タスクが進行中。進捗・実績更新が中心 |
| 完了 | done | 全タスク完了、業務的に終了 |
| 振り返り完了 | retrospected | 振り返りを実施し、ナレッジ化済み |
| クローズ | closed | アーカイブ済み、原則編集不可 |

詳細: [PROJECT_LIFECYCLE.md](./PROJECT_LIFECYCLE.md) §8 / §10

### QCD

プロジェクト健全性の 3 要素: **Q**uality (品質) / **C**ost (コスト) / **D**elivery (納期)。
本サービスは QCD のバランスを保ちながら健全なプロジェクト運営を支援する。

### WBS (Work Breakdown Structure)

プロジェクトを階層構造のタスクに分解した作業分解構造。
本サービスでは「タスク」と概ね同義で扱われる。

### マイタスク (My Tasks)

ログイン中のユーザに割り当てられたタスクのみを横断表示する画面。
プロジェクトをまたいで「自分の作業」を一覧する用途。

### 振り返り (Retrospective)

プロジェクト完了後に実施する反省会・総括。
得られた知見を **ナレッジ** として登録することで、次プロジェクトに引き継ぐ仕組み。

### 見積もり (Estimate)

プロジェクトの工数・コスト・期間の予測値。
過去ナレッジと過去プロジェクトの実績を参照して作成する。

### リスク・課題 (Risk / Issue)

- **リスク**: 顕在化していないが将来発生する可能性のある問題
- **課題**: 既に顕在化している問題

両者を統一の登録・管理フローで扱う。

#### 4 セクション構造 (feat/risk-issue-4-section / 2026-05-26)

リスク・課題の編集 dialog は **4 セクションに分離** されている。同じ DB 列を共有するが
type で UI ラベルを切替える設計:

| DB 列 | 課題 (issue) UI ラベル | リスク (risk) UI ラベル | 説明 |
|---|---|---|---|
| `occurrence` | 発生事象 | 考えられる事象 | 「何が起きたか」/「何が起こりうるか」。public 公開時必須 |
| `cause` | 直接原因 | 考えられる原因 | 「なぜ起きたか」/「何が原因となりうるか」 |
| `response_policy` | 対応策 | 考えられる対応策 | 「どう対処したか」/「どう対処すべきか」 |
| `content` | メモ | メモ | 自由記述。type 共通 (旧「内容」を UI 上のみ「メモ」にリネーム、DB 列名は維持) |

`responseDetail` / `result` / `lessonLearned` は別途存在するが、現状 UI 露出対象外。
CSV sync-import は 17 列で完全網羅 (旧 16 列 CSV も後方互換 import 可能)。

---

## 2. テナントと課金

### テナント (Tenant)

利用組織の単位。1 テナント = 1 顧客企業。テナント境界はデータ隔離の根本単位で、
越境は重大な情報漏洩リスク ([ADR-0001](../adr/0001-multitenant-foundation.md))。

### プラン (Plan)

テナントごとに選択する料金プラン。本サービスは LLM プランと Storage プランの 2 軸で構成される。

#### LLM / Embedding プラン (提案エンジン API 利用枠) — ADR-0022 確定版 (2026-06-01)、ADR-0019 (2026-05-24) で部分 supersede

| プラン | 月額固定 | 席数 | API 上限 | LLM 単価 | Embedding 単価 (ADR-0022) | モデル |
|---|---|---|---|---|---|---|
| Beginner | ¥0 | 5 席 | プロジェクト作成/更新 **月 50 回まで無料** (上限到達後は縮退) | — | **¥0 (= 90 日完全無料訴求保全)** | Haiku |
| Expert | ¥0 | 無制限 | 無制限 (`monthlyBudgetCapJpy` で予算上限設定可) | **プロジェクト作成/更新 ¥10/call** (ADR-0019 改定: ¥5 → ¥10) | **¥1 / 業務操作** | Haiku |
| Pro | ¥0 | 無制限 | 無制限 (同上) | **プロジェクト作成/更新 + なぜ機能 ¥15/call** (据置) | **¥1 / 業務操作** | Sonnet |

**ADR-0022 (2026-06-01) Embedding 課金導入**: Beginner プランは Embedding 系 (`{knowledge,risk-issue,retrospective,memo}-embedding` / `chat-semantic-search` / `external-import-embedding` / `attachment-embedding`) を **¥0 維持** (= 「90 日完全無料」訴求保全)。Expert / Pro は **¥1 / 業務操作** で従量課金 (CSV 100 件取込でも 1 取込操作 = ¥1 集約)。月初 cron による失敗 embedding 自動リカバリ (`*-embedding-backfill` 5 種) は **全プラン無料維持** (= 不当請求リスク回避)。

**4 階層 featureUnit 分類** (ADR-0022 / `src/config/billing-feature-units.ts`):
1. `LLM_BILLABLE_FEATURE_UNITS`: project-upsert / suggestion-explanation / auto-tag-extract (plan 別単価、Beginner 50 件上限の対象)
2. `EMBEDDING_BILLABLE_FEATURE_UNITS`: 上記 7 種 (Beginner ¥0 / Expert・Pro ¥1、Beginner 上限の対象外)
3. `STORAGE_OVERAGE_FEATURE_UNITS`: db-capacity-overage / storage-file-overage (月初 cron INSERT)
4. `EMBEDDING_BACKFILL_FEATURE_UNITS`: 5 種 backfill (全プラン明示的 ¥0)

**「1 回の API 呼び出し」の定義 (1 業務操作 = 1 ApiCallLog ルール)**: ユーザ視点での 1 操作で内部的に複数の LLM/Embedding API を呼んでも、ApiCallLog は **1 件** に集約される。Embedding 系も同様 (CSV 100 件取込 = 1 ApiCallLog = 1 課金、ADR-0022 §2.1)。

詳細: [ADR-0022](../adr/0022-embedding-usage-based-billing.md) (Embedding 課金最新版) / [ADR-0019](../adr/0019-billable-feature-units-and-free-tier-expansion.md) (部分 supersede 済) / [TENANT_AND_BILLING.md Part 5](./TENANT_AND_BILLING.md)

#### Storage プラン (容量 add-on)

LLM プランと独立した軸。Standard (LLM 連動無料容量) / Plus / Pro Storage / Enterprise。

詳細: [TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md) §34.14

### 縮退モード (Degraded Mode)

Beginner プラン上限到達時の **fail-safe 設計**。完全停止 (HTTP 429) ではなく、
裏方の AI 処理 (embedding 自動生成) のみ停止する。ユーザは作成・更新を継続でき、
NULL embedding は月初バッチで補完される。

詳細: [TENANT_AND_BILLING.md](./TENANT_AND_BILLING.md) §34.14.4 / [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §B-4

### 従量課金 / per-API-call

LLM プラン上限超過時、提案エンジン API の呼び出し 1 回ごとに課金される方式。
per-user / per-token / per-seat ではなく per-API-call を採用 ([ADR-0002](../adr/0002-tenant-billing-per-api-call.md))。

### 月初バッチ (Monthly Batch)

毎月 1 日に実行される cron バッチ。役割: 月次カウンタリセット、縮退モード中に生成されなかった
NULL embedding の補完、DB 容量・ファイルストレージ peak の月初請求確定、前月分 snapshot 保存。
プラン切替予約の適用は **2026-05-14 改修で廃止** (全プラン変更を即時反映に統一、Beginner ダウングレードは完全禁止) されており、月初 cron 内の `applyScheduledPlanChanges` は legacy DB レコード対策として残置中。

### Grace Period

プラン上限超過から強制制限まで猶予期間 (通常 7 日)。
ユーザにアップグレード判断の時間を与える設計パターン。

---

## 3. ユーザロールと権限

### システムロール

| ロール | 範囲 | 主な権限 |
|---|---|---|
| super_admin | テナント横断 | テナント追加・削除、利用量モニタ、課金状態確認 |
| admin | テナント内 | ユーザ管理、課金設定、テナント設定、全プロジェクト閲覧 |

### プロジェクトロール

| ロール | 範囲 | 主な権限 |
|---|---|---|
| PM (Project Manager) | プロジェクト内 | プロジェクト全権限。承認・状態遷移可 |
| TL (Team Leader) | プロジェクト内 | PM とほぼ同等。一部承認のみ PM 専用 |
| メンバー (member) | プロジェクト内 | タスク更新、ナレッジ登録、自分担当の編集 |
| 閲覧者 (viewer) | プロジェクト内 | read only |

詳細: [USER_ROLES.md](./USER_ROLES.md) / [docs/specification/PERMISSION_MATRIX.md](../specification/PERMISSION_MATRIX.md)

### 認可方式

**RBAC + 二段階認可**。第一段階でテナント境界、第二段階でロール権限を Service 層で検証。
詳細: [ADR-0005](../adr/0005-rbac-two-stage-tenant-authorization.md)

---

## 4. 核心機能: 提案エンジン (Suggestion Engine)

### 提案エンジン

過去プロジェクトの資産 (ナレッジ / リスク / 課題 / 振り返り / メモ) を、新しい判断時に再利用できるよう
**意味検索ベース** で提示する機能。本サービスの最大の差別化点。

提案候補のスコープは **一律「公開範囲: 全メンバー」(visibility='public')** に限定 (= 提案候補のソースは公開資産のみ)。「公開範囲: 自分のみ」(Knowledge/RiskIssue/Retrospective: `visibility='draft'` / Memo: `visibility='private'`) のデータは候補化しない / embedding 生成もしない (Voyage API 課金回避)。

詳細: [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) / [ADR-0003](../adr/0003-embedding-based-suggestion-engine.md) / [SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md)

### Embedding (埋め込みベクトル)

テキストを高次元ベクトルに変換したもの。意味的に近いテキストは近いベクトルになる。
本サービスでは Voyage AI の embedding を使用、PostgreSQL pgvector で類似度検索を行う。

### Voyage AI

Embedding 生成 API を提供するベンダー (https://www.voyageai.com/)。
本サービスの意味検索の中核。

### pgvector

PostgreSQL のベクトル検索拡張。cosine similarity 等で類似ベクトルを検索できる。

### LLM 自動タグ抽出

Anthropic Claude API でプロジェクト作成・更新時に自動的にタグ (businessDomainTags / techStackTags / processTags) を抽出する機能。
作成時に 1 回呼ばれ、検索時は呼ばれない (コスト最適化)。

2026-05-15 から、auto-tag と embedding 生成は `featureUnit='project-upsert'` の **1 度の `withMeteredLLM` ラップに集約** される (= 1 業務操作 = 1 ApiCallLog ルール)。旧 featureUnit (`auto-tag-extract` / `project-embedding`) は backfill 経路の互換のため metered.ts では受理を残すが、新規発行はされない。

### フェーズ分割提案 / 段階表示

提案結果を「フィルタ → タグマッチ → embedding 類似度」の 3 段階で絞り込み、
スコア順に **段階表示** する設計。網羅性 (recall) を最大化し、見落としを防ぐ。

詳細: [SUGGESTION_ENGINE.md](../design/SUGGESTION_ENGINE.md) §B / memory: project_suggestion_engine_priority

---

## 5. ナレッジ

### ナレッジ (Knowledge)

過去プロジェクトで得られた知見を蓄積する単位。
リスク対応策、振り返り、技術メモなどを構造化された形で登録する。

### 可視性 (Visibility)

資産の公開範囲を制御する属性。**「自分のみ」を表す DB 値は資産種別で異なる**ため、コードで visibility 判定する際は schema を要確認 (KDD §5.X+61)。

| 資産 | 「自分のみ」 (= 提案対象外) | 「全メンバー」 (= 提案対象) |
|---|---|---|
| Knowledge | `visibility='draft'` | `visibility='public'` |
| RiskIssue (リスク / 課題) | `visibility='draft'` | `visibility='public'` |
| Retrospective (振り返り) | `visibility='draft'` | `visibility='public'` |
| **Memo (メモ)** (2026-05-15 追加) | **`visibility='private'`** (他資産の 'draft' に相当) | `visibility='public'` |

「自分のみ」のデータは作成者のみ閲覧可能、提案エンジンの候補にも乗らず、embedding 生成も行わない (Voyage API 課金回避)。「自分のみ → 全メンバー」遷移時に初回 embedding 生成。

**RiskIssue (リスク・課題) のみの追加条件 (2026-05-15)**: visibility='public' に加えて **`state='resolved'`** であることも embedding 生成の必須条件。state='open' / 'in_progress' / 'monitoring' (= 解消前の状態) では Voyage を呼ばない (= 解消するまで課金保留)。state が「resolved」に新たに遷移したタイミングで初回 embedding 化される。これは提案エンジンが「過去に解消された学び」のみを候補化する設計と整合させるためのコスト最適化 (KDD §5.X+62)。

詳細: [USER_ROLES.md](./USER_ROLES.md) §6.5 / [SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) §1.1 §3.2

---

## 6. セキュリティと運用

### 監査ログ (Audit Log)

ユーザの全操作 (CREATE / UPDATE / DELETE / ログイン等) を `audit_logs` テーブルに記録する仕組み。
WORM (Write Once Read Many) 性を持ち、改ざんが検知可能。

### MFA (Multi-Factor Authentication / 多要素認証)

TOTP (Time-based One-Time Password、Google Authenticator 等) を用いた認証強化。
admin は必須、一般ユーザは任意。

### 論理削除 (Soft Delete)

DELETE 操作で物理的にレコードを消さず、`deleted_at` カラムにタイムスタンプを記録する方式。
復元可能 + 関連データの整合性維持。テナント削除時のみ物理削除。

### テナント越境 (Cross-Tenant Access)

別テナントのデータにアクセスしてしまう情報漏洩バグ。**severity-1 (個人情報漏洩相当)**。
防止策は [ADR-0001](../adr/0001-multitenant-foundation.md) / [ADR-0005](../adr/0005-rbac-two-stage-tenant-authorization.md)。

### KDD (Knowledge-Driven Development)

「過去の罠と教訓を次の開発で必ず再利用する」開発方針。
発見した罠・パターンを [docs/knowledge/](../knowledge/) に蓄積する。
※ AI 駆動開発時代に確立した運用。人間駆動移行後は ADR と knowledge の併用に簡素化。

---

## 7. 技術用語 (業務文脈で混同しがちなもの)

### tenant_monthly_usage_history

テナント月次使用履歴テーブル。LLM 呼び出し回数、Storage 容量、金額確定値を月単位で記録。
課金計算と運用モニタリングの基礎データ。

### ApiCallLog

提案エンジン API の呼び出しログ。**「1 業務操作 = 1 ApiCallLog」** を原則とする
(Bulk な内部処理を 1 件に集約。memory: feedback_bulk_llm_call_unit)。

### withMeteredLLM

LLM 呼び出しをラップし、ApiCallLog 記録と課金集計を行うヘルパー関数。
1 業務操作で 1 度だけラップし、内部で複数の Voyage 呼び出しがあっても 1 件にまとめる。

### Inbox provider

E2E テストで使用するメール送信シミュレータ。実 SMTP を経由せず、テストコードから送信内容を確認できる。

### Brevo

本番のメール送信プロバイダ (旧称 Sendinblue)。

### Supabase

PostgreSQL ベースの BaaS。本サービスは DB ホスティング + 認証補助に使用 ([ADR-0004](../adr/0004-postgresql-prisma.md))。
Supabase 固有機能 (RLS / Realtime / Edge Functions) は AWS 移行を視野に**使用しない方針**。

---

## 用語の追加方針

新しい業務用語を見つけたら、本辞書に追記する。判定基準:

- 顧客や社内で **複数回使われている** 用語
- **同義語があり混同しがち** な用語 (例: タスク / WBS / 作業項目)
- **技術用語だが業務文脈で意味を持つ** 用語 (例: embedding, tenant_id)
- **省略形・略語** (例: QCD, MFA, RBAC, KDD)

不要にならない範囲で簡潔に書く。詳細は別ドキュメントへリンクする。
