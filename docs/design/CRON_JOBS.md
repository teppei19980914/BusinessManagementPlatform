# cron ジョブ全体像 — 何をやっていて、何の意味があるか

> **目的**: 本サービス (たすきば) で動作する cron について、エンジニア以外でも「何をやっていて、止まると何が困るのか」を理解できるよう体系化したドキュメントです。
>
> 最終更新: 2026-05-30
>
> **真実源**: cron の名前・スケジュール・endpoint は [`src/config/cron-jobs.ts`](../../src/config/cron-jobs.ts) (= `CRON_JOBS` メタデータ) で一元定義されています。本ドキュメントが古くなった場合は config が正、本ドキュメントは推測ではなく config 値を反映してください。
>
> ## cron 件数の対応関係 (本サービスは 13 件、cron-job.org 上では別サービスの cron も混在)
>
> cron-job.org の運用アカウントは他サービスとも共用しているため、管理画面には本サービス以外の cron も表示されます。**本ドキュメントは本サービス (たすきば) の cron 13 件のみ** を対象とします。
>
> | 区分 | 件数 | 内容 |
> |---|---:|---|
> | **本サービス cron (CRON_JOBS metadata 登録、DB ロギング対象)** | **12 件** | 本ドキュメント §2.1〜§2.12 で詳細解説 |
> | 本サービス cron (metadata 未登録、意図的) | 1 件 | **health-check** ([§2.13](#213-health-check-日次-0900-jst) 死活監視専用、DB ロギング対象外) |
> | 本サービス cron (重複登録、★要整理★) | (+1 件) | **tasukiba attachment-embedding** ([§6.1](#61-attachment-embedding-の重複登録-要対応) 同じ endpoint が 2 つ登録) |
> | **本サービス合計** | **13 件** | (うち運用上整理推奨が 1 件) |
>
> cron-job.org 管理画面で本サービス URL (`https://tasukiba.com/...`) 以外の cron が見えても、本サービスとは無関係です ([§6.4](#64-アカウント共用上の注意) 参照)。

---

## 0. cron とは (= 定期実行スケジューラ)

「毎日 21 時に〇〇する」「毎月 1 日に〇〇する」のような **時間トリガで自動実行される処理** を cron と呼びます。本サービスでは [cron-job.org](https://cron-job.org) という外部サービスから本サービスの HTTPS endpoint を叩く形で実装しています ([詳細: DEPLOYMENT.md §6](../operations/DEPLOYMENT.md))。

各 cron が「実行された」「失敗した」記録は DB の `cron_execution_logs` テーブルに保存され、`/admin/super/cron-history` 画面で運用者が一覧確認できます。

---

## 1. 全 cron の全体像 (日次タイムライン + 月次)

### 1.1 日次 cron (毎日決まった時刻に動く、10 件)

```
JST   00:00 ───┬─────────────────────────────────────────────────────────┐
               │                                                         │
*/10 * * * *   ◆ attachment-embedding (10 分毎)                          │
               │   ファイル添付の意味検索インデックスを背景生成          │
               │   ※ 同 endpoint に 15 分毎の重複登録あり (§6.1 整理推奨) │
               │                                                         │
07:00 ◆ daily-notifications                                              │
               │   今日が予定開始日/終了日の活動について通知メール送信   │
               │   + 30 日前の既読通知削除 + storage 容量再計算          │
               │                                                         │
09:00 ◆ health-check (※ metadata 未登録、§2.13)                          │
               │   サービス本体の死活確認 ping                           │
               │                                                         │
11:00 ◆ daily-usage-aggregation                                          │
               │   昨日の API 利用量をテナント別集計、急増検知、         │
               │   月次予算 80%/100%/150% 到達警告メール                 │
               │                                                         │
11:30 ◆ diagnostics-daily-alert                                          │
               │   ダッシュボード 9 種類の異常検知を集約 → super_admin に│
               │                                                         │
12:00 ◆ cron-failure-alert                                               │
               │   過去 24h で失敗した cron を集約 → super_admin にメール│
               │                                                         │
12:00 ◆ lock-inactive-users (※ 同時刻)                                   │
               │   30 日ログインしていない一般ユーザのログインをロック   │
               │                                                         │
13:00 ◆ stripe-auto-suspend                                              │
               │   未払い猶予期限到来テナントを自動 read-only モードへ   │
               │                                                         │
14:00 ◆ stripe-usage-flush                                               │
               │   API 利用量を Stripe に送信 (クレジットカード決済用)   │
               │                                                         │
17:00 ◆ billing-overdue-alert                                            │
               │   支払期日 +5 日を超えた未払い請求を super_admin にメール│
               │                                                         │
JST   24:00 ───┴─────────────────────────────────────────────────────────┘
```

### 1.2 月次 cron (毎月 1 日 / 2 日に動く、3 件)

| 日 | 時刻 | cron | 何をする |
|---|---|---|---|
| 1 日 | 09:00 | **tenant-monthly-reset** | テナントの API カウンタ + 課金額を 0 にリセット (= 翌月の請求基準点を作る) |
| 1 日 | 15:00 | **stripe-reconcile** | 当社 DB と Stripe の subscription 状態を突合、ズレを Stripe 値で補正 |
| 2 日 | 09:00 | **billing-monthly-aggregation** | 銀行振込 / 請求書払いテナントの前月分請求金額を確定 (BillingHistory upsert) |

### 1.3 各 cron の連鎖関係

```
[月初 1日 09:00]
tenant-monthly-reset
   ↓ (counter リセット完了)
[月初 2日 09:00]
billing-monthly-aggregation (前月分の請求書を集計)
   ↓
[日次 10:00]
billing-overdue-alert (支払期日 +5 日超過を検知)
   ↓
[日次 13:00]
stripe-auto-suspend (猶予期限超過を read-only 化)
```

---

## 2. 各 cron の詳細 (12 件)

### 2.1 attachment-embedding (10 分毎、※ 15 分毎の重複登録あり)

| 項目 | 内容 |
|---|---|
| **スケジュール** | **`*/10 * * * *`** (= 10 分毎、毎時 0/10/20/30/40/50 分 JST) |
| **endpoint** | `/api/cron/attachment-embedding` |
| **何をする** | ユーザがアップロードしたファイル添付 (PDF/Excel/Word/CSV/text) の本文を抽出 → Voyage AI で意味検索用ベクトル化 → DB の `contentEmbedding` カラムに保存 |
| **なぜ必要** | ファイル添付の「意味検索」(= キーワード一致だけでなく文脈マッチ) を可能にするため。リアルタイム処理だとアップロード遅延が大きいので、背景処理 (10 分以内) に分離 |
| **1 回の処理量** | 最大 20 件 (per-tenant=5 / global=50 throttle) |
| **失敗時の挙動** | 指数 backoff (1分→5分) で 3 回まで自動リトライ、それ以降は失敗確定。次回 10 分後に新しいバッチで再開 |
| **止まると困ること** | 新しいファイル添付の意味検索ができなくなる (= キーワード一致のみで検索精度低下)。本体機能には影響なし |
| **異常検知閾値** | 最終成功から 2 時間経過で長期停止扱い |
| **★要整理★** | 同 endpoint に **15 分毎の重複登録** あり (cron-job.org に `tasukiba attachment-embedding` 名で別途登録、`*/15 * * * *`)。advisory lock で同時実行は防御済だが運用上は片方削除推奨 (§6.1 参照) |

### 2.2 daily-notifications (日次 07:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎日朝 7 時 |
| **endpoint** | `/api/cron/daily-notifications` |
| **何をする** | 4 つの処理を一括実行:<br>1. 今日が予定開始日 / 予定終了日の活動 (ACT) について担当者にリマインダ通知<br>2. 30 日経過済の既読通知を物理削除 (DB 容量節約)<br>3. CSV インポートの一時データ (TTL 期限切れ) を削除<br>4. 全テナントのストレージ使用量を再計算 + Beginner プラン猶予期限判定 |
| **なぜ必要** | (1) ユーザが「今日やるべき活動」を朝メールで思い出せる。(2)(3) DB 容量節約 (= 課金影響)。(4) ストレージ容量超過テナントへの警告を翌日には反映 |
| **止まると困ること** | 朝のリマインダ通知が届かず、活動の予定が忘れられる。長期停止だと storage 警告が遅延 |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.3 daily-usage-aggregation (日次 11:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎日 11 時 |
| **endpoint** | `/api/cron/daily-usage-aggregation` |
| **何をする** | 1. 昨日 (UTC) の API 呼出ログをテナント別に集計<br>2. 過去 7 日平均と比較して急増 (spike) を検知<br>3. 月次予算上限の 80% / 100% / 150% 到達を判定 → 警告メール<br>4. Beginner プランの 90 日期限が近いテナントへ警告 + 期限切れ自動物理削除 |
| **なぜ必要** | (3) **予算上限を超えた瞬間にテナント運営者へ通知** (= 予期しない高額請求の防止)。(4) Beginner プラン無料試用後の自動クリーンアップ |
| **止まると困ること** | 予算超過警告が届かない = テナント運営者が支払額に驚く。Beginner 期限切れテナントが残存し DB 容量を圧迫 |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.4 lock-inactive-users (日次 12:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | **`0 12 * * *`** (= 毎日 12:00、※ cron-failure-alert と同時刻、用途は独立) |
| **endpoint** | `/api/admin/users/lock-inactive` |
| **何をする** | 最終ログインから **30 日以上** ログインしていない非管理者ユーザを「ロック」(= isActive=false) する |
| **なぜ必要** | 退職者・休眠ユーザの不正アクセス防止。ただしアカウント自体は削除せず、ナレッジの作者表示等は維持 |
| **止まると困ること** | 退職者のアカウントがログイン可能なまま残り、セキュリティリスク (シリアスではないが運用上の懸念) |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.5 tenant-monthly-reset (月初 1 日 09:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎月 1 日 09:00 |
| **endpoint** | `/api/cron/tenant-monthly-reset` |
| **何をする** | 1. 全テナントの月次 API カウンタ + 課金額を **0 にリセット**<br>2. リセット直前の値をスナップショット保存 (= 後で「先月どれだけ使ったか」を確認できる)<br>3. ストレージアドオンの月次適用<br>4. Beginner プラン期限超過テナントの物理削除<br>5. 月初に embedding 補完バッチ (失敗していた embedding を再生成) |
| **なぜ必要** | ★最重要★ 当月の API 利用量を 0 から数え始めることで、月次請求の基準点を作る。これが動かないと **請求金額が永遠に累積し続ける** |
| **止まると困ること** | ★severity-1★ 課金カウンタがリセットされず、月またぎの請求金額が誤算出される |
| **異常検知閾値** | 最終成功から 35 日経過で長期停止扱い (= 月跨ぎ + 余裕) |

### 2.6 stripe-usage-flush (日次 14:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎日 14 時 |
| **endpoint** | `/api/cron/stripe-usage-flush` |
| **何をする** | DB に蓄積された未送信の API 利用ログを Stripe の Usage Record として **実送信** する |
| **なぜ必要** | クレジットカード決済テナントの月次請求は Stripe が自動で行うが、その元データを当社から Stripe に送信する必要がある |
| **止まると困ること** | クレジットカードテナントの請求が **過少請求** になる (= 我々の収益損失)。`STRIPE_ENABLED=false` の環境では何もしない |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.7 stripe-auto-suspend (日次 13:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎日 13 時 |
| **endpoint** | `/api/cron/stripe-auto-suspend` |
| **何をする** | クレジットカード決済が失敗してから **猶予期限が到来** したテナントを、自動で「read-only モード」(= 閲覧のみ可、書込不可) に移行 |
| **なぜ必要** | 未払いテナントが永続的に書込し続けるのを防ぐ (= 我々のサービスコストが増え続けるのを止める) |
| **止まると困ること** | 未払いテナントが書込を続け、運営側のコスト負担増 |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.8 stripe-reconcile (月初 1 日 15:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎月 1 日 15 時 |
| **endpoint** | `/api/cron/stripe-reconcile` |
| **何をする** | クレジットカードテナント全件について、当社 DB の subscription 状態と Stripe 側の状態を突合し、**ズレを Stripe 値で上書き** + 監査ログ記録 |
| **なぜ必要** | Stripe Webhook (= リアルタイム通知) の配信遅延・失敗で当社 DB が古いままになるケースを月次で自動補正 |
| **止まると困ること** | DB と Stripe で subscription 状態が乖離し、誤請求 / 誤停止のリスクが残る (即時障害ではないが、複数月放置で悪化) |
| **異常検知閾値** | 最終成功から 35 日経過で長期停止扱い |

### 2.9 billing-monthly-aggregation (月初 2 日 09:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎月 2 日 09:00 (= 1 日の tenant-monthly-reset 完了後) |
| **endpoint** | `/api/cron/billing-monthly-aggregation` |
| **何をする** | 銀行振込 / 請求書払いテナントの **前月分請求金額を集計** し `BillingHistory` テーブルに保存 |
| **なぜ必要** | ★最重要★ 銀行振込・請求書発行の基礎データ。これが無いと請求書 PDF が発行できない |
| **対象外** | クレジットカード決済 (= Stripe Webhook で自動同期) |
| **止まると困ること** | ★severity-1★ 銀行振込テナントへの請求書発行が遅延、収益認識ズレ |
| **異常検知閾値** | 最終成功から 35 日経過で長期停止扱い |

### 2.10 billing-overdue-alert (日次 17:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | **`0 17 * * *`** (= 毎日 17:00) |
| **endpoint** | `/api/cron/billing-overdue-alert` |
| **何をする** | `BillingHistory.payment_due_date + 5 日` を超過した未払い行を検知し、super_admin にメール送信 |
| **なぜ必要** | 銀行振込テナントの未払いを早期検知し、回収アクションを取る |
| **dedup 機構** | 24 時間以内の重複送信を抑制 (= 同じ未払い件で毎日メールが届かない) |
| **止まると困ること** | 未払い検知が遅延、回収機会逸失 |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.11 cron-failure-alert (日次 12:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎日 12 時 |
| **endpoint** | `/api/cron/cron-failure-alert` |
| **何をする** | 過去 24 時間で **失敗 (status='failure')** した cron を集約し、super_admin にメール送信 |
| **なぜ必要** | ★cron の cron★ ─ 他 cron の異常を運営者に通知する監視層 |
| **自己診断機能** | 自身 (cron-failure-alert) が前回成功から 25h を超えていたら「サイレント停止警告」も付与 (= 自分自身が止まっても気付ける) |
| **止まると困ること** | 他 cron の失敗が運営者に伝わらない (cron 全体の **2 段階防御** が崩れる) |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.12 diagnostics-daily-alert (日次 11:30 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎日 11:30 |
| **endpoint** | `/api/cron/diagnostics-daily-alert` |
| **何をする** | 診断ダッシュボード ([/admin/super/diagnostics]) の **9 種類の異常検知** を集約:<br>1. API 利用集計 drift / 2. cron 健全性 / 3. 縮退モード / 4. メール失敗 / 5. alert 空打ち / 6. Stripe queue / 7. plan 滞留 / 8. super_admin 数 / 9. 請求書計算ミス<br>→ 1 件以上あれば super_admin にメール送信 |
| **なぜ必要** | super_admin がダッシュボードを毎日見なくても、異常があればメールで気付ける |
| **止まると困ること** | 静かな異常 (= ユーザからは見えないが集計ズレ等) が放置される |
| **異常検知閾値** | 最終成功から 25 時間経過で長期停止扱い |

### 2.13 health-check (日次 09:00 JST)

| 項目 | 内容 |
|---|---|
| **スケジュール** | 毎日 9 時 |
| **endpoint** | `/api/health` |
| **何をする** | サービス本体が稼働しているか HTTP ping。DB 接続まで確認しない軽量 health check |
| **なぜ必要** | サーバが完全停止していないか cron-job.org 側で死活確認するため |
| **★特殊点★ DB ロギング対象外** | 他 cron と異なり `CRON_JOBS` メタデータに **意図的に未登録**。理由: 単純な ping 用途で `cron_execution_logs` への INSERT コストの方が処理コストより大きいため。死活監視は cron-job.org 側の history で完結 |
| **止まると困ること** | サービス停止に気付くのが遅延 (= cron-job.org の history で「最終成功時刻が古い」アラートが届かない)。ただし他 cron も停止していれば cron-failure-alert が二段階で気付く |
| **異常検知閾値** | cron-job.org 側で監視 (本サービスの DB 監視対象外) |

> **注意**: `CRON_JOBS` メタデータに登録しないこの方針は [`src/config/cron-jobs.ts:50-54`](../../src/config/cron-jobs.ts) のコメントで明文化されています。新たに「DB ロギングしない軽量 cron」を追加する場合は同じ判断基準で metadata 登録を見送ること。

---

## 3. 失敗時の影響度 (severity 表)

| severity | cron | 影響 |
|---|---|---|
| **severity-1 (即時対応必要)** | tenant-monthly-reset | 請求カウンタが累積 → 翌月請求金額が誤算出 |
| **severity-1** | billing-monthly-aggregation | 銀行振込請求書が発行できない |
| **severity-2 (収益/コスト影響)** | stripe-usage-flush | クレジットカード請求が過少 (= 収益損失) |
| **severity-2** | stripe-auto-suspend | 未払いテナントが書込継続 (= コスト負担) |
| **severity-medium (運営気付きが遅延)** | cron-failure-alert | 他 cron 失敗が運営者に届かない |
| **severity-medium** | diagnostics-daily-alert | 静かな異常が放置 |
| **severity-medium** | billing-overdue-alert | 未払い検知遅延 |
| **severity-low** | daily-notifications | リマインダ通知が届かない |
| **severity-low** | daily-usage-aggregation | 予算警告メールが届かない |
| **severity-low** | lock-inactive-users | 休眠アカウント残存 |
| **severity-low** | stripe-reconcile | DB-Stripe 乖離 (即時 ではないが累積) |
| **severity-low** | attachment-embedding | 新規ファイル添付の意味検索精度低下 |

---

## 4. 運用監視

### 4.1 リアルタイム監視: super_admin ダッシュボード

- URL: [/admin/super/cron-history](https://tasukiba.com/admin/super/cron-history)
- 機能:
  - 全 cron の最終成功時刻 / 直近の失敗履歴を時系列で表示
  - 「最後の成功から N 時間以上経過していたら **長期停止** とマーク」(各 cron の `expectedMaxGapHours` 設定値)

### 4.2 受動監視: メール通知

- **cron-failure-alert** (日次 12:00): 過去 24h の失敗を集約してメール
- **diagnostics-daily-alert** (日次 11:30): 9 種類の異常を集約してメール
- 両者とも `cron-failure-alert` 自身が止まった場合の **自己診断** あり

### 4.3 cron-job.org 側の独立監視

- cron-job.org の管理画面で「最終実行ステータス」「実行履歴」を確認可能
- DB ロギング (= cron_execution_logs) と独立しているため、**DB 側ロギングが失敗してもこちらで気付ける**

---

## 5. 関連リソース

### 5.1 コード

- **真実源 (本ドキュメントの元データ)**: [`src/config/cron-jobs.ts`](../../src/config/cron-jobs.ts) (`CRON_JOBS` メタデータ)
- ロギングヘルパ: [`src/lib/cron-execution-log.ts`](../../src/lib/cron-execution-log.ts) `withCronExecutionLogging`
- 健全性検査: [`src/services/cron-health.service.ts`](../../src/services/cron-health.service.ts)
- DB スキーマ: [`prisma/schema.prisma`](../../prisma/schema.prisma) `model CronExecutionLog`
- 可視化画面: [`src/app/(dashboard)/admin/super/cron-history/page.tsx`](../../src/app/(dashboard)/admin/super/cron-history/page.tsx)

### 5.2 運用ドキュメント

- cron-job.org 設定手順: [DEPLOYMENT.md §6](../operations/DEPLOYMENT.md)
- 障害対応 SOP: [INCIDENT_RESPONSE.md](../operations/INCIDENT_RESPONSE.md)

### 5.3 過去の知見 (KDD)

- **§5.X+70**: cron route 追加・移行時の checklist
- **§5.X+181**: cron 運用 3 つの罠 (cron 409 / 未登録 cron / metadata 同時追加)

### 5.4 改訂履歴

| 日付 | 改訂内容 |
|---|---|
| 2026-05-30 | 初版 (PR #471 で人間向けに体系化、ユーザ要請) |
| 2026-05-30 | 実態同期: cron-job.org 真実源から 3 件の時刻乖離を補正 (lock-inactive 21→12 / attachment-embedding 15→10 / billing-overdue 10→17) + health-check §2.13 追加 + §6 cron-job.org 運用注意セクション追加 |

---

## 6. cron-job.org 運用上の注意

cron 設定は **cron-job.org が実行スケジュールの真実源**、本サービスの [`src/config/cron-jobs.ts:CRON_JOBS`](../../src/config/cron-jobs.ts) は **メタデータ (description / 異常検知閾値) の真実源** という二重ソース構造です。両者で drift が起きやすいため、本セクションに運用ルールをまとめます。

### 6.1 attachment-embedding の重複登録 (★要対応★)

#### 現状

cron-job.org に **同じ endpoint** (`/api/cron/attachment-embedding`) を叩く cron が **2 つ** 登録されています:

| 登録名 | 周期 | cron 式 |
|---|---|---|
| `attachment-embedding` | 10 分毎 | `*/10 * * * *` |
| `tasukiba attachment-embedding` | 15 分毎 | `*/15 * * * *` |

#### 影響

- **同時実行は防御済** ─ [`src/lib/cron-execution-log.ts:withCronExecutionLogging`](../../src/lib/cron-execution-log.ts) の advisory lock により、同一 cron 名で並列実行が起きても 2 つ目以降は HTTP 409 で即 return ([KDD §5.X+181](../knowledge/KDD_PATTERNS.md))
- **無駄な実行は発生** ─ 10/15/20/30/40/45/50 分のうち、複数 cron が近接時刻 (例: 30 分時点で両方が起動) で重なる場合、片方は 409 で空振りする
- **ロギング容量微増** ─ `cron_execution_logs` テーブルに 409 行も毎回 INSERT される (= severity-low)

#### 推奨対応

cron-job.org 管理画面で **`tasukiba attachment-embedding`** (15 分毎の方) を **削除** することを推奨。理由:
- `attachment-embedding` (10 分毎) の方が周期が短く処理頻度が十分
- 命名規則の一貫性 (他 cron は prefix なし)
- 409 空振りログを減らす

#### 削除手順

1. cron-job.org にログイン
2. 一覧から `tasukiba attachment-embedding` を選択
3. EDIT → Delete cronjob

> 削除後も `attachment-embedding` (10 分毎) で機能は変わらず動作します。

### 6.2 cron-job.org と metadata の同期保持ルール

cron を追加・変更する際は **両方を同時に更新** すること:

| 操作 | 必要な手順 |
|---|---|
| cron 新規追加 | (1) `src/config/cron-jobs.ts:CRON_JOBS` に metadata 追加 → (2) cron-job.org に登録 → (3) 本ドキュメント §2.x に追記 |
| cron スケジュール変更 | (1) cron-job.org で変更 → (2) `cron-jobs.ts:schedule` を実態に合わせる → (3) 本ドキュメントの該当 §2.x 表を更新 |
| cron 削除 | (1) cron-job.org から削除 → (2) `cron-jobs.ts:CRON_JOBS` から削除 (※ 過去ログ参照のため key だけ残す選択肢もある) → (3) 本ドキュメント該当 §2.x を「廃止」マークで残す |
| 名前変更 | (1) cron-job.org で変更 → (2) `cron-jobs.ts` の key と `withCronExecutionLogging(name, ...)` 呼出側を同時変更 (= ロギングとの紐付けが切れるため) → (3) 本ドキュメント該当 §2.x 更新 |

### 6.3 drift 検出方法

drift (= cron-job.org 設定 と `CRON_JOBS` metadata 不一致) を早期検知するため:

1. **手動チェック**: cron 追加・変更の都度、両方を見比べる
2. **★将来課題★ 自動チェック**: cron-job.org API で全登録 cron を取得 → `CRON_JOBS` と diff → CI で fail させる検証スクリプト追加を検討 (現状未実装)

drift の典型症状:
- cron-history 画面で「未登録の cron」表示 (= cron-job.org 側にあるが metadata なし)
- 実行ログが期待時刻と大幅にズレている (= スケジュール drift)
- expectedMaxGapHours が周期より短い設定で常時「長期停止」アラート (= 周期変更後 metadata 未更新)

### 6.4 アカウント共用上の注意

cron-job.org の運用アカウントは **他サービス (例: defrago.onrender.com) の cron とも共用** されているため、管理画面には本サービス以外の cron も表示されます。本サービスの cron だけを操作する際は、必ず URL prefix `https://tasukiba.com/` で見分けてください。

---
