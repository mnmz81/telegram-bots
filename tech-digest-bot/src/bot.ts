import { Bot, type Context, type InlineKeyboard } from 'grammy';
import { CONFIG, type Env } from './config';
import { hoursAgo } from './dates';
import {
  activeMutes, addMute, addSource, allSources, deleteSource, digestItem, isSaved, logMessage, removeMute, savedItems, seedSources,
  setVote, takeLoggedMessages, toggleSaved, toggleSource, vote,
} from './db';
import { runDigest } from './digest';
import { expandItem } from './expand';
import { feedTitle, parseFeed } from './feeds';
import { GeminiError } from './gemini';
import {
  MENU_TEXT, cardKeyboard, cardText, esc, menuKeyboard, muteForKeyboard, muteTagsKeyboard, mutesScreen, savedScreen, sourcesScreen,
} from './messages';
import { logSent } from './telegram';
import { EmailError, sendWeekly } from './weekly';

export const isOwner = (fromId: number | undefined, ownerId: string): boolean =>
  fromId !== undefined && String(fromId) === ownerId;

const COMMANDS = [
  { command: 'menu', description: 'תפריט' },
  { command: 'now', description: 'סקירה עכשיו' },
  { command: 'saved', description: 'שמורים' },
  { command: 'sources', description: 'מקורות' },
  { command: 'muted', description: 'השתקות' },
  { command: 'weekly', description: 'מייל שבועי עכשיו' },
  { command: 'clear', description: 'ניקוי מסך' },
];
const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

export function createBot(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  now: () => Date = () => new Date(),
): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(logSent(env.DB, now));
  const at = () => now().toISOString();

  async function report(ctx: Context, err: unknown) {
    let text = 'שגיאה, נסו שוב';
    if (err instanceof GeminiError) text = `Gemini לא זמין כרגע (${err.message})`;
    else if (err instanceof EmailError) text = `שליחת המייל נכשלה (${err.message})`;
    else console.error('bot error', err);
    await ctx.reply(text).catch(() => {});
  }
  // slow work (Gemini, feeds, email) outlives the webhook response: answer Telegram first, finish in waitUntil
  const background = (ctx: Context, fn: () => Promise<unknown>) => waitUntil(fn().catch((err) => report(ctx, err)));
  bot.catch((err) => report(err.ctx, err.error));

  bot.use(async (ctx, next) => {
    if (!isOwner(ctx.from?.id, env.OWNER_ID)) return;
    if (ctx.message) await logMessage(env.DB, ctx.message.message_id, at());
    await next();
  });

  // a screen opened from a button replaces that message; from a command it is a new message
  async function show(ctx: Context, text: string, keyboard: InlineKeyboard) {
    if (ctx.callbackQuery?.message) {
      return ctx.editMessageText(text, { ...HTML, reply_markup: keyboard }).catch((err) => {
        if (!String(err).includes('message is not modified')) throw err;
      });
    }
    return ctx.reply(text, { ...HTML, reply_markup: keyboard });
  }
  // callback handler: answers the tap (optionally with a toast), then runs the body
  const onTap = (pattern: string | RegExp, fn: (ctx: Context & { match: RegExpMatchArray | string }) => Promise<unknown>, toast?: string) =>
    bot.callbackQuery(pattern, async (ctx) => {
      await ctx.answerCallbackQuery(toast ? { text: toast } : undefined);
      return fn(ctx);
    });

  // ---- menu

  bot.command('start', async (ctx) => {
    await ctx.api.setMyCommands(COMMANDS).catch(() => {});
    return ctx.reply(MENU_TEXT, { ...HTML, reply_markup: menuKeyboard() });
  });
  bot.command('menu', (ctx) => ctx.reply(MENU_TEXT, { ...HTML, reply_markup: menuKeyboard() }));
  onTap('m:new', (ctx) => ctx.reply(MENU_TEXT, { ...HTML, reply_markup: menuKeyboard() }));
  onTap('m:home', (ctx) => show(ctx, MENU_TEXT, menuKeyboard()));

  // ---- digest now

  const digestNow = (ctx: Context) =>
    background(ctx, async () => {
      if (!(await runDigest(env, ctx.api, now(), 'now'))) await ctx.reply('אין חדשות חדשות מאז הסקירה הקודמת');
    });
  bot.command('now', async (ctx) => {
    await ctx.reply('מכין סקירה…');
    digestNow(ctx);
  });
  onTap('m:now', async (ctx) => digestNow(ctx), 'מכין סקירה…');

  // ---- sources

  const showSources = async (ctx: Context) => {
    await seedSources(env.DB);
    const s = sourcesScreen(await allSources(env.DB));
    return show(ctx, s.text, s.keyboard);
  };
  bot.command('sources', showSources);
  onTap('m:src', showSources);
  onTap(/^st:(\d+)$/, async (ctx) => {
    await toggleSource(env.DB, Number(ctx.match[1]));
    return showSources(ctx);
  });
  onTap(/^sd:(\d+)$/, async (ctx) => {
    await deleteSource(env.DB, Number(ctx.match[1]));
    return showSources(ctx);
  });
  bot.command('addsource', async (ctx) => {
    const url = ctx.match.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return ctx.reply('שימוש: /addsource https://example.com/feed');
    background(ctx, async () => {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; tech-digest-bot)' }, signal: AbortSignal.timeout(10_000) });
      const xml = res.ok ? await res.text() : '';
      if (!parseFeed(xml, 3).length) return ctx.reply('לא מצאתי פיד RSS/Atom בכתובת הזו. נסו את כתובת ה-feed עצמה.');
      const name = feedTitle(xml)?.slice(0, 40) || new URL(url).hostname;
      const added = await addSource(env.DB, name, url);
      return ctx.reply(added ? `נוסף מקור: ${name}` : 'המקור הזה כבר קיים');
    });
  });

  // ---- mutes

  const showMutes = async (ctx: Context) => {
    const s = mutesScreen(await activeMutes(env.DB, at()));
    return show(ctx, s.text, s.keyboard);
  };
  bot.command('muted', showMutes);
  onTap('m:mut', showMutes);
  onTap(/^um:(\d+)$/, async (ctx) => {
    await removeMute(env.DB, Number(ctx.match[1]));
    return showMutes(ctx);
  });
  bot.command('mute', async (ctx) => {
    const word = ctx.match.trim();
    if (!word) return ctx.reply('שימוש: /mute מילה');
    await addMute(env.DB, word, null);
    return ctx.reply(`🔇 הושתק: ${word}`);
  });

  // ---- saved

  const showSaved = async (ctx: Context) => {
    const s = savedScreen(await savedItems(env.DB));
    return show(ctx, s.text, s.keyboard);
  };
  bot.command('saved', showSaved);
  onTap('m:saved', showSaved);
  onTap(/^us:(\d+)$/, async (ctx) => {
    if (await isSaved(env.DB, Number(ctx.match[1]))) await toggleSaved(env.DB, Number(ctx.match[1]), at());
    return showSaved(ctx);
  });

  // ---- weekly email now

  const weeklyNow = (ctx: Context) =>
    background(ctx, async () => {
      await sendWeekly(env, now());
      await ctx.reply('📧 המייל השבועי נשלח');
    });
  bot.command('weekly', async (ctx) => weeklyNow(ctx));
  onTap('m:weekly', async (ctx) => weeklyNow(ctx), 'שולח מייל…');

  // ---- clear screen (D1 data stays)

  const clearChat = (ctx: Context) =>
    background(ctx, async () => {
      const logged = await takeLoggedMessages(env.DB);
      const cutoff = hoursAgo(now(), CONFIG.clearWindowHours);
      const ids = logged.filter((m) => m.at > cutoff).map((m) => m.messageId);
      for (let i = 0; i < ids.length; i += 100) {
        await ctx.api.deleteMessages(env.OWNER_ID, ids.slice(i, i + 100)).catch((err) => console.error('deleteMessages', err));
      }
      const old = logged.length - ids.length;
      const note = old ? `\n\n<i>${old} הודעות בנות יותר מ-48 שעות נשארו: טלגרם לא מאפשר לבוט למחוק אותן.</i>` : '';
      await ctx.api.sendMessage(env.OWNER_ID, MENU_TEXT + note, { ...HTML, reply_markup: menuKeyboard() });
    });
  bot.command('clear', async (ctx) => clearChat(ctx));
  onTap('m:clear', async (ctx) => clearChat(ctx));

  // ---- item card

  async function loadItem(ctx: Context, id: string) {
    const it = await digestItem(env.DB, Number(id));
    if (!it) await ctx.reply('הפריט לא נמצא');
    return it;
  }
  const cardKb = async (id: number) => {
    const it = (await digestItem(env.DB, id))!;
    return cardKeyboard(it, await vote(env.DB, id), await isSaved(env.DB, id));
  };

  onTap(/^it:(\d+)$/, async (ctx) => {
    const it = await loadItem(ctx, ctx.match[1]);
    if (!it) return;
    return ctx.reply(cardText(it), { ...HTML, reply_markup: await cardKb(it.id) });
  });
  onTap(/^card:(\d+)$/, async (ctx) => {
    const it = await loadItem(ctx, ctx.match[1]);
    if (!it) return;
    return show(ctx, cardText(it), await cardKb(it.id));
  });
  // "back" on a card closes it: the digest it came from is right above
  onTap('x', (ctx) => ctx.deleteMessage().catch(() => {}));

  bot.callbackQuery(/^v:(\d+):(1|-1)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const v = await setVote(env.DB, id, Number(ctx.match[2]) as 1 | -1, at());
    await ctx.answerCallbackQuery({ text: v === 0 ? 'בוטל' : 'תודה, זה ישפיע על הסקירות הבאות' });
    return ctx.editMessageReplyMarkup({ reply_markup: await cardKb(id) }).catch(() => {});
  });
  bot.callbackQuery(/^sv:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const saved = await toggleSaved(env.DB, id, at());
    await ctx.answerCallbackQuery({ text: saved ? 'נשמר, יופיע גם במייל השבועי' : 'הוסר מהשמורים' });
    return ctx.editMessageReplyMarkup({ reply_markup: await cardKb(id) }).catch(() => {});
  });
  onTap(
    /^ex:(\d+)$/,
    async (ctx) => {
      const it = await loadItem(ctx, ctx.match[1]);
      if (!it) return;
      const replyTo = ctx.callbackQuery?.message?.message_id;
      background(ctx, async () => {
        const text = await expandItem(env, it);
        await ctx.reply(`🔍 <b>${esc(it.titleHe)}</b>\n${esc(text)}`, {
          ...HTML,
          ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
        });
      });
    },
    'מכין סיכום מורחב…',
  );

  onTap(/^mu:(\d+)$/, async (ctx) => {
    const it = await loadItem(ctx, ctx.match[1]);
    if (!it) return;
    if (!it.tags.length) return show(ctx, `${cardText(it)}\n\nאין נושאים לפריט הזה. להשתקה ידנית: <code>/mute מילה</code>`, muteTagsKeyboard(it));
    return show(ctx, `${cardText(it)}\n\n🔇 <b>מה להשתיק?</b>`, muteTagsKeyboard(it));
  });
  onTap(/^mt:(\d+):(\d+)$/, async (ctx) => {
    const it = await loadItem(ctx, ctx.match[1]);
    const tag = it?.tags[Number(ctx.match[2])];
    if (!it || !tag) return;
    return show(ctx, `${cardText(it)}\n\n🔇 להשתיק את <b>${esc(tag)}</b>?`, muteForKeyboard(it.id, Number(ctx.match[2])));
  });
  bot.callbackQuery(/^md:(\d+):(\d+):(f|w)$/, async (ctx) => {
    const it = await digestItem(env.DB, Number(ctx.match[1]));
    const tag = it?.tags[Number(ctx.match[2])];
    if (!it || !tag) return ctx.answerCallbackQuery();
    const week = ctx.match[3] === 'w';
    await addMute(env.DB, tag, week ? new Date(now().getTime() + 7 * 86_400_000).toISOString() : null);
    await ctx.answerCallbackQuery({ text: `🔇 ${tag} הושתק ${week ? 'לשבוע' : 'לתמיד'}` });
    return show(ctx, cardText(it), await cardKb(it.id));
  });

  return bot;
}
