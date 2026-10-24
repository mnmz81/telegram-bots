import { CONFIG } from './config';

const STOP = new Set(
  ('the and for with you your are was were this that from into over than about after its it\'s has have had will can ' +
    'new now how why what who when where just more most here get gets got says said not but all out off use using via ' +
    'one two our their they them his her she him being been also first launch launches launched update updates')
    .split(' '),
);

export function tokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const SEEN = -1;

// groups items whose titles are the same story; items matching an already-sent title are dropped.
// An inverted token index keeps it near-linear: only titles that share a word are compared.
export function cluster<T extends { title: string }>(items: T[], seenTitles: string[] = [], threshold: number = CONFIG.sameStory): T[][] {
  const groups: T[][] = [];
  const members: { tokens: Set<string>; group: number }[] = [];
  const index = new Map<string, number[]>();
  const add = (tk: Set<string>, group: number) => {
    const id = members.push({ tokens: tk, group }) - 1;
    for (const t of tk) {
      const list = index.get(t);
      if (list) list.push(id);
      else index.set(t, [id]);
    }
  };
  for (const t of seenTitles) add(tokens(t), SEEN);

  for (const item of items) {
    const tk = tokens(item.title);
    let best: number | null = null;
    let bestScore = 0;
    const checked = new Set<number>();
    for (const t of tk) {
      for (const m of index.get(t) ?? []) {
        if (checked.has(m)) continue;
        checked.add(m);
        const s = jaccard(tk, members[m].tokens);
        if (s >= threshold && s > bestScore) {
          bestScore = s;
          best = members[m].group;
        }
      }
    }
    if (best === SEEN) continue;
    if (best === null) best = groups.push([]) - 1;
    groups[best].push(item);
    add(tk, best);
  }
  return groups;
}
