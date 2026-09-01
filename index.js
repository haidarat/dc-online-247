'use strict';
require('dotenv').config();

const http = require('node:http');
const { Client, Options } = require('discord.js-selfbot-v13');

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

const REJOIN_DELAY_MS = 10_000;
let selfId = null;
const client = new Client({
  partials: [],
  // Keep the self member/Voice state plus, at most, one transient entry. The
  // Guild and channel caches are deliberately left untouched because the
  // library needs them to resolve and join the configured channel.
  makeCache: Options.cacheWithLimits({
    ApplicationCommandManager: 0,
    GuildEmojiManager: 0,
    GuildMemberManager: {
      maxSize: 1,
      keepOverLimit: member => member.id === selfId,
    },
    GuildStickerManager: 0,
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
    UserManager: 1,
    VoiceStateManager: {
      maxSize: 1,
      keepOverLimit: voiceState => voiceState.id === selfId,
    },
  }),
});

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

  // Clear the previous connection before joining again. The library otherwise
  // treats the old target channel as current and ignores the requested rejoin.
  // Its cleanup removes the VoiceWebSocket error listener before closing a
  // socket that is still connecting, so silence that late raw-socket error.
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

  log(`🔄 Rejoining in ${REJOIN_DELAY_MS / 1000}s (${reason})`);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    joinTargetChannel(guild);
  }, REJOIN_DELAY_MS).unref();
}

function watchVoiceConnection(connection, guild) {
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
    const selfMember = guild.members.cache.get(client.user.id) || await guild.members.fetch(client.user.id);
    inTargetChannel = selfMember.voice.channelId === CHANNEL_ID;
    if (inTargetChannel) {
      clearRejoinTimer();
      log('✅ Already in the target channel');
      return;
    }

    const channel = guild.channels.cache.get(CHANNEL_ID) || await guild.channels.fetch(CHANNEL_ID);
    if (!channel) throw new Error('Voice channel not found — check VOICE_CHANNEL_ID');

    log(`🔊 Joining: #${channel.name}`);
    const connection = await client.voice.joinChannel(channel, { selfMute: true, selfDeaf: true });
    watchVoiceConnection(connection, guild);

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
    log(`📥 In target channel: #${newState.channel?.name}`);
    return;
  }

  const previousChannel = oldState.channel?.name || 'target voice channel';
  const reason = newState.channelId
    ? `moved away from #${previousChannel}`
    : `removed from #${previousChannel}`;

  inTargetChannel = false;
  // A join that is still authenticating owns its timeout and promise. Closing
  // it here clears that timeout but leaves the promise pending forever. Queue
  // the rejoin and let the active join finish or fail first.
  if (!joining) resetVoiceConnection();
  scheduleRejoin(newState.guild, reason);
});

http.createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}).listen(PORT, () => log(`🌐 Health server running on :${PORT}`));

client.login(TOKEN).catch(error => logError(`Login failed: ${error.message}`));
