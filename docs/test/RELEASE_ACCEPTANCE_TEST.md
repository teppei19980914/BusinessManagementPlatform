# RELEASE_ACCEPTANCE_TEST.md — リリース判定 受け入れテスト手順

> **目的**: 単一メールアドレス・単一テナントで「テナント払い出し → 全資産の作成/更新/削除 → 主要機能 → テナント解約」までを **1 本のライフサイクル**として通し、本番リリース可否 (go / no-go) を判定する手動受け入れテスト。
>
> **位置づけ**: 6/1 リリース以降、本手順を完走できないリリースは **no-go**。自動テスト (unit / E2E) でカバーされない「本番に近い実環境での通し動作」を人間が確認するための最終ゲート。
>
> **初版**: 2026-05-31 / **対象**: 公開 `/signup` 経路でのセルフサインアップ (= 最頻ユースケース)
>
> **リリース手順との関係**: 本手順は [docs/operations/develop/RELEASE_PROCEDURE.md](../operations/develop/RELEASE_PROCEDURE.md) §2 の **機能受け入れゲート**として参照される。粒度方針 = 🤖 自動 E2E は毎 CI / 👤 数分スモークは毎リリース / フル完走 (本書全体) はメジャー or signup・課金・資産経路を触ったリリース時。

### 🤖 / 👤 マーカーの意味

本書の各 TC には次のマーカーで「自動化済か / 人間が本番で必ず通すか」を示す:

| マーカー | 意味 | 実行 |
|---|---|---|
| 🤖 | 自動 E2E (Playwright) で回帰カバー済 | 毎 PR/CI で自動実行 (`pnpm test:e2e`) |
| 👤 | 人間が**本番環境**で確認 (自動化が原理的に肩代わりできない領域) | 毎リリースの数分スモーク ([§9](#9-数分の人間スモーク-毎リリース必須)) |
| 🤖+👤 | 配線は 🤖 自動 / 品質・実連携は 👤 | 両方 |

> **自動 E2E のカバー範囲 (CI: e2e.yml)**: 払い出し完全フロー (e2e/specs/19) / 層2・層1 eligibility (20) / セルフ解約 (21) / 初回オンボーディング (22) / チャット・ヘルプ配線 (23、スタブ前提) / signup UX friction (24) / 外部 API インポート (25) / URL リンク型添付 CRUD (26)。
> **Post-Deploy Smoke (post-deploy-smoke.yml)**: SMK-2 ログイン/Cookie / SMK-3 資産作成一覧反映 / SMK-4 実 Supabase Storage アップロード往復 / SMK-5 AI ヘルプ品質 (実 Claude + 実 Voyage) / SMK-7 主要画面レンダリング — **本番 URL に対して Netlify deploy 成功後に自動実行**。
> **自動化の限界**: SMK-1 実メール到達は CI (spec 19) で staging 担保 + 本番 Resend 設定は不変のため省略。SMK-6 実 Stripe 決済は別手順 ([STRIPE_PAYMENT_TEST_PROCEDURE.md](./STRIPE_PAYMENT_TEST_PROCEDURE.md))。

---

## 0. 前提と重要な注意

### 0.1 用意するもの

| 項目 | 内容 |
|---|---|
| メールアドレス | 実際に受信できる受信箱 **1 つ** + **プラスエイリアス** (`example+rel01@example.com` 等)。毎回新しいエイリアスを使う。以後そのエイリアスを **`X`** と表記。理由は [§0.5](#05-単一受信箱で繰り返すコツプラスエイリアス必読) |
| 対象環境 | **Deploy Preview / staging** (実外部サービス + ステージング DB に接続) を主に使う ([§9](#9-数分の人間スモーク-毎リリース必須))。本番 DB を汚さず実連携を検証できる。本番は「本番固有の差分」の最終確認のみ |
| DB アクセス | Supabase ダッシュボード等、テナント状態の確認と **テスト後始末 (リセット)** に使用 |
| 課金 | Beginner プランは ¥0。クレジットカード払いの検証は別手順 [STRIPE_PAYMENT_TEST_PROCEDURE.md](./STRIPE_PAYMENT_TEST_PROCEDURE.md) に分離 |

### 0.2 サインアップ可否の 3 層判定 (ADR-0016 Revised) — 必読

`/signup` は入力した初期管理者メール (`X`) の **DB 履歴状態**で払い出し可否が変わる。判定キーは `initialAdminEmail` のみ。

| 層 | `X` の状態 | 結果 |
|---|---|---|
| **層3** | users に一切履歴なし (完全新規) | 全プラン可 → **本手順の前提状態** |
| **層2** | 他テナントに招待/Default 所属はあるが、自前テナント未保有 | Beginner 不可・Expert/Pro のみ (`BEGINNER_REQUIRES_UPGRADE`) |
| **層1** | 過去に自分が払い出した自前テナントを保有 | 公開フォーム完全不可 (`OWNED_TENANT_EXISTS`、admin 問合せ) |

> ⚠ **本手順 (TC-RA-01〜) は層3 (完全新規) を前提**とする。`X` を一度でも本手順で払い出すと、`X` は層1 に遷移し、**同じ手順を再実行できない**。再実行には [§7 後始末・リセット](#7-後始末リセット) で `X` を初期化する必要がある。
>
> 層2 (Beginner 不可・Expert/Pro 限定) の検証は本ライフサイクルでは網羅できない別分岐。検証手順は [付録 A](#付録-a-層2--層1-の検証単一メールでの追加ケース) に分離。

### 0.3 Beginner プランの主要制約 (期待値の根拠)

| 制約 | 値 | 根拠 |
|---|---|---|
| LLM 実行 (プロジェクト作成/更新・なぜ?機能) | 月 **50 回**まで無料、超過で当該機能停止 | ADR-0019 |
| Embedding 生成 (資産入力・チャット検索・添付索引化等) | 月 **100 件**まで無料、超過で新規生成のみ停止 (既存検索は継続) | ADR-0030 |
| 席数 | 最大 **5** | — |
| 試用期間 | **90 日** (createdAt 起点)、超過で read-only | P-B |
| DB 容量 / ファイル容量 | **50MB / 100MB** 超過で新規作成/更新を write ブロック (削除のみ可) | ADR-0025 |
| 資産入力 (knowledge/risk/issue/retro/memo) 作成・更新 | **全プラン無料・無制限** (LLM 枠を消費しない。embedding 枠は消費) | ADR-0019 |
| チャット意味検索 | 全プラン無料・無制限 | ADR-0019 |
| AI ヘルプ/ガイドチャット (たすきフクロウ) の embedding | 全プラン無料・カウンタ対象外 (LEARNING_FREE) | ADR-0028 |

### 0.4 判定記録

各 TC の「結果」列に `PASS` / `FAIL` / `SKIP` を記入。FAIL があれば原則 no-go。最終判定は [§8 go / no-go 判定](#8-go--no-go-判定) で行う。

### 0.5 単一受信箱で繰り返すコツ (プラスエイリアス) — 必読

> ⚠ **「同じメールで払い出し → 解約 → 同じメールで再テスト」はできない (仕様)**。
>
> セルフ解約は論理削除で、90 日後の物理削除 (purge) でも **`user` 行・`tenant` 行は意図的に残す** ([super-admin.service.ts](../../src/services/super-admin.service.ts) `purgeOldDeletedTenants` で「Beginner 乱用防止のため users を物理削除しない」と明記)。層1 判定は `deletedAt` をフィルタしないため、**一度払い出したメールは解約後も永久に層1 (`OWNED_TENANT_EXISTS`)** となり、`/signup` 再実行が 409 で弾かれる。これは「解約して無料 Beginner を再取得する」乱用を防ぐ正しい設計。

**解決策: 毎回プラスエイリアスを使う。**

```
example+rel01@example.com   ← 1 回目
example+rel02@example.com   ← 2 回目
example+rel03@example.com   ← 3 回目 ...
```

- 層判定は email の **完全一致**で行い `+tag` の正規化はしない → 各エイリアスは**別メール扱い＝常に層3 (完全新規)**
- Gmail 等は `example+...@` を `example@` の受信箱に配送 → **検証メールは 1 つの受信箱に全部届く**
- DB の手動削除が不要・毎回クリーン・本物の `/signup` 経路をテストできる
- テナント解約 (§6) は**テスト項目として**実施するだけでよく、次回の前提条件にはならない

> 初回の TC-RA-02 で `+` 入りメールが受理されるか smoke 確認すること (zod `.email()` / HTML `type=email` は `+` を許容する想定)。

---

## 1. テナント払い出し (層3 / 完全新規) — 🤖 (e2e/specs/19-signup-lifecycle)

> 🤖 自動カバー: 完全払い出しフロー (signup→inbox→setup-password→login) は E2E で毎 CI 検証。本節の 👤 手動実行は **本番での実メール到達確認** (TC-RA-05) が主目的。
> 前提: `X` が DB の `users` に一切存在しないことを事前確認 (Supabase で `select * from users where email = 'X'` が 0 件)。

| # | 手順 | 期待結果 | 結果 |
|---|---|---|---|
| **TC-RA-01** | `/signup` を開く | サインアップフォームが表示される | |
| **TC-RA-02** | 初期管理者メールに `X` を入力し、数百ms 待つ | プラン欄で **Beginner が選択可能** (disabled でない)。「既登録のため選択不可」ヒントが**出ない** (= 層3 判定) | |
| **TC-RA-03** | 表示名・組織 ID(slug)・請求先情報 (法人/個人)・初期管理者氏名を入力、プラン= **Beginner**、利用規約・プラポリに同意 | バリデーションエラーなし | |
| **TC-RA-04** | 「テナントを作成」(送信) | 201 / 「招待メールを送信しました」等の完了メッセージ。テナントは作成されるが ID は画面に出ない (情報漏洩抑止仕様) | |
| **TC-RA-05** | `X` の受信箱を確認 | 検証 (招待) メールが届く | |
| **TC-RA-06** | メール内リンク → `/setup-password` でパスワードを設定 | パスワード設定成功 | |
| **TC-RA-07** | `/login` で 組織 ID(slug) + `X` + 設定したパスワードでログイン | ダッシュボードに到達 | |
| **TC-RA-08** | (DB) 当該 Tenant を確認 | `plan = 'beginner'` / `beginnerEverUpgraded = false` / `createdByUserId` = 初期 admin の user.id | |

---

## 2. 初期状態 + 初回オンボーディングの確認 — 🤖 (オンボーディング: e2e/specs/22) / 👤 (設定タブ表示)

| # | 手順 | 期待結果 | マーカー | 結果 |
|---|---|---|---|---|
| **TC-RA-10** | `/settings/tenant` (概要タブ) | テナント名・組織 ID(slug)・テナント # が表示。現在プラン = Beginner | 👤 | |
| **TC-RA-11** | Beginner 試用バナー | 「90 日試用」系のバナーが表示される (全タブ常時表示) | 👤 | |
| **TC-RA-12** | 使用量タブ | 「当月 LLM 実行回数 0 / 50」「Embedding 生成回数 0 / 100」。費用タイルは出ず**残数**タイル表示 (Beginner 仕様) | 👤 | |
| **TC-RA-13** | 請求タブ | 請求先情報・支払方法 (銀行振込) が登録内容どおり表示。「今月請求金額」が ¥0 系 | 👤 | |
| **TC-RA-14** | 初回ログイン時のオンボーディング | たすきフクロウのウェルカムモーダル (`welcome-owl-modal`) が**自動表示**され、CTA (たすきフクロウに聞く / 使い方ガイド / よくある質問 / 閉じる) が揃う。閉じると非表示 | 🤖 (22) | |
| **TC-RA-15** | オンボーディング再表示 | `/help` の「🦉 はじめてのご案内をもう一度見る」(`welcome-owl-replay`) でモーダルが再表示される | 🤖 (22) | |

---

## 3. 資産の作成 / 更新 / 削除 — 🤖+👤 (API/UI CRUD: e2e/specs/19 / CSV・WBS は 👤)

> 🤖 自動カバー: project/knowledge/risk/issue/retrospective/memo の作成・更新・削除 + 一覧反映は E2E (19-signup-lifecycle) で検証。👤 残: CSV インポート/エクスポート・WBS 階層/ガント・ステークホルダー・見積。
> 各資産で **作成 → 更新 → (一覧/詳細での反映確認) → 削除** を 1 周。CSV インポート/エクスポートがある資産は併せて確認。
> プロジェクト作成/更新は **LLM 枠 (50回)** を消費する点に注意 (使用量タブのカウンタ増加を都度確認)。資産入力は LLM 枠を消費しないが **embedding 枠 (100件)** を消費する。

| # | 資産 / 画面 | 手順 | 期待結果 | 結果 |
|---|---|---|---|---|
| **TC-RA-20** | プロジェクト [/projects](src/app/(dashboard)/projects/page.tsx) | 新規作成 → 名称/説明を更新 → 詳細画面で確認 | 作成・更新が反映。使用量タブの LLM 実行回数が増える | |
| **TC-RA-21** | タスク / WBS (プロジェクト詳細 → タスク) | WBS タスクを階層作成 (WP→ACT 等)、進捗更新、ガントで表示 | 階層・進捗・ガント表示が整合 | |
| **TC-RA-22** | ナレッジ [/knowledge](src/app/(dashboard)/knowledge/page.tsx) + プロジェクト配下 | 作成 → 更新 → 削除、CSV インポート/エクスポート | CRUD 反映。インポート件数一致、エクスポート CSV が開ける | |
| **TC-RA-23** | リスク [/risks](src/app/(dashboard)/risks/page.tsx) + プロジェクト配下 | 作成 → 更新 → 削除、CSV インポート/エクスポート | 同上 | |
| **TC-RA-24** | 課題 (issue) [/issues](src/app/(dashboard)/issues/page.tsx) + プロジェクト配下 | 作成 → 更新 → 削除、CSV インポート/エクスポート | 同上 (RiskIssue モデル) | |
| **TC-RA-25** | 振り返り [/retrospectives](src/app/(dashboard)/retrospectives/page.tsx) + プロジェクト配下 | 作成 → 更新 → 削除、CSV インポート/エクスポート | 同上 | |
| **TC-RA-26** | メモ [/memos](src/app/(dashboard)/memos/page.tsx) / [/all-memos](src/app/(dashboard)/all-memos/page.tsx) | 作成 → 更新 → 削除、エクスポート | CRUD 反映。全メモ画面で横断表示 | |
| **TC-RA-27** | 顧客 [/customers](src/app/(dashboard)/customers/page.tsx) | 作成 → 更新 → 削除 | CRUD 反映 | |
| **TC-RA-28** | ステークホルダー (プロジェクト配下) | 作成 → 更新 → 削除 | CRUD 反映 | |
| **TC-RA-29** | 見積 (プロジェクト配下 estimates) | 作成 → 更新 | CRUD 反映 | |
| **TC-RA-30** | 削除後の embedding 整合 | 資産削除後、使用量タブの「embedding 未生成件数」やドリフト表示に異常がない | 削除が容量再集計に反映 (ADR-0025: 削除後自動再集計) | |

---

## 4. 主要機能 — 🤖+👤 (chat/help 配線は 🤖 e2e/specs/23、品質と添付は 👤)

| # | 機能 / 画面 | 手順 | 期待結果 | マーカー | 結果 |
|---|---|---|---|---|---|
| **TC-RA-40** | チャット意味検索 (全画面右下 FAB) | FAB を開き、登録済資産に関連するクエリで検索 | 関連資産がスコア順に返る。Beginner でも無料・無制限 | 🤖配線(23) +👤関連度 | |
| **TC-RA-41** | AI ヘルプチャット (FAB → ヘルプタブ、たすきフクロウ) | 使い方を質問 | FAQ/ガイドに基づく回答。使用量タブの Embedding カウンタは**増えない** (LEARNING_FREE / ADR-0028) | 🤖配線(23) +👤回答質 | |
| **TC-RA-42** | ガイド [/guide](src/app/(dashboard)/guide/page.tsx) | ガイド検索/閲覧 | 正常表示 | 👤 | |
| **TC-RA-43** | ファイル添付 (アップロード) | タスク/プロジェクト/メモ等で添付をアップロード | アップロード成功、一覧に表示 | 👤 (実 Storage) | |
| **TC-RA-44** | ファイル添付 (ダウンロード/削除) | 添付をダウンロード・削除 | DL 成功、削除反映。ファイル容量表示 (使用量タブ) に反映 | 👤 (実 Storage) | |
| **TC-RA-45** | 提案エンジン (プロジェクト → suggestions) | 提案一覧を開き、関連課題/採用を確認 | 過去資産を網羅した提案がスコア順に段階表示 | |
| **TC-RA-46** | テナント設定: i18n | 概要タブで言語/タイムゾーンを変更 | 反映され、日付表示が変わる | |
| **TC-RA-47** | テナント設定: シードデータ参照 toggle | 概要タブで toggle 切替 | 反映される | |
| **TC-RA-48** | テナント設定: 請求先情報の更新 | 請求タブで請求先を編集して保存 | 保存成功、再読込で保持 | |
| **TC-RA-49** | テナント設定: 再集計ボタン | 「DB 容量 / API 利用量を再集計」 | 集計が走り、ドリフト警告が出ないこと | |
| **TC-RA-50** | データエクスポート/インポート | 概要タブの一括エクスポート → インポート | エクスポート成功、インポート件数一致 | |
| **TC-RA-51** | ユーザ招待/管理 [/admin/users](src/app/(dashboard)/admin/users/page.tsx) | 2 人目のメンバーを招待 (席数 5 以内) | 招待成功 (検証は任意。`X` 以外のメール受信先が必要なら SKIP 可) | |

---

## 5. 境界・退行の確認 (任意だが推奨)

| # | 観点 | 手順 | 期待結果 | 結果 |
|---|---|---|---|---|
| **TC-RA-60** | Beginner LLM 上限 | プロジェクト作成/更新を繰り返し 50 回到達 (※コスト・時間に注意。検証環境推奨) | 50 回到達で縮退モードバナー表示、プロジェクト作成/更新が停止。資産入力・チャット検索は継続可 | |
| **TC-RA-61** | Beginner embedding 上限 | embedding 生成を 100 件到達 | 新規 embedding 生成のみ停止、既存 embedding でのチャット検索は継続 | |
| **TC-RA-62** | プラン変更 (Beginner→Expert) | 概要タブでプランを Expert に変更 | 即時反映。以後 Beginner ラジオが非表示になる (ダウングレード不可) | |
| **TC-RA-63** | 予算上限 (Expert 化後) | 使用量タブで LLM/Embedding の月次予算上限を設定 | 設定保存・表示反映 | |

> TC-RA-60/61 を実施すると当該テナントが縮退状態になる。解約 (§6) 前提なら影響なし。プラン変更 (TC-RA-62) を行うと層判定とは無関係だが、最終的に §6 で解約するので問題ない。

---

## 6. テナント解約 (セルフ削除) — 🤖 (e2e/specs/21-tenant-self-delete)

> 🤖 自動カバー: 名称不一致 422 / 一致成功+90日 / 解約後ログイン不可 / 同 email 再 signup の層1 ブロックは E2E で毎 CI 検証。👤 は本番での UI 操作感の確認のみ。

| # | 手順 | 期待結果 | 結果 |
|---|---|---|---|
| **TC-RA-70** | `/settings/tenant` 概要タブ末尾の「テナント解約」セクション | 危険操作として末尾配置・確認入力欄あり | |
| **TC-RA-71** | テナント名を **わざと誤って**入力して解約実行 | 422 / 「テナント名が一致しません」で拒否 (誤操作防止) | |
| **TC-RA-72** | テナント名を**正確に**入力して解約実行 | 成功。「論理削除から 90 日経過後に業務データは物理削除されます」メッセージ | |
| **TC-RA-73** | 解約後、自動的にログアウト/再ログイン試行 | admin 自身が `isActive=false` となりログイン不可 | |
| **TC-RA-74** | (DB) 当該 Tenant / 配下データ | Tenant.deletedAt がセット (論理削除)。配下業務データも論理削除。課金根拠データ・監査ログは保護 | |
| **TC-RA-75** | (権限境界) general ロールのユーザがいれば、そのユーザで解約 API を試行 | 403 FORBIDDEN (admin 限定) ※ユーザがいなければ SKIP | |

---

## 7. 後始末・リセット

> **推奨: リセットは不要。次回は新しいプラスエイリアス ([§0.5](#05-単一受信箱で繰り返すコツプラスエイリアス必読)) を使う。**
> エイリアスを変えれば常に層3 から始められ、DB を触る必要がない。

**例外: どうしても「全く同じメール文字列」を再利用したい場合のみ**、`X` を層3 に戻すため DB から物理削除する。論理削除のままだと `X` は層1 (自前テナント保有) と判定され、再サインアップが `OWNED_TENANT_EXISTS` で拒否される (= 乱用防止設計の挙動)。

リセット対象 (当該 tenantId / userId で物理削除):

- `tenant` (本体)
- `users` (初期 admin + 招待メンバー)
- `role_change_log`
- `tenant_consent_log`
- `email_verification_token`
- 配下業務データ (project / knowledge / risk_issue / retrospective / memo / task / attachment 等)
- `api_call_log` 等の課金根拠 (※本番では監査・課金の観点から削除是非を運用判断。検証環境では削除可)

> ⚠ 本番環境での物理削除は不可逆。**検証環境での実施を強く推奨**。本番で実施する場合は事前バックアップ + 運用承認を必須とする。

---

## 8. go / no-go 判定

| 区分 | 基準 |
|---|---|
| **go** (通常リリース) | 🤖 CI E2E (e2e.yml) が green + 🤖 [§9 Post-Deploy Smoke](#9-post-deploy-smoke-自動実行---e2esmoke) (post-deploy-smoke.yml) が green。**人間テスト不要** |
| **go** (メジャー / 主要経路変更時) | 上記に加え §1〜§4 + §6 のフル完走がすべて PASS。§5 は推奨 |
| **conditional go** | 必須項目 PASS、軽微な表示崩れ等のみ FAIL で、リリース後即時修正の合意がある |
| **no-go** | 払い出し・資産 CRUD・主要機能・解約のいずれかでデータ不整合 / 課金不整合 / セキュリティ境界 (権限・テナント越境) の FAIL がある |

**最終判定**: ______ (go / conditional go / no-go)
**実施日 / 実施者**: ______
**特記事項**: ______

---

## 9. Post-Deploy Smoke (自動実行) — 🤖 (e2e/smoke/)

> **週次リリース (通常)**: 本節の SMK-2〜5/7 は `.github/workflows/post-deploy-smoke.yml` が **Netlify deploy 成功後に自動実行**する。人間は毎週リリースで何もしなくてよい。
> **メジャーリリース**: 本節の自動 smoke に加え §1〜§4 + §6 のフル完走を人間が実施する ([§8](#8-go--no-go-判定) 参照)。

### 自動実行の仕組み

| 項目 | 内容 |
|---|---|
| ワークフロー | `.github/workflows/post-deploy-smoke.yml` |
| トリガー | `push: branches: [main]` (5 分待機後に実行) + `workflow_dispatch` |
| テスト本体 | `e2e/smoke/production-smoke.spec.ts` + `playwright.config.smoke.ts` |
| 実行コマンド | `pnpm exec playwright test --config=playwright.config.smoke.ts` |
| 必須 Secrets | `SMOKE_BASE_URL` / `SMOKE_TENANT_SLUG` / `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` |

> **Netlify webhook は不要**: Netlify の HTTP POST request はカスタム Authorization ヘッダーを設定できないため、push トリガー + 5 分待機方式を採用。
> **スモーク専用アカウント要件**: MFA (TOTP) が無効であること (30 秒ごとに変化するため自動化不可)、admin 権限を持つこと。

### SMK カバレッジ

| # | スモーク項目 | 自動化 | 備考 |
|---|---|---|---|
| **SMK-1** | 実メール到達 | 🤖 CI (spec 19) で staging 担保 | 本番は Resend 設定不変のため省略。inbox provider は CI 専用ファイルシステム方式のため本番 smoke での再現不可 |
| **SMK-2** | ログイン / Cookie / セッション | 🤖 post-deploy-smoke | ログイン → /projects 到達 + Cookie 確認 |
| **SMK-3** | 資産作成 → 一覧反映 | 🤖 post-deploy-smoke | URL リンク型添付作成 → 削除で資産 CRUD を代替 |
| **SMK-4** | ファイル添付往復 (実 Supabase Storage) | 🤖 post-deploy-smoke | 2 フェーズアップロード (presigned PUT) → DL (302 signed URL) → 削除 |
| **SMK-5** | チャット / AI ヘルプの品質 | 🤖 post-deploy-smoke | 既知 FAQ 質問 → 期待キーワード確認 (実 Claude + 実 Voyage) |
| **SMK-6** | Stripe 決済 (クレジットカード払い提供時のみ) | 👤 手動 (別手順) | [STRIPE_PAYMENT_TEST_PROCEDURE.md](./STRIPE_PAYMENT_TEST_PROCEDURE.md) |
| **SMK-7** | 主要画面の本番レンダリング | 🤖 post-deploy-smoke | /projects + /settings/tenant が 500 なく表示 |

> **SMK-6 のみ** 👤 手動に残る。週次リリースでは SKIP 可 (クレジットカード払い未提供のため)。

---

## 付録 A. 層2 / 層1 の検証 (単一メールでの追加ケース)

本編 (§1〜§6) は層3 のみを通すため、Beginner abuse 防止の核である **層2 (Beginner 不可・Expert/Pro 限定)** と **層1 (公開フォーム完全不可)** は未検証のまま残る。同一メール `X` で検証する場合の手順 (要 DB セットアップ)。

### A-1. 層2: Beginner 不可・Expert/Pro のみ

| # | 手順 | 期待結果 | 結果 |
|---|---|---|---|
| **TC-RA-A1** | (前提) `X` が「他テナントのメンバーだが作成者でない」状態を作る。super_admin が別メールでテナントを作り、そこへ `X` をメンバー招待 (= users に `X` は居るが createdByUserId ではない) | `X` が層2 状態 | |
| **TC-RA-A2** | `/signup` で `X` を入力 | プラン欄で Beginner が **disabled**、ヒント「既登録のため Beginner 不可」表示。plan が自動的に expert へ切替 | |
| **TC-RA-A3** | Beginner を強制送信 (UI バイパス想定) | サーバが 409 `BEGINNER_REQUIRES_UPGRADE` | |
| **TC-RA-A4** | Expert を選んで送信 | 201 成功。Tenant は `plan='expert'` / `beginnerEverUpgraded=true` | |

### A-2. 層1: 公開フォーム完全不可

| # | 手順 | 期待結果 | 結果 |
|---|---|---|---|
| **TC-RA-A5** | `X` が自前テナントを保有する状態 (= §1 完走後、または A-1 完走後) で `/signup` に `X` を入力 | フォーム全体が disable、「自前テナント保有・admin 問合せ」ヒント表示 | |
| **TC-RA-A6** | 強制送信 | サーバが 409 `OWNED_TENANT_EXISTS` | |

> 順序の注意: 層3 (§1) を完走すると `X` は層1 になり、層2 のセットアップ (メンバー招待・非作成者) と両立しない。両方を 1 メールで検証するには §7 のリセットを挟む。
