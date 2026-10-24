export type Category = 'ai' | 'dev' | 'products' | 'industry';
export type SourceKind = 'rss' | 'tldr' | 'hn';
export type SourceDef = { name: string; url: string; kind: SourceKind; category: Category };

export const CATEGORIES: Category[] = ['ai', 'dev', 'products', 'industry'];

// built-in sources, inserted into D1 on every fetch run (INSERT OR IGNORE), so the owner's on/off choice sticks.
// category is only a hint: Gemini assigns the final one, and the no-LLM fallback uses this.
export const DEFAULT_SOURCES: SourceDef[] = [
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml', kind: 'rss', category: 'ai' },
  { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', kind: 'rss', category: 'ai' },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', kind: 'rss', category: 'ai' },
  { name: 'The Decoder', url: 'https://the-decoder.com/feed/', kind: 'rss', category: 'ai' },
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/entries/', kind: 'rss', category: 'ai' },
  { name: 'TLDR AI', url: 'https://tldr.tech/api/rss/ai', kind: 'tldr', category: 'ai' },
  { name: 'Hacker News', url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30', kind: 'hn', category: 'dev' },
  { name: 'GitHub Blog', url: 'https://github.blog/feed/', kind: 'rss', category: 'dev' },
  { name: 'Lobsters', url: 'https://lobste.rs/rss', kind: 'rss', category: 'dev' },
  { name: 'Chrome for Developers', url: 'https://developer.chrome.com/static/blog/feed.xml', kind: 'rss', category: 'dev' },
  { name: 'Angular Blog', url: 'https://blog.angular.dev/feed', kind: 'rss', category: 'dev' },
  { name: 'TLDR Web Dev', url: 'https://tldr.tech/api/rss/webdev', kind: 'tldr', category: 'dev' },
  { name: 'TLDR Dev', url: 'https://tldr.tech/api/rss/dev', kind: 'tldr', category: 'dev' },
  { name: 'TLDR InfoSec', url: 'https://tldr.tech/api/rss/infosec', kind: 'tldr', category: 'dev' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', kind: 'rss', category: 'products' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', kind: 'rss', category: 'products' },
  { name: 'Engadget', url: 'https://www.engadget.com/rss.xml', kind: 'rss', category: 'products' },
  { name: '9to5Mac', url: 'https://9to5mac.com/feed/', kind: 'rss', category: 'products' },
  { name: '9to5Google', url: 'https://9to5google.com/feed/', kind: 'rss', category: 'products' },
  { name: 'TLDR Hardware', url: 'https://tldr.tech/api/rss/hardware', kind: 'tldr', category: 'products' },
  { name: 'TLDR Design', url: 'https://tldr.tech/api/rss/design', kind: 'tldr', category: 'products' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', kind: 'rss', category: 'industry' },
  { name: 'Geektime', url: 'https://www.geektime.co.il/feed/', kind: 'rss', category: 'industry' },
  { name: 'TLDR Tech', url: 'https://tldr.tech/api/rss/tech', kind: 'tldr', category: 'industry' },
  { name: 'TLDR IT', url: 'https://tldr.tech/api/rss/it', kind: 'tldr', category: 'industry' },
];
