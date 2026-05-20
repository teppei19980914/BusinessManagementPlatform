# PR #416 クローズ後 フォローアップ案件 (2026-05-20)

> **作成経緯**: PR #416 (feat/crud-permission-redesign) のクローズ前に実施した 3 巡のフルスキャン検証で検出された残課題を集約。本 PR では severity-1/2 級は全件対応済みだが、以下の High / Moderate / Medium / Low 案件は次以降の PR で対応する。
>
> **PR #416 自体は Critical / severity-1 がゼロ件のためクローズ可と判定**。本ファイルは次の PR を切る際の入口として活用する。

---

## サマリ

| Severity | 件数 | 累積影響 |
|---|---|---|
| **High** | 1 | データ非対称漏洩の可能性 (Knowledge per-link gate) |
| **Moderate** | 4 | 機能不具合 + 業務継続性 (member 削除 403 / admin 自己無効化 / suggestion 漏洩 / retro bulk 不整合) |
| **Medium** | 3 | 技術的負債 + スケーラビリティ (advisory lock release / transaction test assert / cascade chunk 化) |
| **Low** | 4 | 保守性 + DRY (helper 重複 / dead code / ADR 未作成 / UI ヘルパ統一) |

合計 **12 件**。重要度順に対応推奨。

---

## 🟠 High (次 PR の最優先案件、1 件)

### H-1: Knowledge 系で per-link gate 非対称

**ファイル**: `src/services/knowledge.service.ts:207-272` (`listAllKnowledgeForViewer`)

**現状**:
- `risk.service.ts` / `retrospective.service.ts` の `listAllXxxForViewer` には PR #416 で `gateLinkedProjectsName(links, memberProjectIds, isAdmin)` ヘルパ経由の **per-link `isMember` gate** を適用済 (severity-1 漏洩修正)。
- 一方、Knowledge は `AllKnowledgeDTO` で `primaryProjectId` (1 つの主プロジェクト ID) + `linkedProjectCount` (件数のみ) を返す設計で、`linkedProjects[].name[]` は API レスポンスに含まれていない。
- 現時点で実害は限定的だが、**「対称な severity-1 漏洩」が Knowledge で発生していないかを将来の機能追加時に再確認する**必要がある。

**検証ポイント**:
1. Knowledge 横断ビューで複数 project 紐付けナレッジを表示する際、`primaryProjectId` のメンバーでない他 project 名が漏れるパスがないか確認
2. UI コンポーネント `src/app/(dashboard)/knowledge/knowledge-client.tsx` で `linkedProjectCount` の表示形式を確認 (count > 1 で「他 N 件にも紐付き」と表示すると、PM/TL に enumerate 経路ができる)

**対応方針**:
- Knowledge の `linkedProjects[]` を返す設計に統一するなら、`gateLinkedProjectsName` を Knowledge にも適用
- 現状の `primaryProjectId + linkedProjectCount` 設計を維持するなら、PERMISSION_MATRIX.md / SECURITY.md に「Knowledge は単一 primary project 表示のため per-link gate 不要」と明記

**優先度**: High (severity-1 級漏洩を防ぐ構造的対称性、業務影響発生前に整理推奨)

---

## 🟡 Moderate (業務継続性に影響、4 件)

### M-1: Suggestion engine の `sourceProjectName` が同テナント非メンバープロジェクト名を漏洩

**ファイル**: `src/services/suggestion.service.ts:525, 599, 677, 941`

**漏洩シナリオ**:
- 同テナントで A 社向け案件 PM/TL の田中さんが、自プロジェクトの「参考」タブを開く
- 提案候補に B 社向け案件 (田中さんは非メンバー) のリスク/ナレッジ/振り返りが類似度 65% で表示
- `sourceProjectName="B 社向け基幹システム刷新 (2025Q3)"` がクリック可能なリンクとして提示
- プロジェクト名に customer 名を埋め込む慣習があると、**「テナント内に存在する customer の一覧 + 進行中案件の概要」が PM/TL に enumerate 可能**

**現状の防御**:
- 同テナントに限定 (tenant 越境ではない)
- `/api/projects/:id/suggestions` 系は PM/TL + admin のみ (PR #416 で `project:read` → `project:update` に格上げ済)
- `sourceProjectName` は **project.deletedAt のみで null マスク**、viewer のメンバー有無では制御していない

**Severity 評価**: Moderate (severity-2 相当)。同社内 PM/TL 同士は通常「同僚 = 見て良い情報」だが、機密プロジェクト (M&A 案件、人事評価関連、未公開製品の検証) を扱う場合は **NDA レベルの内部隔離** が破られる可能性 → severity-1 級に格上げされる。

**対応方針**:
- `gateLinkedProjectsName` 同様の per-viewer membership gate を `sourceProjectName` に適用
- viewer が source project のメンバーでない場合は name を null マスクし、UI 側で「他プロジェクトの提案」表示にする

### M-2: member-creator のナレッジ削除が project 経路で 403 (pre-existing 機能不具合)

**ファイル**: `src/app/api/projects/[projectId]/knowledge/[knowledgeId]/route.ts:121`

**内容**:
- `checkProjectPermission(user, projectId, 'knowledge:delete')` を呼ぶが、`src/lib/permissions/check-permission.ts:87-98` で `member` の Action Set に `knowledge:delete` が含まれていない
- → member は service-layer の creator 判定に到達する前に 403 で弾かれる

**spec との矛盾**:
- `docs/specification/PERMISSION_MATRIX.md:135` 「ナレッジ一覧 (プロジェクト内) | 自分作成を削除 | ○ | ○ | ○ | ×」(member ○)
- UI も `src/app/(dashboard)/projects/[projectId]/knowledge/project-knowledge-client.tsx:433-444` で `isOwner` のとき member にも削除ボタン表示
- **ボタンを押すと 403 が返る = UAT で必ず再現する機能不具合**

**起源**: PR #416 で導入されたわけではなく既存。ただし PR #416 が PERMISSION_MATRIX に「member ○」を新規明文化した結果、code が doc に反する状態が固定化された。

**対応方針**: `'knowledge:delete'` を `'knowledge:read'` に変更 (risks/retrospectives と同じ慣行) し、service-layer の creator 判定に委ねる。

### M-3: admin 自己 isActive=false ガードなし (pre-existing)

**ファイル**: `src/services/user.service.ts:246-284` (`updateUserStatus`)

**内容**:
- `updateUserRole` には `if (userId === updaterId) throw CANNOT_CHANGE_OWN_ROLE` (line 341) があるが、`updateUserStatus` には自己無効化ガードがない
- admin が自分の isActive=false に PATCH すると、`tokenVersion: { increment: 1 }` で JWT 即時失効 → ログアウト → 再ログイン不可

**業務影響**:
- 誤操作 (admin が自分の行をクリックして status=inactive を選択し保存) で発生
- **最後の admin が自己無効化すると tenant は永続的に admin ゼロ状態 (運用不能) になる**

**起源**: PR #416 で導入されたわけではなく既存。ただし PR #416 で「自己ロール変更禁止」を導入したのと同じ思想で「自己無効化禁止」も入れるべきだった。

**対応方針**:
- `updateUserStatus` に `if (userId === updaterId && !isActive) throw 'CANNOT_DEACTIVATE_SELF'` 追加
- UI 側 (`user-edit-dialog.tsx:204-211`) の isActive select も `currentUserId === user.id` で disabled
- 「最後の admin」検出ガードも併せて検討 (`countActiveAdmins(tenantId) <= 1` で拒否)

### M-4: Retrospective bulk が member を弾く (単発 PATCH と不整合)

**ファイル**: `src/app/api/projects/[projectId]/retrospectives/bulk/route.ts:28`

**内容**:
- 単発 PATCH (`retrospectives/[retroId]/route.ts:41`) は `'project:read'` で member-creator も通すが、bulk は `'project:update'` (pm_tl/admin のみ) で member を弾く
- 結果: member が自作 retrospective を 1 件ずつしか更新できず、一括 visibility 変更ができない

**対応方針**:
- 仕様確認: PERMISSION_MATRIX §7.9 では「振り返り本体を編集する: member ×」とあるため、単発 PATCH の member-creator 例外と統一するか docs を整理
- 単発と bulk で挙動を揃える (どちらかに統一)

---

## 🔵 Medium (技術的負債、3 件)

### Med-1: Advisory lock の明示 release 未実装

**ファイル**: `src/lib/cron-execution-log.ts:203-220` (`tryAcquireAdvisoryLock`)

**現状**:
- PostgreSQL の session-level advisory lock を取得するが、`pg_advisory_unlock(key)` で明示 release していない
- コメント「session lock → connection 終了で自動解放」を前提とするが、**`src/lib/db.ts` で `globalForPrisma` により Pool が warm 化**されているため、Netlify Functions の warm invocation で接続が再利用される場合に **前回 lambda の終了後も lock が保持されるリスク**

**影響**:
- 仮に発生しても fail-safe 設計 (`tryAcquireAdvisoryLock` の catch で true 返却 + cron_execution_logs で stale running 検出) で業務影響は限定的

**対応方針**: 正常終了パスで `await prisma.$queryRaw\`SELECT pg_advisory_unlock(${key})\`` を try/finally の finally に追加

### Med-2: `$transaction` 化の test assert 不足

**現状**:
- `member.service.test.ts` / `project.service.test.ts` で `$transaction` mock を `cb => cb(prismaMock)` で透過させているため、**transaction 化されているか自体は verify されない**
- → 将来 `prisma.$transaction(...)` を素の await sequence に戻す refactor をしても test は通る (regression 検出能力なし)

**対応方針**:
- 各 transaction 化テストに `expect(prisma.$transaction).toHaveBeenCalledTimes(N)` を 1 行追加
- 既存 `user.service.test.ts:162, 175` の pattern を他テストにも展開

### Med-3: `deleteProjectCascade` 前段の chunk 化

**ファイル**: `src/services/project.service.ts:815-1043`

**現状**:
- ADR-0015 で採択した「段階別 transaction」は強制削除セクションのみ atomic 化
- 前段の knowledge/risk/retrospective cascade は per-id serial loop (transaction 外)
- 1000 件超のナレッジを持つ project では Netlify Function の 10s/26s timeout を超過するリスク

**対応方針**:
- batch deleteMany + chunk 化 (例: 100 件ずつ unlink/delete)
- 大規模 project は async job queue 経由 (cron 経由のリトライ可能化)

---

## 🟢 Low (保守性 + DRY、4 件)

### L-1: `gateLinkedProjectsName` の重複定義

**ファイル**: `src/services/risk.service.ts:189-199` + `src/services/retrospective.service.ts:191-201`

**現状**: 同一実装の helper が 2 つの service に重複定義。`listAllRetrospectivesForViewer` (retrospective.service.ts:146-155) は helper を使わず inline 実装。

**対応方針**:
- 共通 helper を `src/services/common/link-gate.ts` (または `src/lib/permissions/link-gate.ts`) に抽出
- 3 箇所すべての callsite で利用 (DRY)

### L-2: `knowledge-edit-dialog.tsx` の dead code path

**ファイル**: `src/components/dialogs/knowledge-edit-dialog.tsx:38-42, 102-104`

**現状**:
```ts
const url = projectId
  ? `/api/projects/${projectId}/knowledge/${knowledge.id}`
  : `/api/knowledge/${knowledge.id}`;  // ← 削除された PATCH endpoint
```
- 現状の呼出元では PATCH には到達しないが、将来 `readOnly={false}` かつ `projectId={null}` の組合せが追加されると silent 405
- コメント (lines 38-42) も古い仕様 (admin or 作成者) を説明したまま

**対応方針**:
- `projectId` 引数を必須化 (`projectId: string`) する型変更
- 古い fallback コードと旧仕様コメントを削除

### L-3: ADR-0015 (deleteCustomerCascade 冪等設計) は本 PR で新規作成済 → 完了予定

### L-4: UI 側 `=== 'admin'` 直接比較 (受容済み)

**ファイル**: 14 ファイル散在 (project-detail-client.tsx, estimates/page.tsx 等)

**現状**: `isAdminOrAbove` ヘルパに統一すれば super_admin が UI に到達できるが、現在は意図的に弾いている (テナント側 UI に super_admin が踏み込まない設計)

**対応方針**: 設計判断として現状維持。将来「super_admin が テナント UI 上で個別テナント運用を行う」要件が出たときに統一する

---

## 過去 2 巡の検証で deferred とした項目

| ID | 内容 | 状態 |
|---|---|---|
| D-1 | createProject で作成者の自動メンバー追加 | 認可影響なし (admin/super_admin が作成、checkMembership で短絡)。UX 課題 |
| C-3 | closed/retrospected で member:manage 仕様明示化 | STATE_RESTRICTIONS で実装上は弾く。docs 整理推奨 |
| B-2 | sync export に「自分の draft」を含めるか | knowledge は visibility filter で対応済 |

---

## 次 PR の推奨スコープ

**最優先 PR (1 つ目)**: H-1 + M-1 + M-2 + M-3 を 1 PR に集約
- High 1 件 (Knowledge per-link gate 確認)
- Moderate 3 件 (suggestion 漏洩 + member ナレッジ削除 403 + admin 自己無効化)
- 共通: 認可境界の対称性向上 + 機能不具合の解消

**次 PR (2 つ目)**: Medium 3 件 (技術的負債) を別 PR
- Advisory lock release
- Transaction test assert
- Cascade chunk 化

**バックログ**: Low 4 件は保守タイミングで個別対応

---

## 関連ドキュメント

- ADR-0014 (CRUD 設計刷新): `docs/adr/0014-crud-permission-redesign.md`
- ADR-0015 (Cascade 削除冪等設計): `docs/adr/0015-cascade-delete-idempotent-design.md`
- PERMISSION_MATRIX (新仕様): `docs/specification/PERMISSION_MATRIX.md`
- USER_ROLES (新仕様): `docs/business/USER_ROLES.md`
- KDD §5.X+85〜+88: `docs/knowledge/KDD_PATTERNS.md`
- PR #416: https://github.com/teppei19980914/BusinessManagementPlatform/pull/416
