import { describe, expect, it } from 'vitest';
import { cluster, jaccard, tokens } from '../src/cluster';
import { feedTitle, normalizeUrl, parseFeed, parseHn, parseTldrIssue, plainText } from '../src/feeds';
import { RSS } from './helpers';

describe('parseFeed', () => {
  it('reads RSS items with CDATA, entities and escaped HTML', () => {
    const xml = RSS([{ title: 'Apple &amp; Google ship X', link: 'https://a.test/1', desc: 'Big &lt;b&gt;news&lt;/b&gt; here' }]);
    const [item] = parseFeed(xml, 10);
    expect(item.title).toBe('Apple & Google ship X');
    expect(item.url).toBe('https://a.test/1');
    expect(item.snippet).toBe('Big news here');
    expect(item.publishedAt).toBe('2026-10-24T06:00:00.000Z');
    expect(feedTitle(xml)).toBe('Test Feed');
  });

  it('stops after max items', () => {
    const xml = RSS(Array.from({ length: 50 }, (_, i) => ({ title: `T${i}`, link: `https://a.test/${i}` })));
    expect(parseFeed(xml, 30)).toHaveLength(30);
  });

  it('reads Atom entries and takes the alternate link, not self', () => {
    const xml = `<feed><title>Atom</title><entry><title type="html">Hello</title>
      <link rel="self" href="https://a.test/self"/><link rel="alternate" type="text/html" href="https://a.test/post?a=1&amp;b=2"/>
      <published>2026-10-24T05:00:00Z</published><summary>Sum</summary></entry></feed>`;
    expect(parseFeed(xml, 5)).toEqual([{ url: 'https://a.test/post?a=1&b=2', title: 'Hello', snippet: 'Sum', publishedAt: '2026-10-24T05:00:00.000Z' }]);
  });

  it('skips entries without a title or http link', () => {
    expect(parseFeed('<rss><item><title></title><link>https://a.test</link></item><item><title>x</title><link>mailto:a</link></item></rss>', 5)).toEqual([]);
  });
});

describe('parseTldrIssue', () => {
  const html = `
    <article class="mt-3"><a class="font-bold" href="https://ads.test/x?sp=1"><h3>Free notes (Sponsor)</h3></a><div class="newsletter-html">Buy</div></article>
    <article class="mt-3"><a class="font-bold" href="https://news.test/a?utm_source=tldrnewsletter&amp;id=7"><h3>OpenAI Ships Thing (4 minute read)</h3></a><div class="newsletter-html">It <b>shipped</b>.<p></p></div></article>`;

  it('splits an issue into stories, drops sponsors and the read-time suffix', () => {
    expect(parseTldrIssue(html, '2026-10-23T00:00:00.000Z')).toEqual([
      { url: 'https://news.test/a?utm_source=tldrnewsletter&id=7', title: 'OpenAI Ships Thing', snippet: 'It shipped .', publishedAt: '2026-10-23T00:00:00.000Z' },
    ]);
  });
});

describe('parseHn', () => {
  it('keeps stories above the points floor and links self posts to HN', () => {
    const items = parseHn(
      { hits: [{ objectID: '1', title: 'Big', url: 'https://b.test', points: 400 }, { objectID: '2', title: 'Ask HN', url: null, points: 200 }, { objectID: '3', title: 'Small', points: 10 }] },
      150,
    );
    expect(items.map((i) => [i.url, i.points])).toEqual([['https://b.test', 400], ['https://news.ycombinator.com/item?id=2', 200]]);
  });
});

describe('normalizeUrl', () => {
  it('treats the same article from two feeds as one', () => {
    expect(normalizeUrl('https://www.Example.com/post/?utm_source=x&b=2&a=1#top')).toBe('example.com/post?a=1&b=2');
    expect(normalizeUrl('http://example.com/post')).toBe(normalizeUrl('https://www.example.com/post/'));
  });
  it('returns junk unchanged', () => {
    expect(normalizeUrl(' not a url ')).toBe('not a url');
  });
});

describe('plainText', () => {
  it('decodes numeric entities', () => {
    expect(plainText('Don&#x27;t &#8220;stop&#8221;')).toBe('Don\'t “stop”');
  });
});

describe('cluster', () => {
  it('groups near-identical headlines and keeps different stories apart', () => {
    const items = [
      { title: 'OpenAI releases GPT-6 model' },
      { title: 'Apple announces new iPad Pro' },
      { title: 'OpenAI releases GPT-6 model today' },
    ];
    const groups = cluster(items);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it('drops items matching an already-sent title', () => {
    expect(cluster([{ title: 'OpenAI releases GPT-6 model' }], ['OpenAI releases the GPT-6 model'])).toEqual([]);
  });

  it('ignores stop words when comparing', () => {
    expect(jaccard(tokens('The new Pixel'), tokens('Pixel'))).toBe(1);
  });
});
