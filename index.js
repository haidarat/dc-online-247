'use strict';
require('dotenv').config();

const http = require('node:http');
const { Client, Options } = require('discord.js-selfbot-v13');
const WebSocketShard = require('discord.js-selfbot-v13/src/client/websocket/WebSocketShard');

// ─── BANDWIDTH OPTIMIZATION: INTERCEPT & DROP OPCODES 37 & 14 ───────────────
// Drop GUILD_SUBSCRIPTIONS_BULK (Op 37) and GUILD_SUBSCRIPTIONS (Op 14).
// This prevents Discord from streaming endless typing indicators, member activity/presences,
// and thread lists across all servers the account is in, reducing bandwidth by 80-95%.
const origShardSend = WebSocketShard.prototype.send;
WebSocketShard.prototype.send = function (data, important) {
  if (data && (data.op === 37 || data.op === 14)) {
    return;
  }
  return origShardSend.call(this, data, important);
};

const TOKEN = process.env.DISCORD_TOKEN || process.env.token;
const GUILD_ID = process.env.GUILD_ID || process.env.server;
const CHANNEL_ID = process.env.VOICE_CHANNEL_ID || process.env.id;
const PORT = Number(process.env.PORT) || 3500;

const missing = [
  !TOKEN && 'DISCORD_TOKEN',
  !GUILD_ID && 'GUILD_ID',
  !CHANNEL_ID && 'VOICE_CHANNEL_ID',
].filter(Boolean);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// Exponential Backoff configuration (3s → 6s → 12s ... max 60s)
const RECONNECT = {
  baseDelay: 3_000,
  maxDelay : 60_000,
  factor   : 2,
};
let retryCount = 0;

let selfId = null;
const client = new Client({
  intents: ['GUILDS', 'GUILD_VOICE_STATES'],
  partials: [],
  makeCache: Options.cacheWithLimits({
    ApplicationCommandManager: 0,
    GuildEmojiManager: 0,
    GuildMemberManager: {
      maxSize: 1,
      keepOverLimit: member => member.id === (selfId || client.user?.id),
    },
    GuildStickerManager: 0,
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
    UserManager: 1,
    VoiceStateManager: {
      maxSize: 1,
      keepOverLimit: voiceState => voiceState.id === (selfId || client.user?.id),
    },
  }),
});

// Also intercept client.ws.broadcast as defense-in-depth
const origBroadcast = client.ws.broadcast.bind(client.ws);
client.ws.broadcast = function (packet) {
  if (packet && (packet.op === 37 || packet.op === 14)) {
    return;
  }
  return origBroadcast(packet);
};

let joining = false;
let rejoinTimer = null;
let inTargetChannel = false;

const timestamp = () => new Date().toTimeString().slice(0, 8);
const log = (...args) => console.log(`[${timestamp()}]`, ...args);
const logError = (...args) => console.error(`[${timestamp()}] ❌`, ...args);

function clearRejoinTimer() {
  clearTimeout(rejoinTimer);
  rejoinTimer = null;
}

function resetVoiceConnection() {
  const connection = client.voice.connection;
  if (!connection) return;

  const rawSocket = connection.sockets?.ws?.ws;
  if (rawSocket) rawSocket.onerror = () => {};
  clearTimeout(connection.connectTimeout);
  try {
    connection.disconnect();
  } catch {}
  if (client.voice.connection === connection) client.voice.connection = null;
}

function scheduleRejoin(guild, reason) {
  if (rejoinTimer) return;

  const delay = Math.min(
    RECONNECT.baseDelay * (RECONNECT.factor ** retryCount),
    RECONNECT.maxDelay
  );
  retryCount++;

  log(`🔄 Rejoining in ${delay / 1000}s (attempt ${retryCount}) (${reason})`);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    joinTargetChannel(guild);
  }, delay).unref();
}

function watchVoiceConnection(connection, guild) {
  // Bandwidth optimization: Clean up unnecessary incoming UDP packet handlers on the socket
  const udpSocket = connection.sockets?.udp?.socket;
  if (udpSocket) {
    udpSocket.removeAllListeners('message');
  }

  connection.once('error', error => {
    logError(`Voice connection error: ${error.message}`);
    if (inTargetChannel) return;
    resetVoiceConnection();
    scheduleRejoin(guild, 'voice connection error');
  });

  connection.once('disconnect', () => {
    if (inTargetChannel) return;
    resetVoiceConnection();
    scheduleRejoin(guild, 'voice disconnected');
  });
}

async function joinTargetChannel(guild) {
  if (joining) {
    scheduleRejoin(guild, 'join already in progress');
    return;
  }

  joining = true;
  try {
    // Check voice state directly from cache (Zero HTTP REST API calls)
    const cachedVoiceState = guild.voiceStates.cache.get(client.user.id);
    if (cachedVoiceState?.channelId === CHANNEL_ID) {
      inTargetChannel = true;
      retryCount = 0;
      clearRejoinTimer();
      log('✅ Already in the target channel');
      return;
    }

    const selfMember = guild.members.cache.get(client.user.id) || (await guild.members.fetch(client.user.id).catch(() => null));
    if (selfMember?.voice?.channelId === CHANNEL_ID) {
      inTargetChannel = true;
      retryCount = 0;
      clearRejoinTimer();
      log('✅ Already in the target channel');
      return;
    }

    const channel = guild.channels.cache.get(CHANNEL_ID) || (await guild.channels.fetch(CHANNEL_ID).catch(() => null));
    if (!channel) throw new Error('Voice channel not found — check VOICE_CHANNEL_ID');

    log(`🔊 Joining: #${channel.name}`);
    const connection = await client.voice.joinChannel(channel, { selfMute: true, selfDeaf: true });
    watchVoiceConnection(connection, guild);

    inTargetChannel = true;
    retryCount = 0;
    clearRejoinTimer();
    log(`✅ Joined: #${channel.name}`);
  } catch (error) {
    if (inTargetChannel) {
      log(`⚠️ Voice transport failed, but the account remains in the target channel: ${error.message}`);
      return;
    }
    logError(`Voice join failed: ${error.message}`);
    resetVoiceConnection();
    scheduleRejoin(guild, 'voice connection failed');
  } finally {
    joining = false;
  }
}

client.once('ready', () => {
  selfId = client.user.id;
  log(`✅ Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    logError('Guild not found — check GUILD_ID');
    return;
  }

  joinTargetChannel(guild);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (newState.id !== client.user?.id || newState.guild?.id !== GUILD_ID) return;

  if (newState.channelId === CHANNEL_ID) {
    inTargetChannel = true;
    retryCount = 0;
    clearRejoinTimer();
    log(`📥 In target channel: #${newState.channel?.name}`);
    return;
  }

  const previousChannel = oldState.channel?.name || 'target voice channel';
  const reason = newState.channelId
    ? `moved away from #${previousChannel}`
    : `removed from #${previousChannel}`;

  inTargetChannel = false;
  if (!joining) resetVoiceConnection();
  scheduleRejoin(newState.guild, reason);
});

// Ultra-lightweight Health server for Render / cron-job.org
const HEALTH_RESPONSE = Buffer.from('{"ok":true}');
http.createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': HEALTH_RESPONSE.length,
      'Connection': 'close',
    });
    response.end(HEALTH_RESPONSE);
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' });
  response.end('Not found');
}).listen(PORT, () => log(`🌐 Health server running on :${PORT}`));

client.login(TOKEN).catch(error => logError(`Login failed: ${error.message}`));
