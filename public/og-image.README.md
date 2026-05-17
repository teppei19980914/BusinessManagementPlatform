# OG 画像 (`og-image.png`) 配置ガイド

本ディレクトリに **`og-image.png`** を配置することで、SNS シェア時のプレビュー画像として機能します。
`src/app/layout.tsx` の `generateMetadata` で `/og-image.png` を参照しています。

## 仕様

- **ファイル名**: `og-image.png` (固定、変更する場合は `src/app/layout.tsx` も同時更新)
- **サイズ**: 1200 × 630 px (Facebook / X / LinkedIn / Slack 等の推奨サイズ)
- **形式**: PNG (透過なし推奨、SNS によっては JPG でも可)
- **ファイルサイズ**: 5MB 以下 (一般的に 200-500KB 程度)
- **内容**:
  - プロダクト名: 「たすきば Knowledge Relay」
  - テーマ: 「知見を残す。判断をつなぐ。プロジェクトを強くする。」
  - 視認性: モバイルサムネイル (横 200px) でも読める文字サイズを推奨

## 作成方法の選択肢

1. **手作業デザイン**: Figma / Adobe Express 等で作成 → PNG 書き出し
2. **テンプレ利用**: og-image.gallery / banner.cc 等の SNS 画像テンプレ
3. **動的生成**: Next.js `app/opengraph-image.tsx` で `ImageResponse` を使う方式
   (将来検討、現状は静的画像で十分)

## 配置後の検証

1. `pnpm build` でビルド成功確認
2. Vercel Preview Deployment にデプロイ
3. [OG Debugger](https://www.opengraph.xyz/) や Facebook Sharing Debugger で確認
4. 実際に X / Slack 等にシェアしてプレビューを目視

## 配置タイミング

PUBLIC_LAUNCH_CHECKLIST.md §2.2 に記載のとおり、6/1 リリース前までに対応。
画像が未配置の場合、SNS シェア時のプレビューは空または既定アイコンになります(機能影響なし)。

---

> このファイル自体 (`og-image.README.md`) は OG 画像配置後も残してメンテ情報として保持してください。
