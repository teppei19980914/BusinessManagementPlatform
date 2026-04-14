---
name: feedback_no_hardcoding
description: UIテキストのハードコーディング禁止。labels ファイルに集約する（全プロジェクト共通）
type: feedback
originSessionId: 2256dc31-9f5d-432f-9efc-bc90c56fcf76
---
ユーザー向けテキスト（ラベル、説明文、エラーメッセージ、プレースホルダー等）をコンポーネントやページに直接書かない。

**Why:** 複数プロジェクト（GrowthEngine, HomePage, MindFlow）で繰り返し指示された共通ルール。表記変更やi18n対応時に全ファイル検索が必要になるのを防ぐため。

**How to apply:**
- フロントエンド: labels.ts / labels.json 等にテキストを集約し、キーで参照
- バックエンド: ログメッセージ・docstring・コメントは対象外（開発者向けのため）
- 新プロジェクトでも同じ原則を適用する
