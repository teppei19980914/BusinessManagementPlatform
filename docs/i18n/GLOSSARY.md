# i18n 用語集 (Glossary)

> たすきば Knowledge Relay の **訳語正本**。全 PR / 全 commit / 全翻訳作業はこの表に従う。
>
> 訳語ドリフトを防ぐため、ここに無い概念を新規翻訳するときは **必ずこのファイルに追加してから** 使用する。
>
> 参照ルール:
> - 実装 (`messages/*.json`, コード内 fallback) は本表の **EN 列の正確な綴り** を使う
> - 文書 (`docs/public/*`, `docs/business/*`) も本表に従って統一する
> - PR レビューは本表との突合を必須項目とする (KDD_PATTERNS.md「ハードコード復活防止」参照)

---

## 1. エンティティ (主要オブジェクト)

| 日本語 | English | 内部識別子 (DB / API) | 補足 |
|---|---|---|---|
| プロジェクト | Project | `project` | |
| タスク | Task | `task` | WBS の葉ノード。Activity / Work Package も含めて Task と総称 |
| ワークパッケージ | Work Package | `workPackage` / `WP` | Task の親階層 (中間レベル) |
| アクティビティ | Activity | `activity` / `ACT` | Task の親階層 (粗いレベル) |
| WBS | WBS | `wbs` | Work Breakdown Structure。略称のまま使用 |
| 見積 / 見積もり | Estimate | `estimate` | 表記ゆれ防止: 常に "Estimate" (単数) |
| ナレッジ | Knowledge | `knowledge` | 単複同形。"Knowledges" は使わない |
| リスク | Risk | `risk` | |
| 課題 | Issue | `issue` | "Problem" / "Task" との混同を避け常に Issue |
| リスク/課題 | Risk/Issue | `riskIssue` | 内部的に同一エンティティ。UI 表示は両併記 |
| 振り返り | Retrospective | `retrospective` | "Retro" は許容しない (正式名のみ) |
| 提案 | Suggestion | `suggestion` | フクロウ AI の提案機能 |
| ステークホルダー | Stakeholder | `stakeholder` | |
| 顧客 | Customer | `customer` | |
| メモ | Memo | `memo` | |
| 添付 | Attachment | `attachment` | URL のみ (ファイル実体は外部) |
| コメント | Comment | `comment` | |
| メンション | Mention | `mention` | |
| 通知 | Notification | `notification` | |
| 監査ログ | Audit Log | `auditLog` | |
| お知らせ | Announcement | `announcement` | システム告知。"News" は使わない |

## 2. テナント・課金・認証

| 日本語 | English | 内部識別子 | 補足 |
|---|---|---|---|
| テナント | Tenant | `tenant` | |
| プラン | Plan | `plan` | Beginner/Free/Standard/Professional |
| Beginner プラン | Beginner Plan | `beginner` | 90 日無料試用枠 |
| Free プラン | Free Plan | `free` | |
| Standard プラン | Standard Plan | `standard` | |
| Professional プラン | Professional Plan | `professional` | |
| 席数 | Seat / Seats | `seats` | 課金単位、複数形可 |
| 招待 | Invitation | `invitation` | 招待中ユーザの状態名は "Invited" |
| 招待中 | Invited | `invited` | ユーザ状態 |
| 有効 | Active | `active` | ユーザ状態 |
| 無効 | Disabled | `disabled` | ユーザ状態 (論理削除とは別軸) |
| 論理削除 | Soft delete | `softDeleted` | 単語間スペース、"deleted" 単独は使わない |
| 物理削除 | Hard delete | `hardDeleted` | |
| 権限 | Role | `role` | "Permission" は権限の細目に使う |
| 役割 | Role | `role` | Role と同義 |
| 多要素認証 (MFA) | Multi-factor Authentication (MFA) | `mfa` | 略称 MFA を本文でも使う |
| パスワード | Password | `password` | |
| ログイン | Sign in | `signIn` | "Login" は使わず "Sign in" / "Signed in" |
| ログアウト | Sign out | `signOut` | |
| サインアップ | Sign up | `signUp` | |
| アカウント | Account | `account` | |
| 請求 | Billing | `billing` | |
| 請求書 | Invoice | `invoice` | |
| 支払い方法 | Payment method | `paymentMethod` | |
| クレジットカード | Credit card | `creditCard` | |
| 銀行振込 | Bank transfer | `bankTransfer` | |

## 3. UI / 操作

| 日本語 | English | 補足 |
|---|---|---|
| 保存 | Save | |
| キャンセル | Cancel | |
| 削除 | Delete | "Remove" は "紐付けを解除" 等の関係解除に使う |
| 解除 | Remove / Unlink | 紐付け解除等 |
| 編集 | Edit | |
| 新規作成 | Create | UI 動詞、"Add" は item を既存集合に追加する場合 |
| 追加 | Add | |
| 戻る | Back | |
| 閉じる | Close | |
| 今日 | Today | |
| クリア | Clear | |
| 検索 | Search | |
| フィルタ | Filter | "Filtering" は動名詞 |
| 並び替え | Sort | |
| 一括更新 | Bulk update | "Mass" は使わない |
| 一括削除 | Bulk delete | |
| ダウンロード | Download | |
| アップロード | Upload | |
| エクスポート | Export | |
| インポート | Import | |
| 取り込み | Import | "Import" に統一 |
| 公開 | Publish | |
| 下書き | Draft | |
| 確定 | Finalize | "Confirm" は確認ダイアログ、Finalize は状態遷移 |
| 確認 | Confirm | 確認ダイアログ |
| 適用 | Apply | |
| プレビュー | Preview | |
| 続行 | Continue | |
| 同意する | Agree | |

## 4. ステータス・状態名

| 日本語 | English | 内部識別子 |
|---|---|---|
| 進行中 | In Progress | `IN_PROGRESS` |
| 完了 | Done | `DONE` |
| 未着手 | Not Started | `NOT_STARTED` |
| 保留 | On Hold | `ON_HOLD` |
| クローズ | Closed | `CLOSED` |
| 中止 | Cancelled | `CANCELLED` |
| 期限切れ | Expired | `EXPIRED` |
| 期限間近 | Due Soon | `DUE_SOON` |
| 読み取り専用 | Read-only | `READ_ONLY` |
| 停止中 | Suspended | `SUSPENDED` |
| 有効化 | Enable / Enabled | |
| 無効化 | Disable / Disabled | |

## 5. メッセージ・通知

| 日本語 | English | 補足 |
|---|---|---|
| 〜しました (完了 toast) | "...d" / "Successfully ...d" | 例: "Saved" / "Deleted successfully" |
| 〜に失敗しました | "Failed to ..." | 例: "Failed to save" |
| 〜できません | "Cannot ..." | 権限/状態起因 |
| 〜が見つかりません | "... not found" | |
| しばらくお待ちください | "Please wait..." | |
| 入力内容に誤りがあります | "Invalid input" | バリデーション包括 |
| 通信エラーが発生しました | "Network error occurred" | |
| 権限がありません | "Permission denied" | |
| 内部エラーが発生しました | "Internal error occurred" | global-error 等 |
| ご迷惑をおかけしております | "We apologize for the inconvenience." | global-error の補足 |
| ご利用いただきありがとうございます | "Thank you for using" | メール冒頭定型 |

## 6. 固有名詞・ブランド

| 日本語 | English | 補足 |
|---|---|---|
| たすきば | Tasukiba | 固有名詞、両言語で同綴り |
| たすきば Knowledge Relay | Tasukiba Knowledge Relay | 製品正式名 |
| たすきフクロウ | Owl / Tasukiba Owl | マスコット。"the Owl" もしくは "Tasukiba Owl" |
| 開発者 | Developer | |
| システム管理者 | System Administrator | `superAdmin` |
| テナント管理者 | Tenant Administrator | `tenantAdmin` |
| サマリ | Summary | |
| ダッシュボード | Dashboard | |

## 7. 数量・単位

| 日本語 | English | 補足 |
|---|---|---|
| {count} 件 | {count} items / 1 item / {count} items | ICU plural 必須 |
| {count} 件中 {selected} 件 | {selected} of {count} | |
| {days} 日 | {days, plural, one {# day} other {# days}} | |
| {hours} 時間 | {hours, plural, one {# hour} other {# hours}} | |
| {n} GB | {n} GB | 単位はスペース付き、本文も `5 GB` |
| {n} MB | {n} MB | 同上 |
| 約 {n} | approx. {n} | |

## 8. 禁忌・揺れ防止

- "Login" 禁止 → **"Sign in"** で統一 (NextAuth 慣習 + GitHub/Stripe 慣習に合わせる)
- "Logout" 禁止 → **"Sign out"** で統一
- "Retro" 禁止 → **"Retrospective"** で統一
- "Knowledges" 禁止 → **"Knowledge"** (単複同形)
- "Member" は座席ホルダー、"User" はシステム上のアカウント (混同しない)
- "Owner" は使わない (ロールは "Tenant Administrator" / "Project Manager" / "Member" 等で明示)
- 日付/数値は ICU `{date}` / `{number}` で必ずフォーマット (生 `toLocaleString` の散在を防ぐ)

## 9. 追加運用

新しい訳語を追加するときは:
1. **この表に行を追加** (PR タイトルに `[glossary]` を含める)
2. CONVENTIONS.md の key 命名規約に準じてメッセージカタログ key を起こす
3. 既存の同義訳がないか grep して横展開漏れを防ぐ

訳語の変更は **既存データへの影響** を必ず検討すること (DB 内に EN ラベルが入っている場合、migration が必要)。
