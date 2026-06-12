# カラム利用状況マップ（画面 × DB カラム 4 象限整理）

> 作成: 2026-06-01 / 対象: `prisma/schema.prisma` 全 42 モデル・全 564 スカラーカラム
> 目的: 各カラムの **画面表示名 / 内部名 / 意味・用途 / 4 象限（必要・不要 × システム制御・画面入力）** を 1 表に集約した、カラム定義の正本。
> **本ドキュメントは今後の開発の第一リソース。**
> **検証ステータス（2026-06-01）**: 全 564 スカラーカラムを `schema.prisma` から機械抽出し、各カラムが本表に **1 行=1 カラム** で漏れなく存在することを script で照合（残 GAP 0）。象限・画面表示名は 3 回のフルスキャン（5 並列 agent + Grep 一次裏取り + 機械照合）で確定。意味・用途は schema の `///` コメントを根拠に付与（確実に言えないものは「-」=ユーザ記入欄）。詳細は「一次検証ログ」参照。
> 関連: [DATA_MODEL.md](./DATA_MODEL.md) / [SCREENS.md](../specification/SCREENS.md) / [STATE_REFERENCE.md](./STATE_REFERENCE.md)

---

## 凡例

### 表の列
| 列 | 意味 |
|---|---|
| 画面表示名 | 画面に出る日本語ラベル（`src/i18n/messages/ja.json` 由来）。画面に出ないカラムは「-」 |
| 内部名 | Prisma フィールド名（camelCase）。DB カラムは snake_case の `@map` 名 |
| 意味・用途 | そのカラムが何を表し何に使われるか。schema コメント根拠。不明な箇所は「-」（ユーザ記入用） |
| 象限 | 下記 ①〜④ |
| 根拠 | 判定の一次ソース（`file:line` / `schema:N` / i18n） |

### 4 象限
| 記号 | 区分 | 定義 |
|---|---|---|
| **①** | 画面入力 | ユーザ/管理者向けの作成・編集フォームに入力欄（input/select/textarea 等）が存在する |
| **②** | 画面表示のみ | 詳細/一覧画面に表示されるが入力欄が無い（算出値・読取専用・自動採番・状態バッジ等） |
| **③** | システム制御 | コード/cron/DB トリガ/認証/FK 配管/embedding 等が設定し、画面に一切出ない |
| **④** | 不要・死蔵 | schema 定義はあるが UI 入力経路が無い。`zod` は受理するが UI から送信されない「dead code」を含む。**撤去候補** または **将来 UI 復活候補** |

補足: 「②/③」「③/④」のような併記は中間的な性質（例: 表示はされるがシステム制御 / 必須だが死蔵気味）を示す。

---

## 一次検証ログ（並列調査の自動報告を Grep で裏取り・訂正した項目）

> 並列 Explore agent の「未使用」判定は read window 限定で誤りうるため、判断に効く争点を直接 Grep で検証した。
> 下表は **自動報告から訂正/確定** したもの。

| 項目 | 自動報告 | 検証結果（確定） | 根拠 |
|---|---|---|---|
| `Task.category` | ④ dead | **③（固定値 `'other'` 補完）/ 実質死蔵**。NOT NULL だが UI に入力欄も表示も無く、システムが定数を入れるだけ | [task.service.ts:657](../../src/services/task.service.ts#L657)、tasks-client.tsx にヒット 0 |
| `User.temporaryLockCount` | 要確認 | **③ 生存**。一時ロック→永続ロック判定で increment | [auth.ts:190-196](../../src/lib/auth.ts#L190) |
| `User.forcePasswordChange` | 要確認 | **③ 生存**。インポートユーザに `true` 設定→JWT/session 伝播 | [data-import.service.ts:484](../../src/services/data-import.service.ts#L484) |
| `Project.outOfScope` / `Project.notes` | ① 画面入力 | **② 表示のみ・UI 入力欄なし**。作成フォーム/編集ダイアログ双方に入力欄が存在せず、値はインポート/API のみ | [project-detail-client.tsx:855,922](../../src/app/(dashboard)/projects/[projectId]/project-detail-client.tsx#L855)（MarkdownDisplay） |
| `Estimate.preconditions` / `Estimate.notes` | ①（UI非表示の可能性） | **UI 非表示確定**。estimates-client.tsx にヒット 0（入力欄も表示もなし） | service/zod は受理 |
| `Task.priority` | ① 画面入力 | **③ 内部のみ (UI 非表示)**。2026-06-03 に my-tasks の優先度列を撤去 (WBS は PR #63 で撤去済) → WBS・my-tasks とも画面に列・入力欄なし。内部の既定並び順 (期限昇順 → 優先度降順) にのみ使用、`default 'medium'` 固定 | [my-tasks/route.ts:40](../../src/app/api/my-tasks/route.ts#L40)（orderBy priority desc）、my-tasks-client.tsx / tasks-client.tsx 列ヒット 0 |
| `TaskProgressLog.completedDate` | ②/要確認 | **③ 自動 set**。`status='completed'` 時にシステムが記録、UI 非表示 | [task.service.ts:1119](../../src/services/task.service.ts#L1119) |
| `Task.wbsNumber` | ①（要確認） | **② 表示**（名称横に muted 表示）。作成/編集フォームに個別入力欄なし、入力は CSV インポート/API 経由 | [tasks-client.tsx:273,497](../../src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx#L273) / [task.ts:13](../../src/lib/validators/task.ts#L13) |
| `Task.notes` | ① 画面入力 | **① 画面入力**（2026-06-12 feat/url-autolink で死蔵を解消）。アクティビティの作成/編集ダイアログに「備考」入力欄を新設（MarkdownTextarea、最大 1000 文字、URL は表示時に自動リンク化）。WP は集約ノードのため非表示 | [tasks-client.tsx](../../src/app/(dashboard)/projects/[projectId]/tasks/tasks-client.tsx)（`task-create-field-notes` / `task-edit-field-notes`）/ [task.ts:16](../../src/lib/validators/task.ts#L16) |
| `Retrospective.state` | ③（要確認: スキーマ検証なし） | **② 表示**（状態バッジ）。「確定」ボタンで `state='confirmed'` 固定 set。validator に state 無し（update は pass-through 受理＝軽微な検証欠落は実在） | [retrospective.service.ts:441](../../src/services/retrospective.service.ts#L441) |
| `RiskIssue`/`Knowledge`/`Retrospective` の `createdBy`/`updatedBy`/`createdAt`/`updatedAt` | ③ | **②（一覧で表示）**。当初「詳細で表示」としたが画面再検証で訂正 — 編集ダイアログには非表示、**全リスク/全ナレッジ/全振り返り一覧**で表示 | all-risks-table.tsx / knowledge-client.tsx / all-retrospectives-table.tsx |
| `Memo.createdAt` | ②（一覧表示） | **③（非表示）**。一覧で表示されるのは `updatedAt` のみ、`createdAt` は未表示 | memos-client.tsx |
| **`TaskProgressLog` 全カラム** | ①（進捗入力） | **④/③（テーブル全体 UI 未接続）**。`updateTaskProgress` を呼ぶ画面が存在せず、書込/読取とも UI 未接続。WBS実績更新は `updateTask` で Task 本体を更新し本テーブルには書かない | task.service.ts:1090 / `/progress` route に UI 呼出なし |

> ⚠️ ある agent が「`Retrospective.state` は retrospective.ts:78 で zod 定義」と報告したが、**Grep 裏取りで retrospective.ts に state フィールドは存在しない**ことを確認（誤報を棄却）。自動報告は必ず一次ソースで裏取りすること。

**網羅性（機械照合で確定）**: `schema.prisma` の全 564 スカラーカラムを awk 抽出 → 本表に 1 行=1 カラムで存在するか script 照合し **残 GAP 0**。型内訳 String 341 + DateTime 122 + Int 44 + Boolean 19 + Json 16 + BigInt 10 + Unsupported 8 + Decimal 4 = 564。DB→schema ドリフト（migration ADD/DROP）・幽霊カラム・`@ignore`・孤立テーブルも検査済で追加の漏れなし。

> ⚠️ **抽出スクリプトのバグ修正記録**: 当初の awk 抽出はフィールド名を `[a-zA-Z_]+` で拾っており、**数字を含むカラム名を取りこぼしていた**（`Tenant.beginnerNoticeDay60SentAt` / `beginnerNoticeDay75SentAt` / `beginnerAutoDeleteNoticeDay150SentAt` / `beginnerAutoDeleteNoticeDay170SentAt` の 4 件 = 当初 560 にカウントされず）。正規表現を `[a-zA-Z_][a-zA-Z0-9_]*` に修正して再抽出し真の総数 564 を確定。これら 4 カラムは本表（Tenant）には schema 直参照で記載済のため最終的な漏れはゼロ。「検証ツール自体の取りこぼし」を疑う重要な教訓。

---

## 全体サマリ

- **業務エンティティ（人が画面で触る系）にドリフトが集中**。資産系（ナレッジ/振り返り/リスク課題）に「zod 受理・UI 送信なし」の死蔵列（④）が多い。
- **システム系テーブル（認証・課金・ログ・embedding）はほぼ全カラム ③**。真の dead は無し（timestamp 自動列がアプリ未参照だが無害）。
- 死蔵・非表示必須・将来 UI 候補のアクション整理は **Part E** 参照。

---

# Part 1. 全カラム定義（エンティティ別統合表）

> 各エンティティ = 1 表、**1 行 = 1 カラム**。全 564 カラムを網羅。

## 1-A. 業務エンティティ

## Customer（顧客）— `/customers`（顧客管理）, `/customers/[id]`（顧客詳細）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:582 | 必要（UI非表示・内部管理用） |
| - | tenantId | 所属テナント(FK、テナント分離境界) | ③ | schema:584 | 必要（UI非表示・内部管理用） |
| 顧客名 | name | 顧客企業名 | ① | customers-client.tsx | 必要（一覧/編集画面表示） |
| 部門 | department | 部門・組織名 | ① | customers-client.tsx | 必要（一覧/編集画面表示） |
| 担当者 | contactPerson | 窓口担当者氏名 | ① | customers-client.tsx | 必要（一覧/編集画面表示） |
| 担当者メール | contactEmail | 窓口メールアドレス | ① | customers-client.tsx | 必要（一覧/編集画面表示） |
| 備考 | notes | その他メモ・特記事項 | ① | customers-client.tsx | 必要（編集画面表示） |
| - | isSeedSample | スターターデータ一括取込の識別マーカー(2026-06-05)。一覧表示は通常通り、「サンプル一括削除」の対象特定専用 | ③ | schema:600 | 必要（UI非表示・内部管理用） |
| 作成者 | createdBy | 作成者(氏名解決、一覧で表示) | ② | schema:590 | 必要（一覧画面表示） |
| 作成日時 | createdAt | 作成日時(YYYY/MM/DD HH:mm:ss、一覧で表示) | ② | schema:592 | 必要（一覧画面表示） |
| 更新者 | updatedBy | 更新者(氏名解決、一覧で表示。未更新は「—」) | ② | schema:591 | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(一覧で表示。未更新は「—」) | ② | schema:593 | 必要（一覧画面表示） |
| - | (監査列の列順・書式) | 作成者→作成日時→更新者→更新日時 / `YYYY/MM/DD HH:mm:ss` で全「○○一覧」と統一 (2026-06-02) | ② | customers-client.tsx | — |

> **✅ 画面確認 (Fix / 2026-06-03) — 顧客の新規登録／編集ダイアログ（`/customers` 全顧客管理）**: 実機キャプチャで確認。全項目単一列。
> - **新規顧客登録**: 顧客名（必須・テキスト）→ 部門 → 担当者 → 担当者メール → 備考（テキストエリア）→ ［キャンセル］［登録］。
> - **顧客情報編集**: 同項目 → ［キャンセル］［更新］→ **コメント（@ メンション）**。
> - **権限（実コードで検証）**: `/customers` の閲覧・作成・編集・削除はすべて **admin / super_admin のみ**（`isAdminOrAbove`。非 admin はページ `/` へ redirect、API は 403）。一般メンバー・PM/TL には表示されない。
> - **一覧の列**: 顧客名・部門・担当者・担当者メール・関連プロジェクト（紐付き件数）・作成者・作成日時・更新者・更新日時・操作（削除）。キーワード絞り込み + 列ヘッダー並べ替え可。
> - **削除の条件**: 進行中（active）プロジェクトが紐付いている顧客は一覧から直接削除できない（詳細画面のカスケード削除へ誘導）。紐付き 0 件の顧客のみ一覧から物理削除可。

> **✅ 画面確認 (Fix / 2026-06-03) — 顧客詳細画面（`/customers/[id]`）**: 実機キャプチャで確認（権限は一覧と同じ admin / super_admin のみ）。
> - パンくず「顧客管理 / 顧客詳細」+ 顧客名（タイトル）+ ［編集］［削除］。
> - **表示項目**: 部門 / 担当者 / 担当者メール（mailto リンク）/ 備考 / **紐付 active プロジェクト（件数）**。
> - **紐付プロジェクト 表**: プロジェクト名（リンク）/ ステータス / 開始予定日 / 終了予定日。
> - **編集**: その場で編集ダイアログ（PATCH /api/customers/[id]、項目は新規/編集と同一）。
> - **削除（カスケード）**: active プロジェクト 0 件 → 単純削除。1 件以上 → カスケード削除ダイアログで **4 オプション（紐付プロジェクトの リスク / 課題 / 振り返り / ナレッジ を一緒に削除するか）** を選んで、顧客 + 紐付 active プロジェクトをまとめて削除（既定は資産を残す＝オフ）。DELETE /api/customers/[id]?cascade=...。

## Project（プロジェクト）— `/projects`（プロジェクト一覧）, `/projects/[id]`（プロジェクト詳細・概要タブ）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:608 | 必要（UI非表示・内部管理用） |
| - | tenantId | 所属テナント(FK、テナント分離境界) | ③ | schema:610 | 必要（UI非表示・内部管理用） |
| プロジェクト名 | name | プロジェクト名 | ① | schema:611 | 必要（一覧/編集画面表示） |
| 顧客 | customerId | 顧客(FK) | ① | schema:618 | 必要（一覧/編集画面表示） |
| 目的 | purpose | プロジェクト目的 | ① | schema:620 | 必要（一覧/編集画面表示） |
| 背景 | background | 背景・現状分析 | ① | schema:621 | 必要（一覧/編集画面表示） |
| スコープ | scope | 実施範囲 | ① | schema:622 | 必要（一覧/編集画面表示） |
| スコープ外 | outOfScope | 対象外範囲(表示のみ、UI入力欄なし) | ② | schema:623 | 必要（一覧/編集画面表示） |
| 開発方式 | devMethod | agile / waterfall / hybrid など | ① | schema:624 | 必要（一覧/編集画面表示） |
| 契約形態 | contractType | 準委任 / 請負 / SES など | ① | schema:626 | 必要（一覧/編集画面表示） |
| 業務ドメインタグ | businessDomainTags | JSON配列、意味検索・分類用 | ① | schema:627 | 必要（UI非表示・内部管理用） |
| 技術スタックタグ | techStackTags | JSON配列、技術スタック候補 | ① | schema:628 | 必要（UI非表示・内部管理用） |
| 工程タグ | processTags | JSON配列、工程分類・提案用 | ① | schema:632 | 必要（UI非表示・内部管理用） |
| 開始予定日 | plannedStartDate | プロジェクト開始予定日 | ① | schema:633 | 必要（一覧/編集画面表示） |
| 終了予定日 | plannedEndDate | プロジェクト終了予定日 | ① | schema:634 | 必要（一覧/編集画面表示） |
| 実績開始日 | actualStartDate | プロジェクト実績開始日(担当者が編集時に入力する任意項目、未着手は null) | ① | schema:637 | 必要（一覧/編集画面表示） |
| 実績終了日 | actualEndDate | プロジェクト実績終了日(同上) | ① | schema:638 | 必要（一覧/編集画面表示） |
| ステータス | status | **5 ステータス: planning(企画中)/estimating(見積中)/scheduling(計画中)/executing(実行中)/closed(クローズ)**（2026-06-03: 旧 completed/retrospected を廃止、実行中→クローズに簡素化、既存値は migration で closed に読替）。**プロジェクト一覧・概要タブ（ヘッダーのバッジ + 基本情報先頭）に表示**。**新規作成/編集フォームの項目（プルダウン）で任意選択可（一方向制限なし）。ヘッダーの「ステータス変更」プルダウンは廃止**。closed = 完全読み取り専用（削除のみ可、STATE_RESTRICTIONS）。旧 state-machine 経路は dormant 残置 | ② | schema:635 | 必要（一覧/概要/編集/新規作成画面表示） |
| 備考 | notes | 補足事項(表示のみ、UI入力欄なし) | ② | schema:636 | 必要（一覧/編集画面表示） |
| - | isSampleData | シードデータ識別フラグ | ③ | schema:643 | 必要（UI非表示・内部管理用） |
| - | isSeedSample | スターターデータ一括取込の識別マーカー(2026-06-05)。一覧表示は通常通り、「サンプル一括削除」の対象特定専用。isSampleData とは別軸 | ③ | schema:658 | 必要（UI非表示・内部管理用） |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:647 | 必要（UI非表示・内部管理用） |
| 作成者 | createdBy | 作成者(氏名解決、一覧で表示) | ② | schema:648 | 必要（一覧画面表示） |
| 作成日時 | createdAt | 作成日時(YYYY/MM/DD HH:mm:ss、一覧で表示)。**作成日時が空表示だったバグ(日付専用フォーマッタ誤用)を 2026-06-02 修正** | ② | schema:650 | 必要（一覧画面表示） |
| 更新者 | updatedBy | 更新者(氏名解決、一覧で表示。未更新は「—」) | ② | schema:649 | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(一覧で表示。未更新は「—」) | ② | schema:651 | 必要（一覧画面表示） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:652 | 必要（UI非表示・内部管理用） |

> **✅ 画面確認 (Fix / 2026-06-02) — 概要タブ「プロジェクト編集」ダイアログ**: 実機キャプチャで確認済み（**問題なし**）。フィールド構成・順序は以下で確定（`｜` = 同一行 2 列、`【】` = MarkdownTextarea プレビュー/差分付き）:
> 1. プロジェクト名（テキスト）
> 2. 顧客（プルダウン）
> 3. **ステータス（プルダウン、2026-06-03 追加。5 ステータス〈企画中/見積中/計画中/実行中/クローズ〉を任意選択。一方向遷移の制限なし）**
> 4. 【目的】
> 5. 【背景】
> 6. 【スコープ】
> 7. 【スコープ外】（任意）
> 8. 【備考】（任意）
> 9. 開発方式 ｜ 契約形態（プルダウン、契約形態の既定=未設定）
> 10. 開始予定日 ｜ 終了予定日（日付、各「今日」ボタン、クリア無し=必須）
> 11. 実績開始日 ｜ 実績終了日（日付、各「今日」「クリア」、任意）
> 12. ［更新］ボタン
>
> **2026-06-03 変更**: 新規作成フォームにも「ステータス」プルダウンを追加（顧客の直後、既定=企画中）。概要タブ右上の専用「ステータス変更」プルダウンは廃止し、ステータス変更は編集フォームに統合。旧 state-machine（一方向遷移）エンドポイントは dormant 残置。

> **✅ 画面確認 (Fix / 2026-06-02) — 概要タブ「表示」レイアウト**（編集ダイアログとは別。実機キャプチャで確認）:
> - ヘッダー: プロジェクト名 + ステータスバッジ + ［編集］［削除］（2026-06-03: 専用「ステータス変更」プルダウンは廃止。変更は［編集］内のステータス項目から。2026-06-09: ［一覧に戻る］ボタンを廃止。一覧へはヘッダーの「たすきば」ロゴ / 「全プロジェクト」タブで戻る）
> - **基本情報**カード: **ステータス（ステータスバッジ。2026-06-03 追加）** / プロジェクト名 / 顧客 / 開発方式 / 契約形態 / 開始予定日 / 終了予定日 / 実績開始日 / 実績終了日（未設定は「─」）。ステータスはヘッダーのバッジに加え、概要本体の基本情報先頭にも表示。
> - **目的** / **背景** / **スコープ** の 3 カード（各テキスト表示）
> - **関連 URL**: メイン資料（「URL を設定」）+ その他の関連 URL（表示名 / URL ＋ 追加）+ ファイルアップロード（50MB 上限）
> - ※ **スコープ外・備考は概要「表示」には出ない**（編集ダイアログのみ）。表示順は基本情報→目的→背景→スコープ→関連URL。

> **✅ 画面確認 (Fix / 2026-06-03) — プロジェクト一覧 `/projects` の表示カラム**: 列順を **プロジェクト名 → ステータス → 開始予定日 → 終了予定日 → 実績開始日 → 実績終了日 → 作成者 → 作成日時 → 更新者 → 更新日時** に変更（**顧客・開発方式の列は削除**。両項目は新規作成/編集フォームと詳細では引き続き扱う）。実績日は未入力時「—」。監査 4 列は `YYYY/MM/DD HH:mm:ss`、未更新は「—」。モバイルカードも同方針（顧客/開発方式を外し、予定期間・実績期間を表示）。

> **ToBe（追加予定カラム・将来要件）**
>
> 実績開始日 / 実績終了日 (actualStartDate / actualEndDate) は **2026-06-02 に実装済み**（上表に統合、schema:637/638、概要タブ表示 + 編集ダイアログ入力 + migration `20260602_add_project_actual_dates`）。現時点で Project に未実装の追加予定カラムはなし。

> **✅ 画面確認 (Fix / 2026-06-02) — 参考タブ `/projects/[id]`（提案・横断参照）**: 実機キャプチャで確認。**DB カラムではなく提案エンジンの算出表示**。
> 上部バナー（説明文。**「核心機能 (提案型サービス):」prefix は 2026-06-02 に削除**し説明文のみ表示）→ 「ナレッジ候補 / 過去課題 / 過去リスク / 過去振り返り」の 4 セクション（各「N 件」、類似が無ければ「〜が見つかりませんでした」案内）。紐付けても元プロジェクトとデータ共有のまま本プロジェクトの各一覧にも表示される。

## Estimate（見積）— `/projects/[id]/estimates`（見積もり管理タブ）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:688 | 必要（UI非表示・内部管理用） |
| - | projectId | 所属プロジェクト(FK) | ③ | schema:689 | 必要（UI非表示・内部管理用） |
| 見積項目名 | itemName | 見積対象項目の名称 | ① | schema:690 | 必要（一覧/編集画面表示） |
| 区分 | category | タスク分類(TASK_CATEGORIES) | ① | schema:691 | 必要（一覧/編集画面表示） |
| 入力モード | inputMode | **v1.2.0追加**。'direct'=手動入力 / 'coefficient'=係数ベース計算。NOT NULL DEFAULT 'direct'。一覧に「手動」「係数」バッジ表示 | ① | schema:723 | 必要（一覧/フォーム） |
| - | devMethod | 係数モード時は選択ツールキー(winactor/kintone 等)を格納。手動モード時は createEstimate で 'other' を補完。**DB 列は v1.2.0 でツールキー格納に転用したため削除しない** | ② | estimate.service.ts | 必要（係数モードで係数一覧にツール名表示） |
| 見積工数 | estimatedEffort | 工数の数値(Decimal 10,2)。係数モードでは calcCoefficient() 計算結果を格納 | ① | schema:693 | 必要（一覧/編集画面表示） |
| 単位 | effortUnit | 人時 / 人日 | ① | schema:694 | 必要（一覧/編集画面表示） |
| - | rationale | 見積根拠。**フォーム撤去済(2026-06-02)、NOT NULL のため '' で補完** | ④ | estimate.service.ts | 不要（UI撤去済・DB列削除はstaging） |
| - | preconditions | 前提条件(UI非表示) | ④ | schema:696 | 必要（UI非表示・内部管理用） |
| ステータス | isConfirmed | 見積確定状態 | ② | schema:697 | 必要（一覧/編集画面表示） |
| 備考 | notes | 備考（一覧・ダイアログで表示） | ① | schema:698 | 必要（一覧/フォーム表示） |
| - | baseHours | **v1.2.0追加**。係数モード時の基準時間(h)。手動モード時はNULL | ③ | schema:724 | 必要（係数モード・Excel/Wordエクスポート） |
| - | scaleCoeff | **v1.2.0追加**。規模係数(0.3〜2.5)。手動モード時はNULL | ③ | schema:725 | 必要（係数モード・Excelエクスポート） |
| - | difficultyCoeff | **v1.2.0追加**。難易度係数(0.8〜1.8)。手動モード時はNULL | ③ | schema:726 | 必要（係数モード・Excelエクスポート） |
| - | methodCoeff | **v1.2.0追加**。手法係数(基本1.0)。手動モード時はNULL | ③ | schema:727 | 必要（係数モード） |
| 作成者 | createdBy | 作成者(氏名解決、一覧で表示) | ② | schema:699 | 必要（一覧画面表示） |
| 作成日時 | createdAt | 作成日時(YYYY/MM/DD HH:mm:ss、一覧で表示) | ② | schema:701 | 必要（一覧画面表示） |
| 更新者 | updatedBy | 更新者(氏名解決、一覧で表示。未更新は「—」) | ② | schema:700 | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(一覧で表示。未更新は「—」) | ② | schema:702 | 必要（一覧画面表示） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:703 | 必要（UI非表示・内部管理用） |

> **✅ 画面確認 (v1.2.0 / 2026-06-12) — 見積もり管理タブ UI**:
>
> **上部サマリパネル**: カテゴリ別小計 + バッファ率(0〜50%、既定20%) + 合計工数(バッファ込み) + [Excel出力][Word出力] ボタン。
>
> **追加ボタン (2種)**:
> - ［手動で登録］: 項目名・区分・工数・単位・備考 を直接入力。
> - ［ツールで見積もる］: 開発ツール選択(16種) + 規模係数 + 難易度係数 で自動計算。基準時間はカテゴリ×ツールのプリセット値が自動入力、自由編集可。
>
> **一覧カラム順**: 項目名 | 区分 | **入力モード(手動/係数バッジ+ツール名)** | 工数 | 備考 | ステータス | 作成者 | 作成日時 | 更新者 | 更新日時 | 操作(確定/削除)。

## ProjectMember（プロジェクトメンバー）— `/projects/[id]`（メンバータブ）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:712 | 必要（UI非表示・内部管理用） |
| - | projectId | 所属プロジェクト(FK) | ③ | schema:713 | 必要（UI非表示・内部管理用） |
| - | userId | メンバーの User(FK)。下記「ユーザ名・メール」の参照元 | ③ | schema:714 | 必要（UI非表示・内部管理用） |
| ユーザ名 | （User.name）※userId経由 | メンバーのユーザ名（User 参照。ProjectMember 自体のカラムではない） | ②（参照表示） | members-client.tsx:213 | 必要（一覧画面表示） |
| メールアドレス | （User.email）※userId経由 | メンバーのメール（User 参照。ProjectMember 自体のカラムではない） | ②（参照表示） | members-client.tsx:214 | 必要（一覧画面表示） |
| プロジェクトロール | projectRole | pm / manager / member など | ① | schema:715 | 必要（一覧/編集画面表示） |
| 作成者 | assignedBy | 割り当て実行者(=メンバーを追加した人)。一覧「作成者」列に氏名解決して表示 | ② | members-client.tsx | 必要（一覧画面表示） |
| 作成日時 | createdAt | メンバー登録日時（一覧「作成日時」列、YYYY/MM/DD HH:mm:ss） | ② | members-client.tsx | 必要（一覧画面表示） |
| 更新者 | updatedBy | ロール変更実行者(2026-06-02 追加、未更新は null)。一覧「更新者」列に氏名解決して表示 | ② | schema:719 | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(自動。未更新=作成時のみは一覧で「—」表示) | ② | members-client.tsx | 必要（一覧画面表示） |

> **補足（ユーザ名・メールの所在）**: メンバータブの「ユーザ名」「メールアドレス」は **User テーブルから userId 経由で表示**（ProjectMember 自体は保持しない）。
> **2026-06-02 実装**: 「追加日」列を「作成者 / 作成日時 / 更新者 / 更新日時」の 4 監査列に統一（他「○○一覧」と横並び）。作成者 = `assignedBy`（既存）を氏名解決、更新者 = 新規 `updatedBy`（migration `20260602_add_project_member_updated_by`、ロール変更時に記録）。**`createdBy` は追加せず `assignedBy` を作成者として流用**（重複回避）。現時点で ProjectMember に未実装の追加予定カラムはなし。
| 作成日 | createdAt | レコード作成日時（自動） | ② | **既存**（現状の `createdAt`＝「追加日」）。追加不要 |

> **✅ 画面確認 (Fix / 2026-06-02) — メンバー追加ダイアログ**: 実機キャプチャで確認。
> ユーザ（プルダウン選択）→ プロジェクトロール（プルダウン・既定=メンバー）→ ［追加］。

> **✅ 画面確認 (Fix / 2026-06-02) — メンバータブ「一覧」表示カラム**（実機キャプチャ＝正）:
> - 上部: 「N 名」+ ［メンバー追加］ボタン。
> - 列順: **ユーザ名（User.name）| メールアドレス（User.email）| ロール（projectRole、例 PM/TL）| 作成者（assignedBy 氏名解決）| 作成日時 | 更新者（updatedBy、未更新「—」）| 更新日時（未更新「—」）| 操作**。
> - ユーザ名・メールは User テーブル参照（ProjectMember 自体は保持しない）。

## Task（WBS）— `/projects/[id]/tasks`（WBS管理タブ）, `/projects/[id]/gantt`（ガントチャートタブ）, `/my-tasks`（マイタスク）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:734 | 必要（UI非表示・内部管理用） |
| - | projectId | 所属プロジェクト(FK) | ③ | schema:735 | 必要（UI非表示・内部管理用） |
| 親ワークパッケージ | parentTaskId | 親タスク(WBS階層化、FK) | ① | schema:736 | 必要（UI非表示・内部管理用） |
| 種別 | type | work_package / activity | ① | schema:737 | 必要（一覧/編集画面表示） |
| WBS番号 | wbsNumber | WBS体系番号(名称横に表示。入力はCSV/API経由、フォーム欄なし) | ② | schema:738 | 必要（UI非表示・内部管理用） |
| 名称 | name | タスク名 | ① | schema:739 | 必要（一覧/編集画面表示） |
| 作業内容 | description | 詳細説明・仕様 | ① | schema:740 | 必要（編集画面表示） |
| - | category | 分類(必須だがUI非表示、'other'固定補完=実質死蔵) | ③/④ | schema:741 | 必要（UI非表示・内部管理用） |
| 担当者 | assigneeId | 割り当て担当者(FK、activity必須) | ① | schema:742 | 必要（一覧/編集画面表示） |
| 開始予定日 | plannedStartDate | 計画開始日(WPは子から自動計算) | ① | schema:743 | 必要（一覧/編集画面表示） |
| 終了予定日 | plannedEndDate | 計画終了日(WPは子から自動計算) | ① | schema:744 | 必要（一覧/編集画面表示） |
| 実績開始日 | actualStartDate | 実績開始日(進捗で自動更新) | ② | schema:745 | 必要（一覧/編集画面表示） |
| 実績終了日 | actualEndDate | 実績終了日(進捗で自動更新) | ② | schema:746 | 必要（一覧/編集画面表示） |
| 予定工数 | plannedEffort | 計画工数(人時、WPは子の合計) | ① | schema:747 | 必要（一覧/編集画面表示・分析） |
| 実績工数 | actualEffort | ACT の実績工数(人時、担当者が実績入力。null=未入力) | ① | schema | 必要（ACT編集ダイアログ実績入力・分析タブの消化工数/工数効率） |
| 優先度 | priority | high/medium/low(2026-06-03 に my-tasks 列も撤去→UI 非表示、内部の既定並び順にのみ使用、default固定) | ③ | schema:748 | 必要（UI非表示・内部管理用） |
| ステータス | status | not_started / in_progress / completed など | ① | schema:749 | 必要（一覧/編集画面表示） |
| 進捗率 | progressRate | 進捗率(0-100%、WPは加重平均) | ① | schema:750 | 必要（一覧/編集画面表示） |
| マイルストーン | isMilestone | ガント図◇表示フラグ(作成フォーム入力欄なし) | ② | schema:751 | 必要（UI非表示・内部管理用） |
| - | notes | 備考(validator受理だがUI入力欄・表示なし=死蔵) | ④ | schema:752 | 必要（UI非表示・内部管理用） |
| - | createdBy | 作成者(監査用 User FK) | ③ | schema:753 | 必要（一覧画面表示） |
| - | updatedBy | 更新者(監査用 User FK) | ③ | schema:754 | 必要（一覧画面表示） |
| - | createdAt | 作成日時(自動) | ③ | schema:755 | 必要（一覧画面表示） |
| - | updatedAt | 更新日時(自動) | ③ | schema:756 | 必要（一覧画面表示） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:757 | 必要（UI非表示・内部管理用） |

**マイルストーンは、最上位に配置されているWPの終了日を自動設定します。**  

> **✅ 画面確認 (Fix / 2026-06-02) — WBS管理タブ（Task = ワークパッケージ/アクティビティ）**: 実機キャプチャで確認。新規作成は種別で項目が変化し、編集は「編集項目＋実績項目」の 2 セクション構成。
>
> **新規作成（種別で出し分け）**:
> - **ワークパッケージ作成**: 種別 / 親ワークパッケージ / 名称 / 関連URL → ［新規作成］（**工数・日程は子要素から自動集計のため入力欄なし**）
> - **アクティビティ作成**: 種別 / 親ワークパッケージ / 名称 / 担当者 / 開始予定日｜終了予定日（2 列・各「今日」）/ 予定工数（人時）/ 作業内容 / 関連URL → ［新規作成］
>
> **アクティビティ編集（2 セクション）**:
> - 編集項目: 種別 / 親WP / 名称 / 担当者 / 開始予定日（今日・クリア）/ 終了予定日（今日・クリア）/ 見積工数（人時）（「✓ 最大日工数」ガイド表示）/ 作業内容
> - 実績項目: ステータス / 進捗率 / 実績開始日（今日・クリア）/ 実績終了日（今日・クリア）
> - 末尾: 関連URL（表示名/URL ＋ 追加）/ ファイルアップロード（50MB 上限）/ ［キャンセル］［保存］/ コメント（@ メンション）
>
> ⚠️ **ラベル不整合（要確認）**: 同じ `plannedEffort` を、新規作成は「**予定工数**（人時）」、編集は「**見積工数**（人時）」と表記。用語統一の余地あり。
> ⚠️ **レイアウト差（任意）**: 開始/終了予定日が、新規作成は 2 列、編集は縦並び。

> **✅ 画面確認 (Fix / 2026-06-02) — WBS管理タブ「一覧」表示カラム**（実機キャプチャ＝正）:
> - 上部ボタン: ［エクスポート］［インポート］［追加］。フィルタ: 担当者 / 状況。［列幅をリセット］。
> - 列順: **チェック | 名称（name。WP/ACT バッジ + 階層インデント + 開閉トライアングル）| 担当者（assigneeName。WP は子から自動集約）| ステータス（status、例 未着手）| 進捗&工数（progressRate% / plannedEffort h、例「0% / 0.5h」。WP は進捗%のみ＝工数は子集計）| 予定期間（plannedStartDate 〜 plannedEndDate）| 実績期間（actualStartDate 〜 actualEndDate、未設定「-」）| 添付 | 操作（編集/削除）**。
> - 「進捗率」と「予定工数」は一覧では **進捗&工数**列に合成表示。WBS番号は名称横に併記。

> **✅ 画面確認 (Fix / 2026-06-02) — ガントチャートタブ（同じ Task を時系列表示）**（実機キャプチャ＝正）:
> - 上部: ［タスク名列の幅をリセット］。フィルタ: 担当者 / 状況。凡例: **予定**（薄青バー＝plannedStart〜plannedEnd）/ **実績(進捗)**（青バー＝progressRate に応じた実績）/ **遅延**（赤）/ **マイルストーン**（紫◇＝isMilestone）。
> - 左の **タスク名**列: WP/ACT バッジ + 階層インデント + 開閉トライアングル + ステータスバッジ（例 未着手）+ 進捗率（例 0%）+ 担当者名。
> - 右の **タイムライン**: 月／日ヘッダー（曜日付き、土日・祝日をハイライト）にタスクのバーを描画。表示は Task の plannedStart/End・actualStart/End・progressRate・isMilestone を可視化したもの（DB 列は WBS 管理タブと同一、追加カラムなし）。

## TaskProgressLog（進捗ログ）— 現状 UI 未接続（将来「変更履歴＋進捗分析」機能として展開予定）

> **重要**: 進捗の時系列ログ。書込関数 `updateTaskProgress` は `POST /api/projects/[id]/tasks/[taskId]/progress` からのみ呼ばれるが、**この API を呼ぶ画面が存在しない**（`/progress` への fetch はコード全体でゼロ）。読取 `getProgressLogs` も UI 未接続。WBS管理タブの「実績更新」は別関数 `updateTask` で **Task 本体**(`progressRate`/`status`/実績日付)を更新し、本テーブルには書き込まない。
> → **テーブル全体が「サーバ実装済・UI未接続」**。全カラム画面表示なし（画面表示名=「-」）。入力フィールドは API/zod は受理するが UI から送られないため現状 ④、サーバ自動設定は ③。
> **製品方針（2026-06-01 決定）**: 本テーブルは「変更履歴＋タスク進捗の分析」機能として **将来 UI 接続して展開する方針**（撤去しない）。サーバ実装（テーブル・route・service・zod）は既に揃っているため、進捗報告フォーム＋進捗推移グラフを画面化すれば機能化できる。「要否」=必要。

| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:778 | 必要 |
| - | taskId | 所属タスク(FK) | ③ | schema:779 | 必要 |
| - | updateDate | 進捗報告日(サーバが記録時 new Date() を設定) | ③ | task.service.ts:1109 | 必要 |
| - | progressRate | 進捗率(%)（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1110（UI呼出なし） | 必要 |
| - | actualEffort | 実施した工数（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1111（UI呼出なし） | 必要 |
| - | remainingEffort | 残工数（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1112（UI呼出なし） | 必要 |
| - | status | 進捗ステータス（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1113（UI呼出なし） | 必要 |
| - | isDelayed | 遅延フラグ（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1114（UI呼出なし） | 必要 |
| - | delayReason | 遅延の理由・背景（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1115（UI呼出なし） | 必要 |
| - | workMemo | 実施内容・作業メモ（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1116（UI呼出なし） | 必要 |
| - | hasIssue | 課題発生フラグ（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1117（UI呼出なし） | 必要 |
| - | nextAction | 次のステップ・アクション（API/zod受理だがUI未接続=死蔵） | ④ | task.service.ts:1118（UI呼出なし） | 必要 |
| - | completedDate | 完了日(status='completed'で自動set) | ③ | schema:791 | 必要 |
| - | updatedBy | 更新者(監査用 User FK) | ③ | schema:780 | 必要 |
| - | createdAt | 作成日時(自動) | ③ | schema:792 | 必要 |

> **ToBe（追加予定カラム・将来要件）** ※画面表示は現段階で不要（将来「変更履歴＋進捗分析」UI 接続時に活用）

| 画面表示名 | 内部名(予定) | 意味・用途 | 想定象限 | 備考 |
|---|---|---|---|---|
| - | createdBy | レコード作成時にシステムが自動セット（作成者 User FK） | ③ | 新規カラム。現状 `updatedBy` はあるが `createdBy` は無い |
| - | updatedAt | レコード作成・更新時にシステムが自動セット（更新日時） | ③ | 新規カラム。現状 `createdAt` はあるが `updatedAt` は無い |

## RiskIssue（リスク・課題）— `/projects/[id]/risks`（リスク一覧タブ）, `/projects/[id]/issues`（課題一覧タブ）, `/risks`（全リスク）, `/issues`（全課題）

> **設計**: 「リスク」と「課題」は **同一 DB テーブル `RiskIssue`** で、`type` カラム（`risk` / `issue`）で区別する。画面は別だがテーブル・編集ダイアログ・本定義表は共通。`impact`/`likelihood` はラベルが type で出し分けられる（影響度↔重要度、発生可能性↔緊急度）。

| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:806 | 必要（UI非表示・内部管理用） |
| - | tenantId | 所属テナント(FK、分離境界) | ③ | schema:808 | 必要（UI非表示・内部管理用） |
| - | projectId | 作成元プロジェクト(M:N中間経由で複数紐付け) | ② | schema:813 | 必要（UI非表示・内部管理用） |
| 種別（リスク/課題） | type | リスク/課題の別 | ② | COLUMN_USAGE_MAP | 必要（一覧/編集画面表示） |
| 件名 | title | 件名(公開時必須) | ① | risk-edit-dialog.tsx:244 | 必要（一覧/編集画面表示） |
| 発生事象（課題）/ 考えられる事象（リスク） | occurrence | 発生事象(issue)/考えられる事象(risk) | ① | risk-edit-dialog.tsx:289 | 必要（一覧/編集画面表示） |
| メモ | content | メモ(旧「内容」をリネーム) | ① | risk-edit-dialog.tsx:292 | 必要（編集画面表示） |
| 直接原因（課題）/ 考えられる原因（リスク） | cause | 原因(任意) | ① | risk-edit-dialog.tsx:290 | 必要（一覧/編集画面表示） |
| 影響度（リスク）/ 重要度（課題） | impact | 影響度(low/medium/high) | ① | risk-edit-dialog.tsx:303 | 必要（編集画面表示） |
| 発生可能性（リスク）/ 緊急度（課題） | likelihood | 可能性(risk)/緊急度(issue)(任意) | ① | risk-edit-dialog.tsx:309 | 必要（編集画面表示） |
| 対応策 | responsePolicy | 対応策(任意) | ① | risk-edit-dialog.tsx:291 | 必要（一覧/編集画面表示） |
| 優先度 | priority | 優先度(low/medium/high)。表示のみ、service自動算出 | ② | COLUMN_USAGE_MAP | 必要（一覧画面表示） |
| - | responseDetail | 対応詳細(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| 担当者 | assigneeId | 担当者(作成者or担当者が編集可) | ① | risk-edit-dialog.tsx:323 | 必要（一覧/編集画面表示） |
| 期限 | deadline | 対応期限(任意) | ① | risk-edit-dialog.tsx:331 | 必要（一覧/編集画面表示） |
| ステータス | state | open/in_progress/monitoring/resolved | ① | risk-edit-dialog.tsx:317 | 必要（一覧/編集画面表示） |
| - | result | 結果(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（一覧/編集画面表示） |
| - | lessonLearned | 教訓(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| 公開範囲 | visibility | draft/public | ① | risk-edit-dialog.tsx:223 | 必要（編集画面表示） |
| 脅威 / 好機 | riskNature | threat/opportunity(riskのみ) | ① | risk-edit-dialog.tsx:227 | 必要（一覧/編集画面表示） |
| - | reporterId | 起票者(作成者固定、監査用 User FK) | ③ | schema:831 | 必要（UI非表示・内部管理用） |
| - | isSeedSample | スターターデータ一括取込の識別マーカー(2026-06-05)。一覧表示は通常通り、「サンプル一括削除」の対象特定専用 | ③ | schema:857 | 必要（UI非表示・内部管理用） |
| 作成者 | createdBy | 作成者(氏名解決)。**リスク一覧/課題一覧タブ + 全リスク/全課題 /risks /issues** の両方で表示。編集ダイアログには非表示 | ② | risks-client.tsx / all-risks-table.tsx | 必要（一覧画面表示） |
| 作成日時 | createdAt | 作成日時(YYYY/MM/DD HH:mm:ss)。両一覧で表示。**プロジェクト内一覧では旧「起票日」列を本列に統合** | ② | risks-client.tsx / all-risks-table.tsx | 必要（一覧画面表示） |
| 更新者 | updatedBy | 更新者(氏名解決)。両一覧で表示。未更新(=作成時のみ)は「—」 | ② | risks-client.tsx / all-risks-table.tsx | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(自動)。両一覧で表示。未更新は「—」 | ② | risks-client.tsx / all-risks-table.tsx | 必要（一覧画面表示） |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:840 | 必要（UI非表示・内部管理用） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:845 | 必要（UI非表示・内部管理用） |

> **2026-06-02 実装（監査列の横展開）**: 4 監査列を **リスク一覧/課題一覧タブ**（旧来は createdAt を「起票日」として 1 列のみ表示）と**全リスク/全課題**で統一。プロジェクト内一覧では旧「起票日」列を削除し「作成日時」に統合（`reporterId`＝起票者は内部監査用に存続、表示は createdBy 由来の作成者）。列順 作成者→作成日時→更新者→更新日時、書式 `YYYY/MM/DD HH:mm:ss`、未更新行は更新系を「—」。氏名は tenantId フィルタ付き user lookup で解決（越境氏名漏えい防止）。

> **✅ 画面確認 (Fix / 2026-06-02) — リスク/課題 編集ダイアログ（RiskEditDialog、type で出し分け）**: 実機キャプチャで確認。
> - **リスク編集**（type=risk）: 公開範囲｜脅威/好機（2 列）→ 件名(任意) → 考えられる事象(任意) → 考えられる原因(任意) → 考えられる対応策(任意) → メモ(任意) → 結果(任意) → 影響度｜発生可能性（2 列）→ ステータス｜担当者（2 列）→ 期限 → 関連URL → ファイル → 紐付け先プロジェクト → ［保存］→ コメント
> - **課題編集**（type=issue）: 公開範囲（単独・脅威/好機なし）→ 件名(任意) → 発生事象(任意) → 直接原因(任意) → 対応策(任意) → メモ(任意) → 結果(任意) → 重要度｜緊急度（2 列）→ ステータス｜担当者（2 列）→ 期限 → 関連URL → ファイル → 紐付け先プロジェクト → ［保存］→ コメント
>
> **補足（結果は編集画面のみ）**: 「結果」は **リスク/課題が対応・収束した後に記録する事後項目** のため、**新規起票（作成）画面には表示されず、編集画面でのみ入力可能**（一覧には表示、未入力は「-」）。起票フォームの項目には結果を含めない（type/公開範囲/脅威好機(riskのみ)/件名/事象/原因/対応策/メモ/影響度/発生可能性/担当者）。

## Stakeholder（ステークホルダー）— `/projects/[id]/stakeholders`（ステークホルダー管理簿タブ）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:895 | 必要（UI非表示・内部管理用） |
| - | tenantId | 所属テナント(FK、分離境界) | ③ | schema:897 | 必要（UI非表示・内部管理用） |
| - | projectId | 所属プロジェクト(FK) | ③ | schema:898 | 必要（UI非表示・内部管理用） |
| 内部メンバー紐付け | userId | 内部メンバー紐付け(任意、null=外部関係者) | ① | schema:901 | 必要（編集画面表示） |
| 氏名 | name | 表示用氏名 | ① | stakeholder-edit-dialog.tsx:224 | 必要（一覧/編集画面表示） |
| 所属組織 / 所属 | organization | 所属組織(例:顧客企画部) | ① | stakeholder-edit-dialog.tsx:226 | 必要（一覧/編集画面表示） |
| 役職 | role | 役職(例:部長、CTO) | ① | stakeholder-edit-dialog.tsx:229 | 必要（一覧/編集画面表示） |
| 連絡先メモ | contactInfo | 連絡先メモ | ① | stakeholder-edit-dialog.tsx:235 | 必要（一覧/編集画面表示） |
| 影響度 (1-5) | influence | PMBOK Power/Interest 1-5段階 | ① | stakeholder-edit-dialog.tsx:265 | 必要（編集画面表示） |
| 関心度 (1-5) | interest | PMBOK Power/Interest 1-5段階 | ① | stakeholder-edit-dialog.tsx:271 | 必要（編集画面表示） |
| 姿勢 | attitude | supportive/neutral/opposing | ① | stakeholder-edit-dialog.tsx:293 | 必要（一覧/編集画面表示） |
| 現在のエンゲージメント | currentEngagement | PMBOK 13.1.2 5段階評価 | ① | stakeholder-edit-dialog.tsx:308 | 必要（一覧/編集画面表示） |
| 望ましいエンゲージメント | desiredEngagement | PMBOK 13.1.2 5段階評価 | ① | stakeholder-edit-dialog.tsx:318 | 必要（一覧/編集画面表示） |
| 優先度 | priority | influence/interestから自動導出(high/medium/low) | ② | stakeholder.service.ts | 必要（一覧） |
| 人となり / 考え方 | personality | 人となり・考え方・接し方のコツ | ① | stakeholder-edit-dialog.tsx:338 | 必要（編集画面表示） |
| - | tags | タグ(Phase A要件10でUI削除、zod受理) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| 対応戦略 | strategy | 対応戦略・具体的アクション | ① | stakeholder-edit-dialog.tsx:346 | 必要（編集画面表示） |
| 作成者 | createdBy | 作成者(氏名解決)。一覧で表示 | ② | stakeholders-client.tsx | 必要（一覧画面表示） |
| 作成日時 | createdAt | 作成日時(YYYY/MM/DD HH:mm:ss)。一覧で表示 | ② | stakeholders-client.tsx | 必要（一覧画面表示） |
| 更新者 | updatedBy | 更新者(氏名解決)。一覧で表示。未更新は「—」 | ② | stakeholders-client.tsx | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(自動)。一覧で表示。未更新は「—」 | ② | stakeholders-client.tsx | 必要（一覧画面表示） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:929 | 必要（UI非表示・内部管理用） |

> **Gap 列について**: 一覧の「Gap」は DB カラムではなく **`engagementGap`（= desiredEngagement − currentEngagement の段階差）をサービス層で算出した表示専用値**。`AsIs → ToBe`（現在→望ましいエンゲージメント）の引き上げ幅を示し、巻き込み計画の優先度づけに使う（0=達成済 / 正=関与強化要 / 負=過剰関与）。
> **2026-06-02 実装（一覧の列整理）**: 一覧から **影響度(influence)/関心度(interest) 列を削除**（両者は元々 doc 上「編集画面表示」で、一覧表示はドリフトだった。本対応で実装を doc に整合。値は編集ダイアログ・Power/Interest マトリクスで引き続き確認可）。**優先度(priority) 列を「役職」と「姿勢」の間に移動**。監査 4 列（作成者/作成日時/更新者/更新日時、`YYYY/MM/DD HH:mm:ss`、未更新は「—」）を他「○○一覧」と統一。

> **✅ 画面確認 (Fix / 2026-06-02) — ステークホルダー編集ダイアログ**: 実機キャプチャで確認。
> 内部メンバー紐付け → 氏名 → 所属組織｜役職（2 列）→ 連絡先メモ → 影響度(1-5)｜関心度(1-5)（2 列）→ 姿勢（単独）→ 現在のエンゲージメント｜望ましいエンゲージメント（2 列）→ 人となり/考え方 → 対応戦略 → ［保存］→ コメント
> **影響度・関心度は編集ダイアログでのみ入力**（一覧は非表示=2026-06-02 対応どおり。一覧の優先度は influence/interest から自動導出）。

> **✅ 画面確認 (Fix / 2026-06-02) — ステークホルダータブ「一覧」表示カラム**（実機キャプチャ＝正）:
> - 上部: 「N 件 / エンゲージメント Gap あり: M 件 (能動的な働きかけ推奨)」+ ［新規登録］。優先度フィルタ。［列幅をリセット］。
> - **Power/Interest エンゲージメント・マトリクス（4 象限カード、DB 列でなく influence×interest の算出グルーピング表示）**: 密接に連携（影響大×関心大）/ 満足させておく（影響大×関心小）/ 常に情報を伝える（影響小×関心大）/ モニタリング（影響小×関心小）。各カードに該当人数（「N 名」）と該当者の姿勢バッジ、該当なしは「該当者なし」。
> - 表の列順: **氏名（name）| 所属（organization）| 役職（role）| 優先度（priority、自動導出）| 姿勢（attitude、例 中立）| AsIs → ToBe（currentEngagement → desiredEngagement、例「中立 → 支持的」）| Gap（engagementGap、↑ ソート可、例 +1）| 作成者 | 作成日時 | 更新者 | 更新日時 | 操作（削除）**。
> - 影響度/関心度の列は無し（編集ダイアログのみ）。監査 4 列は `YYYY/MM/DD HH:mm:ss`、未更新は「—」。

## Knowledge（ナレッジ）— `/projects/[id]/knowledge`（ナレッジ一覧タブ）, `/knowledge`（全ナレッジ）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:948 | 必要（UI非表示・内部管理用） |
| - | tenantId | 所属テナント(FK、分離境界) | ③ | schema:952 | 必要（UI非表示・内部管理用） |
| タイトル | title | ナレッジタイトル(公開時必須) | ① | knowledge-edit-dialog.tsx:169 | 必要（一覧/編集画面表示） |
| 種別 | knowledgeType | ナレッジの種別 | ① | knowledge-edit-dialog.tsx:178 | 必要（一覧/編集画面表示） |
| 背景 | background | 背景(入力) | ① | knowledge-edit-dialog.tsx:206 | 不要（contentに統合＋embedding再生成すれば提案影響なし。※NOT NULL→migration要） |
| 内容 | content | 内容(入力) | ① | knowledge-edit-dialog.tsx:215 | 必要（一覧/編集画面表示） |
| 結果 | result | 結果(入力) | ① | knowledge-edit-dialog.tsx:252 | 不要（contentに統合＋embedding再生成すれば提案影響なし。※NOT NULL→migration要） |
| - | conclusion | 結論(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | recommendation | 推奨(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | reusability | 再利用性(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | techTags | 技術タグ(2026-04-27 UI撤去・DB温存) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | devMethod | 開発手法(2026-04-27 UI撤去・DB温存) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | processTags | 工程タグ(2026-04-27 UI撤去・DB温存) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | businessDomainTags | 業務ドメインタグ(2026-04-27 UI撤去・DB温存) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| 公開範囲 | visibility | draft/project/company | ① | knowledge-edit-dialog.tsx:184 | 必要（編集画面表示。**2026-06-02 ナレッジ一覧の列は削除**、編集ダイアログ + 一括変更ツールバーのみ） |
| 担当者 | assigneeId | 担当者(作成者or担当者が編集可、2026-05-26実装) | ① | knowledge-edit-dialog.tsx:192 | 必要（一覧/編集画面表示） |
| - | isSampleData | シードデータ識別フラグ | ③ | schema:972 | 必要（UI非表示・内部管理用） |
| - | isSeedSample | スターターデータ一括取込の識別マーカー(2026-06-05)。一覧表示は通常通り、「サンプル一括削除」の対象特定専用 | ③ | schema:990 | 必要（UI非表示・内部管理用） |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:974 | 必要（UI非表示・内部管理用） |
| 作成者 | createdBy | 作成者(creator リレーションで氏名解決)。**ナレッジ一覧タブ + 全ナレッジ /knowledge** の両方で表示。編集ダイアログには非表示 | ② | project-knowledge-client.tsx / knowledge-client.tsx | 必要（一覧画面表示） |
| 作成日時 | createdAt | 作成日時(YYYY/MM/DD HH:mm:ss)。両一覧で表示 | ② | project-knowledge-client.tsx / knowledge-client.tsx | 必要（一覧画面表示） |
| 更新者 | updatedBy | 更新者(updater リレーションで氏名解決)。両一覧で表示。未更新(=作成時のみ)は「—」 | ② | project-knowledge-client.tsx / knowledge-client.tsx | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(自動)。両一覧で表示。未更新は「—」 | ② | project-knowledge-client.tsx / knowledge-client.tsx | 必要（一覧画面表示） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:983 | 必要（UI非表示・内部管理用） |

> **2026-06-02 実装（監査列の横展開）**: 「作成者 / 作成日時 / 更新者 / 更新日時」の 4 監査列を **ナレッジ一覧タブ**（旧来は作成者+更新日時のみ）と**全ナレッジ /knowledge** で統一。列順は 作成者→作成日時→更新者→更新日時、書式は `YYYY/MM/DD HH:mm:ss`、未更新行（`updatedAt === createdAt`）は更新者/更新日時を「—」表示。氏名は Knowledge の `creator` / `updater` User リレーション経由で解決（KnowledgeDTO に `updaterName` 追加、listKnowledge で `updater` を include）。編集ダイアログには監査列を出さない方針は他「○○一覧」と共通。

> **✅ 画面確認 (Fix / 2026-06-02) — ナレッジ編集ダイアログ**: 実機キャプチャで確認（2026-06-02 の並べ替え反映済み）。
> 公開範囲｜種別（2 列・1 行目）→ タイトル(任意・2 行目) → 担当者 → 背景(任意) → 内容(任意) → 結果(任意) → 一次情報源URL → 参考リンク（表示名/URL+追加）→ ファイル → ［保存］→ コメント。
> ※ ナレッジの「結果」は通常項目として作成・編集の両方で入力可（リスク/課題の「結果」が編集のみなのとは異なる）。

## Retrospective（振り返り）— `/projects/[id]/retrospectives`（振り返り一覧タブ）, `/retrospectives`（全振り返り）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1037 | 必要（UI非表示・内部管理用） |
| - | tenantId | 所属テナント(FK、分離境界) | ③ | schema:1039 | 必要（UI非表示・内部管理用） |
| - | projectId | 作成元プロジェクト(M:N中間経由で複数紐付け) | ② | schema:1042 | 必要（UI非表示・内部管理用） |
| 実施日 | conductedDate | 振り返り実施日(公開時必須) | ① | retrospective-edit-dialog.tsx:189 | 必要（一覧/編集画面表示） |
| 計画総括 | planSummary | 計画総括(入力) | ① | retrospective-edit-dialog.tsx:213 | 必要（一覧/編集画面表示） |
| 実績総括 | actualSummary | 実績総括(入力) | ① | retrospective-edit-dialog.tsx:213 | 必要（一覧/編集画面表示） |
| 良かった点 | goodPoints | 良かった点(入力) | ① | retrospective-edit-dialog.tsx:213 | 必要（一覧/編集画面表示） |
| 問題点 | problems | 問題点(入力) | ① | retrospective-edit-dialog.tsx:213 | 必要（一覧/編集画面表示） |
| - | estimateGapFactors | 見積差異要因(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | scheduleGapFactors | スケジュール差異要因(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | qualityIssues | 品質課題(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | riskResponseEvaluation | リスク対応評価(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| - | knowledgeToShare | 共有ナレッジ(zod受理だがUI送信なし) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| 次回改善事項 | improvements | 次回改善事項(入力) | ① | retrospective-edit-dialog.tsx:213 | 必要（一覧/編集画面表示） |
| ステータス | state | draft/confirmed。ステータスバッジ表示+「確定」ボタンで遷移 | ② | retrospective.service.ts:441 | 必要（一覧/編集画面表示） |
| 公開範囲 | visibility | draft/public | ① | retrospective-edit-dialog.tsx:176 | 必要（編集画面表示。**2026-06-02 振り返り一覧の列は削除**、編集ダイアログのみ） |
| - | isSeedSample | スターターデータ一括取込の識別マーカー(2026-06-05)。一覧表示は通常通り、「サンプル一括削除」の対象特定専用 | ③ | schema:1074 | 必要（UI非表示・内部管理用） |
| 担当者 | assigneeId | 担当者(作成者or担当者が編集可、2026-05-26実装) | ① | retrospective-edit-dialog.tsx:198 | 必要（一覧/編集画面表示） |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:1057 | 必要（UI非表示・内部管理用） |
| 作成者 | createdBy | 作成者(氏名解決)。**振り返り一覧タブ + 全振り返り /retrospectives** の両方で表示。編集ダイアログには非表示 | ② | retrospectives-client.tsx / all-retrospectives-table.tsx | 必要（一覧画面表示） |
| 作成日時 | createdAt | 作成日時(YYYY/MM/DD HH:mm:ss)。両一覧で表示。実施日(conductedDate)とは別 | ② | retrospectives-client.tsx / all-retrospectives-table.tsx | 必要（一覧画面表示） |
| 更新者 | updatedBy | 更新者(氏名解決)。両一覧で表示。未更新(=作成時のみ)は「—」 | ② | retrospectives-client.tsx / all-retrospectives-table.tsx | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(自動)。両一覧で表示。未更新は「—」 | ② | retrospectives-client.tsx / all-retrospectives-table.tsx | 必要（一覧画面表示） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:1064 | 必要（UI非表示・内部管理用） |

> **2026-06-02 実装（監査列の横展開）**: 4 監査列を **振り返り一覧タブ**と**全振り返り**で統一。プロジェクト内一覧は旧来「作成者」列が createdBy の **UUID を生表示するバグ**があり、本対応で `createdByName`（氏名）解決に修正し、更新者/更新日時も追加。列順 作成者→作成日時→更新者→更新日時、書式 `YYYY/MM/DD HH:mm:ss`、未更新行は更新系を「—」。氏名は tenantId フィルタ付き user lookup で解決。**実施日(conductedDate)は作成日時とは別の業務項目**として存続。

> **ToBe（変更予定・ラベル修正）**: 一覧の表示ラベル「**次回以前事項**」を「**次回改善事項**」に修正する（i18n `retro.improvementsTable`。対象カラムは `improvements`。カラム追加ではなく表示文言の修正）。

> **✅ 画面確認 (Fix / 2026-06-02) — 振り返り編集ダイアログ**: 実機キャプチャで確認（2026-06-02 の 2 列化反映済み）。
> 公開範囲｜実施日(任意)（2 列）→ 担当者 → 計画総括(任意) → 実績総括(任意) → 良かった点(任意) → 課題(任意) → 次回改善事項(任意) → 関連URL → ファイル → 紐付け先プロジェクト → ［保存］→ コメント。
>
> **✅ 画面確認 (Fix / 2026-06-02) — 振り返り一覧・ナレッジ一覧（プロジェクト詳細タブ）**:
> - **振り返り一覧**: 公開範囲列を削除 + **担当者列を新設**。列順 = チェック・実施日・ステータス・**担当者**・作成者・作成日時・更新者・更新日時・**リンク**・添付・操作（確定/削除）。
> - **ナレッジ一覧**: 公開範囲列を削除 + **担当者列を新設**。列順 = チェック・タイトル・種別・**担当者**・作成者・作成日時・更新者・更新日時・**リンク**・添付・操作（削除）。
> - 担当者は `assigneeName`（氏名解決済）を表示、未設定は「—」。i18n は `retro.assignee` / `knowledge.assignee`（ja/en 追加）。
> - 公開範囲はリスク/課題と同様、一覧の「列」からは外したが **編集ダイアログ + 一括変更ツールバー** では従来どおり確認・変更可。
> - あわせて **縦間隔をナレッジ一覧と統一**: ナレッジ一覧の root を `space-y-4 → space-y-6` に変更し、リスク/課題/振り返り/ナレッジの「作成ボタン〜テーブルヘッダー」間の高さを 4 一覧で一致させた。
>
> **✅ 画面確認 (Fix / 2026-06-02) — リスク/課題/振り返り/ナレッジ一覧に「リンク」列を新設**:
> - 4 一覧（プロジェクト詳細タブの risks-client / retrospectives-client / project-knowledge-client）の **作成日時〜添付の間** に「リンク」列を追加（位置は添付の直前）。
> - **リスク/課題一覧の確定列順（実機キャプチャ＝正）**: チェック・件名・ステータス・優先度・担当者・結果・作成者・作成日時・更新者・更新日時・**リンク**・添付・操作（削除）。（リスク一覧は種別列なし＝リスク固定、横断「全リスク/全課題」では種別列あり。公開範囲・影響度/可能性は一覧非表示で編集ダイアログのみ。）
> - 添付は `storageProvider` で **url 型（外部リンク）/ supabase 型（アップロードファイル本体）** に分かれる。新「リンク」列は **url 型のみを縦に複数行表示**（共通部品 `LinksCell`）、編集画面で複数リンクを登録するとそのまま複数行で出る。
> - 重複表示を避けるため、既存「添付」列は **supabase 型（ファイル本体）のみ** に絞り込み（`AttachmentsCell` に渡す items を `storageProvider === 'supabase'` でフィルタ）。
> - i18n: `risk.links` / `retro.links` / `knowledge.links` = 「リンク」/「Links」（ja/en 追加）。
> - ~~横断ビュー（/risks /issues /knowledge /retrospectives = all-*-table）は本変更未反映~~ → **2026-06-03 反映済**（下記）。

> **✅ 画面確認 (Fix / 2026-06-03) — 横断ビュー（全リスク/全課題/全振り返り/全ナレッジ）の列を ○○一覧と統一**: 各横断ビュー（参照のみ）の列順を「**プロジェクト列 + 対応する○○一覧（タブ）と同じ列・同じ順**」に揃えた。本文列（事象/原因、計画総括/良かった点、背景/内容/結果 等）は詳細ダイアログでのみ表示するため一覧から撤去。
> - **全リスク/全課題** (all-risks-table): プロジェクト・[種別(両方表示時のみ)]・件名・ステータス・優先度・担当者・結果・作成者・作成日時・更新者・更新日時・**リンク**・添付・操作(admin削除)。**公開範囲列は撤去**。/risks は種別=risk 固定・/issues は issue 固定のため種別列は非表示。
> - **全振り返り** (all-retrospectives-table): プロジェクト・実施日・**ステータス**・**担当者**・作成者・作成日時・更新者・更新日時・**リンク**・添付・操作(admin削除)。計画総括/実績総括/良かった点/次回改善事項の本文列は撤去。
> - **全ナレッジ** (knowledge-client): プロジェクト・**タイトル**・種別・**担当者**・作成者・作成日時・更新者・更新日時・**リンク**・添付・操作(admin削除)。背景/内容/結果の本文列は撤去。
> - 横断ビューは**参照のみ**（チェックボックス・一括編集なし）。操作列は admin の削除ボタンのみ。詳細は読み取り専用ダイアログ（各○○一覧と同じ編集ダイアログ部品を readOnly=true で流用）。
> - **再取得の罠と修正**: 一覧の添付/リンク列は `useBatchAttachments` で取得するが、id 集合が変わらない更新（既存エンティティの編集ダイアログ内でリンク追加）では fetch key 不変で再取得されず「-」のままになっていた（DB には保存済、F5 では表示）。`useBatchAttachments` に第 4 引数 `reloadToken` を追加し、各一覧で編集ダイアログ閉鎖時・CRUD 後に token を更新して強制再取得するよう修正（risk/issue/retro/knowledge の 3 client に適用）。memos-client は同パターンで未適用。

## Memo（メモ）— `/memos`（メモ一覧）, `/all-memos`（全メモ）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1426 | 必要（UI非表示・内部管理用） |
| - | tenantId | 所属テナント(FK、分離境界) | ③ | schema:1428 | 必要（UI非表示・内部管理用） |
| 作成者 | userId | 作成者(固定、所有者/認可キー)。**2026-06-03: /all-memos のみ一覧表示。/memos は自分のメモのみのため一覧列から撤去** | ② | all-memos-client.tsx | 必要（全メモ一覧表示） |
| タイトル | title | メモタイトル(公開時必須) | ① | memos-client.tsx:434 | 必要（一覧/編集画面表示） |
| 本文 | content | メモ本文(入力) | ① | memos-client.tsx:443 | 必要（一覧/編集画面表示） |
| 公開範囲 | visibility | private/public。**2026-06-03: 一覧の列は撤去。編集ダイアログ + 一覧上部の一括変更ツールバーで操作** | ① | memos-client.tsx（編集select / CrossListBulkVisibilityToolbar） | 必要（編集画面・一括変更で操作、一覧列なし） |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:1434 | 必要（UI非表示・内部管理用） |
| - | assigneeId | 担当者(他資産は実装済、メモのみ未実装、zod受理) | ④ | COLUMN_USAGE_MAP | 必要（UI非表示・内部管理用） |
| 作成日時 | createdAt | 作成日時(自動)。**2026-06-03: 一覧へ作成日時列を追加 (件名・本文・作成日時・更新日時の並び)** | ② | memos-client.tsx / all-memos-client.tsx | 必要（一覧画面表示） |
| 更新日時 | updatedAt | 更新日時(自動、一覧で表示。作成と同値なら「—」表示) | ② | memos-client.tsx | 必要（一覧画面表示） |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:1442 | 必要（UI非表示・内部管理用） |

> **一覧の列順 (2026-06-03 統一)** — 他「○○一覧」に合わせ、リンク (url 型添付) と添付 (ファイル本体) を別列に分離。
> - **メモ一覧 (`/memos`)**: 件名 → 本文 → 作成日時 → 更新日時 → リンク → 添付 → 操作(削除)（先頭に一括選択チェックボックス列）。作成者・公開範囲の列は撤去。
> - **全メモ (`/all-memos`)**: 件名 → 本文 → 作成者 → 作成日時 → 更新日時 → リンク → 添付 → 操作(削除, admin のみ)。
> - リンク列 = `storageProvider !== 'supabase'` (外部 URL)、添付列 = `storageProvider === 'supabase'` (アップロードしたファイル本体)。
> - **2026-06-03: Memo もファイル本体アップロード対応** (`UPLOADABLE_ENTITY_TYPES` / `UPLOAD_ATTACHMENT_ENTITY_TYPES` に memo 追加、旧「URL 添付のみ」制限を解除)。URL リンク = リンク列、ファイル = 添付列。書込は memo 本人のみ、容量はテナント使用量へ計上。
> - 更新者列は持たない (メモは作成者本人のみ更新可能なため、更新者 = 作成者で冗長)。

> **ToBe（追加予定カラム・将来要件）**

| 画面表示名 | 内部名(予定) | 意味・用途 | 想定象限 | 備考 |
|---|---|---|---|---|
| 作成者 | userId（既存）or createdBy | レコード作成時の作成者 | ②/③ | **作成者は既存 `userId` が担う**（一覧表示済）。他資産と命名統一するなら `createdBy` 追加だが userId と二重になるため要検討 |
| 更新者 | updatedBy | レコード作成・更新時にシステムが自動セット（更新者 User FK） | ③ | 新規カラム。現状 `updatedAt` はあるが `updatedBy` は無い |

## RiskIssueProject（リスク・課題 × プロジェクト 紐付け）— M:N中間テーブル
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:873 | 必要（UI非表示・内部管理用） |
| - | riskIssueId | リスク・課題とプロジェクトの紐付け(M:N) | ③ | schema:874 | 必要（UI非表示・内部管理用） |
| - | projectId | リスク・課題とプロジェクトの紐付け(M:N) | ③ | schema:875 | 必要（UI非表示・内部管理用） |

## KnowledgeProject（ナレッジ × プロジェクト 紐付け）— M:N中間テーブル
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1009 | 必要（UI非表示・内部管理用） |
| - | knowledgeId | ナレッジとプロジェクトの紐付け(M:N) | ③ | schema:1010 | 必要（UI非表示・内部管理用） |
| - | projectId | ナレッジとプロジェクトの紐付け(M:N) | ③ | schema:1011 | 必要（UI非表示・内部管理用） |

## TaskKnowledge（タスク × ナレッジ 紐付け）— M:N中間テーブル
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1021 | 必要（UI非表示・内部管理用） |
| - | taskId | タスクとナレッジの紐付け(M:N) | ③ | schema:1022 | 必要（UI非表示・内部管理用） |
| - | knowledgeId | タスクとナレッジの紐付け(M:N) | ③ | schema:1023 | 必要（UI非表示・内部管理用） |

## RetrospectiveProject（振り返り × プロジェクト 紐付け）— M:N中間テーブル
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 | 要否 |
|---|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1084 | 必要（UI非表示・内部管理用） |
| - | retrospectiveId | 振り返りとプロジェクトの紐付け(M:N) | ③ | schema:1085 | 必要（UI非表示・内部管理用） |
| - | projectId | 振り返りとプロジェクトの紐付け(M:N) | ③ | schema:1086 | 必要（UI非表示・内部管理用） |

## 1-B. テナント / 課金系

## Tenant（テナント・課金）— `/settings/tenant`, `/settings/tenant/billing`, `/admin/super/tenants/*`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:58 |
| 組織ID / 連番 | slug | 組織ID(ログイン識別子)。公開サインアップはサーバが数字連番を自動採番(BASE=100000)、super_adminは手入力、Defaultは'default'固定 | ② | schema:60 |
| 組織名 | name | テナント表示名 | ② | schema:61 |
| テナント連番 | tenantSeq | 顧客向け人間可読連番(default-tenant=1)。表示用のみ | ② | schema:67 |
| プラン | plan | 'beginner'/'expert'/'pro' 契約区分 | ① | schema:69 |
| 月次API呼出数 | currentMonthApiCallCount | 当月LLM系呼出回数キャッシュ。真値はApiCallLog SUM、月初cronで0リセット | ② | schema:73 |
| 月次API課金額 | currentMonthApiCostJpy | 当月LLM系課金額(円)。monthlyBudgetCap判定対象 | ② | schema:75 |
| Embedding呼出数 | currentMonthEmbeddingCallCount | 当月Embedding系呼出回数。全プラン記録、Beginner負担外 | ③ | schema:81 |
| Embedding課金額 | currentMonthEmbeddingCostJpy | 当月Embedding系課金額(円)。Expert/Pro=件数×¥5 | ③ | schema:85 |
| - | currentMonthHelpChatCount | たすきフクロウAIチャット当月回数。全プラン月100回上限、課金外 | ③ | schema:93 |
| 月次予算上限 | monthlyBudgetCapJpy | ユーザ自己設定LLM予算上限(円)。NULL=無制限 | ① | schema:97 |
| Embedding予算上限 | monthlyEmbeddingBudgetCapJpy | Embedding系専用月次予算上限(円)。Beginner非表示、Expert/Pro任意 | ① | schema:104 |
| - | beginnerMonthlyCallLimit | Beginner月間API呼出上限(default 50)。プラン変更時のみコード書換 | ③ | schema:109 |
| - | beginnerMaxSeats | Beginner最大席数(default 5)。プラン変更時のみコード書換 | ③ | schema:111 |
| - | pricePerCallHaiku | Haiku単価 ¥10/call(固定、UI表示のみ) | ③ | schema:118 |
| - | pricePerCallSonnet | Sonnet単価 ¥15/call(固定、UI表示のみ) | ③ | schema:119 |
| 請求先種別 | billingType | 'corporate'(法人)/'individual'(個人) | ① | schema:129 |
| 会社名 | billingCompanyName | 請求書発行先正式会社名。corporate必須、individual任意 | ① | schema:132 |
| 請求先担当者名 | billingContactName | 請求書送付先担当者名 | ① | schema:134 |
| 請求先メール | billingContactEmail | 請求書PDF/案内メール送り先 | ① | schema:136 |
| 旧住所(フォールバック) | billingAddress | Legacy単一Text住所。新規入力なし、フォールバック表示用 | ② | schema:139 |
| 郵便番号 | billingPostalCode | 構造化住所要素 | ① | schema:141 |
| 都道府県 | billingPrefecture | 構造化住所要素 | ① | schema:143 |
| 市区町村 | billingCity | 構造化住所要素 | ① | schema:145 |
| 番地・町名 | billingStreetAddress | 構造化住所要素 | ① | schema:147 |
| 建物名・部屋番号 | billingBuildingName | 構造化住所要素、任意 | ① | schema:149 |
| 電話番号 | billingPhoneNumber | 連絡先電話番号、任意 | ① | schema:151 |
| 支払い方法 | paymentMethod | 'invoice'(銀行振込)/'credit_card'(自動引落) | ① | schema:155 |
| - | scheduledPlanChangeAt | プラン変更予約時刻。ダウングレード翌月適用(legacy) | ③ | schema:157 |
| - | scheduledNextPlan | 予約プラン名(legacy、即時化で新規setなし) | ③ | schema:158 |
| - | lastResetAt | 月初リセットcronが最後に処理した月初(UTC) | ③ | schema:160 |
| - | beginnerEverUpgraded | true=一度でもExpert/Proになった。Beginner復帰不可判定 | ③ | schema:165 |
| - | beginnerNoticeDay60SentAt | 60日経過警告メール送信済フラグ(重複防止) | ③ | schema:167 |
| - | beginnerNoticeDay75SentAt | 75日経過警告メール送信済フラグ | ③ | schema:169 |
| - | beginnerExpiredNoticeSentAt | 90日経過read-only通知メール送信済フラグ | ③ | schema:171 |
| - | beginnerAutoDeleteNoticeDay150SentAt | 自動削除予告メール(削除30日前)送信済フラグ | ③ | schema:173 |
| - | beginnerAutoDeleteNoticeDay170SentAt | 自動削除予告メール(削除10日前)送信済フラグ | ③ | schema:175 |
| ~~シードデータ参照~~ (撤去) | ~~seedDataEnabled~~ | **2026-06-05 撤去** (migration 20260613)。提案/チャットを単一テナント化し管理テナント越境参照を廃止。見本データは「スターターデータ取込」(is_seed_sample) に置換 | — | — |
| - | importInProgressAt | データインポート進行中ロック。30分stale失効 | ③ | schema:187 |
| DB容量使用量 | storageBytesUsed | DB容量現在値(バイト)。日次cron更新、キャッシュ値 | ② | schema:190 |
| - | storageBytesUsedAt | DB容量最終更新時刻。「○分前」表示/stale判定用 | ③ | schema:192 |
| - | storageOverLimitNoticeSentAt | DB超過通知メール送信済フラグ(重複防止) | ③ | schema:194 |
| - | storageBytesPeakThisMonth | DB月中最大使用量(バイト)。課金根拠、毎月1日reset | ③ | schema:217 |
| - | storageBytesPeakAt | DBピーク到達時刻(UI表示/audit用) | ③ | schema:219 |
| - | dbInstanceBytesPeakThisMonth | pg_database_size月中peak。Supabase実請求対比 | ③ | schema:222 |
| - | dbCapacityWarningLevel | DB容量4層防御Level(none/l1/l2/l3)。月初reset | ③ | schema:225 |
| - | storageGuardCircuitFailCount | circuit breaker失敗カウンタ。3回でwrite拒否 | ③ | schema:228 |
| - | storageGuardCircuitOpenedAt | circuit breaker open時刻(一時write全拒否) | ③ | schema:230 |
| ファイル容量使用量 | storageFileBytesUsed | Supabase Storage現在値(バイト)。日次cron更新 | ② | schema:245 |
| - | storageFileBytesUsedAt | ファイル容量最終更新時刻。「○分前」表示用 | ③ | schema:247 |
| - | storageFileBytesPeakThisMonth | ファイル月中最大使用量。課金根拠の真値、毎月1日reset | ③ | schema:250 |
| - | storageFileBytesPeakAt | ファイルピーク到達時刻(UI表示/audit用) | ③ | schema:252 |
| - | storageBucketBytesPeakThisMonth | Storage Dashboard実請求対比のdrift検知用 | ③ | schema:255 |
| - | fileStorageWarningLevel | ファイル容量4層防御Level。月初reset | ③ | schema:258 |
| - | storageFileBytesYesterday | 日次異常検知baseline。+5GB以上増加でalert | ③ | schema:261 |
| タイムゾーン | timezone | IANAタイムゾーン名(default 'Asia/Tokyo') | ① | schema:265 |
| ロケール / 言語 | locale | BCP47ロケール(default 'ja-JP') | ① | schema:268 |
| - | createdAt | 作成日時(自動) | ② | schema:269 |
| - | updatedAt | 更新日時(自動) | ③ | schema:270 |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:271 |
| 停止状態 | suspendedAt | read-only強制移行時刻。停止バナー表示 | ② | schema:278 |
| - | suspendReason | 停止理由コード('payment_delinquent'等)。停止時必須 | ③ | schema:281 |
| - | suspendedBy | 停止操作したsuper_admin User.id(監査用) | ③ | schema:283 |
| - | resumedAt | 直近の停止解除時刻(監査用) | ③ | schema:286 |
| - | createdByUserId | テナント払い出し時の初期admin User.id | ③ | schema:296 |
| - | stripeCustomerId | Stripe Customer ID。credit_card切替時作成 | ③ | schema:309 |
| - | stripeSubscriptionId | Stripe Subscription ID。プラン契約時作成 | ③ | schema:312 |
| Stripe購読ステータス | stripeSubscriptionStatus | 'active'/'past_due'/'canceled'等。Webhook同期 | ② | schema:315 |
| - | stripeSubscriptionItemHaikuId | Stripe Meter event送信先(Haiku/Expert) | ③ | schema:317 |
| - | stripeSubscriptionItemSonnetId | Stripe Meter event送信先(Sonnet/Pro) | ③ | schema:319 |
| - | stripeSubscriptionItemEmbeddingId | Stripe Meter event送信先(Embedding) | ③ | schema:325 |
| - | stripeSubscriptionItemDbCapacityId | Stripe Meter event送信先(DB容量超過) | ③ | schema:335 |
| - | stripeSubscriptionItemStorageFileId | Stripe Meter event送信先(ファイル容量超過) | ③ | schema:336 |
| - | stripeDefaultPaymentMethodId | Stripe Payment Method ID(デフォルトカード) | ③ | schema:339 |
| カード最終検証日時 | cardLastVerifiedAt | カード検証成功時刻。プラン変更時/月初cronで更新 | ② | schema:341 |
| カード検証ステータス | cardVerificationStatus | 'valid'/'expired'/'declined'/'never_verified' | ② | schema:343 |
| - | autoSuspendScheduledAt | past_due→自動suspend予定時刻(Webhook受信時now+3d) | ③ | schema:347 |

## ApiCallLog（API呼出ログ＝請求の真値）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1477 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1478 |
| - | userId | 実行ユーザ。cron/匿名/システム実行時null | ③ | schema:1479 |
| - | featureUnit | 機能区分('project-upsert'等)、課金対象判定に使用 | ③ | schema:1480 |
| - | modelName | 使用LLM/embeddingモデル名 | ③ | schema:1481 |
| - | llmInputTokens | LLM入力トークン数。embedding専用はnull | ③ | schema:1483 |
| - | llmOutputTokens | LLM出力トークン数。embedding専用はnull | ③ | schema:1484 |
| - | embeddingTokens | embeddingトークン数。LLM専用はnull | ③ | schema:1486 |
| - | costJpy | 発生課金額(円整数)。請求・counter更新の源泉 | ③ | schema:1488 |
| - | latencyMs | API呼出遅延(ミリ秒) | ③ | schema:1489 |
| - | requestId | リクエスト識別子 | ③ | schema:1490 |
| - | createdAt | 作成日時(自動) | ③ | schema:1491 |

## SuggestionExplanation（なぜ機能の説明キャッシュ）— システム + 表示
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1529 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1530 |
| - | projectId | 提案対象プロジェクト(FK) | ③ | schema:1532 |
| - | candidateKind | 候補種別('knowledge'/'issue'/'retrospective') | ③ | schema:1534 |
| - | candidateId | 候補側ID(Knowledge/RiskIssue/Retrospective.id) | ③ | schema:1536 |
| (説明文) | explanation | 提案説明(LLM出力)。提案画面で表示 | ② | schema:1538 |
| - | modelName | 生成に使用したLLMモデル名 | ③ | schema:1540 |
| - | costJpy | 生成時課金額(円整数) | ③ | schema:1542 |
| - | generatedBy | 生成実行ユーザ(監査用) | ③ | schema:1544 |
| - | generatedAt | 生成日時(自動) | ③ | schema:1545 |

## TenantMonthlyUsageHistory（月次使用量スナップショット）— `/admin/super/usage`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1584 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1585 |
| 対象月 | yearMonth | "YYYY-MM"形式。UNIQUE key、月ラベル表示 | ② | schema:1587 |
| 当月総コール数 | apiCallCount | 課金対象ApiCallLog月内総数。LLM+Embedding+Storage合算 | ② | schema:1595 |
| 当月総課金額 | apiCostJpy | 課金対象costJpy SUM(円整数)。請求書根拠 | ② | schema:1598 |
| Embedding呼出数 | embeddingCallCount | Embedding系呼出回数。全プラン記録(Beginner¥0) | ② | schema:1604 |
| Embedding課金額 | embeddingCostJpy | Embedding系課金額(円)。Expert/Pro=件数×¥5 | ② | schema:1609 |
| 当月末プラン | plan | 当月末時点プラン(請求書根拠) | ② | schema:1611 |
| アクティブユーザ数 | activeUserCount | 当月末時点アクティブユーザ数(請求書根拠) | ② | schema:1613 |
| DB容量使用量 | storageBytesUsed | DB容量snapshot(バイト)。過去月容量推移グラフ用 | ② | schema:1617 |
| ファイル容量ピーク | fileStorageBytesPeak | ファイルストレージpeak(バイト)。月初snapshot | ② | schema:1621 |
| ファイル容量超過課金額 | fileStorageOverageJpy | ファイル超過課金額(円)。ApiCallLog真値ベース | ② | schema:1624 |
| 当月総課金額合計 | totalJpy | 当月総課金額(LLM+Storage合算)。集計用 | ② | schema:1626 |
| - | createdAt | snapshot生成日時(月初cron起動時刻) | ③ | schema:1628 |

## TenantImportPreview（インポート2段階フロー）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1655 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1656 |
| - | createdByUserId | preview生成admin。apply時に同一ユーザのみ実行可 | ③ | schema:1658 |
| - | parsedJson | パース+バリデーション済取込予定データ | ③ | schema:1661 |
| - | costEstimate | 課金見積(calls/estimatedJpy等)。apply時再評価 | ③ | schema:1663 |
| - | summary | パース済件数/エラー件数/詳細サマリ(UI再表示/監査用) | ③ | schema:1665 |
| - | createdAt | 作成日時(自動) | ③ | schema:1666 |
| - | expiresAt | 有効期限(createdAt+24h)。cron削除対象 | ③ | schema:1668 |

## BillingHistory（請求履歴）— `/admin/super/billing/[yearMonth]`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1776 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1777 |
| 請求対象月 | yearMonth | "YYYY-MM"形式。テナントTZベース月単位 | ② | schema:1779 |
| 支払い方法 | paymentMethod | 'invoice'(銀行振込)/'credit_card'(自動引落) | ② | schema:1782 |
| 課金額 | amountJpy | 課金額(税抜、円整数) | ② | schema:1784 |
| 消費税額 | taxAmountJpy | 消費税額(円整数)。Stripe Tax計算結果 | ② | schema:1786 |
| 税込合計 | totalAmountJpy | 税込み合計(=amountJpy+taxAmountJpy) | ② | schema:1788 |
| 状態 | status | pending/paid/failed/refunded/canceled/replaced_by_stripe | ② | schema:1796 |
| - | stripeInvoiceId | Stripe Invoice ID(credit_card払いのみ) | ③ | schema:1798 |
| 入金確認日時 | paidAt | 入金確認日時(status='paid'時) | ③ | schema:1800 |
| 失敗理由 | failureReason | Stripe failure_code等(credit_card払い失敗時) | ③ | schema:1802 |
| 試行回数 | retryCount | Smart Retries試行回数(0〜4) | ③ | schema:1804 |
| 支払期日 | paymentDueDate | 銀行振込支払期日(翌月25日JST)。credit_cardはnull | ③ | schema:1808 |
| - | overdueAlertSentAt | 期日超過alert送信日時(dedup用) | ③ | schema:1812 |
| 次回リトライ予定日時 | nextPaymentAttempt | credit_card Smart Retries次回試行予定時刻 | ③ | schema:1816 |
| - | confirmedBy | 銀行振込手動消込実行者User.id(credit_cardはnull) | ③ | schema:1819 |
| - | confirmedAt | super_admin消込操作時刻(paidAtと区別) | ③ | schema:1822 |
| - | createdAt | 作成日時(自動) | ③ | schema:1823 |
| - | updatedAt | 更新日時(自動) | ③ | schema:1824 |

## StripeWebhookEvent（Stripe Webhook イベント）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | Stripe event.id(冪等性キー、主キー) | ③ | schema:1739 |
| - | type | イベント種別('customer.subscription.updated'等) | ③ | schema:1741 |
| - | payloadJson | 受信payload全体(JSON)。失敗時調査/リプレイ用 | ③ | schema:1743 |
| - | receivedAt | Stripe受信時刻(自動) | ③ | schema:1745 |
| - | processedAt | 処理完了時刻。null=未処理 | ③ | schema:1747 |
| - | errorMessage | 処理失敗時エラーメッセージ(運用調査用) | ③ | schema:1749 |
| - | retryCount | 失敗試行回数(0=初回失敗前/3=DLQ入り) | ③ | schema:1751 |
| - | nextRetryAt | 次回再試行スケジュール時刻。null=DLQ(停止) | ③ | schema:1753 |

## StripeUsageRecordQueue（Stripe Meter イベント送信キュー）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1849 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1850 |
| - | callType | 'haiku'/'sonnet'/'embedding'。Meter event識別 | ③ | schema:1856 |
| - | apiCallLogId | 元のApiCallLog.id(idempotency_key) | ③ | schema:1858 |
| - | quantity | Meter event quantity(default 1) | ③ | schema:1859 |
| - | occurredAt | 元のAPI呼出時刻(Stripe Usage Record timestamp) | ③ | schema:1861 |
| - | retryCount | 送信試行回数(0〜5) | ③ | schema:1863 |
| - | nextSendAt | 次回送信予定時刻。null=DLQ。backoff:1,5,15,60,240分 | ③ | schema:1866 |
| - | sentAt | 送信成功時刻。null=未送信 | ③ | schema:1868 |
| - | lastError | 直近エラーメッセージ | ③ | schema:1870 |
| - | createdAt | 作成日時(自動) | ③ | schema:1871 |

## TenantConsentLog（規約同意証跡）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1897 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1898 |
| - | userId | 同意したユーザID(sign up時初期admin) | ③ | schema:1901 |
| - | consentType | 'terms'/'privacy'。同意種別 | ③ | schema:1903 |
| - | version | 同意規約バージョン(例'1.0')。LP表記と一致 | ③ | schema:1905 |
| - | ipAddress | 同意取得時IP(証跡) | ③ | schema:1907 |
| - | userAgent | 同意取得時User-Agent(証跡) | ③ | schema:1909 |
| - | acceptedAt | 同意日時(自動、immutable) | ③ | schema:1910 |

## 1-C. 認証 / ユーザ系

## User（ユーザ）— `/admin/users`, `/settings`, `/(auth)/*`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:392 |
| - | tenantId | 所属テナント(FK) | ③ | schema:398 |
| ユーザ名 | name | ユーザ表示名(100字以下) | ① | schema:399 |
| メールアドレス | email | ユーザのメール(テナント内一意) | ① | schema:400 |
| - | passwordHash | パスワードのbcryptハッシュ | ③ | schema:401 |
| システムロール | systemRole | admin/general等の権限レベル | ① | schema:402 |
| アカウントステータス/ステータス | isActive | 有効/無効フラグ。2026-06-03〜 状態表示は invitationAcceptedAt と組合せ「招待中/有効/無効」を導出 (招待中は本フラグ false かつ未受諾) | ① | schema:403, user.service.ts deriveAccountStatus |
| ログイン失敗回数/PW失敗 {n}/5 | failedLoginCount | 連続失敗カウント(5回でロック) | ② | schema:404 |
| 一時ロック | lockedUntil | 一時ロック解除予定時刻(NULL=解除済) | ② | schema:405 |
| - | temporaryLockCount | 一時ロック発生回数の累積(永続ロック判定用) | ③ | schema:410 |
| 永続ロック | permanentLock | 恒久ロック状態フラグ | ② | schema:411 |
| 二段階認証(MFA)/MFA有効状態 | mfaEnabled | MFA有効フラグ。admin編集で「設定済み/未設定」表示、設定済み時のみリカバリーコード再発行導線を表示 | ② | schema:412, user-edit-dialog.tsx |
| - | mfaSecretEncrypted | TOTP秘密の暗号化値 | ③ | schema:413 |
| MFA有効化日時 | mfaEnabledAt | MFA有効化のタイムスタンプ | ② | schema:414 |
| MFA失敗 {n}/3 | mfaFailedCount | MFA検証失敗カウント(3回でロック) | ② | schema:419 |
| MFA一時ロック | mfaLockedUntil | MFA一時ロック解除予定時刻(NULL=解除済) | ② | schema:420 |
| 前回ログイン/最終ログイン | lastLoginAt | 最後のログイン成功日時(NULL=未ログイン)。admin一覧の列+編集ダイアログで表示(休眠ユーザ把握) | ② | schema:421, users-client.tsx, user-edit-dialog.tsx |
| アカウント状態(招待中/有効/無効の導出元) | invitationAcceptedAt | 招待受諾日時。NULL=招待中(パスワード未設定)、値あり=受諾済。Beginner席数は「有効+招待中(予約)」で数える(案A)。admin一覧の状態バッジ+編集ダイアログの招待中セクション(再送/取消)で使用 | ② | schema(invitation_accepted_at), users-client.tsx, user-edit-dialog.tsx |
| - | forcePasswordChange | 初回PW変更強制フラグ(インポートユーザ) | ③ | schema:422 |
| - | tokenVersion | JWT失効カウンタ(強制ログアウト用) | ③ | schema:430 |
| 画面テーマ | themePreference | light/dark等のテーマ選択 | ① | schema:433 |
| 作成者 | createdBy | 招待した管理者のUUID(自己参照FK回避でリレーション無し)。admin一覧で氏名解決し「作成者」列表示。NULL=記録なし(既存/セルフ有効化/システム) | ② | schema(created_by), users-client.tsx |
| 更新者 | updatedBy | 最後に編集した管理者のUUID。admin一覧で氏名解決し「更新者」列表示。NULL=記録なし | ② | schema(updated_by), users-client.tsx |
| 作成日時 | createdAt | アカウント作成日時(自動)。admin一覧の「作成日時」列 | ② | schema:436, users-client.tsx |
| 更新日時 | updatedAt | 更新日時(DB自動付与)。admin一覧の「更新日時」列で表示(旧:アプリ未参照) | ② | schema:437, users-client.tsx |
| - | deletedAt | 論理削除日時(NULL=有効)。2026-06-03〜 論理削除専用に戻した(旧設計は「招待中」もここで代用し一覧除外していたが、招待中は invitationAcceptedAt:null で表し一覧に表示する) | ③ | schema:438 |

## Session（セッション）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:488 |
| - | sessionToken | NextAuthセッショントークン(一意) | ③ | schema:489 |
| - | userId | セッション対象ユーザ(FK) | ③ | schema:490 |
| - | expires | セッション有効期限 | ③ | schema:491 |
| - | createdAt | セッション作成日時(自動) | ③ | schema:492 |

## EmailVerificationToken（メール確認トークン）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:501 |
| - | tenantId | 所属テナント(FK・越境再利用防止) | ③ | schema:504 |
| - | userId | 対象ユーザ(FK) | ③ | schema:505 |
| - | tokenHash | トークンのSHA-256ハッシュ(平文はメール/URLのみ) | ③ | schema:506 |
| - | expiresAt | トークン有効期限 | ③ | schema:507 |
| - | usedAt | 使用済日時(一度限り制御・NULL=未使用) | ③ | schema:508 |
| - | createdAt | 作成日時(自動) | ③ | schema:509 |

## PasswordResetToken（パスワード再設定トークン）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:519 |
| - | tenantId | 所属テナント(FK・越境再利用防止) | ③ | schema:521 |
| - | userId | 対象ユーザ(FK) | ③ | schema:522 |
| - | tokenHash | トークンのSHA-256ハッシュ(平文はメール/URLのみ) | ③ | schema:523 |
| - | expiresAt | トークン有効期限 | ③ | schema:524 |
| - | usedAt | 使用済日時(一度限り制御・NULL=未使用) | ③ | schema:525 |
| - | createdAt | 作成日時(自動) | ③ | schema:526 |

## RecoveryCode（MFAリカバリコード）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:536 |
| - | tenantId | 所属テナント(FK) | ③ | schema:538 |
| - | userId | 対象ユーザ(FK) | ③ | schema:539 |
| - | codeHash | リカバリコードのハッシュ | ③ | schema:540 |
| - | usedAt | 使用済日時(一度限り制御・NULL=未使用) | ③ | schema:541 |
| - | createdAt | 作成日時(自動) | ③ | schema:542 |

## PasswordHistory（パスワード変更履歴）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:552 |
| - | tenantId | 所属テナント(FK) | ③ | schema:554 |
| - | userId | 対象ユーザ(FK) | ③ | schema:555 |
| - | passwordHash | 過去のパスワードハッシュ(再利用防止) | ③ | schema:556 |
| - | createdAt | 変更日時(直近N件判定で参照) | ③ | schema:557 |

## 1-D. ログ / 通知 / 添付 / embedding 系

## AuditLog（監査ログ）— `/admin/audit-logs`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1101 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1104 |
| - | userId | 操作ユーザ(FK) | ③ | schema:1105 |
| 操作 | action | CREATE/UPDATE/DELETE | ② | COLUMN_USAGE_MAP |
| 対象 | entityType | 対象エンティティ種別(ポリモーフィック) | ② | COLUMN_USAGE_MAP |
| 対象ID | entityId | 対象エンティティID(ポリモーフィック) | ② | COLUMN_USAGE_MAP |
| - | beforeValue | JSON変更差分(変更前) | ③ | schema:1109 |
| - | afterValue | JSON変更差分(変更後) | ③ | schema:1110 |
| - | ipAddress | 操作元IPアドレス | ③ | schema:1111 |
| 日時 | createdAt | 作成日時(自動) | ② | schema:1112 |

## AuthEventLog（認証イベントログ）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1125 |
| - | tenantId | 所属テナント(FK、NULL許容) | ③ | schema:1128 |
| - | eventType | イベント種別(login_success/login_failure/logout他) | ③ | schema:1129 |
| - | userId | 対象ユーザ(FK、NULL許容) | ③ | schema:1130 |
| - | email | メールアドレス(pre-auth失敗時、NULL許容) | ③ | schema:1131 |
| - | ipAddress | 操作元IPアドレス | ③ | schema:1132 |
| - | userAgent | User-Agent文字列 | ③ | schema:1133 |
| - | detail | JSON詳細情報 | ③ | schema:1134 |
| - | createdAt | 作成日時(自動) | ③ | schema:1135 |

## SystemErrorLog（システムエラーログ）— システムのみ
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1159 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1161 |
| - | severity | エラー重要度(info/warn/error/fatal) | ③ | schema:1162 |
| - | source | 発生箇所(server/client/cron他) | ③ | schema:1163 |
| - | message | エラーメッセージ本文 | ③ | schema:1164 |
| - | stack | スタックトレース | ③ | schema:1165 |
| - | userId | 対象ユーザ(FK、NULL許容) | ③ | schema:1166 |
| - | requestId | リクエストID(トレース用) | ③ | schema:1167 |
| - | context | JSON追加情報(IP/path他) | ③ | schema:1168 |
| - | createdAt | 作成日時(自動) | ③ | schema:1169 |

## CronExecutionLog（cron実行履歴）— `/admin/super/cron-history`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1206 |
| cron名 | cronName | cron識別子(lock-inactive-users他) | ② | COLUMN_USAGE_MAP |
| 開始 | startedAt | 実行開始時刻 | ② | COLUMN_USAGE_MAP |
| - | completedAt | 実行完了時刻(NULL=実行中orタイムアウト) | ③ | schema:1209 |
| 所要 | durationMs | 所要時間(ミリ秒) | ② | COLUMN_USAGE_MAP |
| ステータス | status | running/success/failure | ② | COLUMN_USAGE_MAP |
| エラー | errorMessage | エラーメッセージ | ② | COLUMN_USAGE_MAP |
| - | errorStack | スタックトレース詳細 | ③ | schema:1213 |
| - | payloadJson | 実行結果サマリJSON | ③ | schema:1215 |
| IP | invokerIp | 呼出元IPアドレス(cron-job.org) | ② | COLUMN_USAGE_MAP |

## RoleChangeLog（権限変更履歴）— `/admin/role-changes`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1226 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1230 |
| - | changedBy | 変更実行者(User FK) | ③ | schema:1231 |
| - | targetUserId | 対象ユーザ(User FK) | ③ | schema:1232 |
| 種別 | changeType | system_role/project_role | ② | COLUMN_USAGE_MAP |
| - | projectId | 対象プロジェクト(FK、NULL許容) | ③ | schema:1234 |
| 変更前 | beforeRole | 変更前ロール | ② | COLUMN_USAGE_MAP |
| 変更後 | afterRole | 変更後ロール | ② | COLUMN_USAGE_MAP |
| 理由 | reason | 変更理由 | ② | COLUMN_USAGE_MAP |
| 日時 | createdAt | 作成日時(自動) | ② | COLUMN_USAGE_MAP |

## Attachment（添付ファイル）— 各エンティティ詳細画面
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1256 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1258 |
| - | entityType | 対象エンティティ種別(ポリモーフィック) | ③ | schema:1259 |
| - | entityId | 対象エンティティID(ポリモーフィック) | ③ | schema:1260 |
| - | slot | スロット位置(primary/general他) | ③ | schema:1261 |
| ファイル名 | displayName | 表示用ファイル名 | ① | attachment-list.tsx |
| DLリンク | url | ファイルURL(最大2000字) | ① | attachment-list.tsx |
| - | mimeHint | MIME型ヒント(拡張子判定用) | ③ | schema:1264 |
| - | addedBy | 追加ユーザ(User FK) | ③ | schema:1265 |
| - | createdAt | 作成日時(自動) | ③ | schema:1266 |
| - | updatedAt | 更新日時(自動) | ③ | schema:1267 |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:1268 |
| - | storageProvider | ファイル保存先(url=旧/supabase=本体保存) | ③ | schema:1284 |
| - | storageObjectKey | Supabase Storage Object Key | ③ | schema:1287 |
| サイズ | sizeBytes | ファイルサイズ(バイト) | ② | attachment-list.tsx |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:1292 |
| 状態 | embeddingStatus | pending/generating/completed/failed/unsupported | ② | attachment-list.tsx |
| - | extractedTextHash | 抽出テキストSHA-256ハッシュ(重複防止/改ざん検知) | ③ | schema:1301 |
| - | embeddingGeneratedAt | Embedding生成成功時刻 | ③ | schema:1303 |
| - | embeddingRetryCount | Embedding生成リトライ回数(3で打切) | ③ | schema:1305 |
| - | embeddingLastRetryAt | 最終リトライ時刻(指数backoff) | ③ | schema:1307 |

## Comment（コメント）— 各エンティティ詳細画面
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1331 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1333 |
| - | entityType | 対象エンティティ種別(ポリモーフィック) | ③ | schema:1334 |
| - | entityId | 対象エンティティID(ポリモーフィック) | ③ | schema:1335 |
| - | userId | 投稿ユーザ(FK) | ③ | schema:1336 |
| 本文 | content | コメント本文 | ① | comment.service.ts |
| - | createdAt | 作成日時(自動) | ③ | schema:1338 |
| - | updatedAt | 更新日時(自動、編集フラグ判定に使用) | ③ | schema:1339 |
| - | deletedAt | 論理削除日時(NULL=有効) | ③ | schema:1340 |

## Mention（メンション）— コメント内 @メンション
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1363 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1365 |
| - | commentId | 親コメント(Comment FK、Cascade削除) | ③ | schema:1366 |
| (@入力) | kind | メンション種別(user/all/project_member/role_*他) | ① | mention.service.ts |
| (@入力) | targetUserId | 対象ユーザ(User FK、kind='user'のみ有値) | ① | mention.service.ts |
| - | createdAt | 作成日時(自動) | ③ | schema:1369 |

## Notification（通知）— 通知ベル
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1395 |
| - | tenantId | 所属テナント(FK) | ③ | schema:1397 |
| - | userId | 受信ユーザ(FK) | ③ | schema:1398 |
| 種別 | type | task_start_due/task_end_due他 | ② | notification-bell.tsx |
| - | entityType | 対象エンティティ種別(ポリモーフィック) | ③ | schema:1400 |
| - | entityId | 対象エンティティID(ポリモーフィック) | ③ | schema:1401 |
| 通知文 | title | 通知本文 | ② | notification-bell.tsx |
| リンク | link | 通知先リンク(クリック遷移) | ② | notification-bell.tsx |
| - | dedupeKey | 重複抑止用キー(1日1回保証) | ③ | schema:1406 |
| 既読 | readAt | 既読日時(NULL=未読) | ② | notification-bell.tsx |
| - | createdAt | 作成日時(自動) | ③ | schema:1408 |

## EmailSendLog（メール送信ログ）— `/admin/super/email-failures`
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1698 |
| - | tenantId | 所属テナント(FK、NULL許容=システム通知) | ③ | schema:1700 |
| 種別 | type | invitation/usage_alert/beginner_warning他 | ② | email-failures/page.tsx |
| - | recipientHash | 送信先メールのSHA-256ハッシュ(PII保護) | ③ | schema:1704 |
| ドメイン | recipientDomain | 送信先メールのドメイン部 | ② | email-failures/page.tsx |
| - | success | 送信成功フラグ | ③ | schema:1708 |
| エラー | errorMessage | 失敗時エラーメッセージ | ② | email-failures/page.tsx |
| プロバイダ | providerName | brevo/resend/console/inbox/smtp | ② | email-failures/page.tsx |
| 送信日時 | sentAt | 送信実行時刻 | ② | email-failures/page.tsx |

## FaqEmbedding（FAQ embedding）— システムのみ（help-chat RAG 基盤）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1947 |
| - | entryId | FAQエントリID(config と一致) | ③ | schema:1950 |
| - | contentHash | 生成元テキストのSHA-256(drift検知用) | ③ | schema:1953 |
| - | contentSnapshot | 本文snapshot(RAG入力用) | ③ | schema:1955 |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:1957 |
| - | requiresAdmin | 管理者限定フラグ(権限フィルタ) | ③ | schema:1959 |
| - | requiresProjectPm | Project PM/PL限定フラグ(権限フィルタ) | ③ | schema:1961 |
| - | requiresProjectMember | Project member以上限定フラグ(権限フィルタ) | ③ | schema:1964 |
| - | category | FAQカテゴリ(plan/csv/mfa他、filter/debug用) | ③ | schema:1966 |
| - | generatedAt | Embedding生成時刻(drift確認/監査) | ③ | schema:1968 |
| - | createdAt | 作成日時(自動) | ③ | schema:1969 |
| - | updatedAt | 更新日時(自動) | ③ | schema:1970 |

## GuideEmbedding（使い方ガイド embedding）— システムのみ（help-chat RAG 基盤）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:1984 |
| - | entryId | ガイドステップID(config と一致) | ③ | schema:1986 |
| - | contentHash | 生成元テキストのSHA-256(drift検知用) | ③ | schema:1987 |
| - | contentSnapshot | 本文snapshot(RAG入力用) | ③ | schema:1988 |
| - | contentEmbedding | 意味検索用ベクトル(Voyage 1024次元、自動生成) | ③ | schema:1989 |
| - | requiresAdmin | 管理者限定フラグ(権限フィルタ) | ③ | schema:1990 |
| - | requiresProjectPm | Project PM/PL限定フラグ(権限フィルタ) | ③ | schema:1991 |
| - | requiresProjectMember | Project member以上限定フラグ(権限フィルタ) | ③ | schema:1993 |
| - | stepOrder | 表示順(ガイドはステップ順で意味を持つ) | ③ | schema:1995 |
| - | generatedAt | Embedding生成時刻 | ③ | schema:1996 |
| - | createdAt | 作成日時(自動) | ③ | schema:1997 |
| - | updatedAt | 更新日時(自動) | ③ | schema:1998 |

## SystemBanner（システム周知バナー）— `/admin/super/banners`（運営者専用 / ADR-0036）
| 画面表示名 | 内部名 | 意味・用途 | 象限 | 根拠 |
|---|---|---|---|---|
| - | id | 主キー(UUID自動採番) | ③ | schema:SystemBanner |
| メッセージ | message | 帯に表示する本文(最大500字) | ① | system-banner.ts |
| 緊急度 | severity | high(赤)/medium(黄)/low(青) | ① | system-banner.ts |
| 表示開始日時 | startAt | この日時から表示(JST入力→timestamptz) | ① | ADR-0036 |
| 表示終了日時 | endAt | この日時で表示終了 | ① | ADR-0036 |
| 有効 | enabled | false=取り下げ(期間内でも非表示、履歴は残る) | ① | ADR-0036 |
| - | createdBy | 払い出したsuper_adminのUser.id(FKなし) | ③ | ADR-0036 |
| - | createdAt | 作成日時(自動) | ③ | schema |
| - | updatedAt | 更新日時(自動) | ③ | schema |

> グローバル(tenantId なし)。表示判定 getActiveBanner + 1本制約(期間重複禁止)。`message/severity/startAt/endAt/enabled` は管理画面で super_admin が入力(①)。

---

# Part E. 整理対象カラムの棚卸し（アクション候補）

> 「不要・死蔵」「非表示だが必須」「将来 UI 復活候補」に該当するカラムと、推奨対応。**最終判断は人間（製品判断）に委ねる。**

## E-1. zod 受理・UI 送信なし（dead code、最大の塊）
| エンティティ | カラム | 経緯 | 推奨方針（要・製品判断） |
|---|---|---|---|
| RiskIssue | responseDetail / result / lessonLearned | 4 セクション化で他列は UI 露出、これらは残留 | 将来 UI 復活 or 撤去 |
| RiskIssue | priority | PR #63 で UI 撤去、service 自動算出に移行 | ③ として維持（zod 受理は整理可） |
| Knowledge | conclusion / recommendation / reusability / techTags / devMethod / processTags / businessDomainTags（7） | 2026-04-27 `refactor/knowledge-tags-removal-temp` で UI 撤去・DB 温存 | **要方針決定**: 復活予定なら一時撤去の追跡、無ければ撤去 |
| Retrospective | estimateGapFactors / scheduleGapFactors / qualityIssues / riskResponseEvaluation / knowledgeToShare（5） | 元々 UI 未実装、zod のみ受理 | 将来 UI 復活 or 撤去 |
| Stakeholder | tags | Phase A 要件 10 で UI 削除 | 復活予定なら追跡、無ければ撤去 |
| Memo | assigneeId | 他資産は 2026-05-26 実装、メモのみ未実装 | **UI 入力欄を追加**（横展開漏れの可能性大） |
| Estimate | preconditions / notes | service/zod 受理、UI 非表示 | UI 入力欄追加 or 撤去 |
| ~~Task | notes~~ | ✅ **解消済 (2026-06-12 feat/url-autolink)**: アクティビティの作成/編集ダイアログに「備考」入力欄を新設（MarkdownTextarea・最大 1000 文字・URL 自動リンク化）。死蔵ではなくなった | — |

## E-2. 必須なのに UI 非表示（システムが既定値補完）
| エンティティ | カラム | 状態 | 推奨方針 |
|---|---|---|---|
| Task | category（分類） | NOT NULL、UI 非表示、`'other'` 固定補完 | **要方針決定**: 分類を使う設計なら UI 入力追加、使わないなら撤去検討 |

## E-3. 表示のみ・UI 入力経路なし（インポート/API のみ）
| エンティティ | カラム | 状態 | 推奨方針 |
|---|---|---|---|
| Project | outOfScope（スコープ外） | 詳細で表示のみ、作成/編集フォームに入力欄なし | UI 入力欄追加 or 表示専用と割り切る |
| Project | notes（備考） | 同上 | 同上 |
| Task | priority（優先度） | 2026-06-03 に my-tasks 列も撤去→UI 完全非表示、内部の既定並び順にのみ使用、`default 'medium'` 固定 | UI で優先度設定を可能にするか方針決定 |
| Task | wbsNumber（WBS番号） | 名称横に表示、入力は CSV/API のみ | UI 個別入力の要否決定 |
| Task | isMilestone | ガント◇表示のみ、作成フォームに入力欄なし | マイルストーン設定 UI の要否決定 |

## E-4. legacy / フォールバック（撤去は慎重に）
| エンティティ | カラム | 状態 |
|---|---|---|
| Tenant | scheduledPlanChangeAt / scheduledNextPlan | Expert↔Pro 即時化で新規 set なし、cron に旧データ処理が残存 |
| Tenant | billingAddress | 構造化住所に置換済、フォールバック表示用に残置 |

## E-5. アプリ未参照の自動 timestamp（無害、撤去候補ではない）
User.updatedAt / Session.createdAt / 各 Token.createdAt 等。Prisma 自動付与の監査列。撤去メリットは薄い。

## E-6. テーブル全体が UI 未接続（サーバ実装済・画面から未使用）
| テーブル | 状態 | 方針 |
|---|---|---|
| **TaskProgressLog（進捗ログ）** | 書込 `updateTaskProgress`（`POST /api/.../[taskId]/progress`）も読取 `getProgressLogs` も**呼ぶ画面が無い**。進捗の時系列ログ機能がサーバ実装済だが UI 未接続（進捗の最新値は Task 本体に保存され表示、ログ蓄積はされていない）| **将来展開予定（撤去しない、2026-06-01 製品方針）**: 「変更履歴＋タスク進捗の分析」機能として UI 接続する。進捗報告フォーム（作業メモ/遅延理由/次アクション等の時系列記録）＋進捗推移グラフを画面化。サーバ実装は既存のため接続で機能化可能 |

## 残課題（実装側の検討事項。本マップの分類自体は確定済）
- **Retrospective.state のバリデーション欠落**: `state` は validator(retrospective.ts) に無く、update 経路で pass-through 受理される（[retrospective.service.ts:527](../../src/services/retrospective.service.ts#L527)）。「確定」操作は固定値 `'confirmed'` を set するため通常運用では問題ないが、PATCH 経由で任意文字列を受け付けうる。zod enum 追加を推奨。
- E-1〜E-3 の各死蔵列について「将来 UI 復活予定 あり/なし」の製品判断が未確定（撤去/復活の方針決定待ち）。

---

## 関連メモ / 設計ドキュメント

- インポート設計: マッピング対象は「UI 表示項目のみ」。非表示かつ必須 → システム既定値補完（Task.category）、非表示かつ任意 → マッピング除外。
- [DATA_MODEL.md](./DATA_MODEL.md)（実装ミラー） / [SCREENS.md](../specification/SCREENS.md) / [STATE_REFERENCE.md](./STATE_REFERENCE.md)
