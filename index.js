require('dotenv').config();
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const DB_PATH = './tw_casual14.sqlite';
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const WORLD_HOST = process.env.TW_WORLD_HOST || 'itc1.tribals.it';

// 1. INIZIALIZZAZIONE DATABASE LOCALE
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS villages (
      id INTEGER PRIMARY KEY,
      name TEXT,
      x INTEGER,
      y INTEGER,
      player_id INTEGER,
      points INTEGER
    )
  `);

  db.run(`CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, name TEXT)`);
});

// Helper per notifiche Discord
async function sendDiscordNotification(embedData) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, { embeds: [embedData] });
  } catch (err) {
    console.error('Errore invio Discord Webhook:', err.message);
  }
}

// 2. FETCH GIOCATORI PER NOMI
async function updatePlayersCache() {
  try {
    const res = await axios.get(`https://${WORLD_HOST}/map/player.txt`);
    const lines = res.data.split('\n');

    db.run('DELETE FROM players');
    const stmt = db.prepare('INSERT INTO players VALUES (?, ?)');
    for (const line of lines) {
      if (!line) continue;
      const [id, name] = line.split(',');
      stmt.run(parseInt(id), decodeURIComponent(name.replace(/\+/g, ' ')));
    }
    stmt.finalize();
  } catch (err) {
    console.error('Errore aggiornamento player cache:', err.message);
  }
}

function getPlayerName(id) {
  return new Promise((resolve) => {
    if (id === 0) return resolve('Nessuno (Barbaro)');
    db.get('SELECT name FROM players WHERE id = ?', [id], (err, row) => {
      resolve(row ? row.name : `Giocatore #${id}`);
    });
  });
}

// 3. MONITORAGGIO COMPARSA BARBARI
async function checkBarbarians() {
  try {
    const res = await axios.get(`https://${WORLD_HOST}/map/village.txt`);
    const lines = res.data.trim().split('\n');

    const knownVillages = await new Promise((resolve) => {
      db.all('SELECT id, player_id, points FROM villages', [], (err, rows) => {
        const map = new Map();
        if (rows) rows.forEach(r => map.set(r.id, r));
        resolve(map);
      });
    });

    const isFirstRun = knownVillages.size === 0;

    for (const line of lines) {
      if (!line) continue;
      const [id, rawName, x, y, playerId, points] = line.split(',');
      const vId = parseInt(id);
      const vX = parseInt(x);
      const vY = parseInt(y);
      const vPlayerId = parseInt(playerId);
      const vPoints = parseInt(points);
      const vName = decodeURIComponent(rawName.replace(/\+/g, ' '));

      const oldState = knownVillages.get(vId);

      if (!isFirstRun) {
        // CASO 1: Un giocatore diventa BARBARO (Punti Grigi)
        if (oldState && oldState.player_id !== 0 && vPlayerId === 0) {
          const exPlayerName = await getPlayerName(oldState.player_id);

          const embed = {
            title: '📜 UN GIOCATORE È DIVENTATO BARBARO!',
            color: 0x95a5a6, // Grigio
            fields: [
              { name: 'Coordinate', value: `[${vX}|${vY}](https://${WORLD_HOST}/game.php?screen=info_village&id=${vId})`, inline: true },
              { name: 'Punti', value: `${vPoints} pt`, inline: true },
              { name: 'Ex Proprietario', value: exPlayerName, inline: false }
            ],
            footer: { text: `Casual 14 • ${new Date().toLocaleTimeString('it-IT')}` }
          };

          await sendDiscordNotification(embed);
        }

        // CASO 2: Compare un nuovo villaggio barbaro
        if (!oldState && vPlayerId === 0) {
          const embed = {
            title: '🏕️ NUOVO VILLAGGIO BARBARO SPUNTATO!',
            color: 0x2ecc71, // Verde
            fields: [
              { name: 'Coordinate', value: `[${vX}|${vY}](https://${WORLD_HOST}/game.php?screen=info_village&id=${vId})`, inline: true },
              { name: 'Punti Iniziali', value: `${vPoints} pt`, inline: true }
            ],
            footer: { text: `Casual 14 • ${new Date().toLocaleTimeString('it-IT')}` }
          };

          await sendDiscordNotification(embed);
        }
      }

      // Aggiorna DB
      db.run(
        `INSERT OR REPLACE INTO villages (id, name, x, y, player_id, points) VALUES (?, ?, ?, ?, ?, ?)`,
        [vId, vName, vX, vY, vPlayerId, vPoints]
      );
    }

  } catch (error) {
    console.error('Errore durante il controllo dei barbari:', error.message);
  }
}

// 4. ESECUZIONE PERIODICA
(async () => {
  console.log('Avvio monitoraggio Barbari e Punti Grigi su Casual 14...');
  await updatePlayersCache();
  await checkBarbarians();

  // Aggiorna nomi giocatori ogni 30 min
  cron.schedule('*/30 * * * *', async () => {
    await updatePlayersCache();
  });

  // Controlla la mappa ogni 2 minuti
  cron.schedule('*/2 * * * *', async () => {
    await checkBarbarians();
  });
})();
