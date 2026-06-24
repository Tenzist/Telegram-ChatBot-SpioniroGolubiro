import fetch from "node-fetch";
import { configDotenv } from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import db from './db.js';

configDotenv();

const { TG_TOKEN, BM_TOKEN } = process.env;
const bot = new TelegramBot(TG_TOKEN, { polling: true });

const _send = bot.sendMessage.bind(bot);
bot.sendMessage = (chatId, text, opts = {}) =>
  _send(chatId, text, { disable_web_page_preview: true, ...opts });

const headers = {
  Authorization: `Bearer ${BM_TOKEN}`,
  'Content-Type': 'application/json',
};

const utils = {
  getDateNDaysAgoISO: (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  },
  getLastSeen: (stopTime) => {
    if (!stopTime) return "Игрок всё ещё онлайн";
    const diffMs = Date.now() - new Date(stopTime).getTime();
    const mins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days >= 1) return `${days} дн назад`;
    if (hrs >= 1)  return `${hrs} ч назад`;
    return `${mins} мин назад`;
  }
};

const state = {
  waitingForNickname: new Map(),
  searchMode:         new Map(),
  searchState:        new Map(),
  trackedPlayers:     new Map(), 
  playerNames:        new Map(),
};

const db_addTracked = (playerId, chatId) => {
  db.prepare("INSERT OR IGNORE INTO tracked (playerId, chatId) VALUES (?, ?)").run(String(playerId), String(chatId));
};

const db_removeTracked = (playerId, chatId) => {
  db.prepare("DELETE FROM tracked WHERE playerId = ? AND chatId = ?").run(String(playerId), String(chatId));
};

const db_getTrackedByChat = (chatId) => {
  return db.prepare("SELECT playerId FROM tracked WHERE chatId = ?")
    .all(String(chatId))
    .map(r => r.playerId);
};

const apiFetch = async (url) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

const getPlayerName = async (playerId) => {
  const pid = String(playerId);
  if (state.playerNames.has(pid)) return state.playerNames.get(pid);
  try {
    const json = await apiFetch(`https://api.battlemetrics.com/players/${pid}`);
    const name = json.data?.attributes?.name || `Игрок ${pid}`;
    state.playerNames.set(pid, name);
    return name;
  } catch {
    return `Игрок ${pid}`;
  }
};

const getPlayerLastSession = async (playerId, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const json = await apiFetch(
        `https://api.battlemetrics.com/players/${playerId}/relationships/sessions`
      );
      return json.data?.[0] ?? null;
    } catch (err) {
      if (i < retries - 1) await sleep(1000 * (i + 1));
      else console.error(`Не удалось получить сессии для ${playerId}:`, err.message);
    }
  }
  return null;
};

const getOnlineStatus = async (playerId) => {
  try {
    const json = await apiFetch(
      `https://api.battlemetrics.com/players/${playerId}/relationships/sessions`
    );
    const session = json.data?.[0];
    if (!session) return "";
    return session.attributes.stop === null
      ? '🟢'
      : `(${utils.getLastSeen(session.attributes.stop)})`;
  } catch {
    return "";
  }
};

const getUniqueServers = async (playerId, maxServers = 5) => {
  try {
    const json = await apiFetch(
      `https://api.battlemetrics.com/players/${playerId}/relationships/sessions?include=server&page[size]=50`
    );
    const seen = new Set();
    const result = [];
    for (const session of (json.data ?? [])) {
      const sid = session.relationships?.server?.data?.id;
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const details = json.included?.find(i => i.type === 'server' && i.id === sid);
      if (details) {
        result.push({ id: sid, name: details.attributes.name, lastSeen: session.attributes.stop });
        if (result.length === maxServers) break;
      }
    }
    return result;
  } catch (err) {
    console.error('Ошибка getUniqueServers:', err.message);
    return [];
  }
};

const getServerName = async (serverId) => {
  try {
    const json = await apiFetch(`https://api.battlemetrics.com/servers/${serverId}`);
    return json.data?.attributes?.name || "Неизвестный сервер";
  } catch {
    return "Неизвестный сервер";
  }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const buildPlayerKeyboard = (players, hasNext, hasPrev) => {
  const rows = players.map(p => [{ text: p.name, callback_data: `player:${p.id}` }]);
  const nav = [];
  if (hasPrev) nav.push({ text: '⬅️ Назад', callback_data: 'prevPage' });
  if (hasNext) nav.push({ text: '➡️ Далее', callback_data: 'nextPage' });
  if (nav.length) rows.push(nav);
  return { reply_markup: { inline_keyboard: rows } };
};

const fetchPlayers = async (url) => {
  try {
    const json = await apiFetch(url);
    const players = await Promise.all((json.data ?? []).map(async (p) => ({
      name: `${p.attributes.name} ${await getOnlineStatus(p.id)}`,
      id: p.id
    })));
    return { players, nextLink: json.links?.next ?? null, prevLink: json.links?.prev ?? null, currentUrl: url };
  } catch {
    return { players: [], nextLink: null, prevLink: null, currentUrl: url };
  }
};

const searchPlayers = async (name, mode) => {
  const base = `https://api.battlemetrics.com/players?filter[search]=${encodeURIComponent(name)}&filter[server][game]=rust`;
  const url = mode === 'global'
    ? base
    : `${base}&filter[after]=${utils.getDateNDaysAgoISO(mode === 'last30' ? 30 : 7)}`;
  return fetchPlayers(url);
};

const checkPlayerInfo = async (playerId, chatId, isTrackedContext = false) => {
  try {
    const json = await apiFetch(
      `https://api.battlemetrics.com/players/${playerId}/relationships/sessions`
    );
    const session = json.data?.[0];
    if (!session) return bot.sendMessage(chatId, "Сессии не найдены.");

    const { stop, name } = session.attributes;
    const id = session.relationships.player.data.id;

    const uniqueServers = await getUniqueServers(playerId, 5);
    const statusText = stop ? `Игрок был в сети ${utils.getLastSeen(stop)}` : `Сейчас в сети 🟢`;

    let serversMsg = "\n\n🌐 Информация о серверах не найдена.";
    if (uniqueServers.length > 0) {
      serversMsg = "\n\n🌐 <b>Последние сервера:</b>\n" + uniqueServers.map(s => {
        const seen = s.lastSeen ? `(${utils.getLastSeen(s.lastSeen)})` : "Сейчас онлайн";
        return `  • <i>${s.name}</i> ${seen}`;
      }).join("\n");
    }

    const keyboard = isTrackedContext ? [] : [[
      { text: "➕ Добавить в отслеживание", callback_data: `track:${playerId}` }
    ]];

    bot.sendMessage(
      chatId,
      `<a href="https://www.battlemetrics.com/players/${id}">${name}</a>\n${statusText}${serversMsg}`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true }
    );
  } catch (err) {
    console.error("Ошибка checkPlayerInfo:", err);
    bot.sendMessage(chatId, "Ошибка при получении информации об игроке.");
  }
};

const addTrackedPlayer = async (playerId, chatId) => {
  const pid = String(playerId);
  db_addTracked(pid, chatId);

  if (!state.trackedPlayers.has(pid)) {
    const session = await getPlayerLastSession(pid);
    if (session) {
      state.trackedPlayers.set(pid, session.attributes.stop);
      const name = session.attributes.name;
      if (name) state.playerNames.set(pid, name);
    }
  }
};

const removeTrackedPlayer = (playerId, chatId) => {
  db_removeTracked(String(playerId), String(chatId));
  const remaining = db.prepare("SELECT COUNT(*) as cnt FROM tracked WHERE playerId = ?")
    .get(String(playerId));
  if (remaining.cnt === 0) {
    state.trackedPlayers.delete(String(playerId));
  }
};

const checkTrackedPlayers = async () => {
  const rows = db.prepare("SELECT DISTINCT playerId FROM tracked").all();

  for (const { playerId } of rows) {
    const session = await getPlayerLastSession(playerId);
    if (!session) continue;

    const currentStop = session.attributes.stop;
    const currentName = session.attributes.name;

    const prevName = state.playerNames.get(playerId);
    if (prevName && currentName && prevName !== currentName) {
      state.playerNames.set(playerId, currentName);
      const chatRows = db.prepare("SELECT chatId FROM tracked WHERE playerId = ?").all(playerId);
      for (const { chatId } of chatRows) {
        bot.sendMessage(chatId,
          `✏️ Игрок сменил ник:\n<b>${prevName}</b> ➜ <b>${currentName}</b>`,
          { parse_mode: "HTML" }
        );
      }
    } else if (currentName && !prevName) {
      state.playerNames.set(playerId, currentName);
    }

    // Онлайн/оффлайн
    const prevStop = state.trackedPlayers.get(playerId);
    if (prevStop !== currentStop) {
      const serverId = session.relationships?.server?.data?.id;
      const serverName = serverId ? await getServerName(serverId) : "Неизвестный сервер";
      const msg = currentStop === null
        ? `🔔 Игрок <b>${currentName}</b> зашёл на сервер "<i>${serverName}</i>".`
        : `🔔 Игрок <b>${currentName}</b> вышел с сервера "<i>${serverName}</i>".`;

      state.trackedPlayers.set(playerId, currentStop);
      const chatRows = db.prepare("SELECT chatId FROM tracked WHERE playerId = ?").all(playerId);
      for (const { chatId } of chatRows) {
        bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
      }
    }
  }
};

const initTrackedPlayerStates = async () => {
  const rows = db.prepare("SELECT DISTINCT playerId FROM tracked").all();
  for (const { playerId } of rows) {
    const session = await getPlayerLastSession(playerId);
    if (!session) continue;
    state.trackedPlayers.set(playerId, session.attributes.stop);
    const name = session.attributes.name;
    if (name) state.playerNames.set(playerId, name);
  }
  console.log(`✅ Инициализировано ${rows.length} отслеживаемых игроков.`);
};

bot.setMyCommands([
  { command: "/search", description: "🔍 Поиск игроков" },
  { command: "/track",  description: "📎 Ввести ссылку вручную" },
  { command: "/list",   description: "📋 Список отслеживаемых" },
  { command: "/stop",   description: "🛑 Удалить отслеживание" }
]);

bot.onText(/\/search/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "📅 Выберите период поиска:", {
    reply_markup: {
      inline_keyboard: [[
        { text: "Неделя",   callback_data: "period:last7"  },
        { text: "Месяц",    callback_data: "period:last30" },
        { text: "Все время",callback_data: "period:global" }
      ]]
    }
  });
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  state.waitingForNickname.set(chatId, "awaitingTrackLink");
  bot.sendMessage(chatId, "📎 Отправьте ссылку на игрока с сайта BattleMetrics:");
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const ids = db_getTrackedByChat(chatId);
  if (!ids.length) return bot.sendMessage(chatId, "📭 Вы никого не отслеживаете.");

  const names = await Promise.all(ids.map(getPlayerName));
  bot.sendMessage(chatId, "📋 Отслеживаемые игроки:", {
    reply_markup: {
      inline_keyboard: names.map((name, i) => [
        { text: name, callback_data: `show_stats:${ids[i]}` }
      ])
    }
  });
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  const ids = db_getTrackedByChat(chatId);
  if (!ids.length) return bot.sendMessage(chatId, "📭 Вы никого не отслеживаете.");

  const names = await Promise.all(ids.map(getPlayerName));
  bot.sendMessage(chatId, "🗑 Выберите игрока для удаления из отслеживания:", {
    reply_markup: {
      inline_keyboard: names.map((name, i) => [
        { text: name, callback_data: `stop:${ids[i]}` }
      ])
    }
  });
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  if (state.waitingForNickname.get(chatId) === "awaitingTrackLink") {
    state.waitingForNickname.delete(chatId);
    const match = text.match(/battlemetrics\.com\/players\/(\d+)/);
    if (!match) {
      return bot.sendMessage(chatId,
        "❌ Неверная ссылка. Пример: https://www.battlemetrics.com/players/217865317"
      );
    }
    const playerId = match[1];
    await addTrackedPlayer(playerId, chatId);
    const name = await getPlayerName(playerId);
    return bot.sendMessage(chatId,
      `✅ Игрок <b>${name}</b> добавлен в отслеживание.`,
      { parse_mode: "HTML" }
    );
  }

  if (state.waitingForNickname.get(chatId) === true) {
    state.waitingForNickname.delete(chatId);
    const mode = state.searchMode.get(chatId) || "last7";
    state.searchMode.delete(chatId);

    const name = /^\d/.test(text.trim()) ? text.trim().replace(/\s+/g, '') : text.trim();
    const result = await searchPlayers(name, mode);

    if (!result.players?.length) return bot.sendMessage(chatId, "❌ Игроки не найдены.");
    state.searchState.set(chatId, result);
    return bot.sendMessage(chatId, "📊 Результаты:", buildPlayerKeyboard(result.players, !!result.nextLink, !!result.prevLink));
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;

  if (data.startsWith("period:")) {
    const mode = data.split(":")[1];
    state.searchMode.set(chatId, mode);
    state.waitingForNickname.set(chatId, true);
    const label = mode === "last7" ? "последнюю неделю" : mode === "last30" ? "последний месяц" : "все время";
    await bot.editMessageText(`Поиск за ${label}.\n\nВведите ник игрока для поиска:`, { chat_id: chatId, message_id: msgId });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("show_stats:")) {
    await checkPlayerInfo(data.split(":")[1], chatId, true);
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("track:")) {
    const playerId = data.split(":")[1];
    await addTrackedPlayer(playerId, chatId);
    bot.sendMessage(chatId, "✅ Игрок добавлен в отслеживание.");
    return bot.answerCallbackQuery(query.id);
  }


  if (data.startsWith("stop:")) {
    const playerId = data.split(":")[1];
    removeTrackedPlayer(playerId, chatId);

    const remaining = db_getTrackedByChat(chatId);
    if (!remaining.length) {
      await bot.editMessageText("✅ Все игроки удалены из отслеживания.", { chat_id: chatId, message_id: msgId });
    } else {
      const names = await Promise.all(remaining.map(getPlayerName));
      await bot.editMessageReplyMarkup(
        { inline_keyboard: names.map((name, i) => [{ text: name, callback_data: `stop:${remaining[i]}` }]) },
        { chat_id: chatId, message_id: msgId }
      );
    }
    return bot.answerCallbackQuery(query.id, { text: "🗑 Игрок удалён из отслеживания." });
  }

  const curState = state.searchState.get(chatId);

  if (data === "nextPage" || data === "prevPage") {
    if (!curState) return bot.answerCallbackQuery(query.id, { text: "Поиск не найден." });
    const url = data === "nextPage" ? curState.nextLink : curState.prevLink;
    if (!url) return bot.answerCallbackQuery(query.id);
    const newData = await fetchPlayers(url);
    state.searchState.set(chatId, newData);
    await bot.editMessageText("Результаты:", {
      chat_id: chatId,
      message_id: msgId,
      ...buildPlayerKeyboard(newData.players, !!newData.nextLink, !!newData.prevLink)
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("player:")) {
    await checkPlayerInfo(data.split(":")[1], chatId, false);
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "cancel") {
    bot.sendMessage(chatId, "❎ Отмена.");
    return bot.answerCallbackQuery(query.id);
  }

  bot.answerCallbackQuery(query.id);
});

await initTrackedPlayerStates();
setInterval(checkTrackedPlayers, 30000);
