import fetch from "node-fetch";
import { configDotenv } from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import db from './db.js';


configDotenv();

const { TG_TOKEN, BM_TOKEN } = process.env;
const bot = new TelegramBot(TG_TOKEN, { polling: true });

const headers = {
  Authorization: `Bearer ${BM_TOKEN}`,
  'Content-Type': 'application/json',
};

const utils = {
  getDateNDaysAgoISO: (n) => {
    const date = new Date();
    date.setDate(date.getDate() - n);
    return date.toISOString();
  },

  getLastSeen: (stopTime) => {
    if (!stopTime) return "Игрок всё ещё онлайн";
    const diffMs = new Date() - new Date(stopTime);
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    return diffDays >= 1 ? `${diffDays} дн назад` : diffHours >= 1 ? `${diffHours} ч назад` : `${diffMinutes} мин назад`;
  }
};

const maps = {
  waitingForNickname: new Map(),
  searchState: new Map(),
  searchMode: new Map(),
  trackedPlayers: new Map(),
  playerChats: new Map()
};


bot.setMyCommands([

  { command: "/search", description: "🔍 Поиск игроков" },
  { command: "/track", description: "📎 Ввести ссылку вручную" },
  { command: "/list", description: "📋 Список отслеживаемых" },
  { command: "/stop", description: "🛑 Удалить отслеживание" }
]);

bot.onText(/\/search/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "📅 Выберите период поиска:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Неделя", callback_data: "period:last7" },
          { text: "Месяц", callback_data: "period:last30" },
          { text: "Все время", callback_data: "period:global" }
        ]
      ]
    }
  });
});

bot.onText(/\/track/, (msg) => {
  const chatId = msg.chat.id;
  maps.waitingForNickname.set(chatId, "awaitingTrackLink");
  bot.sendMessage(chatId, "📎 Отправьте ссылку на игрока с сайта BattleMetrics:");
});

bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  const trackedPlayerIds = getTrackedPlayersByChat(chatId);

  if (!trackedPlayerIds.length) return bot.sendMessage(chatId, "📭 Вы никого не отслеживаете.");

  const names = await Promise.all(trackedPlayerIds.map(getPlayerName));

  const message = names.map((name, i) =>
    `${i + 1}. <a href="https://www.battlemetrics.com/players/${trackedPlayerIds[i]}">${name}</a>`
  ).join("\n");

  bot.sendMessage(chatId, `📋 Отслеживаемые игроки:\n${message}`, { parse_mode: "HTML" });
});


bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  const trackedPlayerIds = getTrackedPlayersByChat(chatId);

  if (!trackedPlayerIds.length) {
    return bot.sendMessage(chatId, "📭 Вы никого не отслеживаете.");
  }

  const names = await Promise.all(trackedPlayerIds.map(getPlayerName));
  const inlineKeyboard = names.map((name, i) => [
    { text: name, callback_data: `stop:${trackedPlayerIds[i]}` }
  ]);

  bot.sendMessage(chatId, "🗑 Выберите игрока для удаления из отслеживания:", {
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
});



bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text.startsWith("/")) return;

  if (maps.waitingForNickname.get(chatId) === false) {
    let mode = null;
    if (text === "Неделя") mode = "last7";
    else if (text === "Месяц") mode = "last30";
    else if (text === "Все время") mode = "global";

    if (!mode) {
      return bot.sendMessage(chatId, "Пожалуйста, выберите один из предложенных вариантов.");
    }

    maps.searchMode.set(chatId, mode);
    maps.waitingForNickname.set(chatId, true);

    return bot.sendMessage(chatId, "⌨️ Введите ник игрока:");
  }


  if (maps.waitingForNickname.get(chatId) === "awaitingTrackLink") {
    maps.waitingForNickname.delete(chatId);

    const match = text.match(/battlemetrics\.com\/players\/(\d+)/);
    if (!match) {
      return bot.sendMessage(chatId, "❌ Неверная ссылка. Пример: https://www.battlemetrics.com/players/217865317");
    }

    const playerId = match[1];
    addTrackedPlayer(playerId, chatId);
    const playerName = await getPlayerName(playerId);
    return bot.sendMessage(chatId, `✅ Игрок <b>${playerName}</b> добавлен в отслеживание.`, { parse_mode: "HTML" });
  }


  if (!maps.waitingForNickname.get(chatId)) return;

  maps.waitingForNickname.delete(chatId);
  const mode = maps.searchMode.get(chatId) || "last7";
  maps.searchMode.delete(chatId);

  const name = /^\d/.test(text.trim()) ? text.trim().replace(/\s+/g, '') : text.trim();

  let result;
  if (mode === "global") {
    result = await globalSearchPlayers(name);
  } else {
    const days = mode === "last30" ? 30 : 7;
    result = await searchPlayersLastDays(name, days);
  }

  const { players, nextLink, prevLink, currentUrl } = result;
  if (!players?.length) return bot.sendMessage(chatId, "❌ Игроки не найдены.");

  maps.searchState.set(chatId, { currentUrl, nextLink, prevLink, players });
  bot.sendMessage(chatId, "📊 Результаты:", buildPlayerKeyboard(players, !!nextLink, !!prevLink));
});



bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = maps.searchState.get(chatId);

  if (data.startsWith("period:")) {
    const mode = data.split(":")[1]; // last7, last30, global

    maps.searchMode.set(chatId, mode);
    maps.waitingForNickname.set(chatId, true);

    await bot.editMessageText(`Поиск за  ${mode === "last7" ? "последнюю неделю" : mode === "last30" ? "последний месяц" : "все время"}.\n\nВведите ник игрока для поиска:`, {
      chat_id: chatId,
      message_id: query.message.message_id
    });

    return bot.answerCallbackQuery(query.id);
  }

  if (!state) return bot.answerCallbackQuery(query.id, { text: "Поиск не найден." });

  const { nextLink, prevLink, players } = state;

  if (data === "nextPage" || data === "prevPage") {
    const url = data === "nextPage" ? nextLink : prevLink;
    if (!url) return;

    const newData = await fetchPlayers(url);
    maps.searchState.set(chatId, newData);

    await bot.editMessageText("Результаты:", {
      chat_id: chatId,
      message_id: query.message.message_id,
      ...buildPlayerKeyboard(newData.players, !!newData.nextLink, !!newData.prevLink)
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("player:")) {
    await checkPlayerInfo(data.split(":")[1], chatId);
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "cancel") {
    bot.sendMessage(chatId, "❎ Отмена.");
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith("track:")) {
    const playerId = data.split(":")[1];
    addTrackedPlayer(playerId, chatId);
    bot.sendMessage(chatId, "✅ Игрок добавлен в отслеживание.");
    return bot.answerCallbackQuery(query.id);
  }
  if (data.startsWith("stop:")) {
    const playerIdToRemove = data.split(":")[1];

    removeTrackedPlayer(playerIdToRemove, chatId);

    const trackedPlayerIds = getTrackedPlayersByChat(chatId);

    if (!trackedPlayerIds.length) {
      await bot.editMessageText("Все игроки удалены из отслеживания", {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    } else {
      const names = await Promise.all(trackedPlayerIds.map(getPlayerName));
      const inlineKeyboard = names.map((name, i) => [
        { text: name, callback_data: `stop:${trackedPlayerIds[i]}` }
      ]);
      await bot.editMessageReplyMarkup({ inline_keyboard: inlineKeyboard }, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }

    await bot.answerCallbackQuery(query.id, { text: "🗑 Игрок удалён из отслеживания." });
    return;
  }
});

const buildPlayerKeyboard = (players, hasNext, hasPrev) => {
  const inlineKeyboard = players.map(player => ([{ text: player.name, callback_data: `player:${player.id}` }]));
  const navButtons = [];
  if (hasPrev) navButtons.push({ text: '⬅️ Назад', callback_data: 'prevPage' });
  if (hasNext) navButtons.push({ text: '➡️ Далее', callback_data: 'nextPage' });
  if (navButtons.length) inlineKeyboard.push(navButtons);
  return { reply_markup: { inline_keyboard: inlineKeyboard } };
};

const getPlayerName = async (playerId) => {
  try {
    const res = await fetch(`https://api.battlemetrics.com/players/${playerId}`, { headers });
    const json = await res.json();
    return json.data?.attributes?.name || `Игрок ${playerId}`;
  } catch {
    return `Игрок ${playerId}`;
  }
};

const getOnlineStatus = async (playerId) => {
  try {
    const res = await fetchPlayerSessions(playerId);
    const session = (await res.json()).data[0];
    if (!session) return "";
    return session.attributes.stop === null ? '🟢' : `(${utils.getLastSeen(session.attributes.stop)})`;
  } catch {
    return "";
  }
};

const getServerName = async (serverId) => {
  try {
    const res = await fetch(`https://api.battlemetrics.com/servers/${serverId}`, { headers });
    return (await res.json()).data?.attributes?.name || "Неизвестный сервер";
  } catch {
    return "Ошибка при получении сервера";
  }
};

const getPlayerLastSession = async (playerId) => {
  try {
    const res = await fetchPlayerSessions(playerId);
    return (await res.json()).data?.[0] || null;
  } catch {
    return null;
  }
};

const getSessionServerName = async (session) => {
  try {
    const serverId = session.relationships?.server?.data?.id;
    if (!serverId) return "Неизвестный сервер";
    return await getServerName(serverId);
  } catch {
    return "Ошибка при получении сервера";
  }
};

const checkPlayerInfo = async (playerId, chatId) => {
  try {
    const res = await fetchPlayerSessions(playerId);
    const session = (await res.json()).data?.[0];
    if (!session) return bot.sendMessage(chatId, "Сессии не найдены.");

    const { stop, name } = session.attributes;
    const id = session.relationships.player.data.id
    const serverName = await getSessionServerName(session);
    const statusText = stop ? `Игрок был в сети ${utils.getLastSeen(stop)}` : `Сейчас в сети`;

    const options = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "Добавить в отслеживание", callback_data: `track:${playerId}` },
          // { text: "Отмена", callback_data: "cancel" }
        ]]
      }
    };

    bot.sendMessage(chatId, `<a href="https://www.battlemetrics.com/players/${id}">${name}</a>\n"<i>${serverName}</i>"\n${statusText}`, options);
  } catch {
    bot.sendMessage(chatId, "Ошибка при получении сессии.");
  }
};

const fetchPlayers = async (url) => {
  try {
    const res = await fetch(url, { headers });
    const json = await res.json();
    const players = await Promise.all((json.data || []).map(async (player) => ({
      name: `${player.attributes.name} ${await getOnlineStatus(player.id)}`,
      id: player.id
    })));
    return {
      players,
      nextLink: json.links?.next || null,
      prevLink: json.links?.prev || null,
      currentUrl: url
    };
  } catch {
    return { players: [], nextLink: null, prevLink: null, currentUrl: url };
  }
};

const searchPlayersLastDays = async (name, days = 7) => {
  const url = `https://api.battlemetrics.com/players?filter[search]=${name}&filter[after]=${utils.getDateNDaysAgoISO(days)}&filter[server][game]=rust`;
  return await fetchPlayers(url);
};

const globalSearchPlayers = async (name) => {
  const url = `https://api.battlemetrics.com/players?filter[search]=${name}&filter[server][game]=rust`;
  return await fetchPlayers(url);
};

const checkTrackedPlayers = async () => {
  for (const [playerId, lastStop] of maps.trackedPlayers.entries()) {
    const currentSession = await getPlayerLastSession(playerId);
    if (!currentSession) continue;

    const currentStop = currentSession.attributes.stop;
    if (currentStop !== lastStop) {
      const playerName = await getPlayerName(playerId);
      const serverName = await getSessionServerName(currentSession);
      const message = currentStop === null
        ? `🔔 Игрок <b>${playerName}</b> зашёл в сеть на сервер "<i>${serverName}</i>".`
        : `🔔 Игрок <b>${playerName}</b> вышел с сервера "<i>${serverName}</i>".`;

      maps.trackedPlayers.set(playerId, currentStop);

      const chats = maps.playerChats.get(playerId);
      if (chats) {
        for (const chatId of chats) {
          bot.sendMessage(chatId, message, { parse_mode: "HTML" });
        }
      }
    }
  }
};

const fetchPlayerSessions = async (playerId) => {
  try {
    return await fetch(`https://api.battlemetrics.com/players/${playerId}/relationships/sessions`, { headers });
  } catch (error) {
    console.error("Ошибка при получении сессий игрока:", error);
    return { json: async () => ({ data: [] }) };
  }
};

const addTrackedPlayer = (playerId, chatId) => {
  db.prepare("INSERT OR IGNORE INTO tracked (playerId, chatId) VALUES (?, ?)").run(playerId, chatId);
};

const removeTrackedPlayer = (playerId, chatId) => {
  db.prepare("DELETE FROM tracked WHERE playerId = ? AND chatId = ?").run(playerId, chatId);
};

const getTrackedPlayersByChat = (chatId) => {
  return db.prepare("SELECT playerId FROM tracked WHERE chatId = ?")
  .all(chatId)
  .map(row => row.playerId);
};

setInterval(checkTrackedPlayers, 20000);