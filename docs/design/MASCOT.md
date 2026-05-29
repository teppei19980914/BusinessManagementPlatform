# 公式マスコット「たすきフクロウ」

## 概要

「たすきば Knowledge Relay」の公式マスコット。濃紺のフクロウが羽でドキュメントを抱え、
胸元に鍵穴付きの盾、背景に円形のバリアが配置されている。

| 項目 | 値 |
|---|---|
| 名前 | たすきフクロウ |
| 制定日 | 2026-05-26 |
| 汎用 元画像 | `docs/design/assets/mascot-owl-source.png` (1254×1254 PNG) |
| チャット 元画像 | `docs/design/assets/mascot-owl-chat-source.png` (1254×1254 PNG、吹き出し + たすき帯 + 盾の構図) |
| SNS プロフィール 元画像 | `docs/design/assets/mascot-owl-sns-source.png` (会社公式 SNS 設定用マスター、コード参照なし) |
| 派生画像 | `public/mascot-owl.png` (512), `src/app/icon.png` (256), `src/app/apple-icon.png` (180), `public/og-image.png` (1200×630), `public/mascot-owl-chat.png` (256 / チャット FAB + アシスタント・アバター) |
| 再生成スクリプト | `scripts/generate-mascot-derivatives.cjs` |

## 選定根拠

フクロウは古来より **「知恵」「記憶」「夜でも見守る」** の象徴とされる。これらはプロダクトの
3 つの軸 — プロジェクト管理 / ナレッジ管理 / セキュリティ — と次のように対応する。

| プロダクトの軸 | フクロウの象徴 |
|---|---|
| ナレッジ管理 (過去資産の検索・継承) | 「知恵」「記憶」 |
| プロジェクト管理 (判断支援) | 「夜でも見守る」 (= プロジェクトの状況を常に把握) |
| セキュリティ (テナント分離・権限管理) | 「夜でも見守る」 (= 守護者) |

選定にあたり 4 候補を比較したが、フクロウは「信頼・落ち着き・知識」のニュアンスを最も強く
表現でき、法人導入・セキュリティ重視文脈にも耐えやすい点で採用された。

## デザイン要素

### 汎用バージョン (`mascot-owl-source.png`)

| 要素 | 意味 |
|---|---|
| 濃紺ベース | 信頼・落ち着き・夜の見守り |
| 羽でドキュメントを抱える構図 | 「知見を守る」「次の判断に渡す (= たすき)」 |
| 胸元の盾 + 鍵穴 | セキュリティ・権限管理・テナント分離 |
| 背景の円形バリア (薄青) | 守護・安全な領域 |

### チャット バージョン (`mascot-owl-chat-source.png`)

チャット意味検索の FAB / アシスタント・アバター専用に、汎用バージョンとは別構図を採用。

| 要素 | 意味 |
|---|---|
| 吹き出しの輪郭にフクロウを内包 | 「チャットの相手 = たすきフクロウ」を一瞬で伝える |
| ミントのたすき帯 | サービス名「たすきば」と「世代間でたすきを渡す」象徴の継承 |
| 小さな盾 (チェック付き) | チャット越境・テナント漏れに対する安全性を視覚化 |
| 青系の配色統一 | 汎用バージョンと同じ色相で連続感を維持 (ヘッダロゴ ↔ FAB ↔ チャット内アバター) |

## 使い方ガイド

### 推奨される使い方

- **ヘッダ左上のロゴ** (`<AppHeader>`) — デスクトップは「アイコン + たすきば」併記、モバイルはアイコンのみ。`public/mascot-owl.png` を使用
- **ログイン画面のサービス名横ロゴ** (`src/app/(auth)/login/page.tsx` CardHeader) — `public/mascot-owl.png` を 40×40 で「たすきば / Knowledge Relay」テキストの左に並べる。AppHeader と同じ `next/image` + `alt={t('appName')}` + `priority` + `rounded-sm` パターンを採用し、ロゴとしての視覚的一貫性を保つ。`data-testid="login-mascot-owl"`。**setup-guide footer は Card 内ではなく Card 下に縦並びで配置** (毎日利用するユーザにとっての視覚ノイズ最小化、`flex-col` レイアウト)
- **favicon / apple-touch-icon** — Next.js の `src/app/icon.png` / `src/app/apple-icon.png` 規約で自動配信
- **OG 画像 (SNS シェア)** — `public/og-image.png`、左にロゴ + 右にサービス名・タグライン
- **チャット意味検索の FAB** — 全画面右下の常時表示ボタン、`public/mascot-owl-chat.png` (チャットバージョン) を使用。aria-label は「たすきフクロウに相談する」固定
- **チャット意味検索のアシスタント・アバター** — チャットパネル内のヘッダ + 各返答吹き出しの左に同画像を表示し「フクロウが応答している」体験を作る ([CHAT_SEMANTIC_SEARCH.md](../specification/CHAT_SEMANTIC_SEARCH.md))

#### `<Image>` 配信方針: `unoptimized` 必須 (KDD §5.X+177)

マスコット画像 5 用途 (ヘッダ / ログイン / help FAQ / チャット FAB / チャット avatar) はすべて `<Image>` に **`unoptimized` を明示**する。理由:

- 本番 (Netlify) の Image Optimizer Lambda (`/_next/image?url=...`) が小さな PNG で不安定に失敗し、broken-image (alt テキスト縦書きフォールバック) を起こす事故が発生したため (詳細: [KDD §5.X+177](../knowledge/KDD_PATTERNS.md))
- 28×28 〜 120×120 の小アイコンで WebP/AVIF 圧縮メリットは数十 KB 程度。一方 Optimizer 失敗時の UI 崩壊コストは「ブランド要素全消失 + ユーザ困惑」と非対称
- raw PNG 直接配信 (`unoptimized`) でブラウザ HTTP cache に乗り、CDN level での再配信効率は同等

全 5 ファイルに source-pattern 回帰テストで `unoptimized` 付与を invariant 化済 (`app-header.test.tsx` / `help-client.test.ts` / `chat-fab.test.ts` / `chat-panel.test.ts`)。
- **SNS 公式アカウントのプロフィール画像** — X / LinkedIn / Facebook の会社公式アカウントに人間が手動アップロード。マスター画像は `docs/design/assets/mascot-owl-sns-source.png` (リポジトリ参照のみ、コード参照なし)
- **ランディングページ (HomePage)** — Header のサービス名横に小さく配置
- **オンボーディング画面 / 空状態イラスト** — 親しみやすさを補強するために配置可

### 避けるべき使い方

- **過度なデフォルメ / アニメ化** — 法人導入時の信頼感を損ねる
- **背景色とのコントラスト不足** — 濃紺マスコットを濃色背景に置かない (視認性低下)
- **権限・セキュリティと無関係なメタファでの使用** — 例えば「エンタメ性」「軽さ」のみを訴求するシーン
- **不安・警告系の文脈** — 守護のメタファに反するため、エラー表示等には使わない (別アイコン推奨)

### コピー (文言) の方向性

マーケコピー・サービス紹介で「たすきフクロウ」を出す際は次の 3 文脈に揃える:

1. 「夜でも見守る」 (= 常時稼働・継続的監視)
2. 「知見を守る」 (= データ保全・ナレッジ蓄積)
3. 「必要なときに示す」 (= 提案エンジン・判断支援)

## 派生画像の再生成

元画像 (`docs/design/assets/mascot-owl-source.png` または `mascot-owl-chat-source.png`)
を更新したら、以下を実行して派生画像をすべて再生成する:

```bash
node scripts/generate-mascot-derivatives.cjs
```

スクリプトは 2 つの元画像から以下を生成する:

- `mascot-owl-source.png` → `public/mascot-owl.png`, `src/app/icon.png`, `src/app/apple-icon.png`, `public/og-image.png`
- `mascot-owl-chat-source.png` → `public/mascot-owl-chat.png` (※ trim 抽出後 fit:'cover')

### チャット派生のバッジ全面占有 (KDD §5.X+165)

`mascot-owl-chat-source.png` は **暗い studio 背景 + 右下に白い円形バッジ + フクロウ**
という複合キャンバス構成のため、そのまま `fit:'contain'` で 256 に縮めるとバッジが
中央付近に小さく残り、FAB の `bg-background` が周囲に黒枠として見える事故が起きる。

これを避けるため、スクリプトでは `sharp.trim({ threshold: 30 })` で暗背景を除去 →
約 512×507 のバッジ単体を抽出 → `fit:'cover'` で 256×256 に拡縮し、**派生画像は
バッジが全面を占める** 状態にする。これにより `chat-fab.tsx` / `chat-panel.tsx`
ヘッダ / `AssistantBubble` のどこに置いても黒枠 / 余白が出ない。

詳細は [docs/knowledge/KDD_PATTERNS.md §5.X+165](../knowledge/KDD_PATTERNS.md) と
[docs/design/UI_PATTERNS.md §36](./UI_PATTERNS.md) を参照。

### その他

生成スクリプトは `sharp` (Next.js の依存パッケージ) を使用するため別途インストール不要。
スクリプトは冪等で、既存ファイルを上書きする。`palette: false` を明示しており Next.js
Image Optimizer の palette PNG 弾き挙動 (KDD §5.X+160) は回避済み。

なお `mascot-owl-sns-source.png` は派生を生成しない (会社公式 SNS の管理者が手動でアップロード)。

## ライセンス・著作権

元画像は OpenAI 社の ChatGPT (DALL·E) で 2026-05-26 に生成。OpenAI 利用規約により
ユーザに商用利用権が帰属する。詳細は OpenAI Terms of Use 該当条項を参照。

## 関連

- [プロジェクト概要](../README.md)
- [OG 画像配置ガイド](../../public/og-image.README.md)
- [アーキテクチャ](./ARCHITECTURE.md)
