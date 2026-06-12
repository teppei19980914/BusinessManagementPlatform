# テナント設定画面 設計書

> 対象画面: `/settings/tenant`（テナント管理者専用）+ 子画面 `/settings/tenant/billing`（請求履歴）/ `/settings/tenant/migration-import`（CSV 一括取込・7 種）/ `/settings/tenant/api-import`（API 連携インポート・ベータ）
> 本書は **現ソースコードを正** とした設計の真値（2026-06-03 時点）。画面仕様の要約は [specification/SCREENS.md §11.14](../specification/SCREENS.md)、公開向けは [public/tenant-settings-guide.md](../public/tenant-settings-guide.md)。
> 課金・プラン・容量の深い設計は各専用ドキュメントに委譲し、本書は **画面の構成と各セクションの責務** を集約する。

---

## 1. 目的・アクセス制御

テナント管理者が、自テナントの **プラン / 言語・TZ / 提案エンジン設定 / データ入出力 / 当月使用量 / 請求** を管理する画面。

- **アクセス**: `isTenantAdmin`（= テナント管理者 `admin`）のみ。**super_admin（運営者）と一般ユーザはリダイレクト**（super_admin は管理テナント所属で本画面の対象外。運営者向けは `/admin/super/*`）。
- 実装: `page.tsx` で `auth()` → `if (!isTenantAdmin(session.user)) redirect('/settings')`。データは `getTenantSelfInfo`（請求 invariant を守るため `ApiCallLog` SUM の真値で reconcile）。
- **DB 容量 / API 利用量は画面を開いた時点で再集計**（cron キャッシュに依存しない。誤請求防止、`feedback_billing_data_realtime`）。右上「DB 容量 / API 利用量を再集計」ボタンで明示再集計も可能。

---

## 2. 画面構成（3 タブ + ヘッダ + 共通セクション）

| 位置 | 要素 | 概要 |
|---|---|---|
| ヘッダ | 画面見出し「テナント設定」/ テナント名 / 組織 ID / 再集計ボタン | — |
| バナー | Beginner プラン残日数 | Beginner 試用 (90 日) の残日数 + 期限後の読み取り専用化告知 |
| タブ | 概要 / 使用量 / 請求 | `Tabs`（overview / usage / billing） |

### 2.1 概要タブ
| セクション | 内容 |
|---|---|
| プラン | Beginner / Expert / Pro のラジオ + 「変更を保存」。**Beginner へのダウングレードは不可**（ADR-0013）、**Expert ↔ Pro は即時反映**（日割りなし） |
| 言語・タイムゾーン | テナント全体の表示言語・TZ（配下全ユーザの画面表示・Beginner 残日数・月初リセット境界に適用）+ 保存 |
| スターターデータ (見本データ) の取込/削除 | 運営提供の見本データ (顧客/プロジェクト/課題・リスク/ナレッジ/振り返り) を管理テナントから自テナントへ 1 クリック複製 (`is_seed_sample=true`, `isSampleData=false`)、および一括削除。Expert/Pro は容量従量課金の確認→承認で投入。実装: `sample-clone.service` / `/api/tenants/me/sample-data` (POST/DELETE)。<br>※ 旧「提案エンジン: シードデータ参照」トグル (`seedDataEnabled`) は 2026-06-05 撤去 (提案/チャットの単一テナント化に伴う) |
| データエクスポート | 全業務データを ZIP（JSON 構造化 + CSV 主要 5 種 + 添付 URL）でダウンロード。パスワードハッシュ・MFA 秘密鍵等は除外 |
| データインポート | 3 つの入口を案内: ① CSV ファイルをインポート（`/settings/tenant/migration-import`、7 種）/ ② 外部データを直接インポート（`/settings/tenant/api-import`、API 連携・ベータ）/ ③ ZIP をインポート（**自サービスから出力した ZIP 専用**、バックアップ復元 / テナント間移行）。外部システム（Excel/旧 PM ツール）の初回移行は ① へ誘導 |
| 詳細情報（サポート用） | テナント UUID / 作成日時（JST 固定表示）/ 単価（Haiku ¥10/call・Sonnet ¥15/call）。アコーディオン |
| テナント解約（危険な操作） | テナント名の一致入力で確認 → 解約。アコーディオン |

### 2.2 使用量タブ
| セクション | 内容 |
|---|---|
| embedding 未生成バナー | embedding 未生成データ件数 + 月初 cron で自動補完（当月 API 枠消費）の告知 |
| 生成 AI 系利用量 | 当月 LLM 実行回数（Beginner は X/50・残数表示）/ Embedding 生成回数（Beginner は X/100、ADR-0028 でヘルプ/ガイドチャットは含まれない） |
| 月次予算上限（Expert / Pro のみ） | LLM 用 / Embedding 用の上限（ADR-0030）。生成 AI 系セクション直下に配置。Beginner は API 層で NULL 強制 |
| DB 系利用量 | DB 容量（現在 / 月中ピーク=請求根拠 / 想定請求額 + 無料枠ゲージ）/ ファイルストレージ（同上）。「Beginner プランの容量ルールを表示」アコーディオン |

### 2.3 請求タブ
| セクション | 内容 |
|---|---|
| 今月請求金額 | LLM 費用 / Embedding 費用 / DB 容量超過（想定）/ Storage 超過（想定）/ 合計（税抜）。月末 cron で確定、容量系は月中 peak ベースの想定 |
| 請求先情報 | 請求先種別（法人/個人）/ 会社名 / 担当者 / メール / 住所（郵便番号・都道府県・市区町村・番地・建物・電話）/ 支払い方法（銀行振込 / クレジットカード）+ 「請求先情報を更新」 |
| 支払い方法 | 現在の支払い方法表示 + 「クレジットカード情報更新」（Stripe）/「請求履歴を見る」。**クレジットカード払いは運営による有効化待ちの場合あり** |
| 請求履歴 | 子画面 `/settings/tenant/billing` へ。直近 6 ヶ月の請求金額・入金状況（Stripe 自動引落 / 銀行振込） |

---

## 3. プラン・課金・容量（詳細は専用ドキュメント）

本画面の数値・ルールの真値は以下に集約。本書では重複を避け参照に留める。

| 領域 | 真値ドキュメント |
|---|---|
| プラン体系・単価・縮退モード | [business 課金 ADR 群] / [public/plan-guide.md](../public/plan-guide.md)（公開）。Expert ¥10/call・Pro ¥15/call + なぜ機能、資産入力/チャット検索は無料無制限 |
| DB 容量従量課金 | [ADR-0020](../adr/0020-db-capacity-usage-based-billing.md) / [public/db-capacity-billing-guide.md](../public/db-capacity-billing-guide.md)。DB ¥50/GB tier |
| ファイルストレージ従量課金 | [public/file-storage-billing-guide.md](../public/file-storage-billing-guide.md)。ファイル ¥10/GB tier |
| Beginner プラン（90 日試用・無料枠・期限挙動） | [specification/BEGINNER_PLAN.md](../specification/BEGINNER_PLAN.md)。DB 50MB / ファイル 100MB / 月 50 LLM / 最大 5 席 / Embedding 月 100 件無料 |
| 課金 invariant（ApiCallLog SUM=表示=請求） | [feedback 課金 invariant] / OBSERVABILITY §2 drift 検知 |
| 月次予算上限（LLM / Embedding） | [ADR-0030](../adr/0030-embedding-monthly-budget-cap.md) |
| Stripe 連携（カード・自動引落・Webhook・DLQ） | [STRIPE_TECHNICAL_DESIGN.md](./STRIPE_TECHNICAL_DESIGN.md) / [STRIPE_ENV_MAPPING.md](./STRIPE_ENV_MAPPING.md) |
| データ入出力（エクスポート/インポート/外部移行） | [public/csv-import-guide.md](../public/csv-import-guide.md)（外部移行ウィザード） |

---

## 4. データ入出力の区別（重要）

3 つの似た機能を混同しないこと:

| 機能 | 入口 | 用途 | 受け付ける形式 |
|---|---|---|---|
| データエクスポート | 概要タブ | 全業務データの ZIP バックアップ | （出力のみ） |
| データインポート | 概要タブ | **本サービスの ZIP の復元 / テナント間移行** | 自サービス出力 ZIP のみ |
| CSV 一括取込 | `/settings/tenant/migration-import` | **外部システム（Excel/旧 PM ツール）からの初回移行**（7 種） | CSV（UTF-8）4 ステップ（選択→マッピング→dry-run→取込） |
| API 連携インポート（ベータ） | `/settings/tenant/api-import` | Notion/Backlog/kintone/Pleasanter/Google スプレッドシートから直接取込 | 接続→マッピング→プレビュー→取込（トークン非保存） |

---

## 5. テナント解約（自己解約）

- 危険操作。**現在のテナント名の一致入力**で確認 → 解約実行。
- 解約直後: テナント本体 + 配下業務データを **論理削除**（即時ログイン不可・業務データ参照不可）。
- 90 日経過後: 業務データを **物理削除**（復元不可・DB 容量解放）。
- **監査ログ・課金根拠データ（api_call_logs / 月次履歴）は保持**（法令保管）。
- 解約前に **データエクスポート実施を強く推奨**。
- 詳細フロー: [business] セルフ解約 / Beginner 90 日タイムラインと共通の削除設計。

---

## 6. 監査・整合性

- プラン変更・予算上限・請求先・解約などの **ユーザ操作は、現状 `audit_logs`（監査ログ画面）には記録されない**（[OBSERVABILITY.md §1.1 スコープ ④]、将来対応候補）。Stripe 連携エラー等の一部のみ例外的に記録。
- 課金関連の表示は全経路で `ApiCallLog` SUM（真値）で reconcile（counter はホットパスの上限チェック専用）。

---

## 7. 関連画面・ドキュメント

- 子画面: 請求履歴 `/settings/tenant/billing`、CSV 一括取込 `/settings/tenant/migration-import`、API 連携インポート `/settings/tenant/api-import`（ベータ）。
- 個人設定（アカウント・テーマ・言語・MFA）は別画面 `/settings`（[public/settings-guide.md](../public/settings-guide.md)）。
- 公開ガイド: [tenant-settings-guide.md](../public/tenant-settings-guide.md)（本画面）/ plan / db-capacity / file-storage / payment-methods / payment-terms / credit-card 各ガイド。
