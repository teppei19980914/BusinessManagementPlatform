/**
 * remark プラグイン: Markdown 描画経路で http/https URL を「URL 部分だけ」リンク化する
 * (feat/url-autolink)。
 *
 * 背景:
 *   react-markdown + remark-gfm の標準 autolink は「空白か `<` まで」を URL とみなすため、
 *   「https://tasukiba.com/loginにアクセスしてください。」のように URL の直後へ空白なしで
 *   日本語が続くと、日本語や全角句点まで href に巻き込んでしまう (リンク先が壊れる)。
 *
 * 本プラグインの役割:
 *   1. remark-gfm が生成した autolink リテラル (url === 表示テキスト) のうち、末尾に
 *      非 URL 文字 (日本語等) を巻き込んだものを検出し、URL 部分と残りテキストに分割し直す。
 *   2. 念のため、まだリンク化されていない素の text ノード内の URL も同じ規則でリンク化する
 *      (gfm autolink が無効な構成でも自己完結で動くようにするための保険)。
 *
 * 除外: code / inlineCode、および明示リンク `[label](url)` (url と表示テキストが異なる、
 *   または title を持つもの) は触らない。ユーザが意図して書いたリンクは尊重する。
 *
 * 境界判定は src/lib/url-linkify.ts の splitByUrl() に委譲 (CJK 安全)。
 */

import { splitByUrl } from '@/lib/url-linkify';

/** 触れる範囲の最小 mdast ノード形 (unist/mdast 型に依存しないための局所定義)。 */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
}

function textNode(value: string): MdNode {
  return { type: 'text', value };
}

function linkNode(url: string): MdNode {
  return { type: 'link', url, title: null, children: [textNode(url)] };
}

/** 1 つの text ノードを URL/テキストのノード列へ展開 (URL を含まなければ自身を返す)。 */
function expandTextNode(node: MdNode): MdNode[] {
  const segs = splitByUrl(node.value ?? '');
  if (segs.length <= 1 && (segs.length === 0 || segs[0].type === 'text')) {
    return [node];
  }
  return segs.map((seg) => (seg.type === 'url' ? linkNode(seg.value) : textNode(seg.value)));
}

/**
 * gfm autolink リテラル (url === 表示テキストの link) で URL に非 URL 末尾文字が
 * 巻き込まれているものを、URL 部分 + 残りテキストへ分割し直す。
 * 対象外 (明示リンク等) や既にクリーンなものは null を返す。
 */
function repairAutolinkLiteral(node: MdNode): MdNode[] | null {
  if (node.type !== 'link' || !node.url) return null;
  if (node.title) return null; // 明示リンクは尊重
  const children = node.children ?? [];
  if (children.length !== 1 || children[0].type !== 'text') return null;
  const text = children[0].value ?? '';
  // autolink リテラルは「表示テキスト === url」。異なれば明示リンクなので触らない。
  if (text !== node.url) return null;

  const segs = splitByUrl(node.url);
  // クリーン (URL 1 個のみで全体が URL) ならそのまま。
  if (segs.length === 1 && segs[0].type === 'url' && segs[0].value === node.url) {
    return null;
  }
  if (segs.length === 0) return null;
  return segs.map((seg) => (seg.type === 'url' ? linkNode(seg.value) : textNode(seg.value)));
}

/** mdast ツリーを再帰的に走査し、子配列を URL リンク化規則で組み替える。 */
export function linkifyMdastTree(node: MdNode): void {
  const children = node.children;
  if (!Array.isArray(children)) return;

  const next: MdNode[] = [];
  for (const child of children) {
    if (child.type === 'code' || child.type === 'inlineCode') {
      next.push(child);
      continue;
    }
    if (child.type === 'link') {
      const repaired = repairAutolinkLiteral(child);
      if (repaired) {
        next.push(...repaired);
      } else {
        // 明示リンク等はそのまま (中身はリンク済みなので再帰不要)
        next.push(child);
      }
      continue;
    }
    if (child.type === 'text') {
      next.push(...expandTextNode(child));
      continue;
    }
    // それ以外 (paragraph / list / heading / table 等) は再帰
    linkifyMdastTree(child);
    next.push(child);
  }
  node.children = next;
}

/** remark プラグイン本体。unified の Transformer を返す。 */
export default function remarkLinkifyUrls() {
  return (tree: MdNode): void => {
    linkifyMdastTree(tree);
  };
}
