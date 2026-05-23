# docs/roadmap/future/ — v2 以降の将来構想

本ディレクトリは、**v1.0 (2026-06-01) の対象外** で、**v1.x 〜 v2 以降に検討する将来構想**の文書集約場所です。

> **active な仕様** (`docs/specification/`) と **完了済プロジェクトの履歴** (`docs/archive/`) の中間に位置づけます。
> 「いずれ実装する」前提のドラフト仕様をここに置くことで、specification/ には v1.0 リリース対象の仕様だけを残し可読性を保ちます。

---

## ファイル一覧

(現在、本ディレクトリに active なファイルはありません。`CHAT_SEMANTIC_SEARCH.md` は 2026-05-23 に v1 実装決定により [../../specification/CHAT_SEMANTIC_SEARCH.md](../../specification/CHAT_SEMANTIC_SEARCH.md) に復帰しました。)

---

## 取り扱いルール

### 配置する判断基準

- **v1.0 (6/1) リリースの対象外** であり、明確に「実装は将来」と判断されている
- ただし設計議論は進んでおり、仕様ドラフトが存在する
- vision レベル (思想・価値観) ではなく、具体的な機能仕様レベル

### specification/ への移動 (active 化)

実装着手が決まったら specification/ に戻す:

1. `git mv docs/roadmap/future/<file>.md docs/specification/<file>.md`
2. 本 README の索引から削除
3. specification/README.md の索引に追加
4. PR で実装計画と同時に提示

### archive/ への移動 (撤退判断)

「やはり実装しない」と決まったら archive へ:

1. `git mv docs/roadmap/future/<file>.md docs/archive/future-plans/<file>.md`
2. 本 README から削除
3. docs/archive/README.md に「撤退理由」を含めて記録

---

## 関連ドキュメント

- 現行ロードマップ: [../RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md)
- 提案エンジン v2 計画: [../SUGGESTION_ENGINE_PLAN.md](../SUGGESTION_ENGINE_PLAN.md)
- 思想・長期展望: [../../vision/README.md](../../vision/README.md) §8 長期的な展望
- v1 リリースノート: [../../operations/RELEASE_NOTES_v1.md](../../operations/RELEASE_NOTES_v1.md) — 「v1.0 の対象外」セクション
