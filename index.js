// ===== FIX: undici File error =====
if (typeof File === 'undefined') global.File = class File {};

'use strict';
require('dotenv').config();

const os   = require('os');
const path = require('path');
const { Client, Options }           = require('discord.js-selfbot-v13');
const { joinVoiceChannel,
        getVoiceConnection,
        VoiceConnectionStatus }     = require('@discordjs/voice');
const express                       = require('express');

// ─── ENV VALIDATION ───────────────────────────────────────────────────────────
const REQUIRED_ENV = ['token', 'server', 'id'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const TOKEN      = process.env.token;
const GUILD_ID   = process.env.server;
const CHANNEL_ID = process.env.id;
const PORT       = Number(process.env.PORT) || 3500;

// ─── RECONNECT CONFIG ─────────────────────────────────────────────────────────
const RECONNECT = {
  baseDelay : 3_000,   // 3s initial
  maxDelay  : 60_000,  // 1 min cap
  factor    : 2,       // exponential backoff
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  connecting    : false,
  reconnectTimer: null,
  retryCount    : 0,
  inChannel     : false,
};

// CPU Usage Calculation Helper
function getCpuUsage() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  for (const cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys  += cpu.times.sys;
    idle += cpu.times.idle;
    irq  += cpu.times.irq;
  }
  const total = user + nice + sys + idle + irq;
  return { idle, total };
}
let startCpu = getCpuUsage();

function calculateCpuPercent() {
  const endCpu = getCpuUsage();
  const idleDiff = endCpu.idle - startCpu.idle;
  const totalDiff = endCpu.total - startCpu.total;
  startCpu = endCpu;
  if (totalDiff === 0) return '0.0';
  const percentage = 100 - Math.floor((100 * idleDiff) / totalDiff);
  return percentage.toFixed(1);
}

// ─── LOGGING ──────────────────────────────────────────────────────────────────
const ts  = () => new Date().toTimeString().slice(0, 8);
const log = {
  info : (...a) => console.log( `[${ts()}]`, ...a),
  error: (...a) => console.error(`[${ts()}] ❌`, ...a),
};

// ─── VOICE ────────────────────────────────────────────────────────────────────
function destroyConnection() {
  state.inChannel = false;
  try {
    const conn = getVoiceConnection(GUILD_ID);
    if (conn) {
      conn.removeAllListeners();
      conn.destroy();
    }
  } catch {}
}

async function connect(guild) {
  if (state.connecting) return;

  const existing = getVoiceConnection(GUILD_ID);
  if (existing?.state.status === VoiceConnectionStatus.Ready) return;

  state.connecting = true;

  try {
    const channel = guild.channels.cache.get(CHANNEL_ID);

    if (!channel || ![2, 'GUILD_VOICE'].includes(channel.type)) {
      log.error('Voice channel not found or invalid — check env id');
      return;
    }

    destroyConnection();

    const conn = joinVoiceChannel({
      channelId      : channel.id,
      guildId        : guild.id,
      adapterCreator : guild.voiceAdapterCreator,
      selfMute       : true,
      selfDeaf       : true,
    });

    conn.on('stateChange', (_, next) => {
      if (next.status === VoiceConnectionStatus.Disconnected) {
        log.info('Connection dropped — scheduling reconnect');
        destroyConnection();
        scheduleReconnect(guild);
      }
    });

    state.retryCount = 0;
    state.inChannel  = true;
    log.info(`📢 Joined: #${channel.name}`);

  } catch (err) {
    log.error('connect():', err.message);
    scheduleReconnect(guild);
  } finally {
    state.connecting = false;
  }
}

function scheduleReconnect(guild) {
  if (state.reconnectTimer) return;

  const delay = Math.min(
    RECONNECT.baseDelay * RECONNECT.factor ** state.retryCount,
    RECONNECT.maxDelay
  );
  state.retryCount++;
  log.info(`🔄 Reconnect in ${delay / 1000}s (attempt ${state.retryCount})`);

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect(guild);
  }, delay);
}

// ─── DISCORD CLIENT ───────────────────────────────────────────────────────────
const client = new Client({
  makeCache: Options.cacheWithLimits({
    MessageManager     : 0,
    PresenceManager    : 0,
    GuildMemberManager : { maxSize: 1 },
    UserManager        : { maxSize: 1 },
    ReactionManager    : 0,
    GuildEmojiManager  : 0,
    GuildStickerManager: 0,
    ThreadManager      : 0,
    VoiceStateManager  : 100,
  }),
});

client.once('ready', async () => {
  log.info(`✅ Logged in as ${client.user.tag}`);
  try { await client.user.setPresence({ status: 'online' }); } catch {}

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { log.error('Guild not found — check env server'); return; }

  await connect(guild);

  if (typeof global.gc === 'function') {
    setInterval(() => {
      try { global.gc(); } catch {}
    }, 30 * 60 * 1_000);
    log.info('🧹 GC interval registered (every 30 min)');
  }
});

client.on('voiceStateUpdate', (oldVS, newVS) => {
  if (newVS.member?.id !== client.user?.id) return;
  if (newVS.guild.id   !== GUILD_ID)        return;

  const left  = !newVS.channelId &&  oldVS.channelId;
  const moved =  newVS.channelId && (newVS.channelId !== oldVS.channelId);

  if (left) {
    log.info(`📤 Removed from #${oldVS.channel?.name}`);
    destroyConnection();
    scheduleReconnect(newVS.guild);
  } else if (moved) {
    log.info(`📥 Moved to #${newVS.channel?.name}`);
  }
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
function shutdown(signal) {
  log.info(`${signal} — shutting down`);
  clearTimeout(state.reconnectTimer);
  destroyConnection();
  client.destroy();
  process.exit(0);
}
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ─── GLOBAL SAFETY NET ────────────────────────────────────────────────────────
process.on('uncaughtException',  err => log.error('uncaughtException:',  err));
process.on('unhandledRejection', err => log.error('unhandledRejection:', err));

// ─── HEALTH SERVER ────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');

// Serve static HTML file (index.html)
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint สำหรับ /ping (UptimeRobot / External Monitors)
app.get('/ping', (_, res) => {
  const alive = state.inChannel;
  const conn = getVoiceConnection(GUILD_ID);
  const status = conn?.state.status ?? 'disconnected';

  res
    .status(alive ? 200 : 503)
    .json({
      ok: alive,
      voice: status,
      uptime: Math.floor(process.uptime()),
      retry: alive ? 0 : state.retryCount,
    });
});

// Endpoint ส่งข้อมูล JSON สถิติแบบ Real-time ให้หน้า Web Dashboard
app.get('/api/stats', (_, res) => {
  const guild = client.guilds.cache.get(GUILD_ID);
  const channel = guild?.channels.cache.get(CHANNEL_ID);

  const memUsage = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedSystemMem = totalMem - freeMem;

  res.json({
    online: state.inChannel,
    serverName: guild ? guild.name : 'Unknown Guild',
    channelName: channel ? channel.name : 'Unknown Channel',
    cpuModel: os.cpus()[0]?.model || 'Unknown CPU',
    cpu: calculateCpuPercent(),
    ramProcess: (memUsage.heapUsed / 1024 / 1024).toFixed(1),
    ramSystem: ((usedSystemMem / totalMem) * 100).toFixed(1),
    ramTotalMb: (totalMem / 1024 / 1024).toFixed(0),
    uptime: Math.floor(process.uptime()),
    botUser: client.user ? client.user.tag : 'Not Logged In',
  });
});

app.listen(PORT, () => log.info(`🌐 Health & Dashboard server running on :${PORT}`));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
