# 共通 UI 制御ルール (Specification)

本ドキュメントは、画面横断的な UI 制御ルールを集約する (SPECIFICATION.md §12)。技術的な実装パターンは [design/UI_PATTERNS.md](../design/UI_PATTERNS.md) を参照。

---

## 12. 共通UI制御ルール

### 12.1 保存系
- 未入力の必須項目がある場合は保存不可または保存時エラーとする
- クローズ状態では保存不可とする（読み取り専用。ただしプロジェクトの削除は可）
  - ※ 2026-06 簡素化で旧「完了」「振り返り完了」状態は廃止（実行中→クローズの 5 区分）

### 12.2 削除系
- すべて論理削除とする
- メンバー、閲覧者は削除ボタンを表示しない
- クローズ状態では削除不可とする

### 12.3 状態変更系
- プロジェクト状態変更は **PM/TL またはシステム管理者** が可 (fix/quick-ux 改修、2026-04-26)
  - 旧仕様: PM/TL のみ (admin は除外して「運用責務分離」を意図) → 運用が詰まるケースが多発し admin 代行を許可
- クローズ解除はシステム管理者のみ可とする
- 状態変更時は遷移条件チェックを必須実施する

### 12.4 公開・確定系
- 見積確定、振り返り確定、ナレッジ公開はPM/TL以上のみ可とする
- メンバーは下書き・提案までとする

### 12.5 実装向け判定式
操作可否は以下で判定する。

`操作可 = ロール可 AND 状態可 AND 対象データ条件可`

例: メンバーが進捗更新できる条件

`メンバーである AND 実行中である AND 自分担当タスクである`

---

### 12.6 確認ダイアログ系 (破壊的・不可逆操作)

削除・解除など **取り消せない / 影響範囲の大きい操作** は、実行前にユーザ確認を必須とする。実装は `window.confirm(t(...))` で i18n 文言を渡し、キャンセル時は早期 return して副作用を起こさない。

| 操作 | 確認文言 (i18n key) | 実装箇所 |
|---|---|---|
| コメント削除 | `deleteConfirm` | [comment-section.tsx:453](../../src/components/comments/comment-section.tsx) |
| 添付ファイル / URL 削除 | `deleteConfirm` / `deleteUrlConfirm` | [attachment-list.tsx:221](../../src/components/attachments/attachment-list.tsx) / [single-url-field.tsx:118](../../src/components/attachments/single-url-field.tsx) |
| ユーザ削除 | `deleteConfirm` (name / email を埋め込み) | [user-edit-dialog.tsx:131](../../src/components/dialogs/user-edit-dialog.tsx) |
| プロジェクト紐付け解除 | `unlinkConfirm` (projectName を埋め込み) | [linked-projects-section.tsx:71](../../src/components/common/linked-projects-section.tsx) |

ルール:
- **破壊的操作 (論理削除・解除) は必ず確認ダイアログを経由する** (§12.2 削除系と整合)。
- 確認文言には **対象を特定できる情報** (ユーザ名・プロジェクト名等) を含め、誤対象への実行を防ぐ。
- ユーザがキャンセルした場合は state 変更・API 呼び出しを一切行わない (早期 return)。

### 12.7 未保存変更ガード (dirty guard)

フォーム入力途中での **タブ切替 / 画面離脱** で入力内容が失われる経路では、未保存変更 (dirty) を検知して確認ダイアログを表示する。

- dirty 判定は **現在フォーム値と baseline 値の比較** (`JSON.stringify(form) !== JSON.stringify(baseline)`) で行う ([tenant-settings-client.tsx:1820](../../src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx))。
- dirty な状態でタブを離れようとしたら `confirm('...未保存の変更があります...続行しますか?')` で確認し、キャンセル時は遷移を中止する ([tenant-settings-client.tsx:201](../../src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx))。
- 遷移が確定したら dirty フラグを解除する (再入力で再度立つ)。

### 12.8 フォーム検証・送信制御

- **必須項目未入力時は送信ボタンを `disabled`** にするか、送信時にエラー表示する (§12.1 保存系と整合)。
- 文字数上限を持つ入力欄 (例: ヘルプチャット `MAX_QUERY_CHARS = 2000`、チャット意味検索 `CHAT_SEARCH_INPUT_MAX_CHARS = 8000`) は、超過時に送信を不可とし警告を表示する。閾値定数は `@/config/*` に分離して Client / Server で共有する。
- 送信中 (`submitting`) / レート制限中 (`rateLimited`) は送信ボタンを `disabled` にして連投・二重送信を防ぐ ([help-chat-input.tsx:363](../../src/components/help-chat/help-chat-input.tsx))。
- 連投を伴う非同期送信は `AbortController` で前回 in-flight リクエストを破棄し、race / 古いレスポンスの上書きを防ぐ。

### 12.9 一覧のページネーション (標準機能、2026-06-03)

すべての一覧テーブルは **1 ページ 100 行のページネーション** を標準で備える。

- ページ送り (前へ / 次へ / 「N / 全M ページ」) は**表の直下・中央**に統一配置する (全画面で同一位置)。1 ページに収まる件数のときは非表示。
- 絞り込み・検索条件を変えると**先頭ページに戻す**。並び替えではページを維持する。
- 実装は共通部品 `useTablePagination` + `<TablePagination>` に集約し、画面ごとに独自実装しない (技術詳細は [design/UI_PATTERNS.md §38.8](../design/UI_PATTERNS.md))。
- 監査ログのみ、取得上限を選ぶ「表示件数」(100/300/1000/全件) を併設する。

---

