// ===== FIX: undici File error =====
if (typeof File === 'undefined') global.File = class File {};

'use strict';
require('dotenv').config();

const path = require('path');
const { Client, Options }           = require('discord.js-selfbot-v13');
const { joinVoiceChannel,
        getVoiceConnection,
        VoiceConnectionStatus,
        VoiceConnectionDisconnectReason,
        entersState }               = require('@discordjs/voice');
const express                       = require('express');

// ─── ENV VALIDATION ───────────────────────────────────────────────────────────
const CONFIG = {
  token    : process.env.DISCORD_TOKEN || process.env.token,
  guildId  : process.env.GUILD_ID || process.env.server,
  channelId: process.env.VOICE_CHANNEL_ID || process.env.id,
};
const missing = Object.entries(CONFIG)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const TOKEN      = CONFIG.token;
const GUILD_ID   = CONFIG.guildId;
const CHANNEL_ID = CONFIG.channelId;
const PORT       = Number(process.env.PORT) || 3500;

// ─── RECONNECT CONFIG ─────────────────────────────────────────────────────────
const RECONNECT = {
  baseDelay             : 15_000,  // 15s initial: avoid an immediate leave/join loop
  maxDelay              : 5 * 60_000,
  factor                : 2,
  readyTimeout          : 20_000,
  stableReadyFor         : 60_000,
  removalDelay           : 5 * 60_000,
  maxRejoinsBeforeRebuild: 4,
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  connecting    : false,
  reconnectTimer: null,
  reconnectAt   : null,   // timestamp ที่จะ reconnect (ms)
  retryCount    : 0,
  inChannel     : false,
  stableTimer   : null,
  rejoinFailures: 0,
  shuttingDown  : false,
  lastVoiceEvent: 'Starting',
};

// ─── LOGGING ──────────────────────────────────────────────────────────────────
const ts  = () => new Date().toTimeString().slice(0, 8);
const log = {
  info : (...a) => console.log( `[${ts()}]`, ...a),
  error: (...a) => console.error(`[${ts()}] ❌`, ...a),
};

// ─── VOICE ────────────────────────────────────────────────────────────────────
function clearStableTimer() {
  clearTimeout(state.stableTimer);
  state.stableTimer = null;
}

function isCurrentConnection(conn) {
  return getVoiceConnection(GUILD_ID) === conn;
}

function destroyConnection() {
  clearStableTimer();
  state.inChannel = false;
  try {
    const conn = getVoiceConnection(GUILD_ID);
    if (conn) {
      conn.removeAllListeners();
      conn.destroy();
    }
  } catch {}
}

function markReady(conn) {
  if (!isCurrentConnection(conn)) return;

  state.inChannel = true;
  state.lastVoiceEvent = 'Voice connection ready';
  clearStableTimer();

  // A connection that only reaches Ready briefly is not a successful recovery.
  // Reset the backoff only after it has remained stable for a full minute.
  state.stableTimer = setTimeout(() => {
    if (!isCurrentConnection(conn) || conn.state.status !== VoiceConnectionStatus.Ready) return;
    state.retryCount = 0;
    state.rejoinFailures = 0;
    log.info('✅ Voice connection stable — reconnect backoff reset');
  }, RECONNECT.stableReadyFor);
}

function disconnectDescription(next) {
  if (next.reason === VoiceConnectionDisconnectReason.WebSocketClose) {
    return `voice WebSocket closed (${next.closeCode ?? 'unknown'})`;
  }
  return `voice disconnected (${next.reason ?? 'unknown reason'})`;
}

function watchConnection(conn, guild) {
  conn.on('error', err => {
    log.error('Voice connection error:', err.message);
  });

  conn.on('stateChange', (_, next) => {
    if (!isCurrentConnection(conn) || state.shuttingDown) return;

    if (next.status === VoiceConnectionStatus.Ready) {
      markReady(conn);
      return;
    }

    if (next.status !== VoiceConnectionStatus.Disconnected) return;

    state.inChannel = false;
    clearStableTimer();
    const reason = disconnectDescription(next);
    state.lastVoiceEvent = reason;
    log.info(`${reason} — scheduling recovery`);

    // 4014 indicates Discord does not want an immediate reconnect. This often
    // accompanies a kick/remove, so use the longest initial delay.
    const minimumDelay =
      next.reason === VoiceConnectionDisconnectReason.WebSocketClose && next.closeCode === 4014
        ? RECONNECT.removalDelay
        : 0;
    scheduleReconnect(guild, reason, minimumDelay);
  });
}

async function waitForReady(conn, guild, context) {
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, RECONNECT.readyTimeout);
    markReady(conn);
    log.info(`📢 Voice ready (${context})`);
    return true;
  } catch (err) {
    if (!isCurrentConnection(conn) || state.shuttingDown) return false;
    state.inChannel = false;
    clearStableTimer();
    const reason = `${context} timed out waiting for Ready`;
    state.lastVoiceEvent = reason;
    log.info(`${reason} — scheduling recovery`);
    scheduleReconnect(guild, reason);
    return false;
  }
}

async function connect(guild) {
  if (state.connecting || state.shuttingDown) return;

  const existing = getVoiceConnection(GUILD_ID);
  if (existing) {
    if (existing.state.status === VoiceConnectionStatus.Ready) markReady(existing);
    // Never destroy an in-flight connection merely because it is not Ready yet.
    // It may be completing Discord's built-in reconnect.
    else await waitForReady(existing, guild, 'existing connection');
    return;
  }

  state.connecting = true;

  try {
    const channel = guild.channels.cache.get(CHANNEL_ID);

    if (!channel || ![2, 'GUILD_VOICE'].includes(channel.type)) {
      log.error('Voice channel not found or invalid — check env id');
      return;
    }

    const conn = joinVoiceChannel({
      channelId      : channel.id,
      guildId        : guild.id,
      adapterCreator : guild.voiceAdapterCreator,
      selfMute       : true,
      selfDeaf       : true,
    });

    watchConnection(conn, guild);
    state.lastVoiceEvent = 'Connecting to voice';
    log.info(`🔊 Connecting to: #${channel.name}`);
    await waitForReady(conn, guild, 'new connection');

  } catch (err) {
    log.error('connect():', err.message);
    state.lastVoiceEvent = 'Could not create voice connection';
    scheduleReconnect(guild, 'could not create voice connection');
  } finally {
    state.connecting = false;
  }
}

function scheduleReconnect(guild, reason, minimumDelay = 0) {
  if (state.shuttingDown || state.reconnectTimer) return;

  const backoffDelay = Math.min(
    RECONNECT.baseDelay * RECONNECT.factor ** state.retryCount,
    RECONNECT.maxDelay
  );
  const delay = Math.max(backoffDelay, minimumDelay);
  state.retryCount++;
  state.reconnectAt = Date.now() + delay;  // บันทึกเวลาที่จะ reconnect
  log.info(`🔄 Recovery in ${delay / 1000}s (attempt ${state.retryCount}; ${reason})`);

  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    state.reconnectAt    = null;
    if (state.shuttingDown) return;

    const conn = getVoiceConnection(GUILD_ID);
    if (!conn) {
      await connect(guild);
      return;
    }

    if (conn.state.status === VoiceConnectionStatus.Ready) {
      markReady(conn);
      return;
    }

    if (conn.state.status !== VoiceConnectionStatus.Disconnected) {
      // Discord may already be performing its own recovery. Wait rather than
      // creating another Voice connection and generating another join event.
      await waitForReady(conn, guild, 'Discord recovery');
      return;
    }

    if (state.rejoinFailures >= RECONNECT.maxRejoinsBeforeRebuild) {
      log.info('Voice recovery limit reached — rebuilding connection once');
      state.rejoinFailures = 0;
      destroyConnection();
      await connect(guild);
      return;
    }

    state.rejoinFailures++;
    state.lastVoiceEvent = 'Recovering existing voice connection';
    if (!conn.rejoin()) {
      log.info('Existing voice connection could not rejoin — retrying later');
      scheduleReconnect(guild, 'existing connection refused rejoin');
      return;
    }
    await waitForReady(conn, guild, 'rejoin');
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
    state.inChannel = false;
    clearStableTimer();
    state.lastVoiceEvent = 'Removed from voice channel';
    // Do not leave and immediately join again after a kick/remove. The existing
    // connection is allowed to settle, then recovery waits five minutes.
    scheduleReconnect(newVS.guild, 'removed from voice channel', RECONNECT.removalDelay);
  } else if (moved) {
    log.info(`📥 Moved to #${newVS.channel?.name}`);
    state.lastVoiceEvent = 'Moved to another voice channel';
  }
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
function shutdown(signal) {
  log.info(`${signal} — shutting down`);
  state.shuttingDown = true;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.reconnectAt = null;
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
app.use((_, res, next) => {
  res.set({
    'Cache-Control'            : 'no-store',
    'Content-Security-Policy'  : "default-src 'self'; connect-src 'self'; font-src https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    'Permissions-Policy'       : 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy'          : 'no-referrer',
    'X-Content-Type-Options'   : 'nosniff',
    'X-Frame-Options'          : 'DENY',
    'X-Robots-Tag'             : 'noindex, nofollow',
  });
  next();
});

function voiceStatus() {
  const conn = getVoiceConnection(GUILD_ID);
  const voice = conn?.state.status ?? 'disconnected';
  const online = state.inChannel && voice === VoiceConnectionStatus.Ready;

  return {
    online,
    voice,
    uptime: Math.floor(process.uptime()),
    retryCount: state.retryCount,
    reconnectIn: state.reconnectAt
      ? Math.max(0, Math.ceil((state.reconnectAt - Date.now()) / 1000))
      : null,
    lastVoiceEvent: state.lastVoiceEvent,
  };
}

// Serve static HTML file (index.html)
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Use only this endpoint as Render's health check. It deliberately reports the
// process health, not voice health, so a temporary voice issue cannot restart
// the service and create an unnecessary new Voice session.
app.get('/healthz', (_, res) => {
  res.status(200).json({ ok: true, uptime: Math.floor(process.uptime()) });
});

// This is intentionally read-only and does not disclose Discord/server details.
// /ping remains for existing external monitors: do not configure it as Render's
// health check because 503 means the Voice connection, not the web process, is down.
function sendVoiceStatus(_, res) {
  const status = voiceStatus();
  res.status(status.online ? 200 : 503).json(status);
}
app.get('/ping', sendVoiceStatus);
app.get('/voice-status', sendVoiceStatus);
app.get('/api/stats', (_, res) => {
  res.status(200).json(voiceStatus());
});

app.listen(PORT, () => log.info(`🌐 Health & Dashboard server running on :${PORT}`));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
