---
name: recall
description: 開発着手時にナレッジベース (DEVELOPER_GUIDE.md / E2E_LESSONS_LEARNED.md) から関連事例を抽出し、適用すべき横展開・回避すべき罠の一覧を返す
---

# /recall — 開発着手前のナレッジ参照

新機能・改修・バグ修正の **着手前** に必ず実行する KDD (知識駆動開発) フローの Step 2。

## 実行タイミング (必須)

- 新規 PR を切る前
- 既存 PR への大きな変更を加える前
- バグ調査の方針を決める前
- リファクタの範囲を決める前

「ちょっとした修正」でもスキップしない。同じ罠が連続再発した実例 (§10.5 末尾追記コンフリクト 5 例目まで) を踏まえての方針。

## 入力 (引数)

ユーザは以下のいずれかの形式で topic を指定する:

- 自然言語: 「リスクの編集ダイアログにフィールドを追加したい」
- ファイル名: `risks-client.tsx` の改修
- パターン名: `visibility 表示`、`edit dialog 自動 close`、`SearchableSelect`、`getByLabel`
- 引数なし: 直近の会話文脈から推測

## 手順

### Step 1: ナレッジソースの全体像を把握

```bash
# DEVELOPER_GUIDE の章立てを確認
grep -nE "^### " docs/developer/DEVELOPER_GUIDE.md | head -40
# E2E_LESSONS_LEARNED の章立てを確認
grep -nE "^### " docs/developer/E2E_LESSONS_LEARNED.md | head -40
```

### Step 2: topic に関連する section を抽出

3 種類の検索を順に実行:

1. **キーワード一致**: topic に含まれる名詞を grep
   ```bash
   grep -nE "<keyword>" docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md
   ```

2. **触るファイルに紐づくセクション**: 改修ファイルを grep
   ```bash
   grep -nE "<filename>" docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md
   ```

3. **「再発事例」「汎化ルール」を含む全セクション**: 過去に複数回発生したパターンは横展開価値が高い
   ```bash
   grep -nE "再発事例|汎化ルール" docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md
   ```

### Step 3: 抽出結果を「適用」「回避」に分類して提示

報告フォーマット:

```
## /recall 結果: <topic>

### 適用すべき先例 (これを真似する)

- §X.Y タイトル — 適用ポイント (どう使うか)
- §X.Y タイトル — 適用ポイント

### 回避すべき罠 (再発させない)

- §X.Y タイトル — 罠の概要 + 回避方法
- §X.Y タイトル — 罠の概要 + 回避方法

### 関連 (参考程度)

- §X.Y タイトル

### 結論

実装前に **適用 N 件 / 回避 M 件** を全て踏まえて進める。
```

### Step 4: ユーザに確認

「上記を踏まえて実装に進みます。漏れはないですか？」と聞く。

ユーザが新しい関連事例を提示した場合は Step 2 を再実行。

## 出力例

### 入力: 「リスク編集ダイアログにフィールドを追加したい」

```
## /recall 結果: リスク編集ダイアログにフィールド追加

### 適用すべき先例

- §5.10.1.5 (DEVELOPER_GUIDE) — `<Label htmlFor>` + `<Input id>` ペア必須。新規フィールド追加時も同規約
- §5.11 (DEVELOPER_GUIDE) — 編集ダイアログの save→close 順序は `onOpenChange(false) → void onSaved()`
- §5.11 — 編集可能なフィールドはリスト表示にも必ず追加 (visibility 表示漏れの教訓)

### 回避すべき罠

- §4.3 (E2E_LESSONS) — Label htmlFor 漏れで getByLabel が timeout
- §4.30 (E2E_LESSONS) — 「担当者」など部分一致するラベルは exact:true で防御
- §5.10 — HTML5 required で拾えない SearchableSelect は handleXxx 先頭で事前 validation

### 結論

実装前に 適用 3 件 / 回避 3 件 を全て踏まえて進める。
```

## 連携

- 実装中に **新たな罠を発見** → `/knowledge-add` で即追記
- ナレッジが多すぎて整理が必要 → `/knowledge-organize`
- 関連: CLAUDE.md「知識駆動開発 (KDD) フロー」 Step 2
