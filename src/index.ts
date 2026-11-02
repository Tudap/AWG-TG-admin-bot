import { Bot, Context, session, InlineKeyboard, InputFile } from "grammy";
import {
  type Conversation,
  type ConversationFlavor,
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import QRCode from "qrcode";
import * as awg from "./awg";
import { checkRussianReachability } from "./ping";

// -----------------------------------------------------------------------------
// Environment Configuration & Validation
// -----------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("FATAL: Переменная окружения BOT_TOKEN не задана в .env");
  process.exit(1);
}

const ADMIN_ID_RAW = process.env.ADMIN_ID;
if (!ADMIN_ID_RAW) {
  console.error("FATAL: Переменная окружения ADMIN_ID не задана в .env");
  process.exit(1);
}

const ADMIN_ID = Number(ADMIN_ID_RAW);
if (isNaN(ADMIN_ID) || ADMIN_ID <= 0) {
  console.error("FATAL: Переменная окружения ADMIN_ID должна быть положительным числом");
  process.exit(1);
}

const SERVER_HOST = process.env.SERVER_HOST || "127.0.0.1";

// -----------------------------------------------------------------------------
// Context Types
// -----------------------------------------------------------------------------
type MyContext = Context & ConversationFlavor;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>(BOT_TOKEN);

// -----------------------------------------------------------------------------
// Security Middleware (Rule 1)
// Drop any incoming update from non-ADMIN_ID silently
// -----------------------------------------------------------------------------
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ADMIN_ID) {
    // Silently drop unauthorized update
    return;
  }
  await next();
});

// -----------------------------------------------------------------------------
// Formatting Helpers
// -----------------------------------------------------------------------------
function formatBytes(bytes: number | string | undefined): string {
  if (!bytes) return "0 B";
  if (typeof bytes === "string") {
    const trimmed = bytes.trim();
    // If it already has human-readable units (e.g. "2.63 GiB", "16.12 GiB", "0 B")
    if (/[a-zA-Zа-яА-Я]/.test(trimmed)) {
      return trimmed;
    }
  }
  const num = Number(bytes);
  if (isNaN(num) || num <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(1024)), units.length - 1);
  const formatted = (num / Math.pow(1024, i)).toFixed(1);
  return `${formatted} ${units[i]}`;
}

function formatHandshake(timestamp: number | string | undefined): string {
  if (!timestamp) return "Никогда";
  if (typeof timestamp === "string") {
    const trimmed = timestamp.trim();
    if (
      trimmed.toLowerCase() === "никогда" ||
      trimmed === "0" ||
      trimmed === "-" ||
      trimmed === "never"
    ) {
      return "Никогда";
    }
    // Parse datetime like "2026-11-02 09:30:03" or ISO string
    const parsedDate = Date.parse(trimmed.replace(" ", "T"));
    if (!isNaN(parsedDate)) {
      const diffSec = Math.floor((Date.now() - parsedDate) / 1000);
      if (diffSec < 0 || diffSec < 60) return `${diffSec < 0 ? 0 : diffSec} сек. назад`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin} мин. назад`;
      const diffHours = Math.floor(diffMin / 60);
      if (diffHours < 24) return `${diffHours} ч. назад`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays} дн. назад`;
    }
    return trimmed;
  }

  const num = Number(timestamp);
  if (isNaN(num) || num <= 0) return "Никогда";

  // If timestamp is in seconds vs milliseconds
  const tsMs = num < 10000000000 ? num * 1000 : num;
  const diffSec = Math.floor((Date.now() - tsMs) / 1000);

  if (diffSec < 0) return "Только что";
  if (diffSec < 60) return `${diffSec} сек. назад`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин. назад`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ч. назад`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} дн. назад`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function safeEditMessage(ctx: MyContext, text: string, keyboard?: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err: any) {
    if (err?.description?.includes("message is not modified")) {
      return;
    }
    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  }
}

// -----------------------------------------------------------------------------
// Keyboards
// -----------------------------------------------------------------------------
function getMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Список клиентов", "menu_clients")
    .text("➕ Добавить клиента", "menu_add_client")
    .row()
    .text("📊 Статус и трафик", "menu_stats")
    .text("🩺 Здоровье сервера", "menu_check")
    .row()
    .text("🇷🇺 Доступность из РФ", "menu_ping")
    .text("💾 Создать бэкап", "menu_backup");
}

function getMainMenuText(): string {
  return (
    "🎛 *Панель управления AmneziaWG*\n\n" +
    `🖥 Серверный хост: \`${SERVER_HOST}\`\n` +
    "Выберите необходимое действие в меню ниже:"
  );
}

// -----------------------------------------------------------------------------
// FSM Conversation: Add Client
// -----------------------------------------------------------------------------
async function addClientConversation(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply(
    "➕ *Создание нового клиента AmneziaWG*\n\n" +
      "Введите имя клиента (разрешены только `a-z`, `A-Z`, `0-9` и символ `_`, от 1 до 32 символов).\n\n" +
      "_Для отмены введите /cancel_",
    { parse_mode: "Markdown" }
  );

  let clientName = "";
  while (true) {
    const nameCtx = await conversation.waitFor(":text");
    const input = nameCtx.message?.text?.trim() || "";

    if (input === "/cancel") {
      await nameCtx.reply("❌ Создание клиента отменено.", {
        reply_markup: getMainMenuKeyboard(),
      });
      return;
    }

    if (/^[a-zA-Z0-9_]{1,32}$/.test(input)) {
      clientName = input;
      break;
    }

    await nameCtx.reply(
      "⚠️ *Недопустимое имя клиента!*\n\n" +
        "Используйте только символы латиницы, цифры и подчеркивание (1–32 символа).\n" +
        "Попробуйте ещё раз или введите /cancel:",
      { parse_mode: "Markdown" }
    );
  }

  // Ask for expiration
  const expiresKeyboard = new InlineKeyboard()
    .text("♾ Бессрочно", "exp_unlimited")
    .row()
    .text("⏱ 1 день", "exp_1d")
    .text("⏱ 7 дней", "exp_7d")
    .text("⏱ 30 дней", "exp_30d")
    .row()
    .text("❌ Отмена", "exp_cancel");

  await ctx.reply(
    `👤 Клиент: *${clientName}*\n\n` +
      "Выберите желаемый срок действия доступа:",
    {
      parse_mode: "Markdown",
      reply_markup: expiresKeyboard,
    }
  );

  let choice = "";
  let expCtx: MyContext;

  while (true) {
    const nextCtx = await conversation.wait();
    if (
      nextCtx.callbackQuery?.data &&
      [
        "exp_unlimited",
        "exp_1d",
        "exp_7d",
        "exp_30d",
        "exp_cancel",
      ].includes(nextCtx.callbackQuery.data)
    ) {
      choice = nextCtx.callbackQuery.data;
      expCtx = nextCtx;
      await expCtx.answerCallbackQuery().catch(() => {});
      break;
    }

    if (nextCtx.message?.text?.trim() === "/cancel") {
      await nextCtx.reply("❌ Создание клиента отменено.", {
        reply_markup: getMainMenuKeyboard(),
      });
      return;
    }
  }

  if (choice === "exp_cancel") {
    await expCtx.editMessageText("❌ Создание клиента отменено.");
    await expCtx.reply(getMainMenuText(), {
      parse_mode: "Markdown",
      reply_markup: getMainMenuKeyboard(),
    });
    return;
  }

  let expiresFlag: string | undefined = undefined;
  let expiresLabel = "Бессрочно";

  if (choice === "exp_1d") {
    expiresFlag = "1d";
    expiresLabel = "1 день";
  } else if (choice === "exp_7d") {
    expiresFlag = "7d";
    expiresLabel = "7 дней";
  } else if (choice === "exp_30d") {
    expiresFlag = "30d";
    expiresLabel = "30 дней";
  }

  await expCtx.editMessageText(
    `⏳ Создание клиента *${clientName}* (${expiresLabel})...\nПожалуйста, подождите.`,
    { parse_mode: "Markdown" }
  );

  try {
    const result = await awg.add(clientName, expiresFlag);

    // Generate QR in memory Buffer strictly
    const qrBuffer = await QRCode.toBuffer(result.config, {
      type: "png",
      width: 512,
      margin: 2,
    });

    const caption =
      `✅ *Клиент ${clientName} успешно создан!*\n\n` +
      `⏱ Срок действия: *${expiresLabel}*\n` +
      `🛡 Конфиг пропатчен: \`AllowedIPs = 0.0.0.0/0\`, \`PersistentKeepalive = 15\``;

    // Send QR photo
    await expCtx.replyWithPhoto(
      new InputFile(qrBuffer, `${clientName}_qr.png`),
      {
        caption,
        parse_mode: "Markdown",
      }
    );

    // Send .conf document
    await expCtx.replyWithDocument(
      new InputFile(Buffer.from(result.config, "utf-8"), `${clientName}.conf`),
      {
        caption: `📄 Файл конфигурации для *${clientName}*`,
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("👥 К списку клиентов", "menu_clients")
          .text("🎛 Главное меню", "menu_main"),
      }
    );
  } catch (error: any) {
    await expCtx.reply(
      `❌ Ошибка при создании клиента *${clientName}*:\n\`\`\`\n${error?.message || String(error)}\n\`\`\``,
      {
        parse_mode: "Markdown",
        reply_markup: getMainMenuKeyboard(),
      }
    );
  }
}

// -----------------------------------------------------------------------------
// Middleware & Plugins Setup
// -----------------------------------------------------------------------------
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());
bot.use(createConversation(addClientConversation));

// -----------------------------------------------------------------------------
// Client List & Detail Views
// -----------------------------------------------------------------------------
const CLIENTS_PER_PAGE = 6;

async function renderClientsList(ctx: MyContext, page = 0) {
  try {
    const clients = await awg.list();

    if (!clients || clients.length === 0) {
      const emptyKb = new InlineKeyboard()
        .text("➕ Добавить клиента", "menu_add_client")
        .row()
        .text("🎛 Главное меню", "menu_main");

      await safeEditMessage(
        ctx,
        "👥 *Список клиентов AmneziaWG*\n\n_На сервере пока нет зарегистрированных клиентов._",
        emptyKb
      );
      return;
    }

    const totalPages = Math.ceil(clients.length / CLIENTS_PER_PAGE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const startIdx = currentPage * CLIENTS_PER_PAGE;
    const pageClients = clients.slice(startIdx, startIdx + CLIENTS_PER_PAGE);

    const kb = new InlineKeyboard();

    for (const client of pageClients) {
      const isExpired = client.status === "expired";
      const icon = isExpired ? "🔴" : client.expires_at ? "⏱" : "🟢";
      kb.text(`${icon} ${client.name}`, `client_view:${client.name}`).row();
    }

    // Pagination row
    const navButtons = [];
    if (currentPage > 0) {
      navButtons.push(
        InlineKeyboard.text("⬅️ Назад", `clients_page:${currentPage - 1}`)
      );
    }
    navButtons.push(
      InlineKeyboard.text(`Стр. ${currentPage + 1}/${totalPages}`, "noop")
    );
    if (currentPage < totalPages - 1) {
      navButtons.push(
        InlineKeyboard.text("Вперёд ➡️", `clients_page:${currentPage + 1}`)
      );
    }
    kb.row(...navButtons);

    kb.row()
      .text("➕ Добавить клиента", "menu_add_client")
      .text("🔄 Обновить", `clients_page:${currentPage}`)
      .row()
      .text("🎛 Главное меню", "menu_main");

    const messageText =
      `👥 *Список клиентов AmneziaWG* (Всего: ${clients.length}):\n\n` +
      `🟢 — бессрочный доступ\n` +
      `⏱ — временный доступ\n` +
      `🔴 — истёкший доступ\n\n` +
      `_Нажмите на имя клиента для управления конфигом:_`;

    await safeEditMessage(ctx, messageText, kb);
  } catch (error: any) {
    const errKb = new InlineKeyboard().text("🎛 Главное меню", "menu_main");
    await safeEditMessage(
      ctx,
      `❌ Ошибка при получении списка клиентов:\n\`\`\`\n${error?.message || String(error)}\n\`\`\``,
      errKb
    );
  }
}

async function renderClientDetails(ctx: MyContext, clientName: string) {
  try {
    const [clients, statsData] = await Promise.all([
      awg.list().catch(() => []),
      awg.stats().catch(() => ({ peers: [] })),
    ]);

    const client = clients.find((c) => c.name === clientName);
    const peerStats = (statsData.peers || []).find(
      (p) =>
        p.name === clientName ||
        (client?.ip && p.allowed_ips && p.allowed_ips.includes(client.ip)) ||
        (client?.ip && p.ip && p.ip === client.ip)
    );

    let text = `👤 *Клиент:* \`${clientName}\`\n\n`;
    text += `📍 *IP адрес:* \`${client?.ip || peerStats?.ip || "не назначен"}\`\n`;
    text += `🚦 *Статус:* \`${peerStats?.status || client?.status || "active"}\`\n`;
    text += `⏱ *Срок действия:* \`${client?.expires_at || "Бессрочно"}\`\n`;

    if (client?.created_at) {
      text += `📅 *Создан:* \`${client.created_at}\`\n`;
    }

    if (peerStats) {
      const rx = formatBytes(peerStats.transfer_rx);
      const tx = formatBytes(peerStats.transfer_tx);
      const handshake = formatHandshake(peerStats.latest_handshake);
      text += `\n📊 *Трафик:* ⬇️ ${rx} | ⬆️ ${tx}\n`;
      text += `🕒 *Последний Handshake:* ${handshake}\n`;
      if (peerStats.endpoint) {
        text += `🌐 *Endpoint:* \`${peerStats.endpoint}\`\n`;
      }
    }

    const kb = new InlineKeyboard()
      .text("📥 Скачать QR и конфиг", `client_regen:${clientName}`)
      .row()
      .text("🗑 Удалить", `client_rm_ask:${clientName}`)
      .row()
      .text("⬅️ К списку клиентов", "menu_clients")
      .text("🎛 Главное меню", "menu_main");

    await safeEditMessage(ctx, text, kb);
  } catch (error: any) {
    await safeEditMessage(
      ctx,
      `❌ Ошибка получения данных клиента *${clientName}*:\n${error?.message || String(error)}`,
      new InlineKeyboard().text("⬅️ К списку клиентов", "menu_clients")
    );
  }
}

// -----------------------------------------------------------------------------
// Stats & Health Views
// -----------------------------------------------------------------------------
async function renderStats(ctx: MyContext) {
  try {
    const stats = await awg.stats();
    const iface = stats.interface || "awg0";
    const port = stats.listening_port ? `:${stats.listening_port}` : "";
    const peers = stats.peers || [];

    let text = `📊 *Статус интерфейса и трафик*\n\n`;
    text += `🔌 Интерфейс: \`${iface}${port}\`\n`;
    text += `👥 Активных пиров в WireGuard: *${peers.length}*\n\n`;

    if (peers.length === 0) {
      text += `_Нет подключенных пиров или статистика пуста._\n`;
    } else {
      text += `*Сводка по пирам:*\n`;
      for (const p of peers) {
        const name = p.name || p.public_key?.slice(0, 8) + "..." || "Неизвестный";
        const rx = formatBytes(p.transfer_rx);
        const tx = formatBytes(p.transfer_tx);
        const handshake = formatHandshake(p.latest_handshake);
        const statusBadge =
          p.status?.toLowerCase().includes("актив")
            ? "🟢"
            : p.status?.toLowerCase().includes("недав")
            ? "🟡"
            : "⚪️";

        const ipBadge = p.ip ? ` \`(${p.ip})\`` : "";
        text += `• *${name}*${ipBadge} ${statusBadge}\n`;
        text += `  ⬇️ ${rx} | ⬆️ ${tx} | 🕒 ${handshake}\n`;
      }
    }

    const kb = new InlineKeyboard()
      .text("🔄 Обновить", "menu_stats")
      .row()
      .text("🎛 Главное меню", "menu_main");

    await safeEditMessage(ctx, text, kb);
  } catch (error: any) {
    await safeEditMessage(
      ctx,
      `❌ Ошибка при получении статистики:\n\`\`\`\n${error?.message || String(error)}\n\`\`\``,
      new InlineKeyboard().text("🎛 Главное меню", "menu_main")
    );
  }
}

async function renderCheck(ctx: MyContext) {
  try {
    await safeEditMessage(ctx, "⏳ Выполняется диагностика AmneziaWG...");
    const output = await awg.check();

    // Telegram maximum message length is 4096 chars
    const cleanOutput = output.trim() || "Проверка завершена без текстового вывода.";
    const truncated =
      cleanOutput.length > 3500
        ? cleanOutput.slice(0, 3500) + "\n\n...[Вывод обрезан]"
        : cleanOutput;

    const text = `🩺 *Здоровье и диагностика сервера:*\n\n\`\`\`\n${truncated}\n\`\`\``;

    const kb = new InlineKeyboard()
      .text("🔄 Повторить проверку", "menu_check")
      .row()
      .text("🎛 Главное меню", "menu_main");

    await safeEditMessage(ctx, text, kb);
  } catch (error: any) {
    await safeEditMessage(
      ctx,
      `❌ Ошибка при выполнении проверки check:\n\`\`\`\n${error?.message || String(error)}\n\`\`\``,
      new InlineKeyboard().text("🎛 Главное меню", "menu_main")
    );
  }
}

// -----------------------------------------------------------------------------
// Commands Handlers
// -----------------------------------------------------------------------------
bot.command("start", async (ctx) => {
  await ctx.reply(getMainMenuText(), {
    parse_mode: "Markdown",
    reply_markup: getMainMenuKeyboard(),
  });
});

bot.command("menu", async (ctx) => {
  await ctx.reply(getMainMenuText(), {
    parse_mode: "Markdown",
    reply_markup: getMainMenuKeyboard(),
  });
});

bot.command("clients", async (ctx) => {
  await renderClientsList(ctx, 0);
});

bot.command("add", async (ctx) => {
  await ctx.conversation.enter("addClientConversation");
});

bot.command("stats", async (ctx) => {
  await renderStats(ctx);
});

bot.command("check", async (ctx) => {
  await renderCheck(ctx);
});

bot.command("ping", async (ctx) => {
  await handlePing(ctx);
});

bot.command("backup", async (ctx) => {
  await handleBackup(ctx);
});

bot.command("cancel", async (ctx) => {
  await ctx.reply("Главное меню:", {
    reply_markup: getMainMenuKeyboard(),
  });
});

// -----------------------------------------------------------------------------
// Action Handlers
// -----------------------------------------------------------------------------
async function handlePing(ctx: MyContext) {
  await safeEditMessage(
    ctx,
    `⏳ *Замер доступности из РФ (Globalping API)...*\nЦелевой хост: \`${SERVER_HOST}\`\n\nПожалуйста, подождите 3–5 секунд.`
  );

  const report = await checkRussianReachability(SERVER_HOST);

  const kb = new InlineKeyboard()
    .text("🔄 Повторить тест", "menu_ping")
    .row()
    .text("🎛 Главное меню", "menu_main");

  await safeEditMessage(ctx, report, kb);
}

async function handleBackup(ctx: MyContext) {
  await safeEditMessage(ctx, "⏳ Создание резервной копии конфигурации AmneziaWG...");

  try {
    const { backupPath } = await awg.backup();
    const filename = backupPath.split("/").pop() || "amneziawg_backup.tar.gz";

    const fileContent = await Bun.file(backupPath).arrayBuffer();
    const inputFile = new InputFile(Buffer.from(fileContent), filename);

    await ctx.replyWithDocument(inputFile, {
      caption: `💾 *Резервная копия AmneziaWG успешно создана!*\n📁 Файл: \`${filename}\``,
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🎛 Главное меню", "menu_main"),
    });
  } catch (error: any) {
    await safeEditMessage(
      ctx,
      `❌ Ошибка при создании бэкапа:\n\`\`\`\n${error?.message || String(error)}\n\`\`\``,
      new InlineKeyboard().text("🎛 Главное меню", "menu_main")
    );
  }
}

// -----------------------------------------------------------------------------
// Callback Query Routing
// -----------------------------------------------------------------------------
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Always answer callback queries to dismiss client loading state
  await ctx.answerCallbackQuery().catch(() => {});

  if (data === "noop") {
    return;
  }

  if (data === "menu_main") {
    await safeEditMessage(ctx, getMainMenuText(), getMainMenuKeyboard());
    return;
  }

  if (data === "menu_clients") {
    await renderClientsList(ctx, 0);
    return;
  }

  if (data.startsWith("clients_page:")) {
    const page = parseInt(data.replace("clients_page:", ""), 10) || 0;
    await renderClientsList(ctx, page);
    return;
  }

  if (data === "menu_add_client") {
    await ctx.conversation.enter("addClientConversation");
    return;
  }

  if (data === "menu_stats") {
    await renderStats(ctx);
    return;
  }

  if (data === "menu_check") {
    await renderCheck(ctx);
    return;
  }

  if (data === "menu_ping") {
    await handlePing(ctx);
    return;
  }

  if (data === "menu_backup") {
    await handleBackup(ctx);
    return;
  }

  // View specific client
  if (data.startsWith("client_view:")) {
    const name = data.replace("client_view:", "");
    await renderClientDetails(ctx, name);
    return;
  }

  // Regen client config and send QR + .conf
  if (data.startsWith("client_regen:")) {
    const name = data.replace("client_regen:", "");
    await safeEditMessage(ctx, `⏳ Перевыпуск / подготовка конфига для *${name}*...`);

    try {
      const result = await awg.regen(name);
      const qrBuffer = await QRCode.toBuffer(result.config, {
        type: "png",
        width: 512,
        margin: 2,
      });

      const caption =
        `✅ *Конфиг для ${name} обновлен!*\n\n` +
        `🛡 Пропатчено: \`AllowedIPs = 0.0.0.0/0\`, \`PersistentKeepalive = 15\``;

      await ctx.replyWithPhoto(new InputFile(qrBuffer, `${name}_qr.png`), {
        caption,
        parse_mode: "Markdown",
      });

      await ctx.replyWithDocument(
        new InputFile(Buffer.from(result.config, "utf-8"), `${name}.conf`),
        {
          caption: `📄 Файл конфигурации для *${name}*`,
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("👤 К клиенту", `client_view:${name}`)
            .text("👥 К списку", "menu_clients"),
        }
      );
    } catch (error: any) {
      await safeEditMessage(
        ctx,
        `❌ Ошибка при перевыпуске конфига *${name}*:\n\`\`\`\n${error?.message || String(error)}\n\`\`\``,
        new InlineKeyboard().text("👤 К клиенту", `client_view:${name}`)
      );
    }
    return;
  }

  // Ask confirmation before removing client
  if (data.startsWith("client_rm_ask:")) {
    const name = data.replace("client_rm_ask:", "");
    const kb = new InlineKeyboard()
      .text("⚠️ Да, удалить клиента", `client_rm_do:${name}`)
      .row()
      .text("❌ Отмена", `client_view:${name}`);

    await safeEditMessage(
      ctx,
      `⚠️ *Подтверждение удаления*\n\nВы уверены, что хотите безвозвратно удалить клиента *${name}*?`,
      kb
    );
    return;
  }

  // Perform client removal
  if (data.startsWith("client_rm_do:")) {
    const name = data.replace("client_rm_do:", "");
    await safeEditMessage(ctx, `⏳ Удаление клиента *${name}*...`);

    try {
      await awg.remove(name);

      const kb = new InlineKeyboard()
        .text("👥 К списку клиентов", "menu_clients")
        .row()
        .text("🎛 Главное меню", "menu_main");

      await safeEditMessage(
        ctx,
        `✅ Клиент *${name}* успешно удален с сервера.`,
        kb
      );
    } catch (error: any) {
      await safeEditMessage(
        ctx,
        `❌ Ошибка при удалении клиента *${name}*:\n\`\`\`\n${error?.message || String(error)}\n\`\`\``,
        new InlineKeyboard()
          .text("👤 К клиенту", `client_view:${name}`)
          .text("👥 К списку", "menu_clients")
      );
    }
    return;
  }
});

// -----------------------------------------------------------------------------
// Error Handling & Startup
// -----------------------------------------------------------------------------
bot.catch((err) => {
  console.error("Ошибка в работе Telegram-бота:", err);
});

console.log("🚀 Запуск AmneziaWG Telegram Admin Bot...");
console.log(`👤 Разрешенный ADMIN_ID: ${ADMIN_ID}`);
console.log(`🌐 Хост проверки доступности: ${SERVER_HOST}`);
console.log(`🔧 Скрипт AmneziaWG: ${awg.getScriptPath()}`);

if (!awg.isUserRoot()) {
  const currentUser = process.env.USER || "не root";
  console.warn(`\n⚠️ ВНИМАНИЕ: Бот запущен от непривилегированного пользователя "${currentUser}"!`);
  console.warn("Файлы конфигураций в /root/awg/ и сетевой стек WireGuard требуют прав суперпользователя.");
  console.warn("Для стабильной работы запустите через sudo или от пользователя root:");
  console.warn("  sudo bun run src/index.ts  (или sudo systemctl start awg-bot)\n");
}

bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Бот @${botInfo.username} успешно запущен и готов к работе!`);
  },
});
