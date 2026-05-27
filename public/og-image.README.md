# OG 画像 (`og-image.png`) 配置ガイド

本ディレクトリに **`og-image.png`** を配置することで、SNS シェア時のプレビュー画像として機能します。
`src/app/layout.tsx` の `generateMetadata` で `/og-image.png` を参照しています。

## 仕様

- **ファイル名**: `og-image.png` (固定、変更する場合は `src/app/layout.tsx` も同時更新)
- **サイズ**: 1200 × 630 px (Facebook / X / LinkedIn / Slack 等の推奨サイズ)
- **形式**: PNG (透過なし)
- **ファイルサイズ**: 5MB 以下 (現状は ~120KB)
- **内容**:
  - 左に公式マスコット「たすきフクロウ」のロゴ
  - 右にサービス名「たすきば」「Knowledge Relay」「プロジェクトの知見を、次の判断へ。」

## 生成方法

公式マスコットの派生画像はすべて `scripts/generate-mascot-derivatives.cjs` で
`docs/design/assets/mascot-owl-source.png` (1254×1254 の元画像) から自動生成します。

```bash
node scripts/generate-mascot-derivatives.cjs
```

このスクリプトは下記すべてを再生成します:
- `public/mascot-owl.png` (512×512、ヘッダ等で使用)
- `src/app/icon.png` (256×256、Next.js が favicon を自動生成)
- `src/app/apple-icon.png` (180×180、iOS apple-touch-icon)
- `public/og-image.png` (1200×630、本ファイル)

OG 画像のレイアウト・コピーを変更したい場合は、スクリプト内の SVG オーバーレイ
ブロックを編集して再実行してください。

## 配置後の検証

1. `pnpm build` でビルド成功確認
2. ステージング/Preview にデプロイ
3. [OG Debugger](https://www.opengraph.xyz/) や X Card Validator でプレビュー確認
4. 実際に X / Slack 等にシェアしてプレビューを目視

## 関連ドキュメント

- [マスコット選定根拠](../docs/design/MASCOT.md)
