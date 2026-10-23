import { Bot, InlineKeyboard, type Context } from 'grammy';
import { CONFIG, type Env } from './config';
import { isClosed, israelNow, monthOptions, weekendPairs, type DatePair, type Pattern } from './dates';
import {
  activeTracked, addTracked, blockedFlights, history, kvGet, kvSet, lastCheck, loadOption, replaceOption, saveOption, setBlocked,
  stopAll, stopTracked, takeOption,
} from './db';
import { closedText, expiredText, fmtLeg, fmtPair, fmtPrice, trackedKeyboard } from './messages';
import { getProfile, ConfigError } from './profile';
import { needsConfirm } from './quota';
import {
  SearchClosedError, SerpApiError, blockKey, legKey, searchPairs, searchReturns, searchesLeft, searchesUsed,
  type Leg, type Option, type SearchResult,
} from './serpapi';

export const isOwner = (fromId: number | undefined, ownerId: string): boolean =>
  fromId !== undefined && String(fromId) === ownerId;

type MonthSearch = { dest: string; pairs: DatePair[] };
// back: id of the saved screen (text + keyboard) the "⬅️ חזרה" button re-sends, so going back costs no search
type PairView = { dest: string; pair: DatePair; result: SearchResult; back?: number };
type OutboundPick = { dest: string; pair: DatePair; outbound: Option; cheapest: Option; back?: number };
type Screen = { text: string; keyboard: InlineKeyboard['inline_keyboard'] };
type WantPick = OutboundPick & { ret: Option };

const PATTERN_LABELS: Record<Pattern, string> = { thu: 'חמישי–שני', wed: 'רביעי–שני', both: 'שניהם' };
const bagNote = (o: Option) => (o.bagExtra ? ' · מזוודה בתשלום' : '');
const BACK = '⬅️ חזרה';
const COMMANDS = [
  { command: 'search', description: 'חיפוש טיסות' },
  { command: 'tracking', description: 'הטיסות במעקב' },
  { command: 'quota', description: 'מכסת חיפושים' },
  { command: 'blocked', description: 'טיסות מוסתרות' },
];

export function createBot(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  now: () => Date = () => new Date(),
): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const at = () => now().toISOString();

  async function report(ctx: Context, err: unknown) {
    let text = 'שגיאה, נסו שוב';
    if (err instanceof SearchClosedError) text = closedText();
    else if (err instanceof SerpApiError || err instanceof ConfigError) text = err.message;
    else console.error('bot error', err);
    await ctx.reply(text).catch(() => {});
  }
  // searches outlive the webhook response: answer Telegram first, send results from waitUntil
  const background = (ctx: Context, fn: () => Promise<unknown>) => waitUntil(fn().catch((err) => report(ctx, err)));
  // Telegram has no disabled buttons: removing the keyboard is the instant "disable"
  const disable = (ctx: Context) => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  bot.catch((err) => report(err.ctx, err.error));

  bot.use(async (ctx, next) => {
    if (!isOwner(ctx.from?.id, env.OWNER_ID)) return;
    await next();
  });

  async function showDestinations(ctx: Context) {
    if (isClosed(now())) return ctx.reply(closedText());
    const kb = new InlineKeyboard();
    for (const f of getProfile(env).favorites) kb.text(f.name, `dst:${f.code}`).row();
    kb.text('אחר', 'dst:other').row().text('📋 המעקבים שלי', 'menu:tracking');
    return ctx.reply('לאן טסים?', { reply_markup: kb });
  }
  bot.command('start', async (ctx) => {
    await ctx.api.setMyCommands(COMMANDS).catch(() => {});
    return showDestinations(ctx);
  });
  bot.command('search', showDestinations);
  bot.callbackQuery('menu:start', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showDestinations(ctx);
  });
  bot.callbackQuery('menu:tracking', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showTracking(ctx);
  });
  bot.callbackQuery(/^screen:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const screen = await loadOption<Screen>(env.DB, Number(ctx.match[1]));
    if (!screen?.text) return ctx.reply(expiredText());
    return ctx.reply(screen.text, { reply_markup: { inline_keyboard: screen.keyboard } });
  });

  async function showMonths(ctx: Context, dest: string) {
    const months = monthOptions(now());
    if (!months.length) return ctx.reply(closedText());
    const kb = new InlineKeyboard();
    for (const m of months) kb.text(`${m.slice(5)}.${m.slice(0, 4)}`, `mon:${dest}:${m}`).row();
    kb.text(BACK, 'menu:start');
    return ctx.reply('איזה חודש?', { reply_markup: kb });
  }

  bot.callbackQuery(/^dst:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === 'other') {
      await kvSet(env.DB, 'await_iata', '1');
      return ctx.reply('כתבו קוד שדה תעופה בן 3 אותיות, למשל JFK');
    }
    return showMonths(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^mon:([A-Z]{3}):(\d{4}-\d{2})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    for (const p of Object.keys(PATTERN_LABELS) as Pattern[]) {
      kb.text(PATTERN_LABELS[p], `pat:${ctx.match[1]}:${ctx.match[2]}:${p}`).row();
    }
    kb.text(BACK, `dst:${ctx.match[1]}`);
    return ctx.reply('אילו ימים?', { reply_markup: kb });
  });

  bot.callbackQuery(/^pat:([A-Z]{3}):(\d{4}-\d{2}):(thu|wed|both)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, dest, month, pattern] = ctx.match;
    const pairs = weekendPairs(month, pattern as Pattern, israelNow(now()).date);
    if (!pairs.length) return ctx.reply('אין סופ"שים מתאימים בחודש הזה');
    const left = await searchesLeft(env, now());
    const id = await saveOption(env.DB, { dest, pairs } satisfies MonthSearch, at());
    const warn = needsConfirm(left, pairs.length) ? `\n⚠️ זה יוריד אותך מתחת לרזרבה (${CONFIG.quotaReserve})` : '';
    return ctx.reply(`החיפוש יעלה ${pairs.length} חיפושים, נשארו ${left}.${warn}`, {
      reply_markup: new InlineKeyboard().text('חפש', `go:${id}`).row().text(BACK, `mon:${dest}:${month}`),
    });
  });

  bot.callbackQuery(/^go:(\d+)$/, async (ctx) => {
    await Promise.all([ctx.answerCallbackQuery(), disable(ctx)]);
    const job = await takeOption<MonthSearch>(env.DB, Number(ctx.match[1]));
    if (!job) return ctx.reply(expiredText());
    background(ctx, async () => {
      const results = await searchPairs(env, job.dest, job.pairs, now());
      const screenId = await saveOption(env.DB, {}, at());
      const kb = new InlineKeyboard();
      const lines: string[] = [];
      for (const [i, pair] of job.pairs.entries()) {
        const result = results[i];
        const best = result?.options[0];
        if (!result) lines.push(`${fmtPair(pair)} · החיפוש נכשל`);
        else if (!best) lines.push(`${fmtPair(pair)} · אין טיסה ישירה בשעות`);
        else {
          const row = `${fmtPair(pair)} · ${fmtPrice(best.price)} · ${fmtLeg(best.leg)}`;
          lines.push(row);
          const id = await saveOption(env.DB, { dest: job.dest, pair, result, back: screenId } satisfies PairView, at());
          kb.text(row, `pair:${id}`).row();
        }
      }
      kb.text(BACK, `mon:${job.dest}:${job.pairs[0].out.slice(0, 7)}`);
      const text = lines.join('\n');
      await replaceOption(env.DB, screenId, { text, keyboard: kb.inline_keyboard } satisfies Screen);
      await ctx.reply(text, { reply_markup: kb });
    });
  });

  bot.callbackQuery(/^pair:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await loadOption<PairView>(env.DB, Number(ctx.match[1]));
    if (!view) return ctx.reply(expiredText());
    const screenId = await saveOption(env.DB, {}, at());
    const kb = new InlineKeyboard();
    for (const outbound of view.result.options.filter((o) => o.departureToken)) {
      const id = await saveOption(
        env.DB,
        { dest: view.dest, pair: view.pair, outbound, cheapest: view.result.options[0], back: screenId } satisfies OutboundPick,
        at(),
      );
      kb.text(`${fmtLeg(outbound.leg)} · מ־${fmtPrice(outbound.price)}${bagNote(outbound)}`, `out:${id}`).row();
    }
    await addHideButton(kb, view.result.options.map((o) => o.leg));
    if (view.result.googleUrl) kb.url('Google Flights', view.result.googleUrl);
    if (view.back) kb.row().text(BACK, `screen:${view.back}`);
    const text = `${fmtPair(view.pair)} · טיסות הלוך`;
    await replaceOption(env.DB, screenId, { text, keyboard: kb.inline_keyboard } satisfies Screen);
    return ctx.reply(text, { reply_markup: kb });
  });

  async function openReturns(ctx: Context, id: number) {
    const pick = await loadOption<OutboundPick>(env.DB, id);
    if (!pick) return ctx.reply(expiredText());
    background(ctx, async () => {
      const rets = await searchReturns(env, pick.dest, pick.pair, pick.outbound.departureToken!, now());
      if (!rets.options.length) return ctx.reply('אין טיסות חזור ישירות בשעות המתאימות');
      const kb = new InlineKeyboard();
      for (const ret of rets.options) {
        const wantId = await saveOption(env.DB, { ...pick, ret } satisfies WantPick, at());
        kb.text(`${fmtLeg(ret.leg)} · ${fmtPrice(ret.price)}${bagNote(ret)}`, `want:${wantId}`).row();
      }
      await addHideButton(kb, rets.options.map((o) => o.leg));
      if (rets.googleUrl) kb.url('Google Flights', rets.googleUrl);
      if (pick.back) kb.row().text(BACK, `screen:${pick.back}`);
      await ctx.reply(`${fmtPair(pick.pair)} · בחרו טיסת חזור ולחצו "אני רוצה את זה"`, { reply_markup: kb });
    });
  }

  bot.callbackQuery(/^out:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]);
    const left = await searchesLeft(env, now());
    if (!needsConfirm(left, 1)) return openReturns(ctx, id);
    return ctx.reply(`נשארו ${left} חיפושים, להמשיך?`, { reply_markup: new InlineKeyboard().text('כן', `outgo:${id}`) });
  });
  bot.callbackQuery(/^outgo:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    return openReturns(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^want:(\d+)$/, async (ctx) => {
    await Promise.all([ctx.answerCallbackQuery(), disable(ctx)]);
    const pick = await takeOption<WantPick>(env.DB, Number(ctx.match[1]));
    if (!pick) return ctx.reply(expiredText());
    const active = await activeTracked(env.DB);
    if (active.length >= CONFIG.maxTracked) {
      const kb = new InlineKeyboard();
      for (const t of active) kb.text(`עצור: ${t.label}`, `stop:${t.id}`).row();
      return ctx.reply(`כבר עוקבים אחרי ${CONFIG.maxTracked} טיסות. עצרו אחת כדי להוסיף.`, { reply_markup: kb });
    }
    const label = `${fmtPair(pick.pair)} · ${fmtLeg(pick.outbound.leg)} / ${fmtLeg(pick.ret.leg)}`;
    const id = await addTracked(
      env.DB,
      { dest: pick.dest, out: pick.pair.out, ret: pick.pair.ret, outKey: legKey(pick.outbound.leg), retKey: legKey(pick.ret.leg), label },
      { chosenPrice: pick.ret.price, cheapestPrice: pick.cheapest.price, cheapestLabel: fmtLeg(pick.cheapest.leg) },
      at(),
    );
    return ctx.reply(`✅ מתחיל לעקוב: ${label}, ${fmtPrice(pick.ret.price)}`, { reply_markup: trackedKeyboard(id) });
  });

  bot.callbackQuery(/^stop:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await stopTracked(env.DB, Number(ctx.match[1]));
    return ctx.reply('הפסקתי לעקוב');
  });
  bot.callbackQuery('booked', async (ctx) => {
    await ctx.answerCallbackQuery();
    await stopAll(env.DB);
    return ctx.reply('סגרת טיסה, כל המעקבים נעצרו');
  });

  // one button under a flight list opens a hide menu; a 🚫 on every row would squeeze the flight labels
  async function addHideButton(kb: InlineKeyboard, legs: Leg[]) {
    if (!legs.length) return;
    const id = await saveOption(env.DB, { legs }, at());
    kb.text('🚫 להסתיר טיסה', `hidemenu:${id}`).row();
  }

  bot.callbackQuery(/^hidemenu:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const menu = await loadOption<{ legs: Leg[] }>(env.DB, Number(ctx.match[1]));
    if (!menu) return ctx.reply(expiredText());
    const kb = new InlineKeyboard();
    for (const leg of menu.legs) kb.text(`🚫 ${fmtLeg(leg)}`, `hide:${blockKey(leg)}`).row();
    return ctx.reply('איזו טיסה להסתיר? היא לא תופיע יותר בחיפושים ובמעקב.', { reply_markup: kb });
  });

  bot.callbackQuery(/^hide:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setBlocked(env.DB, ctx.match[1], true);
    return ctx.reply(`הטיסה ${ctx.match[1]} הוסתרה. להחזרה: /blocked`);
  });

  bot.callbackQuery(/^unhide:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setBlocked(env.DB, ctx.match[1], false);
    return ctx.reply(`הטיסה ${ctx.match[1]} חזרה לחיפושים`);
  });

  bot.command('blocked', async (ctx) => {
    const list = await blockedFlights(env.DB);
    if (!list.length) return ctx.reply('אין טיסות מוסתרות');
    const kb = new InlineKeyboard();
    for (const f of list) kb.text(`↩️ ${f}`, `unhide:${f}`).row();
    return ctx.reply('טיסות מוסתרות (לחיצה מחזירה):', { reply_markup: kb });
  });

  bot.command('tracking', (ctx) => showTracking(ctx));
  async function showTracking(ctx: Context) {
    const active = await activeTracked(env.DB);
    if (!active.length) return ctx.reply('אין מעקבים');
    for (const t of active) {
      const prices = (await history(env.DB, t.id)).map((h) => (h.chosenPrice === null ? '—' : fmtPrice(h.chosenPrice)));
      const current = (await lastCheck(env.DB, t.id))?.chosenPrice;
      await ctx.reply(`${t.label}\nעכשיו: ${current == null ? '—' : fmtPrice(current)}\n${prices.join(' → ')}`, {
        reply_markup: trackedKeyboard(t.id),
      });
    }
  }

  bot.command('quota', async (ctx) => {
    const [left, used] = await Promise.all([searchesLeft(env, now()), searchesUsed(env, now())]);
    return ctx.reply(`נשארו ${left} חיפושים החודש. נוצלו ${used} לפי הספירה שלי (רזרבה: ${CONFIG.quotaReserve})`);
  });

  // last on purpose: a text handler that does not call next() would swallow every command registered after it
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!(await kvGet(env.DB, 'await_iata')) || !/^[A-Za-z]{3}$/.test(text)) return;
    await kvSet(env.DB, 'await_iata', null);
    return showMonths(ctx, text.toUpperCase());
  });

  return bot;
}
