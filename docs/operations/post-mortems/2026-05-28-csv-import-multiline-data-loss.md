# Post-mortem: CSV 上書きインポートで quoted multi-line cell の 2 行目以降が silent に欠落

- **日付**: 2026-05-28
- **重大度**: S-high (silent data loss、復旧経路は rollback snapshot のみ)
- **対応者**: teppei
- **影響時間**: 2026-04 (T-22 sync-import 機能リリース時点) 〜 2026-05-28 (本 PR デプロイまで)
- **影響範囲**: 5 entity の sync-import (knowledge / risk-issue / retrospective / memo / wbs-task)

---

## サマリ (3 行以内)

5 sync-import service すべてが `csvText.split(/\r?\n/)` で CSV 全文を改行で先割りしてから自前の 1 行用パーサ (`parseCsvLine`) を呼んでいたため、RFC 4180 の **quoted multi-line cell** (例: `"line1\nline2"`) が分断され、`background` / `content` / `本文` 等の textarea 入力フィールドの **2 行目以降が silent に欠落** していた。エクスポート側 (`escapeCsv()`) は改行を正しくクォートしていたため、**export と import が round-trip しない非対称性**を持っていた。

## タイムライン

| 時刻 | 出来事 |
|---|---|
| 2026-04 | T-22 で 5 entity の sync-import 機能をリリース。最初の knowledge 実装に `split(/\r?\n/) + parseCsvLine` パターンが含まれ、後続 4 entity (risk / retro / memo / task) に **機械流用** で複製 (KDD §5.32 段階的汎用化の代償でもある) |
| 2026-04 ~ 2026-05-28 | ユーザは sync-import 経路を利用するたび multi-line cell が silent に欠落していた可能性 (件数カウントは正常値、エラー表示なしのため気付けず) |
| 2026-05-28 朝 | ナレッジ一覧から 4 件追加 + 1 件更新を一括インポートしたところ、`text` フィールドの最初の 1 行しか反映されないことを発覚 |
| 2026-05-28 昼 | サブエージェントで全 service フルスキャン、5 service が同型バグを保持していることを特定 |
| 2026-05-28 夕 | `csv-parse/sync` (既存 dependency) でラップする `parseCsvText` を `task.service.ts` に追加、5 service を置き換え、round-trip テスト 5 件 + parser 単体テスト 8 件追加で本 PR 完了 |

## 影響

- **ユーザ影響**: 「エクスポート → Excel 編集 → 再 import」経路で textarea 入力フィールドが silent に短縮される。短縮されたデータで UPDATE が走ると元の multi-line 値は rollback snapshot からしか復旧不能 (CREATE 経路は最初から短縮データで作成)
- **データ影響**: 報告時点の対象は **ナレッジ 5 件 (CREATE 4 / UPDATE 1)**。詳細は「データ復旧」セクション参照
- **金銭影響**: なし (Embedding 課金は ADR-0022 の 1 業務操作 = ¥1 集約で影響なし)
- **個人情報漏洩**: なし (本人テナント内のデータ短縮のみ。他テナントへの混入は無し)
- **検知容易度**: 低 (エラー表示なし / 件数カウント正常 / 行末の `fields.length < 3` skip で silent)

## 直接原因 (Direct Cause)

```typescript
// src/services/knowledge-sync-import.service.ts:112 (修正前)
const cleanText = csvText.replace(/^﻿/, '');
const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());  // ❌ NG
//                ↑ quoted multi-line cell を物理行で分断
if (lines.length < 2) return [];

const headerFields = parseCsvLine(lines[0]);
// ... col 設定 ...

const dataLines = lines.slice(1);
for (let i = 0; i < dataLines.length; i++) {
  const fields = parseCsvLine(dataLines[i]);  // 1 物理行用パーサ
  if (fields.length < 3) continue;            // ★ ここで multi-line の 2 行目以降が silent skip
  ...
}
```

### 動作トレース

エクスポート CSV (RFC 4180 準拠で正しい):
```
id,title,type,bg,"line1
line2",result,public
```

`split(/\r?\n/)` で物理行に分断:
- 行 A: `id,title,type,bg,"line1`
- 行 B: `line2",result,public`

`parseCsvLine(行 A)`:
- 4 列目まで通常パース → `[id, title, type, bg]`
- 5 列目 `"line1` でクォート開始、行末で閉じられず `line1` が現フィールドに push
- 返り値: `['id', 'title', 'type', 'bg', 'line1']` (5 fields)

→ `content` = `'line1'` のみ反映、`result` / `visibility` は undefined → 既定値 `'public'` にフォールバック

`parseCsvLine(行 B)`:
- 1 文字目から非クォートモードでパース、`line2` まで蓄積
- `"` でクォート開始、`,result,public` まで quoted 状態で全部 1 フィールドに
- 返り値: `['line2,result,public']` (1 field)

→ `fields.length < 3` で silent skip → **2 行目は完全に消失**

## 根本原因 (Root Cause)

### コード品質側の根本原因

1. **CSV パーサを自前実装 (`parseCsvLine`) していた**: `csv-parse@^6.2.1` という RFC 4180 準拠ライブラリが `external-data-import.service.ts` で既に使われていたが、sync-import service は別経路で実装され共有されていなかった
2. **「1 行用パーサ」を「全文用」として誤用していた**: `parseCsvLine` の docstring に「改行を含まない 1 物理行専用」の制約が書かれていなかった
3. **同型コードが 5 ファイルに複製されていた**: T-22 で knowledge を「先行 1 entity 完成形」として実装した際 (KDD §5.32 段階的汎用化パターン)、CSV パースロジックを **共有ヘルパに切り出さずに** 5 ファイルに機械流用した。1 箇所のバグが 5 倍に拡大

### 検証側の根本原因

4. **既存テストが multi-line cell ケースを 5/5 ファイルで欠いていた**: HEADER + data row を `.join('\n')` で連結する pattern で、シングルライン CSV のみテスト
5. **E2E が round-trip 検証していなかった**: import が「成功する」ことしか確認しておらず、import 後の DB 値が source CSV と一致するかの **対称性テストが存在しなかった**

## 修正内容

### 1. 共有 `parseCsvText` を追加 (RFC 4180 準拠)

[src/services/task.service.ts](../../../src/services/task.service.ts) に [`parseCsvText`](../../../src/services/task.service.ts) を追加。内部実装は `csv-parse/sync` ([既存 dependency](../../../package.json))。

```typescript
import { parse as parseCsvSync } from 'csv-parse/sync';

export function parseCsvText(csvText: string): string[][] {
  if (!csvText || csvText.length === 0) return [];
  return parseCsvSync(csvText, {
    columns: false,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: false,
  }) as string[][];
}
```

### 2. 5 sync-import service の置き換え

| Service | 修正前 (line) | 修正後 |
|---|---|---|
| `knowledge-sync-import.service.ts` | 112: `split(/\r?\n/).filter(...)` | `parseCsvText(csvText)` |
| `risk-sync-import.service.ts` | 164: 同上 | 同上 |
| `retrospective-sync-import.service.ts` | 97: 同上 | 同上 |
| `memo-sync-import.service.ts` | 67: 同上 | 同上 |
| `task-sync-import.service.ts` | 155: 同上 | 同上 |

`parseCsvLine` は残置 (まだ build / lint で外部参照あり)。docstring に「**改行を含まない 1 物理行専用**。CSV 全文は [[parseCsvText]] を使え」と警告コメント追加。

### 3. テスト追加

- `task.service.test.ts` に `parseCsvText` テスト 8 件 (multi-line / CRLF / BOM / カンマ含み / `""` エスケープ / relax_column_count / 空行スキップ / 空 CSV)
- 5 sync-import test に `★★ quoted multi-line cell が欠落しない` ケースを各 1 件追加 (knowledge / risk / retrospective / memo / task)

## データ復旧

### 自動復旧の可否

- **不可** (silent data loss、source CSV がユーザ手元にしかない、DB ログには欠落後の値しか残らない)

### 復旧手順 (ユーザ側で実施)

1. ユーザ手元の元 CSV ファイル (export 直後 or 編集後) を準備
2. 影響対象 5 件のうち、編集前の状態に戻したい場合は audit log (`/admin/super` の監査ログ) から旧値を確認し手動で更新
3. 本 PR デプロイ後 (= 修正適用後) は同じ CSV を再 import すれば multi-line cell が正しく保存される

### 他テナント影響の確認

- 本バグは **同一テナント内のデータ短縮**のみで、テナント越境やデータ混入は無い (sync-import の `viewerTenantId` 検証は別経路で正常動作)
- データベース上のレコードを `WHERE content LIKE '%' || CHR(10) || '%'` でカウントすれば multi-line 値を持つ既存レコード数が分かるが、これは「正常に作成 / 編集された multi-line 値」も含むため fix 対象の特定には使えない

## 再発防止策

| 対策 | 実装内容 | 状態 |
|---|---|---|
| 共有 `parseCsvText` ヘルパ集約 | `task.service.ts` に 1 関数で集約、5 service から共通使用 | ✅ 本 PR |
| round-trip テスト追加 | 5 service の test に multi-line round-trip ケース、parser 自体に 8 ケース | ✅ 本 PR |
| `parseCsvLine` の誤用警告 | docstring で「1 物理行専用」を明示、全文は `parseCsvText` を使えと指示 | ✅ 本 PR |
| KDD 記録 | [§5.X+171](../../knowledge/KDD_PATTERNS.md) に同型コード複製のリスクとして登録 | ✅ 本 PR |
| ESLint カスタムルール (将来) | `service ファイルで csvText.split(...)` を検出するルール | ⏳ 必要に応じて |

## 教訓 (本件の本質)

1. **round-trip 系の機能は「対称性テスト」が最初から必要**: export ↔ import / serialize ↔ deserialize は parser 単体テスト + formatter 単体テストでは非対称性バグを必ず見落とす。最初から「source → round-trip → source の値一致」を assert
2. **同型コードの複製は 1 バグを N 倍に拡大する**: 5 ファイルに同じ 1 行が並んでいたら、共有ヘルパに切り出すか、それが難しいなら各ファイルにバグ責任を明示する。本件は機械流用パターン (KDD §5.32) の代償
3. **「既存 dependency にあるなら使う」原則**: `csv-parse@^6.2.1` が `external-data-import.service.ts` で使われていたのに sync-import は別実装。新規実装前に既存資産の確認が必要
4. **silent skip は禁忌**: `fields.length < 3` で `continue` する経路はエラーログを残すか、せめて DEBUG ログを残す。silent fail が長期に渡って気付けない原因
5. **「textarea 入力可能な field」と「CSV シングルライン前提」は構造的に衝突する**: スキーマ設計時に「multi-line 可能」かどうかを明示しないと、CSV 経路で必ず矛盾する

## 関連

- 関連 PR: fix/csv-import-multiline-text-data-loss (本 PR)
- 関連 KDD: [§5.X+171 quoted multi-line cell 欠落バグ](../../knowledge/KDD_PATTERNS.md)
- 関連 KDD: [§5.18 WBS 上書きインポート (Sync by ID) 実装パターン](../../knowledge/KDD_PATTERNS.md) (5 entity 共通 sync-import 設計の起点)
- 関連 KDD: [§5.32 複数 entity 横展開時の段階的汎用化パターン](../../knowledge/KDD_PATTERNS.md) (機械流用パターンの代償としての本バグ)
- 関連 memory: [feedback_repeated_verification_request](../../../C:/Users/SF02512/.claude/projects/c--Users-SF02512-GitHub-Private-BusinessManagementPlatform/memory/feedback_repeated_verification_request.md) (full-scan 検証で重大バグ検出する実例)
