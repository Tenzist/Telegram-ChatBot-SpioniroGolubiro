import Database from 'better-sqlite3';

const db = new Database('tracked.db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS tracked (
    playerId TEXT NOT NULL,
    chatId INTEGER NOT NULL,
    PRIMARY KEY (playerId, chatId)
  )
`).run();

export default db;
