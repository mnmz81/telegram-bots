import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot, isOwner } from '../src/bot';
import { activeMutes, allSources, isSaved, logMessage, saveDigest, seedSources, vote, type DigestItem } from '../src/db';
import { e, geminiAnswer, mockFetch, resetDb, telegram } from './helpers';

const NOW = () => new Date('2026-10-24T10:00:00Z');
const chat = { id: 1, type: 'private' };
const user = (id: number) => ({ id, is_bot: false, first_name: 'x' });
const command = (from: number, text: string, messageId = 1) => ({
  update_id: 1,
  message: { message_id: messageId, date: 0, chat, from: user(from), text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] },
});
const tap = (data: string, from = 1) => ({
  update_id: 1,
  callback_query: { id: 'c', from: user(from), chat_instance: 'x', data, message: { message_id: 50, date: 0, chat, text: 'screen' } },
});

let f: ReturnType<typeof mockFetch>;
const pending: Promise<unknown>[] = [];
async function send(update: object) {
  const bot = createBot(e, (p) => pending.push(p), NOW);
  await bot.init();
  await bot.handleUpdate(update as any);
  await Promise.all(pending.splice(0));
}
const buttons = (body: any): string[] => (body?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data);
const lastOf = (method: string) => telegram(f, method).at(-1);

let item: DigestItem;
beforeEach(async () => {
  await resetDb();
  f = mockFetch();
  [item] = await saveDigest(env.DB, 'scheduled', [{
    url: 'https://a.test/1', title: 'OpenAI ships GPT-6', snippet: 'snip', sources: 'The Verge +1', coverage: 2,
    titleHe: 'OpenAI משיקה את GPT-6', summaryHe: 'תקציר', category: 'ai', tags: ['OpenAI', 'GPT-6'], importance: 5,
  }], NOW().toISOString());
});
afterEach(() => vi.unstubAllGlobals());

describe('owner only', () => {
  it('accepts only the configured user id', () => {
    expect(isOwner(1, '1')).toBe(true);
    expect(isOwner(2, '1')).toBe(false);
    expect(isOwner(undefined, '1')).toBe(false);
  });
  it('ignores everyone else', async () => {
    await send(command(2, '/menu'));
    expect(telegram(f, 'sendMessage')).toHaveLength(0);
  });
});

describe('menu', () => {
  it('/start installs the commands and shows the menu', async () => {
    await send(command(1, '/start'));
    expect(telegram(f, 'setMyCommands')).toHaveLength(1);
    expect(buttons(lastOf('sendMessage'))).toEqual(['m:now', 'm:saved', 'm:src', 'm:mut', 'm:weekly', 'm:clear']);
  });

  it('sub-screens edit the same message and lead back to the menu', async () => {
    for (const screen of ['m:src', 'm:mut', 'm:saved']) {
      await send(tap(screen));
      const edit = lastOf('editMessageText');
      expect(edit.message_id).toBe(50);
      expect(buttons(edit).at(-1)).toBe('m:home');
    }
    await send(tap('m:home'));
    expect(buttons(lastOf('editMessageText'))).toContain('m:now');
  });
});

describe('item card', () => {
  it('opens from a number button with feedback, save, expand, mute and close', async () => {
    await send(tap(`it:${item.id}`));
    const card = lastOf('sendMessage');
    expect(card.text).toContain('OpenAI משיקה את GPT-6');
    expect(buttons(card)).toEqual([`v:${item.id}:1`, `v:${item.id}:-1`, `sv:${item.id}`, `ex:${item.id}`, `mu:${item.id}`, 'x']);
  });

  it('votes toggle and show a check mark', async () => {
    await send(tap(`v:${item.id}:1`));
    expect(await vote(env.DB, item.id)).toBe(1);
    expect(lastOf('editMessageReplyMarkup').reply_markup.inline_keyboard[0][0].text).toBe('👍 ✓');
    await send(tap(`v:${item.id}:-1`));
    expect(await vote(env.DB, item.id)).toBe(-1);
    await send(tap(`v:${item.id}:-1`));
    expect(await vote(env.DB, item.id)).toBe(0);
  });

  it('saves and lists the item, and removes it from the saved screen', async () => {
    await send(tap(`sv:${item.id}`));
    expect(await isSaved(env.DB, item.id)).toBe(true);
    await send(command(1, '/saved'));
    expect(lastOf('sendMessage').text).toContain('OpenAI משיקה את GPT-6');
    await send(tap(`us:${item.id}`));
    expect(await isSaved(env.DB, item.id)).toBe(false);
  });

  it('mute flow: tag, then duration, then back to the card', async () => {
    await send(tap(`mu:${item.id}`));
    expect(buttons(lastOf('editMessageText'))).toEqual([`mt:${item.id}:0`, `mt:${item.id}:1`, `card:${item.id}`]);
    await send(tap(`mt:${item.id}:1`));
    expect(buttons(lastOf('editMessageText'))).toEqual([`md:${item.id}:1:f`, `md:${item.id}:1:w`, `mu:${item.id}`]);
    await send(tap(`md:${item.id}:1:w`));
    const [m] = await activeMutes(env.DB, NOW().toISOString());
    expect(m.word).toBe('gpt-6');
    expect(m.until!.slice(0, 10)).toBe('2026-10-31');
    expect(buttons(lastOf('editMessageText'))).toContain(`sv:${item.id}`);
  });

  it('back on a card deletes it', async () => {
    await send(tap('x'));
    expect(lastOf('deleteMessage').message_id).toBe(50);
  });

  it('expand fetches the article, asks Gemini once and caches the answer', async () => {
    f = mockFetch(
      (u) => (u === 'https://a.test/1' ? new Response(`<html><script>x()</script><article><p>${'Body text. '.repeat(50)}</p></article></html>`) : undefined),
      (u, init) => {
        if (!u.includes('generativelanguage')) return;
        expect(String(init!.body)).toContain('Body text.');
        expect(String(init!.body)).not.toContain('x()');
        return geminiAnswer('**סיכום** מורחב');
      },
    );
    await send(tap(`ex:${item.id}`));
    await send(tap(`ex:${item.id}`));
    expect(telegram(f, 'sendMessage').map((m) => m.text)).toEqual(Array(2).fill('🔍 <b>OpenAI משיקה את GPT-6</b>\nסיכום מורחב'));
    expect(f.mock.calls.filter(([u]) => String(u).includes('generativelanguage'))).toHaveLength(1);
  });
});

describe('sources', () => {
  it('toggles a built-in source; only custom sources can be deleted', async () => {
    await send(command(1, '/sources'));
    const [s] = await allSources(env.DB);
    expect(buttons(lastOf('sendMessage'))).not.toContain(`sd:${s.id}`);
    await send(tap(`st:${s.id}`));
    expect((await allSources(env.DB))[0].enabled).toBe(false);
  });

  it('/addsource validates the feed before saving', async () => {
    f = mockFetch((u) =>
      u === 'https://blog.test/feed'
        ? new Response('<rss><channel><title>My Blog</title><item><title>Hi</title><link>https://blog.test/1</link></item></channel></rss>')
        : u === 'https://blog.test/page' ? new Response('<html>no feed</html>') : undefined,
    );
    await send(command(1, '/addsource https://blog.test/page'));
    expect(lastOf('sendMessage').text).toContain('לא מצאתי');
    await send(command(1, '/addsource https://blog.test/feed'));
    expect(lastOf('sendMessage').text).toBe('נוסף מקור: My Blog');
    await seedSources(env.DB);
    const custom = (await allSources(env.DB)).find((s) => s.name === 'My Blog')!;
    await send(command(1, '/sources'));
    expect(buttons(lastOf('sendMessage'))).toContain(`sd:${custom.id}`);
    await send(tap(`sd:${custom.id}`));
    expect((await allSources(env.DB)).some((s) => s.name === 'My Blog')).toBe(false);
  });
});

describe('/clear', () => {
  it('deletes recent messages in batches of 100, keeps data, reports what is too old', async () => {
    const recent = new Date(NOW().getTime() - 3_600_000).toISOString();
    for (let id = 1000; id < 1150; id++) await logMessage(env.DB, id, recent);
    await logMessage(env.DB, 7, '2026-10-20T00:00:00.000Z');
    await send(command(1, '/clear', 2000));
    const batches = telegram(f, 'deleteMessages').map((b) => b.message_ids.length);
    expect(batches).toEqual([100, 51]); // 150 logged + the /clear message itself
    const menu = lastOf('sendMessage');
    expect(menu.text).toContain('1 הודעות בנות יותר מ-48 שעות נשארו');
    expect(buttons(menu)).toContain('m:clear');
    // the digest data is untouched
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM digest_items').first('n')).toBe(1);
    // only the new menu remains logged, ready for the next /clear
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM chat_messages').first('n')).toBe(1);
  });
});

describe('/now', () => {
  it('says so when there is nothing new', async () => {
    await send(command(1, '/now'));
    expect(lastOf('sendMessage').text).toBe('אין חדשות חדשות מאז הסקירה הקודמת');
  });
});
