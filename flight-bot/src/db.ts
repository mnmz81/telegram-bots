export type Tracked = {
  id: number;
  dest: string;
  out: string;
  ret: string;
  outKey: string;
  retKey: string;
  label: string;
  status: 'active' | 'stopped';
};
export type Check = { chosenPrice: number | null; cheapestPrice: number | null; cheapestLabel: string | null };

export async function activeTracked(db: D1Database): Promise<Tracked[]> {
  const { results } = await db
    .prepare(`SELECT id, dest, out, ret, out_key, ret_key, label, status FROM tracked WHERE status = 'active' ORDER BY id`)
    .all<Record<string, any>>();
  return results.map((r) => ({
    id: r.id, dest: r.dest, out: r.out, ret: r.ret, outKey: r.out_key, retKey: r.ret_key, label: r.label, status: r.status,
  }));
}

export async function addTracked(
  db: D1Database,
  t: Omit<Tracked, 'id' | 'status'>,
  baseline: Check,
  at: string,
): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO tracked (dest, out, ret, out_key, ret_key, label) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(t.dest, t.out, t.ret, t.outKey, t.retKey, t.label)
    .first<{ id: number }>();
  await addCheck(db, row!.id, baseline, at);
  return row!.id;
}

export const stopTracked = (db: D1Database, id: number) =>
  db.prepare(`UPDATE tracked SET status = 'stopped' WHERE id = ?`).bind(id).run();

export const stopAll = (db: D1Database) => db.prepare(`UPDATE tracked SET status = 'stopped'`).run();

export const stopExpired = (db: D1Database, today: string) =>
  db.prepare(`UPDATE tracked SET status = 'stopped' WHERE status = 'active' AND out <= ?`).bind(today).run();

export async function lastCheck(db: D1Database, trackedId: number): Promise<Check | null> {
  const r = await db
    .prepare(
      `SELECT chosen_price, cheapest_price, cheapest_label FROM price_points WHERE tracked_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(trackedId)
    .first<Record<string, any>>();
  return r ? { chosenPrice: r.chosen_price, cheapestPrice: r.cheapest_price, cheapestLabel: r.cheapest_label } : null;
}

export const addCheck = (db: D1Database, trackedId: number, c: Check, at: string) =>
  db
    .prepare(`INSERT INTO price_points (tracked_id, at, chosen_price, cheapest_price, cheapest_label) VALUES (?, ?, ?, ?, ?)`)
    .bind(trackedId, at, c.chosenPrice, c.cheapestPrice, c.cheapestLabel)
    .run();

export async function history(db: D1Database, trackedId: number): Promise<{ at: string; chosenPrice: number | null }[]> {
  const { results } = await db
    .prepare(`SELECT at, chosen_price FROM price_points WHERE tracked_id = ? ORDER BY id`)
    .bind(trackedId)
    .all<{ at: string; chosen_price: number | null }>();
  return results.map((r) => ({ at: r.at, chosenPrice: r.chosen_price }));
}

export async function saveOption(db: D1Database, payload: unknown, at: string): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO options (payload, at) VALUES (?, ?) RETURNING id`)
    .bind(JSON.stringify(payload), at)
    .first<{ id: number }>();
  return row!.id;
}

export async function loadOption<T>(db: D1Database, id: number): Promise<T | null> {
  const row = await db.prepare(`SELECT payload FROM options WHERE id = ?`).bind(id).first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as T) : null;
}

// atomic read-and-delete: a double tap on the same button gets the payload once
export async function takeOption<T>(db: D1Database, id: number): Promise<T | null> {
  const row = await db.prepare(`DELETE FROM options WHERE id = ? RETURNING payload`).bind(id).first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as T) : null;
}

export const pruneOptions = (db: D1Database, before: string) =>
  db.prepare(`DELETE FROM options WHERE at < ?`).bind(before).run();

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM kv WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export const kvSet = (db: D1Database, key: string, value: string | null) =>
  value === null
    ? db.prepare(`DELETE FROM kv WHERE key = ?`).bind(key).run()
    : db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();

// flight numbers the owner hid (e.g. a night flight); applied to every search, so tracking ignores them too
export async function blockedFlights(db: D1Database): Promise<string[]> {
  return JSON.parse((await kvGet(db, 'blocked')) ?? '[]');
}

export async function setBlocked(db: D1Database, flightNumber: string, blocked: boolean): Promise<void> {
  const list = new Set(await blockedFlights(db));
  if (blocked) list.add(flightNumber);
  else list.delete(flightNumber);
  await kvSet(db, 'blocked', JSON.stringify([...list]));
}
