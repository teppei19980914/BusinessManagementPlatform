import { describe, it, expect } from 'vitest';
import { linkifyMdastTree } from './remark-linkify-urls';

/** 触れる範囲の最小 mdast ノード形 (remark-linkify-urls.ts の局所 MdNode と同形)。 */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
};

/** mdast の link ノードを (url, 表示テキスト) のタプルへ簡約。 */
function links(node: MdNode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (n: MdNode) => {
    if (n.type === 'link') {
      const text = (n.children ?? []).map((c) => c.value ?? '').join('');
      out.push([n.url ?? '', text]);
    }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

/** paragraph 直下の text/link を平坦化した値の連結 (元テキスト復元確認用)。 */
function flatText(para: MdNode): string {
  return (para.children ?? [])
    .map((c) => (c.type === 'link' ? (c.children ?? []).map((g) => g.value).join('') : c.value))
    .join('');
}

describe('linkifyMdastTree', () => {
  it('★gfm autolink が日本語を巻き込んだ URL を URL 部分だけに補正する', () => {
    // remark-gfm autolink リテラルの再現: url === 表示テキスト、CJK を巻き込んでいる
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://tasukiba.com/loginにアクセスしてください。',
              title: null,
              children: [{ type: 'text', value: 'https://tasukiba.com/loginにアクセスしてください。' }],
            },
          ],
        },
      ],
    };
    linkifyMdastTree(tree);
    expect(links(tree)).toEqual([['https://tasukiba.com/login', 'https://tasukiba.com/login']]);
    expect(flatText(tree.children![0])).toBe(
      'https://tasukiba.com/loginにアクセスしてください。',
    );
  });

  it('クリーンな autolink リテラルはそのまま (冪等)', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com/page',
              title: null,
              children: [{ type: 'text', value: 'https://example.com/page' }],
            },
          ],
        },
      ],
    };
    linkifyMdastTree(tree);
    expect(links(tree)).toEqual([['https://example.com/page', 'https://example.com/page']]);
  });

  it('明示リンク [label](url) は表示テキストが異なるので触らない', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com/x',
              title: null,
              children: [{ type: 'text', value: 'こちら' }],
            },
          ],
        },
      ],
    };
    linkifyMdastTree(tree);
    expect(links(tree)).toEqual([['https://example.com/x', 'こちら']]);
  });

  it('素の text ノード内の URL もリンク化する (保険経路)', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: '詳細は https://example.com/a を参照' }],
        },
      ],
    };
    linkifyMdastTree(tree);
    expect(links(tree)).toEqual([['https://example.com/a', 'https://example.com/a']]);
    expect(flatText(tree.children![0])).toBe('詳細は https://example.com/a を参照');
  });

  it('inlineCode / code 内の URL はリンク化しない', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '例: ' },
            { type: 'inlineCode', value: 'https://example.com/in-code' },
          ],
        },
        { type: 'code', value: 'https://example.com/in-block' },
      ],
    };
    linkifyMdastTree(tree);
    expect(links(tree)).toEqual([]);
  });

  it('リスト等のネストした子も再帰的にリンク化する', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', value: 'https://example.com/item です' }],
                },
              ],
            },
          ],
        },
      ],
    };
    linkifyMdastTree(tree);
    expect(links(tree)).toEqual([['https://example.com/item', 'https://example.com/item']]);
  });
});
