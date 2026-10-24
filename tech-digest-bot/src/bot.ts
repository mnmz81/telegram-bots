import { Bot, type Context, type InlineKeyboard } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { CONFIG, type Env } from './config';
import { hoursAgo } from './dates';
import {
  activeMutes, addMute, allSources, isSaved, itemState, kvGet, kvSet, logMessage, removeMute, savedItems, seedSources, setVote,
  takeLoggedMessages, toggleSaved, toggleSource,
} from './db';
import { runDigest } from './digest';
import { expandItem } from './expand';
import { GeminiError } from './gemini';
import {
  MENU_TEXT, cardText, cardView, esc, homeKeyboard, menuKeyboard, muteForKeyboard, muteTagsKeyboard, mutesScreen, savedScreen,
  sourcesScreen,
} from './messages';
import { logSent } from './telegram';
import { EmailError, sendWeekly } from './weekly';

export const isOwner = (fromId: number | undefined, ownerId: string): boolean =>
  fromId !== undefined && String(fromId) === ownerId;

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

// getMe once per Worker isolate, not on every webhook request: it made taps feel unresponsive
let cachedBotInfo: UserFromGetMe | undefined;

export function createBot(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  now: () => Date = () => new Date(),
): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, cachedBotInfo ? { botInfo: cachedBotInfo } : {});
  bot.api.config.use(logSent(env.DB, now));
  const at = () => now().toISOString();

  async function report(ctx: Context, err: unknown) {
    let text = 'שגיאה, נסו שוב';
    if (err instanceof GeminiError) text = `Gemini לא זמין כרגע:\n${err.message}`;
    else if (err instanceof EmailError) text = `שליחת המייל נכשלה (${err.message})`;
    else console.error('bot error', err);
    await ctx.reply(text).catch(() => {});
  }
  // slow work (Gemini, email) outlives the webhook response: answer Telegram first, finish in waitUntil
  const background = (ctx: Context, fn: () => Promise<unknown>) => waitUntil(fn().catch((err) => report(ctx, err)));
  bot.catch((err) => report(err.ctx, err.error));

  bot.use(async (ctx, next) => {
    cachedBotInfo ??= ctx.me;
    if (!isOwner(ctx.from?.id, env.OWNER_ID)) return;
    if (ctx.message) await logMessage(env.DB, ctx.message.message_id, at());
    await next();
  });

  // a screen opened from a button replaces that message; otherwise it is a new message
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

  // ---- menu: buttons only. Anything sent to the bot (/start, the 🏠 button, text, files) is deleted and answered
  // with the menu; the first time it also installs the persistent 🏠 button

  // one menu in the chat: a new one replaces the last
  async function sendMenu(ctx: Context, note = '') {
    const old = await kvGet(env.DB, 'menu_msg');
    const [sent] = await Promise.all([
      ctx.api.sendMessage(env.OWNER_ID, MENU_TEXT + note, { ...HTML, reply_markup: menuKeyboard() }),
      old ? ctx.api.deleteMessage(env.OWNER_ID, Number(old)).catch(() => {}) : null,
    ]);
    await kvSet(env.DB, 'menu_msg', String(sent.message_id));
  }
  bot.on('message', async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    if (!(await kvGet(env.DB, 'welcomed'))) {
      await ctx.api.deleteMyCommands().catch(() => {});
      await ctx.reply('הבוט עובד בכפתורים בלבד. הכפתור 🏠 למטה פותח את התפריט.', { reply_markup: homeKeyboard() });
      await kvSet(env.DB, 'welcomed', '1');
    }
    return sendMenu(ctx);
  });
  onTap('m:new', (ctx) => sendMenu(ctx));
  onTap('m:home', (ctx) => show(ctx, MENU_TEXT, menuKeyboard()));

  onTap(
    'm:now',
    async (ctx) =>
      background(ctx, async () => {
        if (!(await runDigest(env, ctx.api, now(), 'now'))) await ctx.reply('אין חדשות חדשות מאז הסקירה הקודמת');
      }),
    'מכין סקירה…',
  );

  // ---- sources

  const showSources = async (ctx: Context) => {
    await seedSources(env.DB);
    const s = sourcesScreen(await allSources(env.DB));
    return show(ctx, s.text, s.keyboard);
  };
  onTap('m:src', showSources);
  onTap(/^st:(\d+)$/, async (ctx) => {
    await toggleSource(env.DB, Number(ctx.match[1]));
    return showSources(ctx);
  });

  // ---- mutes

  const showMutes = async (ctx: Context) => {
    const s = mutesScreen(await activeMutes(env.DB, at()));
    return show(ctx, s.text, s.keyboard);
  };
  onTap('m:mut', showMutes);
  onTap(/^um:(\d+)$/, async (ctx) => {
    await removeMute(env.DB, Number(ctx.match[1]));
    return showMutes(ctx);
  });

  // ---- saved

  const showSaved = async (ctx: Context) => {
    const s = savedScreen(await savedItems(env.DB));
    return show(ctx, s.text, s.keyboard);
  };
  onTap('m:saved', showSaved);
  onTap(/^us:(\d+)$/, async (ctx) => {
    if (await isSaved(env.DB, Number(ctx.match[1]))) await toggleSaved(env.DB, Number(ctx.match[1]), at());
    return showSaved(ctx);
  });

  // ---- weekly email now

  onTap(
    'm:weekly',
    async (ctx) =>
      background(ctx, async () => {
        await sendWeekly(env, now(), 'tap');
        await ctx.reply('📧 המייל השבועי נשלח');
      }),
    'שולח מייל…',
  );

  // ---- clear screen (D1 data stays)

  onTap('m:clear', async (ctx) =>
    background(ctx, async () => {
      const logged = await takeLoggedMessages(env.DB);
      const cutoff = hoursAgo(now(), CONFIG.clearWindowHours);
      const ids = logged.filter((m) => m.at > cutoff).map((m) => m.messageId);
      for (let i = 0; i < ids.length; i += 100) {
        await ctx.api.deleteMessages(env.OWNER_ID, ids.slice(i, i + 100)).catch((err) => console.error('deleteMessages', err));
      }
      const old = logged.length - ids.length;
      const note = old ? `\n\n<i>${old} הודעות בנות יותר מ-48 שעות נשארו: טלגרם לא מאפשר לבוט למחוק אותן.</i>` : '';
      await sendMenu(ctx, note);
    }),
  );

  // ---- item card

  async function load(ctx: Context, id: string) {
    const s = await itemState(env.DB, Number(id));
    if (!s) await ctx.reply('הפריט לא נמצא');
    return s;
  }

  // only one card is open at a time: a new one replaces the last, so repeated taps never stack copies
  onTap(
    /^it:(\d+)$/,
    async (ctx) => {
      const [s, open] = await Promise.all([load(ctx, ctx.match[1]), kvGet(env.DB, 'open_card')]);
      if (!s) return;
      const v = cardView(s);
      const [sent] = await Promise.all([
        ctx.reply(v.text, { ...HTML, reply_markup: v.keyboard }),
        open ? ctx.api.deleteMessage(env.OWNER_ID, Number(open)).catch(() => {}) : null,
      ]);
      await kvSet(env.DB, 'open_card', String(sent.message_id));
    },
    'פותח…',
  );
  onTap(/^card:(\d+)$/, async (ctx) => {
    const s = await load(ctx, ctx.match[1]);
    if (!s) return;
    const v = cardView(s);
    return show(ctx, v.text, v.keyboard);
  });
  // "back" on a card closes it: the digest it came from is right above
  onTap('x', (ctx) => ctx.deleteMessage().catch(() => {}));

  const refreshButtons = async (ctx: Context, id: number) => {
    const s = await itemState(env.DB, id);
    if (s) await ctx.editMessageReplyMarkup({ reply_markup: cardView(s).keyboard }).catch(() => {});
  };
  bot.callbackQuery(/^v:(\d+):(1|-1)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const v = await setVote(env.DB, id, Number(ctx.match[2]) as 1 | -1, at());
    await ctx.answerCallbackQuery({ text: v === 0 ? 'בוטל' : 'תודה, זה ישפיע על הסקירות הבאות' });
    return refreshButtons(ctx, id);
  });
  bot.callbackQuery(/^sv:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const saved = await toggleSaved(env.DB, id, at());
    await ctx.answerCallbackQuery({ text: saved ? 'נשמר, יופיע גם במייל השבועי' : 'הוסר מהשמורים' });
    return refreshButtons(ctx, id);
  });
  onTap(
    /^ex:(\d+)$/,
    async (ctx) => {
      const s = await load(ctx, ctx.match[1]);
      if (!s) return;
      const replyTo = ctx.callbackQuery?.message?.message_id;
      background(ctx, async () => {
        const text = await expandItem(env, s.item);
        await ctx.reply(`🔍 <b>${esc(s.item.titleHe)}</b>\n${esc(text)}`, {
          ...HTML,
          ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
        });
      });
    },
    'מכין סיכום מורחב…',
  );

  onTap(/^mu:(\d+)$/, async (ctx) => {
    const s = await load(ctx, ctx.match[1]);
    if (!s) return;
    const prompt = s.item.tags.length ? '🔇 <b>מה להשתיק?</b>' : 'אין נושאים להשתקה בפריט הזה.';
    return show(ctx, `${cardText(s.item)}\n\n${prompt}`, muteTagsKeyboard(s.item));
  });
  onTap(/^mt:(\d+):(\d+)$/, async (ctx) => {
    const s = await load(ctx, ctx.match[1]);
    const tag = s?.item.tags[Number(ctx.match[2])];
    if (!s || !tag) return;
    return show(ctx, `${cardText(s.item)}\n\n🔇 להשתיק את <b>${esc(tag)}</b>?`, muteForKeyboard(s.item.id, Number(ctx.match[2])));
  });
  bot.callbackQuery(/^md:(\d+):(\d+):(f|w)$/, async (ctx) => {
    const s = await itemState(env.DB, Number(ctx.match[1]));
    const tag = s?.item.tags[Number(ctx.match[2])];
    if (!s || !tag) return ctx.answerCallbackQuery();
    const week = ctx.match[3] === 'w';
    await addMute(env.DB, tag, week ? new Date(now().getTime() + 7 * 86_400_000).toISOString() : null);
    await ctx.answerCallbackQuery({ text: `🔇 ${tag} הושתק ${week ? 'לשבוע' : 'לתמיד'}` });
    const v = cardView(s);
    return show(ctx, v.text, v.keyboard);
  });

  return bot;
}
