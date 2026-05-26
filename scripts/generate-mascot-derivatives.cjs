/* eslint-disable @typescript-eslint/no-require-imports -- .cjs ファイルのため意図的に CommonJS require を使用 */
/**
 * たすきフクロウ派生アイコン生成スクリプト (一度きり想定)
 *
 * 用途: docs/design/assets/mascot-owl-source.png (1254×1254 元画像) から
 *   サービス全体で使う派生画像を生成する。
 *
 * 出力:
 *   - public/mascot-owl.png        512×512   ヘッダ / hero 等の汎用利用
 *   - src/app/icon.png             256×256   Next.js App Router の icon 規約 (favicon 自動生成)
 *   - src/app/apple-icon.png       180×180   iOS apple-touch-icon
 *   - public/og-image.png          1200×630  SNS シェア用 OG image (合成)
 *
 * 再実行:
 *   $ node scripts/generate-mascot-derivatives.cjs
 *
 * 依存:
 *   sharp (Next.js の transitive dep として既にインストール済)
 *
 * 関連: docs/design/MASCOT.md, public/og-image.README.md
 */
const path = require('path');
const fs = require('fs');

// sharp は Next.js Image Optimization 用に既に依存ツリーへ入っている。
// 直接 require できないケースがあるため pnpm-store 経由のパスにフォールバック。
function loadSharp() {
  try {
    return require('sharp');
  } catch {
    const root = path.resolve(__dirname, '..');
    const sharpDir = path.join(root, 'node_modules/.pnpm');
    const dirs = fs.readdirSync(sharpDir).filter((d) => /^sharp@/.test(d));
    if (dirs.length === 0) {
      throw new Error('sharp が見つかりません。pnpm install を実行してください。');
    }
    return require(path.join(sharpDir, dirs[0], 'node_modules/sharp'));
  }
}

const sharp = loadSharp();

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'docs/design/assets/mascot-owl-source.png');

async function writePng(buf, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  const meta = await sharp(outPath).metadata();
  const stat = fs.statSync(outPath);
  console.log(`  ${path.relative(ROOT, outPath)}  ${meta.width}x${meta.height}  ${(stat.size / 1024).toFixed(1)} KB`);
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`元画像が見つかりません: ${SRC}`);
    console.error('元画像を docs/design/assets/mascot-owl-source.png に配置してください。');
    process.exit(1);
  }

  const srcBuf = fs.readFileSync(SRC);
  const srcMeta = await sharp(srcBuf).metadata();
  console.log(`source: ${srcMeta.width}x${srcMeta.height} ${srcMeta.format} (${(srcBuf.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log('--- 出力 ---');

  // 1) 汎用 512×512 (ヘッダ / hero / その他)
  const main512 = await sharp(srcBuf)
    .resize(512, 512, { fit: 'cover' })
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer();
  await writePng(main512, path.join(ROOT, 'public/mascot-owl.png'));

  // 2) Next.js App Router icon 規約 — src/app/icon.png は自動で <link rel="icon"> 化される
  const icon256 = await sharp(srcBuf)
    .resize(256, 256, { fit: 'cover' })
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer();
  await writePng(icon256, path.join(ROOT, 'src/app/icon.png'));

  // 3) Apple touch icon — iOS は 180×180 を期待
  const apple180 = await sharp(srcBuf)
    .resize(180, 180, { fit: 'cover' })
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer();
  await writePng(apple180, path.join(ROOT, 'src/app/apple-icon.png'));

  // 4) OG image 1200×630
  //    背景は元画像の薄青に近い oklch(0.95 0.02 235) ≒ #d9ecf7 を採用。
  //    左にロゴ 560×560、右にサービス名・補足テキストを SVG で描画。
  //    フォントは system default の sans-serif に依存 (Noto Sans JP が無いと別 fallback)。
  const LOGO = 560;
  const logoBuf = await sharp(srcBuf)
    .resize(LOGO, LOGO, { fit: 'cover' })
    .png()
    .toBuffer();

  const ogSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <style>
    .name { font: 700 88px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif; fill: #1a3a8a; }
    .sub { font: 600 36px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif; fill: #3a5a9a; }
    .tag { font: 400 28px 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif; fill: #3a5a9a; }
  </style>
  <text x="640" y="270" class="name">たすきば</text>
  <text x="640" y="340" class="sub">Knowledge Relay</text>
  <text x="640" y="410" class="tag">プロジェクトの知見を、</text>
  <text x="640" y="450" class="tag">次の判断へ。</text>
</svg>`);

  const og = await sharp({
    create: {
      width: 1200,
      height: 630,
      channels: 3,
      background: { r: 217, g: 236, b: 247 }, // #d9ecf7 (元画像の背景色相)
    },
  })
    .composite([
      { input: logoBuf, top: 35, left: 35 },
      { input: ogSvg, top: 0, left: 0 },
    ])
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer();
  await writePng(og, path.join(ROOT, 'public/og-image.png'));

  console.log('\n完了。git status で差分を確認してください。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
