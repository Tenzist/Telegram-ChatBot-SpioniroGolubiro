import fetch from "node-fetch";
import { configDotenv } from "dotenv";

configDotenv();

const { BM_TOKEN } = process.env;
const PLAYER_ID = 217865317;

const headers = {
    Authorization: `Bearer ${BM_TOKEN}`,
    'Content-Type': 'application/json',
};

const getServerName = async (serverId) => {
    try {
        const res = await fetch(`https://api.battlemetrics.com/servers/${serverId}`, { headers });
        const json = await res.json();
        return json.data?.attributes?.name || "Неизвестный сервер";
    } catch (err) {
        console.error(`Ошибка при получении сервера ${serverId}:`, err.message);
        return "Ошибка при получении имени сервера";
    }
};

let lastStop = null; // храним последнее значение stop

const checkSession = async () => {
    try {
        const sessionRes = await fetch(`https://api.battlemetrics.com/players/${PLAYER_ID}/relationships/sessions`, { headers });
        const sessionJson = await sessionRes.json();

        const sessions = sessionJson.data;
        if (!sessions.length) {
            console.log("Сессии не найдены.");
            return;
        }

        const session = sessions[0];
        const { start, stop, name } = session.attributes;
        const serverId = session.relationships.server?.data?.id;
        const serverName = serverId ? await getServerName(serverId) : "Нет сервера";

        if (lastStop === null && stop === null) {
            lastStop = stop;
            return;
        }

        if (lastStop === null && stop !== null) {
            console.log(`${name} вышел с сервера "${serverName}"`);
            lastStop = stop;
            return;
        }

        if (lastStop !== null && stop === null) {
            console.log(`${name} в сети на сервере "${serverName}"`);
            lastStop = stop;
            return;
        }

    } catch (err) {
        console.error("Ошибка при проверке сессии:", err.message);
    }
};

checkSession();
setInterval(checkSession, 20 * 1000);
