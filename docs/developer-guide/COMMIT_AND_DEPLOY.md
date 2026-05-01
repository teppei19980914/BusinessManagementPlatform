# コミットとデプロイ ワークフロー (Developer Guide)

本ドキュメントは、コミット・PR 作成・デプロイのワークフローを集約する (DEVELOPER_GUIDE.md §7、§10)。

---

## §7. DB スキーマ変更手順

## 7. DB スキーマ変更手順

詳細は [docs/administrator/OPERATION.md](../administrator/OPERATION.md) §3 (DB マイグレーション手順) を参照。

要点:

1. ローカルで `prisma/schema.prisma` を編集
2. `npx prisma migrate dev --name xxx` で migration ファイル生成 + ローカル適用
3. PR を作成
4. **本番デプロイ前**に Supabase ダッシュボードの SQL Editor で migration SQL を
   手動実行する (Vercel ビルドでは自動適用されない設計)
5. 本番 DB 更新後に PR をマージ → Vercel が自動デプロイ

---


## §10. コミットとデプロイ

## 10. コミットとデプロイ

### 10.1 ブランチ運用

- `main` ブランチへの直接コミット禁止
- 機能改修は `feat/...` / `docs/...` / `fix/...` ブランチで作業
- 当日ブランチ `dev/YYYY-MM-DD` は SessionStart hook が自動切替

### 10.2 コミット作成

```bash
git add <changed files>
git commit -m "変更内容を端的に記述"
```

> Stop hook が自動で secret scan / 静的解析 / テストを実行し、テスト成功時のみ
> 自動 commit & push を行う設定もあります (`.claude/.git-automation-config`)。

### 10.3 PR 作成

```bash
gh pr create --title "..." --body "..."
```

PR 本文には以下を含めると後の引き継ぎがスムーズです:
- Summary (変更の目的と概要)
- 変更したファイルと内容
- Test plan (動作確認の手順)
- 関連 PR / 設計書セクション

### 10.4 マージとデプロイ

1. GitHub 上で PR をマージ (手動)
2. **DB スキーマ変更を含む場合**: マージ前に Supabase で migration を手動実行
   (詳細: OPERATION.md §3)
3. Vercel が `main` ブランチを自動デプロイ
4. 本番 URL で動作確認

### 10.5 並行 PR でコンフリクトが出た場合の解消手順 (PR #115 で得た知見)

複数 PR が同時進行中に **同一ファイルを触る** と、先にマージされた PR の内容が
後続 PR ベースに存在せず GitHub UI で "This branch has conflicts" 表示が出る。
本プロジェクトでは daily branch + feature PR 並走運用のため発生しやすい。

#### 典型パターン (PR #115 実例)

- PR #114 (security hardening) がマージされた後、PR #115 (error log 基盤) が
  コンフリクト表示。衝突したファイル:
  1. `src/app/api/cron/cleanup-accounts/route.ts` — PR #114 が修正、PR #115 が削除 (modify/delete conflict)
  2. `src/app/api/projects/[projectId]/tasks/import/route.ts` — 両 PR が同一 catch 句を編集 (content conflict)
  3. `docs/developer/DESIGN.md` — 両 PR が §9.8 配下に新サブ節追加 (隣接挿入で誤検知)

#### 解消手順 (CLI で実施)

```bash
# 1. PR ブランチに戻り、最新 main を取得
git checkout feat/pr-xxx-...
git fetch origin main

# 2. main をマージ (rebase でも可)
git merge origin/main
# → CONFLICT (content) や CONFLICT (modify/delete) が出る

# 3. 各ファイルの解消方針を決める
#    - content conflict (<<<<<< / ====== / >>>>>>): エディタで手動統合
#      → 「先行 PR の意図」と「本 PR の意図」を両方活かす (両方 keep が基本)
#    - modify/delete conflict: ファイル自体の存続を決める
#      → git rm <path> で削除側確定、または戻して修正版を残す

# 4. 解消したら add → commit (merge commit)
git add <解決済ファイル>
git commit -m "Merge main into feat/pr-xxx: 先行 PR #NNN とのコンフリクト解消"

# 5. lint / test / build で回帰確認
pnpm lint && pnpm test --run && pnpm build

# 6. push
git push
```

#### 解消時の判断基準

| 衝突パターン | 判断 |
|---|---|
| 同じバグ修正を両 PR で実装 (意図同じ) | **後続 PR (上位互換) の実装を採用**、先行 PR 実装は削除 |
| 別々の機能追加 (隣接挿入) | **両方 keep**、マーカーだけ除去 |
| 片方が削除、もう片方が修正 | **削除側が意図的なら削除確定** (git rm)、そうでないなら復元 + 修正統合 |
| ドキュメントの表/セクション追加 | **両方 keep**、章番号は時系列順で整理 |

#### 予防策

- PR を小さく保つ (1 PR = 1 コンセプト)
- 長期 PR は定期的に `git merge origin/main` で main 追従
- 同じファイルを複数 PR で触る場合は PR の先後を事前に合意し、後続は先行マージ後に rebase

#### ドキュメント追記箇所の「末尾追記」が多発する罠 (PR #127 で再確認)

**症状**: `DEVELOPER_GUIDE.md` の **更新履歴テーブル末尾** や `RESPONSIVE_AUDIT.md` の
**更新履歴末尾** に複数 PR が同時期に行を追加すると、ほぼ確実にコンフリクトが出る。

例: PR #127 が main (PR #125 まで取り込み済) から分岐した後、PR #126 が main にマージ。
両 PR が `| 2026-04-24 | §xxx 追加 (PR #xxx) |` を **同一行の直後** に追記しており、
マージ時に `<<<<<<< HEAD | ... | ======= | >>>>>>> origin/main` が出る。

**解消**: 両方 keep、時系列順 (PR 番号の若い順) に並べる。今回の衝突は PR #127 末尾行を PR #126 の直下に残すだけで解消。

**予防**:
- 更新履歴は「1 行 1 PR」なので、他 PR と干渉しやすい場所と認識する
- stacked PR が複数ある場合は、上流が main にマージされたら速やかに下流を
  `git merge origin/main` で追従させる
- 長期 stacked PR では「末尾追記 3 行」を見越した rebase コミュニケーションを取る

#### Stacked PR で base に hotfix を当てた場合の sub-PR への伝播 (PR #128 → #129 で得た知見)

**背景**: 要望項目 7 のレスポンシブ対応は stacked PR (`#128` base → `#128a` `/projects`
→ `#128a-2` WBS → `#128b` 横断一覧 → `#128c` admin → `#128d` fine-tune) で進めている。

**症状**: `#128` base に hotfix を 4 回 commit (WebKit エンジン override / main merge /
`testIgnore` / mobile baseline 自動生成) した後、`#128a` (= PR #129) の CI を確認すると
**`#128` 初回と同じ WebKit 起動エラー 5 件** で fail していた。

**原因**: `#128a` branch は `#128` の **初回コミット (0490185)** から分岐しており、
以降に `#128` へ足した 4 件の hotfix を継承していない。stacked PR は後続が
自動追従しないため、base 更新分は各 sub-PR で明示的に取り込む必要がある。

**解消**: `#128a` で `git merge origin/feat/pr128-responsive-audit` 実行。
auto-merge が全ファイル成立 (PR #128a の `/projects` モバイルカード実装は、main 由来
SearchableSelect 追加と同一ファイル `projects-client.tsx` を触るが別範囲のため衝突なし)。

**予防・運用ルール**:
1. stacked PR の **base (上流) に hotfix を commit したら即座に下流全部に merge を流す**。
   上流の CI が green になった時点で sub-PR の CI も再走させるために必要。
2. sub-PR の CI が fail していて、かつ base (上流) の同 workflow も同時期に fail して
   いた場合、**まず上流の fix 伝播漏れを疑う**。下流固有のバグ調査より先に rebase/merge
   を試す方が安い。
3. stacked PR の commit は意図的に 1 本化しておくと、base merge 時の衝突対処が容易
   (#128a の 4870b74 のように 1 コミット/PR に寄せる)。
4. Mobile baseline PNG のような **workflow が自動生成してコミットしたファイル** も
   base に溜まっていく。sub-PR rebase 時に大量の新規 PNG ファイルが一括で降ってくるが
   正常動作 (衝突にならない、単に `new file` として追加される)。

**再発事例 3 例目 (PR #130 = PR #128a-2 hotfix)**: PR #129 への hotfix 取り込み後、
PR #130 (`feat/pr128a-2-wbs-mobile`) も同じ E2E Visual Baseline の WebKit エラーで
fail。PR #130 は PR #129 の **初回コミット 4870b74** から分岐しており、PR #129 が
後から追加した merge commits (`f096b8d` + `fadcdfe`) を引き継いでいなかった。
同じく `git merge origin/feat/pr128a-p1-tables-card` の 1 コマンドで auto-merge 成立
(conflict 0 件、`projects-client.tsx` の WBS 改修 / mobile card / SearchableSelect
3 系統が同一ファイルを触るが別範囲なので衝突せず)。stacked PR 長さが n 段なら
hotfix 伝播もそのぶん n-1 回必要 = 本例では **#128 base → #128a(#129) → #128a-2(#130)**
の 2 段伝播となった。

**再発事例 4 例目 (PR #131 = PR #128b hotfix)**: 3 段目。PR #131
(`feat/pr128b-p2-cross-list`, P2 横断一覧モバイルカード化) は PR #130 の初回
コミットから分岐しており、PR #130 が後で取り込んだ hotfix を継承していなかった。
`git merge origin/feat/pr128a-2-wbs-mobile` で auto-merge 成立。

**再発事例 5 例目 + 6 例目 (PR #132 / #133 hotfix)**: 4 段目 / 5 段目。
同パターンが **5 PR 連続** (#129 → #130 → #131 → #132 → #133) で再発し、
それぞれ `git merge` 1 コマンドで解消。

**運用ルールとして確定 (5 例以上の連続再発が根拠)**:
1. stacked chain を運用する PR では **base ブランチへ hotfix が push されたら
   即座に全 sub-PR へ順送り merge を流す** (下流ほど新しい変更を含むため、
   上流から下流の向きが正しい)。
2. 手動運用は 4 段を超えると伝播忘れが多発するため、**自動化スクリプト**
   (各 sub-PR branch をチェックアウト → `git merge origin/<上流>` → push) を
   整備すべき。現状は手動 + チェックリスト運用。
3. sub-PR を作る際は **初回コミット直前に base の最新 HEAD に rebase しておく**
   ことで以降の伝播回数を最小化できる (本件の PR #128 スタックは全 sub-PR が
   一斉に #128 初期状態 0490185 から分岐していたため伝播コストが連鎖した)。
4. **並走 docs PR の場合、後発 PR は先に main にマージされる予定の PR 内容を
   事前に把握し sub-section header の重複追加を避ける** (本件の PR #136 で
   遭遇 = §10.5 末尾追記罠 4 例目)。具体的には:
   - 後発 PR を作る前に **gh pr list --state open** で並走中の docs 系 PR を確認
   - 同一セクションを触る場合は **後発 PR の本文を「差分のみ」に絞る**
     (header / 既存 sub-section の重複を避け、新規追加分だけを含める)
   - 結果として後発 PR がコンフリクトしても **conflict 解消はゼロ削除のみ**
     (新規追加行の保持) で済むようになる
5. **stacked sub-PR は docs を抱えない、知見集約は別途専用 docs PR に切り出す**
   (本件の PR #137 で遭遇 = §10.5 末尾追記罠 5 例目)。stacked PR の sub-PR
   (`feat/pr128a-p1-tables-card` 等) が独自に §10.5 再発事例を docs に追記
   していると、main 側で集約 PR (PR #136 形式) が先にマージされた瞬間、
   sub-PR の docs 追記分は確実に重複コンフリクトを起こす。
   - sub-PR の commit message には知見を残しても良いが、**docs ファイルへの
     追記は集約 PR に一本化**する
   - 集約 PR を後発で出す場合は本ルール 4 項目の「差分のみ追記」と組み合わせ、
     sub-PR との衝突点を最小化する
   - PR #137 で実証された通り、5 PR 連続再発した stacked chain では sub-PR
     5 本ぶん全てに同じ docs 追記が紛れ込んでいる確率が高く、main 取り込み時
     に **n-1 回**の同種 conflict が連鎖する

**補足 (2026-04-24, docs/stacked-pr-propagation-lessons で追加)**:
本セクションは PR #128 stack hotfix 対応で得た知見だが、sub-PR (#129〜#133) が
**squash-merge** されたため、hotfix 伝播で追加した §10.5 の追記内容が main に
取り込まれなかった。一般論として **「sub-PR が squash-merge 運用の場合、sub-PR
のマージ後に追加した docs コミットは別 PR で main へ取り込む必要がある」** と
いうメタ教訓もある (merge commit 運用なら自動継承されるが、squash-merge では
最初の squash 時点のスナップショットしか残らないため)。

---

#### 独立並走 PR の衝突パターン (PR #156-#162 一気出しで得た知見、2026-04-27)

**3-6 例目までと異なる分類**: 上記 3-6 例目は「stacked PR の hotfix 伝播」(同じ機能を
段階分割して上流→下流に流す系) の罠だったが、**7-8 例目は stacked ではなく独立
並走 PR (1 セッションで複数の独立機能を 6 PR 一気にオープン) の衝突**で、性質が
異なる。stacked では「上流が変わったから下流に流す」だが、独立並走では「同じ
ファイルを別観点で編集した PR が並走」する点が違い、解消方針も「上流追従」では
なく「**両方の意図を統合**」になる。

**再発事例 7 例目 (PR #161 conflict resolve, 2026-04-27)**:
PR #161 (feat/cross-list-bulk-update) は main から枝分かれ後、並走していた
PR #156-#160 が先に **5 件連続マージ** され、PR #161 をマージする時点で 2 種類の
コンフリクトが発生:
1. **`src/services/risk.service.ts`**: PR #157 (cross-list-non-member-columns) が
   `listAllRisksForViewer` の **同じ行** で「非メンバーへの氏名マスク撤廃」を実施。
   PR #161 は同関数の同じ場所に `viewerIsCreator: r.reporterId === viewerUserId` を
   追加しており、両方の修正が同一 return オブジェクトに集中して衝突。
   **解消方針**: main の「氏名マスク撤廃」を採用 (確定方針) + PR #161 の
   `viewerIsCreator` を維持 (両立可能、責務が直交している)。
2. **`docs/developer/DEVELOPER_GUIDE.md`**: PR #160 が §5.20 を、PR #161 が §5.21 を
   **§5.10.2 の直前** という同じ位置に追加 → 末尾追記コンフリクト。
   **解消方針**: 番号順 (§5.20 → §5.21) に並べて両方残し、§5.21 の関連リンクから
   §5.20 (同じく「DB 側 where で除外」設計指針) を参照する形で結合。

**根本原因**: PR #161 を 2026-04-27 朝の 6 PR 一気出しの先頭で作成 (#156→#161 の
順) したため、後発 PR が先にマージされる順序入れ替わりで衝突が発生。複数の独立 PR を
並走で出す場合、各 PR の **影響ファイル** を事前にマトリクス化し、衝突確率の高い
PR (同 entity / 同 service / 同 docs section) は逐次マージの順序合意を取ってから
作成するのが望ましい。今回は影響範囲が幸い独立しており衝突解消は機械的だったが、
PR #157 と PR #161 がどちらも risk.service.ts の同じ関数を触ったのは設計上の
近さの問題で、片方マージ後の rebase で合流させる順序にすべきだった。

**運用ルール 6 として確定**:
6. **同 entity/同 service/同 docs section を触る並走 PR は逐次運用**: 影響範囲が
   重なる PR を並列で出さない。先に出した PR のマージ後に rebase して 2 本目を出す。
   それが難しければ、後発 PR の作成前に **影響ファイルマトリクス** で衝突確率を
   見積もり、衝突確実なら先発 PR のマージを待つ。

**再発事例 8 例目 (PR #162 conflict resolve, 2026-04-27 / 7 例目の **同日連鎖**)**:
PR #162 (feat/cross-list-bulk-update-phase2) は PR #161 と同じ朝に並走作成された
ため、PR #157 / PR #160 / PR #161 のマージ後に **3 種類** のコンフリクトが発生:

1. **`src/services/knowledge.service.ts`** (= 7 例目の risk.service.ts と同型):
   PR #157 が `listAllKnowledgeForViewer` で「非メンバーへの氏名マスク撤廃」を実施。
   PR #162 は同関数の同じ return オブジェクトに `viewerIsCreator: k.createdBy === viewerUserId`
   を追加。**解消**: 7 例目と同方針で main 採用 + viewerIsCreator 維持。
2. **`src/services/retrospective.service.ts`** (auto-merge 成功): PR #157 の氏名公開と
   PR #162 の viewerIsCreator が **return オブジェクト内の異なる行** に分散していたため
   git の 3-way merge が自動解消。conflict marker 出ず。
3. **`docs/developer/DEVELOPER_GUIDE.md`**: PR #160 (§5.20) + PR #161 (§5.21) が main に
   先行マージされた後、PR #162 (§5.22) を加える形で末尾追記コンフリクト。
   **解消**: 番号順 (§5.20 → §5.21 → §5.22) に並べて 3 つとも保持。

**根本原因 (運用ルール 6 違反の証拠)**: PR #161 と PR #162 は **同じ「全○○一覧」横断
ビュー機能の Phase 1/2 分割** で、構造上ほぼ同じファイル群 (knowledge/retrospective
service の同じ DTO を編集) を触ることが事前に明白だった。にもかかわらず両 PR を
2026-04-27 朝に同時オープンしたため、PR #161 マージ後の PR #162 で確実に衝突。
**運用ルール 6 を確定したセッション (PR #161) と同セッションで違反した**ため、
ルールが機能するのは「ルール確定後に作成する PR」のみで、**既に並走中の PR には
適用できない** という制約が判明。

**運用ルール 7 として補強 (機能段階展開系 PR の逐次運用)**:
7. **機能段階展開系 PR (Phase 1 → Phase 2、entity 拡張展開、共通基盤 → 利用箇所展開等) は最初から逐次運用**:
   同じ機能を段階分割する PR は、前段 (Phase N) のマージを待ってから後段 (Phase N+1) を作成する。
   先回りして並走出しすると、前段の修正 (レビュー指摘での追加コミット等) が後段に伝播せず
   再度衝突する 2 重コストが発生する。本件 (PR #161 → PR #162) のように **同じファイル群を
   触ることが構造的に明白** な PR は運用ルール 6 の例外ではなく、より厳密に逐次化すべき。
   - 適用例: Phase 分割 (Phase 1 / Phase 2)、entity 横展開 (Risk → Knowledge / Memo)、
     共通 hook → 利用画面複数の段階展開
   - 例外: 完全に独立した別機能 (entity も service も docs section も無関係) なら並走可

**再発事例 9 例目 (PR #168 conflict resolve, 2026-04-27)**:
独立並走 PR が **DEVELOPER_GUIDE.md の同じ位置に同番号でセクションを追加** したパターン。
PR #167 (asset-tab-responsive-mobile) と PR #168 (wbs-attachment-display) はどちらも
2026-04-27 朝に並走作成され、それぞれ:

- PR #167 が `### 5.24 TabsList のレスポンシブ集約パターン` を §5 末尾に追加
- PR #168 が `### 5.25 添付対応 entity の一覧表示横展開チェック` を §5 末尾に追加 (起票時点で
  PR #167 が先にマージされる前提で 5.25 を予約)
- 加えて §11.1 TODO 表で PR #167 (PR #166 経由) が **T-04** (視覚回帰拡大) を追加、
  PR #168 が **T-05** (Estimate 添付 UI) を追加

PR #167 が先に main へマージ → PR #168 で末尾追記コンフリクト 2 箇所発生:
1. §5 末尾: HEAD §5.25 vs main §5.24 (両者は完全に独立した別トピック)
2. §11.1 TODO 表: HEAD T-05 vs main T-04 (こちらも独立した別 TODO)

**解消**: 番号順 (§5.24 → §5.25 / T-04 → T-05) で **両方 keep**。conflict marker を
HEAD/origin 共に削除し、機械的に並べるだけで解決 (内容判断ゼロ)。

**今回の特徴 (8 例目までと違う点)**:
- 7-8 例目は **同じ機能領域の Phase 1/2 並走** (cross-list bulk update) が原因で同一
  service 関数の同じ return オブジェクトが衝突した「**意図統合型**」
- 9 例目は **完全に独立した機能** (タブ UI vs 添付一覧) が並走した結果、たまたま docs の
  同セクション末尾に同時追記した「**機械並列型**」。運用ルール 6/7 の **例外条項
  「完全に独立した別機能なら並走可」** に該当する正常運用での衝突であり、解消も機械的。
- 番号予約 (`### 5.25` を先取り) は PR #167 が先にマージされる前提で行ったため番号自体は
  正しく機能した (上書きせずに済んだ) が、**ファイル位置 (末尾 N 行目)** が同じになるのは
  避けられず、git の text-merge は依然として conflict を出す。

**運用ルール 8 として補強 (独立並走 PR の docs 衝突は機械解消で OK)**:
8. **完全独立 PR (運用ルール 6/7 の例外条項該当) の docs コンフリクトは機械解消で良い**:
   §5 末尾追記 / §11 TODO 表追記 のように **「リスト末尾に 1 セクション/1 行追加」型** の
   コンフリクトは、両 PR の追加内容を **番号順に並べる** だけで解消する。意図統合や
   設計判断は不要。
   - 解消手順: `<<<<<<< HEAD ... >>>>>>>` の 2 ブロックを **両方残し、番号順に並び替える**
   - 番号予約衝突 (両 PR が同番号 5.24 を予約してしまった等) が起きた場合のみ、後発 PR を
     繰り上げ (5.25 にリネーム) する判断が必要
   - 機械的に解消できるかの判断基準: **2 ブロックの内容が完全に独立** (同一 entity / 同一
     service / 同一 sub-section を触っていない) なら機械解消で OK

   **8a. 番号予約衝突の繰り上げ手順 (PR #171 で実適用、3 PR 並走に拡張)**:

   N 件の先行 PR (PR #167/#168 で §5.24/§5.25 を取得) と並走していた後発 PR (PR #171 が
   §5.24 を予約) が衝突した場合、後発 PR は **N 段繰り上げ** (§5.24 → §5.26) する。
   その際、以下を **必ず一括更新**:

   ```bash
   # 1. セクション header の番号 (`### 5.24` → `### 5.26`)
   # 2. body 内の self-reference (`本 §5.24` 等を全置換)
   #    → grep で漏れチェック:
   grep -n "§5\.24\|本セクション" docs/developer/DEVELOPER_GUIDE.md  # 該当 section 範囲のみ
   # 3. 関連リンク (「関連」サブセクション内の `§5.24 (本 PR)` 等)
   # 4. 更新履歴テーブルの追記行 (`§5.24 新設 (...)` → `§5.26 新設 (...)`)
   # 5. 他セクションからの forward-reference (もしあれば)
   ```

   **冒頭に「section 番号メモ」コメントを残す**: 後から経緯を辿れるよう、繰り上げた
   セクションの冒頭 (h3 直下) に `> **section 番号メモ**: 当初 §5.NN として執筆したが、
   PR #XXX が先にマージされ §5.NN を取得したため §5.MM に繰り上げた。` を 1〜2 行で記載する。

   **判定基準**: 先行 PR が main にマージされた時点で predecessor の section 番号は
   **確定**。後発 PR の rebase/merge 時に **次に空いている番号** に振り直す
   (run-time での衝突回避ではなく、merge resolve のタイミングで決定する)。

**汎化された予防策 (累積版)**:
- **PR 起票時に section 番号を予約**: PR description / commit message に「§5.NN を予約」
  と明記し、並走中の PR description を `gh pr list --state open` で確認して衝突を予防
- **末尾追記型のコンフリクトはほぼ確実に出る前提で運用**: 解消コストは低い (機械並べ替え)
  ので、衝突を恐れて並走を止める必要はない。むしろ「衝突しても解消は機械的」という
  共通理解で並走を許容するのが現実的

#### 再発事例 10 例目 (PR #170 orphan recovery, 2026-04-27): stacked PR の base が main 以外の場合の落とし穴

**症状**: PR #170 (i18n Phase C-1 認証系) は GitHub 上「MERGED」表示で `mergeCommit.oid`
も存在 (6a88075) するが、**main の first-parent linear history に含まれない**。結果、
PR #170 の変更 (auth セクション 50 行 / 認証画面 4 ファイルの i18n 化 / DEVELOPER_GUIDE
§10.10.1) が main から **完全に欠落**。検出は Phase C-2 着手時に
`git show origin/main:src/i18n/messages/ja.json | grep auth` が 0 件となって発覚。

**根本原因**: PR #170 は `base = feat/i18n-foundation` (PR #169 の branch) で起票
された stacked PR。`gh pr view 170 --json baseRefName` の結果も `feat/i18n-foundation`。

時系列 (UTC):
1. 09:28:50 — PR #169 が main にマージ (base=main、正常)
2. 09:29:08 — PR #170 が **`feat/i18n-foundation` 側へマージ** (base=feat/i18n-foundation)

**ここが落とし穴**: PR #169 が main にマージされた瞬間、`feat/i18n-foundation` ブランチは
論理的に「不要」になるが GitHub は branch を自動削除しない (merge 後も残る)。
PR #170 はその「孤児ブランチ」へマージされ、main には伝播しない。

GitHub の挙動:
- PR #170 の状態: `state=MERGED`, `mergedAt=09:29:08Z` (✅)
- merge commit (6a88075) は存在 (✅)
- ただし merge 先は **`feat/i18n-foundation`** (PR #170 の元 base)
- main には反映されない (PR #169 マージ時点で stacked chain は切断済)

**確認方法**:
```bash
# 1. PR の base を確認
gh pr view 170 --json baseRefName,mergeCommit
#   → baseRefName が "main" 以外なら orphan リスクあり

# 2. main の first-parent history に merge commit があるか
git log --first-parent origin/main | grep <merge_commit_oid>
#   → 出てこなければ orphan 確定

# 3. 各ファイルが main に取り込まれているか
git show origin/main:<重要ファイル> | grep <PR で追加した識別子>
```

**Recovery 手順** (本 PR で実行):
```bash
# 1. main からリカバリーブランチを切る
git checkout main && git checkout -b fix/<PR>-recovery

# 2. orphan PR の元コミット (merge commit ではなく feature commits) を順に cherry-pick
git log --oneline origin/main..origin/<PR_branch>
git cherry-pick <commit1> <commit2> ...

# 3. lint/test/build → push → 新規 PR (base=main) を起票
```

**予防ルール (運用ルール 9 として確定)**:
9. **stacked PR を起票するときは「base が main か」を必ず確認**:
   - 上流 PR (PR #169) の動向を見守りながら作業する場合は stacked にしてもよいが、
     **上流が main にマージされた瞬間に下流 PR の base を main に切り替える** ことを
     ルール化する (gh CLI: `gh pr edit <下流> --base main`)
   - 切替を忘れると本件のように「PR は merged 表示なのに main に届いていない」
     という見えない regression が発生する
   - **GitHub UI 経由のマージ時はマージ画面で base を確認**: 「Merge into XXX」の
     XXX が "main" でなければ alert
   - **CI/CD と CODEOWNERS では検出できない**: regression は静かに進行するため、
     依存する後続 PR (本件の Phase C-2) で初めて発覚する。**自動検出は困難**で、
     起票時の base 設定が最後の砦
   - **Stop hook 補強**: 並走 PR が複数ある場合、Stop hook で
     `gh pr list --json number,baseRefName` を出力させ base が "main" 以外の PR を警告
     する仕組みも検討余地あり (TODO)

**§10.5 既存サブセクションとの関係**:
- 既存「Stacked PR で base に hotfix を当てた場合の sub-PR への伝播」(再発 3-6 例目)
  と関連するが、症状が異なる:
  - 既存: 上流に追加された hotfix が下流に流れない (CI fail で検出可能)
  - **10 例目 (本件)**: 上流マージ時点で **下流 PR が orphan 化** (CI は通る、merged 表示も出る、
    main に届いていないことだけが問題 = 検出が難しい)
- 既存の運用ルール 1「stacked PR の base に hotfix を commit したら即座に下流全部へ
  順送り merge を流す」とは独立。本件は **「下流 PR の base を main に切替える」** という
  別操作が必要

### 10.5.1 並列 worktree agents による大規模一括翻訳パターン (PR #175 で確立)

#### 背景

Phase C 残作業 (~933 hits / 30+ ファイル) を 1 PR に統合するという要件があり、単一 agent
での serial 処理ではコンテキスト枯渇のリスクが高かった。**isolated worktree** で 5 agents を
並列実行することで、各 agent が独立したファイル群を担当できる構成を取った。

#### 実装パターン

```ts
// 各 agent には固有の namespace prefix を割り当て、ja.json/en-US.json への追記が衝突しないようにする
Agent A (worktree): project / customer / member  (~169 hits)
Agent B (worktree): wbs / gantt / estimate       (~204 hits)
Agent C (worktree): risk / retro / knowledge     (~207 hits)
Agent D (worktree): memo / myTask / setting      (~103 hits)
Agent E (worktree): admin / stakeholder / UI     (~120 hits)
```

各 agent は:
1. 担当ファイルを Read
2. ja.json + en-US.json に **自分の namespace の root section** のみ追加
3. 担当 .tsx を t() 呼び出しに置換
4. 抽出スクリプトで自ファイルの残ヒット 0 件確認
5. worktree branch に commit

orchestrator (主 agent) は agents 完了後:
1. 各 worktree branch を fetch
2. 順次 merge — JSON は section 単位で独立追加なので機械解消可
3. 全体検証 (lint / test / build) + extraction script で全体残数確認
4. SELECTABLE_LOCALES 切替

#### 落とし穴 1: worktree の `.next/` ビルド成果物が ESLint で誤検出される

各 agent worktree で `pnpm build` を実行すると `.next/build/chunks/*.js`
等の生成 JS が大量に作られる。これらは `node_modules/` ではなく `.next/`
配下なので **ESLint の ignore patterns に含まれていない場合がある**。

PR #175 では merge 後の最終 lint で:
```
✖ 58529 problems (2844 errors, 55685 warnings)
```
が出て初見ではプロジェクト本体の問題と誤認した。実態は **agent worktrees の
`.next/build/chunks/*.js`** (`require()` / `@ts-ignore` / `module = ...`
等の bundler 出力) を ESLint が走査していただけ。

**解消手順**:
```bash
# 1. worktree を git 管理から外す
for wt in $(git worktree list --porcelain | grep "^worktree" | awk '{print $2}' | grep "agent-"); do
  git worktree remove -f -f "$wt"
done

# 2. branch を削除
git branch | grep worktree-agent | xargs -r git branch -D

# 3. ディレクトリを物理削除 (Windows は long-path 問題が出るので PowerShell)
# bash:
#   rm -rf .claude/worktrees/agent-*
# PowerShell (Windows long-path):
#   Get-ChildItem ".claude\worktrees" -Directory | ForEach-Object {
#     Remove-Item "\\?\$($_.FullName)" -Recurse -Force
#   }

# 4. lint 再実行 → clean になる
pnpm lint
```

**汎化ルール**:
- 並列 agents パターンを終了するときは **必ず worktree directory も物理削除**する
  (git worktree remove だけでは Windows で「Filename too long」が残ることがある)
- ESLint config の ignore patterns に `**/.next/**` を **明示**しておく
  (Next.js プロジェクトでは事実上必須)

#### 落とし穴 2: `pg` symlink 破損 → `pnpm install --force` で復旧

worktree 削除と並行して `node_modules/.pnpm/@prisma+adapter-pg@*/node_modules/pg/`
の symlink が壊れ、`pnpm test` で:
```
Error: Cannot find package 'pg/index.js' imported from @prisma/adapter-pg/dist/index.mjs
```
が発生。`pnpm install` (lockfile up to date) では復旧せず、`pnpm install --force`
で全 symlink 再生成して復旧した。

**汎化ルール**:
- worktree を多用したセッション後に node_modules のリンク破損が起きうる
- `pnpm install` で「Already up to date」と出ても症状が残るなら `--force` を試す

#### 落とし穴 3: agent commit 後の未コミット残作業

各 agent は worktree 内で commit + push (worktree branch) するが、orchestrator が
最終 merge する際に「agent F (residual cleanup) が完了したが未コミット」のような
中間状態が working tree に残る。これに気付かず lint/test を回すと既存の test 失敗が
新規由来と誤認しやすい。

**汎化ルール**:
- セッション再開時 (resume) は最初に `git status --short` + `git stash list` を
  確認し、未コミット変更が agent 残作業か確認する
- agent 残作業の commit message は明示的に `(residual cleanup)` 等の suffix を
  付け、後から判別しやすくする

#### 関連
- §10.5 (PR-conflict patterns) — orchestrator が複数 worktree を merge する際の参考
- §10.6 (.next キャッシュ) — worktree でも同じ .next 罠が踏まれる
- `scripts/i18n-extract-hardcoded-ja.ts` — 進捗計測スクリプト (PR #169)

### 10.6 `.next` キャッシュがコンフリクト解消後にビルドを壊す (PR #115 hotfix)

Next.js は開発時 `.next/dev/types/validator.ts` にルートハンドラの型情報を
キャッシュする。**ファイル削除を伴うマージ**後にそのまま `pnpm build` すると、
削除済みの `.next/dev/types/validator.ts` が消滅した route (例:
`/api/cron/cleanup-accounts/route.js`) を import しようとして型エラーで
build 失敗する。

**対策**: コンフリクト解消後 (特にエンドポイント削除を含む場合) は必ず
`rm -rf .next` で キャッシュを消してから build する。

### 10.7 日時描画ルール — ハイドレーション不一致の防止 (PR #117 で得た知見)

クライアントコンポーネントで `new Date(x).toLocaleString('ja-JP')` や
`d.getFullYear()` 等の **runtime TZ に依存する API** を使うと、React hydration
mismatch (`#418 Minified hydration failed because the server rendered text
didn't match the client`) が発生する。

**原因**: Next.js の Server Component → Client Component ハイドレーション時、
サーバは UTC (Vercel/Docker 等) でレンダリングし、クライアントは JST で再計算する。
`toLocaleString` / `getHours()` 等は実行環境の TZ を使うため、両者で文字列が
異なり、React が「マウント時の DOM が SSR 出力と一致しない」と判定する。

**ルール**:

- クライアントコンポーネントで日時を描画するときは必ず `src/lib/format.ts` の
  ヘルパを使う:
  - `formatDate(iso)` → `YYYY/MM/DD`
  - `formatDateTime(iso)` → `YYYY-MM-DD HH:MM`
  - `formatDateTimeFull(iso)` → `YYYY/MM/DD HH:MM` (ツールチップ等)
- サーバコンポーネント (`page.tsx` 等) でも、環境差を避けるため同じヘルパを使う
- 禁止 API: `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` /
  `getFullYear()` / `getMonth()` / `getDate()` / `getHours()` / `getMinutes()`
  (いずれも runtime TZ 依存)

**実装の裏側** (PR #118 で i18n 化): ヘルパは `Intl.DateTimeFormat(locale, { timeZone, ... })`
を (locale, tz) の組ごとにキャッシュして使い回す。
サーバ/クライアントが同じ timezone/locale を渡す限りハイドレーション安全。

テストは `src/lib/format.test.ts` / `src/config/i18n.test.ts` で
UTC→JST 変換 / runtime TZ 独立性 / オプション指定 / フォールバック動作を検証。

**チェック**: 新規ファイル追加時は以下で漏れ検査できる:

```bash
rg -n "toLocaleDateString|toLocaleString|toLocaleTimeString|getFullYear\(\)|getMonth\(\)|getDate\(\)|getHours\(\)|getMinutes\(\)" src/
```

### 10.8 タイムゾーン / ロケールの 3 段階フォールバック (PR #118)

**背景**: 日本国内限定から将来的にローカル/オンプレ/クラウド多拠点展開を視野に入れ、
JST ハードコード (PR #117) を設定可能化。

**解決順序** (`src/config/i18n.ts` の `resolveTimezone()` / `resolveLocale()` 実装):

```
ユーザ個別設定 (User.timezone / User.locale)     ← 設定画面で変更 (PR #119 予定)
  ↓ (null / 空文字列なら)
システムデフォルト (src/config/i18n.ts の FALLBACK) ← リポジトリ同梱の既定値 (Asia/Tokyo / ja-JP)
  ↓ (env が設定されていれば上書き)
環境変数 (APP_DEFAULT_TIMEZONE / APP_DEFAULT_LOCALE) ← オンプレ / クラウド環境ごとに指定
```

**使い方** (PR #119 で整備済、通常こちらを使う):

```tsx
// クライアントコンポーネント: useFormatters フック
'use client';
import { useFormatters } from '@/lib/use-formatters';
export function MyClient() {
  const { formatDate, formatDateTime, formatDateTimeFull } = useFormatters();
  return <span>{formatDate(iso)}</span>;
}

// サーバコンポーネント: getServerFormatters 関数
import { getServerFormatters } from '@/lib/server-formatters';
export default async function MyPage() {
  const { formatDateTimeFull } = await getServerFormatters();
  return <td>{formatDateTimeFull(log.createdAt.toISOString())}</td>;
}
```

**低レベル API** (特殊ケース、通常は上記を使う):

```ts
import { formatDate } from '@/lib/format';
// (1) 引数なし = システムデフォルト (login page 等 session が無い場所で使用)
formatDate(iso)
// (2) 明示的 TZ/locale 指定 (テスト・固定表示等)
formatDate(iso, { timeZone: 'UTC', locale: 'ja-JP' })
```

**SSR/CSR 一貫性**: `session.user.timezone` / `session.user.locale` は JWT に格納され、
`<SessionProvider session={session}>` (PR #119 で設定) により第 1 クライアントレンダリングで確定値が参照可能。
サーバとクライアント両方で同じ値を使うためハイドレーション安全。

**DB 格納方針**: DB の `timestamptz` は常に UTC で保存・交換する (Postgres 仕様通り)。
描画時のみ TZ 解決を行う。API 境界も ISO 8601 UTC (`...Z` サフィックス) で統一。

**env 設定例** (オンプレ展開で米国東部を既定にしたい場合):

```bash
# .env.production
APP_DEFAULT_TIMEZONE=America/New_York
APP_DEFAULT_LOCALE=en-US
```

**ロケールを段階的に提供するパターン (PR #120 で導入)**:

メッセージカタログ未整備のロケールを UI に出したいが誤選択を防ぎたい場合、
`src/config/i18n.ts` の `SELECTABLE_LOCALES` マップを使う:

```ts
// UI には出すが選択不可にしたい場合
export const SUPPORTED_LOCALES = { 'ja-JP': '日本語', 'en-US': 'English' } as const;
export const SELECTABLE_LOCALES = {
  'ja-JP': true,   // 選択可
  'en-US': false,  // 表示するが disabled (翻訳未完)
} as const;
```

- UI 層: `<option disabled={!SELECTABLE_LOCALES[key]}>` + 「※準備中」表記
- API 層: `isSelectableLocale(value)` で 400 拒否 (curl 直叩き等の迂回防止)
- format 層: `isSupportedLocale` は true のまま返す (過去に書き込まれた値を壊さない)

翻訳完了 PR で該当キーの `SELECTABLE_LOCALES` を `true` に切り替えると、
カタログ側も紐付いて一斉に有効化される。

### 10.9 設定画面にセクションを追加するときの CI 連鎖 fail パターン (PR #119 で得た知見)

`settings-client.tsx` に新しい Card セクションを追加したり、`src/app/api/settings/*`
配下に route.ts を新設したりする場合、以下の **2 つの CI チェックが同時に fail** する。
両方まとめて対処しないとマージできないので手順化する。

**症状**:
1. `E2E coverage manifest check` — 新規 `route.ts` が `E2E_COVERAGE.md` に未記載
2. 視覚回帰 (`e2e/visual/dashboard-screens.spec.ts` / `settings-themes.spec.ts`) —
   設定画面の高さが変わって baseline PNG と不一致

**対処手順**:

1. `docs/developer/E2E_COVERAGE.md` の「API Routes > その他」セクションに新規 route を追記
   (即 E2E でカバーしないなら `[ ] /api/settings/xxx — skip: <理由>` の形式)
2. `pnpm e2e:coverage-check` をローカル実行して green 確認
3. `[gen-visual]` タグ付き commit を push して baseline を CI で再生成:
   ```bash
   git commit --allow-empty -m "chore: regenerate visual baselines for settings section [gen-visual]"
   git push
   ```
4. "E2E Visual Baseline" workflow 完了後、自動 commit が push され E2E ワークフローが緑化する

**なぜ両方同時に必要か**: `E2E coverage manifest check` が先に fail すると
`Test (vitest + coverage)` が skip → `coverage-summary.json` 不在で
`Report coverage` も連鎖 fail (§9.5.1 の PR #115 知見と同パターン)。
視覚回帰 fail は独立だが、UI 変更を伴う PR では必ず同時に発生する。

### 10.10.1 i18n Phase C 翻訳実施時の罠と運用知見 (PR #170 / feat/i18n-phase-c-1-auth で得た知見)

#### 罠 1: 抽出スクリプトはコメント内日本語も拾う

`scripts/i18n-extract-hardcoded-ja.ts` は **シングル/ダブルクオート + JSX text node** を
網羅抽出する。一方、コメント (`// ...` / `/* ... */`) 内の日本語は事前に `stripComments`
で除去するが、**抽出後に grep で確認するときはコメントが含まれる**。

- **対策**: 翻訳完了確認時は抽出スクリプト経由で 0 件確認 (コメント除去済) を採用、
  生 grep `[ぁ-ゖァ-ヺ一-鿿]` ではなく
  `pnpm tsx scripts/i18n-extract-hardcoded-ja.ts | grep <folder>` で確認する

#### 罠 2: useEffect の依存配列に t() を含める必要がある

`useTranslations` で取得した `t` は **render ごとに新しい識別子** になる。
useEffect 内で `t('xxx')` を呼ぶ場合、`t` を依存配列に含めないと React Hook の
exhaustive-deps lint warning が出る。

- **対策**: `useEffect(() => { setError(t('foo')); }, [token, t]);` のように `t` を含める。
  next-intl の `useTranslations` は同一キーで安定した参照を返すため、過剰な再 render は起きない

#### 罠 3: ICU MessageFormat の動的値は文字列連結よりも安全

旧:
```ts
setError(`ログイン失敗が続いたため${formatDateTimeFull(unlockAt)} 以降に...`);
```

新:
```ts
setError(t('temporaryLock', { unlockAt: formatDateTimeFull(unlockAt) }));
```

- **理由**: 翻訳者が文型を入れ替えやすい (英語と日本語で語順が異なる)、テスト時に
  プレースホルダ部分を動的に置換しやすい

#### 罠 4: section 間でキーを重複定義しない (単一源泉性) — PR #170 hotfix

`field.newPassword` / `field.newPasswordConfirm` が既に存在するのに、認証画面用に
`auth.newPassword` / `auth.newPasswordConfirm` を **同じ意味で重複追加** してしまった。
Stop hook §6 (i18n key 単一源泉チェック) で検出。

- **対策**: 既存 `field.*` / `action.*` / `message.*` セクションに同名キーがある場合、
  そちらを再利用する。複数 section から取りたい場合は **`useTranslations` を複数取得**:
  ```tsx
  const t = useTranslations('auth');
  const tField = useTranslations('field');
  // ...
  <Label>{tField('newPassword')}</Label>
  ```
- **追加前 grep**: 新規キー追加時は `grep -n '"<keyName>"' src/i18n/messages/ja.json` で
  別 section に同名が無いか確認 (キー名衝突 ≒ 意味重複の可能性大)
- **判断基準**: 画面横断で再利用される **フォーム項目名** は `field.*`、**ボタン文言** は
  `action.*`、**メッセージ** は `message.*`、画面固有のヒント・タイトルは `<screen>.*`

#### Phase C 各 PR の進め方 (PR-1 認証系で確立)

1. **対象ファイル特定**: `grep -E "^src.app..auth." docs/developer/i18n-extraction-2026-04-27.txt`
   で機能領域内のハードコード一覧を抽出
2. **キー設計**: 画面横断で再利用可能なキー (`email`, `password` 等) は共通化、
   画面固有のメッセージは画面プレフィックス (`reset`, `setup` 等) で命名
3. **両 JSON 同時更新**: ja.json と en-US.json に必ず同じキーを追加 (片方欠落で
   フォールバック)
4. **`useTranslations('auth')` を import**: 各 .tsx の関数本体先頭で `const t = useTranslations('section')` を取得
5. **置換**: ハードコード文字列を `t('key')` に。三項演算子の両分岐 (例: `step === 'verify' ? 'A' : 'B'`)
   も忘れず両方置換
6. **進捗確認**: PR 後に抽出スクリプト再実行し、対象フォルダのヒット数が 0 になったことを確認
7. **検証**: `pnpm lint` / `pnpm test` / `pnpm build` 全 pass

#### Phase C の stacked PR 運用

各 Phase C-N は **前段 (Phase B = PR #169) または前 Phase C にスタック** する。
- **base ブランチ指定**: `gh pr create --base feat/i18n-foundation` のように直前のブランチを base に
- **マージ順序**: PR #169 (Phase B) → PR #170 (C-1 認証) → PR #171 (C-2) ... の順
- **base 切替**: 上流 PR がマージされたら、下流 PR の base を `main` に切り替えてマージ

#### 関連

- §10.10 (元規約)
- §11.1 T-06 (Phase C 進捗管理)
- `scripts/i18n-extract-hardcoded-ja.ts`
- `docs/developer/i18n-extraction-2026-04-27.txt` (Phase B 起点の抽出結果)

### 10.10 i18n 翻訳作業の規約 (PR #169 / feat/i18n-foundation)

#### 全体像 (3 段階の現在地)

| 段階 | 内容 | 現状 |
|---|---|---|
| **Phase A** (PR #77) | `next-intl` 導入、ja.json に最小キー (action / field / message) 集約 | 済 (50 行のみ) |
| **Phase B** (PR #169 = 本セクションの起源) | en-US.json 雛形、request.ts の session.user.locale 連携、抽出スクリプト | 済 |
| **Phase C** (§11 T-06 = 別 PR) | 1069 箇所のハードコード日本語を全件 ja.json + en-US.json に移行、SELECTABLE_LOCALES.en-US = true | 未着手 (Phase B 後) |

#### Phase B (PR #169) で確立した基盤

1. **`src/i18n/messages/en-US.json`** — `ja.json` と同構造の英訳カタログ (action / field / message セクション、計 50 行)
2. **`src/i18n/request.ts`** — `auth().user.locale` を取得し `resolveLocale()` で BCP 47 解決、
   `messages/{ja,en-US}.json` を動的 import。
3. **`scripts/i18n-extract-hardcoded-ja.ts`** — `src/app/` + `src/components/` 配下から
   日本語文字列をハードコードしている箇所を全件抽出 (シングル/ダブルクオート + JSX text node)
4. **`docs/developer/i18n-extraction-2026-04-27.txt`** — 上記抽出スクリプトの実行結果。
   総ヒット **1069 箇所** / ユニーク文字列 **621 種**

#### Phase C 着手時の手順 (§11 T-06)

1. `pnpm tsx scripts/i18n-extract-hardcoded-ja.ts > docs/developer/i18n-extraction-<date>.txt` で再生成
2. **頻出文字列上位** から順にキー化 (例: 「対象が見つかりません」23 件 → `message.notFound`)
3. **キー命名規約**:
   - **action.*** : ボタン/動詞 (save / delete / cancel / submit)
   - **field.*** : フォーム項目ラベル (title / content / assignee)
   - **message.*** : ユーザ向けメッセージ (saveSuccess / deleteFailed / loading)
   - **page.<route>.*** : 画面固有のラベル (page.projects.create.title 等)
4. **ja.json + en-US.json を同時更新** (キー追加は両方必須、片方だけだとフォールバックされる)
5. **置換**: 該当 .tsx の文字列を `t('action.save')` に置換 (`useTranslations('action').then(t => t('save'))`)
6. **動作確認**: 設定画面で言語を English に変更 → 該当画面が英語表示されることを確認
7. **完了基準**: `pnpm tsx scripts/i18n-extract-hardcoded-ja.ts | grep "総ヒット数: 0"` ≒ 残ヒット数が
   翻訳対象外文言 (ログメッセージ、Markdown placeholder の例示など) のみになるまで進める
8. **最終ステップ**: `src/config/i18n.ts` の `SELECTABLE_LOCALES['en-US']` を `true` に切替、
   設定画面の言語選択肢から英語を選べるようにして release

#### 進め方の推奨 (1 PR = 1 機能領域)

1069 箇所を 1 PR で全置換するのはレビュー負荷が大きすぎるため、**機能領域 (画面群) ごとに分割** する:

- **PR-1**: 認証系 (login / mfa / setup-password / reset-password) ≈ 50 箇所
- **PR-2**: ダッシュボード共通 (dashboard-header / loading-overlay / 各メニュー) ≈ 80 箇所
- **PR-3**: プロジェクト系 (project-detail-client / risks / issues / retros / knowledge / wbs) ≈ 400 箇所
- **PR-4**: 個人機能 (memos / settings / my-tasks) ≈ 100 箇所
- **PR-5**: 管理系 (admin/users / customers / audit-logs) ≈ 200 箇所
- **PR-6**: 残り + SELECTABLE_LOCALES.en-US = true 切替

各 PR は単独でマージ可能 (ja のみ運用は維持される)。すべて完了 = SELECTABLE_LOCALES 切替で公開。

#### 汎化ルール

1. **新規 .tsx 追加時は最初から `useTranslations` を使う**: 後付けで置換するより着手段階で
   キー化する方がコスト低
2. **動的文字列 (`${count} 件`) は ICU MessageFormat**: `next-intl` は ICU 構文をサポート。
   `t('foo', { count })` で `{count, plural, one{# 件} other{# 件}}` 形式を使う
3. **DB 由来の文字列は翻訳しない**: ユーザ入力データ (タスク名、コメント本文等) は元言語で
   表示する。UI ラベル/メッセージのみ翻訳対象

#### 関連

- DESIGN.md §21.4.5 (UI ラベル外出しと next-intl 導入指針)
- src/config/i18n.ts (`SUPPORTED_LOCALES` / `SELECTABLE_LOCALES` / `resolveLocale`)
- §11 T-06 (en-US 本格翻訳、6 サブ PR で段階展開)
- §11 T-10 (en-US 有効化、本セクションで Phase B 完了を反映)

---

