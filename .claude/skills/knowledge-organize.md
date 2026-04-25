---
name: knowledge-organize
description: ナレッジベース (DEVELOPER_GUIDE.md / E2E_LESSONS_LEARNED.md) を MECE 視点で監査し、重複統合・古い情報の更新・dead セクション削除を行う。週次 or PR 5 件ごとが推奨実行頻度
---

# /knowledge-organize — ナレッジベース MECE 整理

KDD (知識駆動開発) フローの Step 7。ナレッジが増えると重複・矛盾・陳腐化が発生する
ため、定期的に整理する。

## 実行タイミング

- **週次 (推奨)**: 毎週金曜午後など固定タイミング
- **PR 5 件ごと**: PR 番号が 5 増えたら実行
- **章立てが見にくくなったと感じたら**: 主観的な閾値だが重要

## 監査観点 (MECE)

### 1. 重複検出 (M = Mutually Exclusive)

同じ事象が複数セクションに散らばっていないか。

```bash
# 同一キーワードを含むセクションを抽出
for keyword in "htmlFor" "getByLabel" "router.refresh" "末尾追記" "WebKit" "stacked PR"; do
  echo "=== $keyword ==="
  grep -nE "^### .*$keyword|^### " docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md \
    | grep -E "$keyword|^([^:]+):[0-9]+:###"
done
```

判定基準:

| 状態 | アクション |
|---|---|
| 完全に同じ事象が 2 セクション | 1 つに統合、もう 1 つは削除 + ポインタを残す |
| 似ているが微妙に違う | 統合せず両方残し、相互参照を追記 (「§X.Y も参照」) |
| 1 つの大きな事象を分割している | 章立てとして適切なら維持、過剰分割なら統合 |

### 2. 網羅性 (E = Collectively Exhaustive)

主要な開発活動領域に対して、ナレッジが偏っていないか。

確認すべき領域 (本プロジェクトの場合):

- フォーム/UI コンポーネント (§5.x 系)
- API/サービス層 (§5.x 系)
- DB schema/Prisma (§5.x 系)
- 認証/認可 (DESIGN.md §脅威 と CLAUDE.md セキュリティ)
- E2E テスト (§4.x 系)
- Git/PR 運用 (§10.x 系)
- Vercel/CI 運用 (§10.x 系)

特定領域がスカスカなら、過去の commit/PR ログから補完候補を探す。

### 3. 鮮度

「PR #NN 時点で〜」と書かれた情報が現在も有効か。

```bash
# PR 番号付き記述の鮮度チェック
grep -nE "PR #[0-9]+|2026-[0-9]+-[0-9]+" docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md \
  | head -50
```

判定基準:

| 状態 | アクション |
|---|---|
| 既に解消済の罠 | 「歴史記録として残す」「もう発生しない」を明記 |
| API/関数名が変わった | 旧名 + 新名を併記 |
| 完全に陳腐化 | 削除 + 削除理由を更新履歴に記録 |

### 4. dead セクション

参照ゼロ・ポインタなしの孤立セクション。

```bash
# section の見出しを抽出 → 他セクションからの参照数を grep
grep -oE "§[0-9]+\.[0-9]+" docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md | sort | uniq -c | sort -n | head -10
```

参照ゼロのセクションは:
- 本当に独立した知見なら維持
- 他で言及されてもおかしくないのに参照ゼロなら relevance を再評価

## 整理手順

### Step 1: 監査レポート作成

以下のフォーマットでユーザに提示:

```
## /knowledge-organize 監査レポート (YYYY-MM-DD)

### 重複候補 (N 件)

- §A.B + §C.D : <同じ事象、統合候補>
- §X.Y : <他 2 セクションと内容重複>

### 鮮度懸念 (N 件)

- §A.B : PR #NN 時点の記述、現状 X が変更済 → 更新候補
- §X.Y : 旧 API 名のまま記述 → 新名併記候補

### dead セクション (N 件)

- §A.B : 参照ゼロ、内容も他で言及なし
- §X.Y : 参照ゼロ、ただし独立価値あり (維持)

### 網羅性ギャップ (N 件)

- 領域 X (例: パフォーマンス計測) のナレッジが §0 件、過去 PR から補完候補:
  - PR #NN: <内容>
```

### Step 2: ユーザ承認後、変更を適用

1 つずつ編集 (一括では危険) し、各変更を更新履歴に記録:

```markdown
| 2026-XX-XX | §X.Y 統合 (旧 §A.B + 旧 §C.D を §X.Y に統合)。理由: 同じ事象を別文言で記述していた。<3 行> |
| 2026-XX-XX | §X.Y 削除 (dead セクション、PR #NN 時点で解消済)。<2 行> |
| 2026-XX-XX | §X.Y 更新 (API 名変更追従)。<旧名 → 新名> |
```

### Step 3: 整理後の検証

```bash
# 章番号の連続性チェック (欠番があれば再採番判断)
grep -nE "^### [0-9]+\.[0-9]+" docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md
# 重複参照のチェック
grep -nE "§[0-9]+\.[0-9]+" docs/developer/DEVELOPER_GUIDE.md docs/developer/E2E_LESSONS_LEARNED.md \
  | awk -F: '{print $3}' | sort | uniq -c | sort -rn | head
```

## 整理しすぎない原則

過度な統合は **「歴史 (なぜそうなったか)」を失う** 。以下は維持する:

- 「再発事例」シリーズ (§10.5 の 5 例目まで等) — 連続再発の事実は教訓そのもの
- PR 番号の引用 — 後から「いつどの PR で得た知見か」を辿れる価値
- 「旧 → 新」の対比記述 — 移行期の混乱を回避できる

## 連携

- 着手前のナレッジ参照 → `/recall` (整理されたナレッジが参照しやすくなる)
- 新ナレッジ追記 → `/knowledge-add` (整理時に重複検知の手間が減るよう既存に統合する)
- 関連: CLAUDE.md「知識駆動開発 (KDD) フロー」 Step 7
