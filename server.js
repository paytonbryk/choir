import Fastify from 'fastify';
import FastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fastify = Fastify({ logger: false });

await fastify.register(FastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/',
  index: 'index.html',
});

const io = new Server(fastify.server);

// lobbies: Map<code, { players: Map<socketId, playerState>, started: boolean }>
const lobbies = new Map();

function generateCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function lobbySnapshot(lobby) {
  return {
    players: Object.fromEntries(
      [...lobby.players.entries()].map(([id, p]) => [id, { ...p }])
    ),
    started: lobby.started,
  };
}

function broadcastLobby(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  io.to(code).emit('lobby:update', { code, ...lobbySnapshot(lobby) });
}

io.on('connection', (socket) => {

  // ── Lobby creation ──────────────────────────────────────────────
  socket.on('lobby:create', (settings, ack) => {
    let code;
    do { code = generateCode(); } while (lobbies.has(code));

    const lobby = {
      players: new Map([[socket.id, {
        slot: 0,
        ready: false,
        pitch: settings.pitch ?? 195.9,
        vibrato: settings.vibrato ?? true,
        pan: 0,
        reverb: 0,
        amplitude: 0.5,
      }]]),
      started: false,
    };
    lobbies.set(code, lobby);
    socket.join(code);
    socket.data.lobbyCode = code;

    ack?.({ ok: true, code, slot: 0 });
    broadcastLobby(code);
  });

  // ── Join lobby ──────────────────────────────────────────────────
  socket.on('lobby:join', (code, settings, ack) => {
    code = code.toUpperCase();
    const lobby = lobbies.get(code);

    if (!lobby)                          return ack?.({ ok: false, reason: 'not_found' });
    if (lobby.started)                   return ack?.({ ok: false, reason: 'already_started' });
    if (lobby.players.size >= 4)         return ack?.({ ok: false, reason: 'full' });
    if (lobby.players.has(socket.id))    return ack?.({ ok: false, reason: 'already_in_lobby' });

    // find first free slot 0-3
    const usedSlots = new Set([...lobby.players.values()].map(p => p.slot));
    const slot = [0,1,2,3].find(s => !usedSlots.has(s));

    lobby.players.set(socket.id, {
      slot,
      ready: false,
      pitch: settings.pitch ?? 195.9,
      vibrato: settings.vibrato ?? true,
      pan: 0,
      reverb: 0,
      amplitude: 0.5,
    });

    socket.join(code);
    socket.data.lobbyCode = code;

    ack?.({ ok: true, code, slot });
    broadcastLobby(code);
  });

  // ── Player updates settings (pre-game) ─────────────────────────
  socket.on('lobby:settings', (settings) => {
    const code = socket.data.lobbyCode;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    const player = lobby.players.get(socket.id);
    if (!player) return;

    if (settings.pitch   !== undefined) player.pitch   = settings.pitch;
    if (settings.vibrato !== undefined) player.vibrato = settings.vibrato;
    broadcastLobby(code);
  });

  // ── Ready up ────────────────────────────────────────────────────
  socket.on('lobby:ready', (isReady) => {
    const code = socket.data.lobbyCode;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    const player = lobby.players.get(socket.id);
    if (!player) return;

    player.ready = isReady;

    const allReady = [...lobby.players.values()].every(p => p.ready);
    if (allReady && lobby.players.size >= 2) {
      lobby.started = true;
      // emit start so clients switch to in-game UI
      io.to(code).emit('game:start', { code, ...lobbySnapshot(lobby) });
    } else {
      broadcastLobby(code);
    }
  });

  // ── In-game parameter update (amp, reverb, pan) ─────────────────
  socket.on('game:params', (params) => {
    const code = socket.data.lobbyCode;
    const lobby = lobbies.get(code);
    if (!lobby || !lobby.started) return;
    const player = lobby.players.get(socket.id);
    if (!player) return;

    if (params.amplitude !== undefined) player.amplitude = params.amplitude;
    if (params.reverb    !== undefined) player.reverb    = params.reverb;
    if (params.pan       !== undefined) player.pan       = params.pan;

    // broadcast updated state to everyone in room
    io.to(code).emit('game:update', { code, ...lobbySnapshot(lobby) });
  });

  // ── Disconnect ──────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;

    lobby.players.delete(socket.id);
    if (lobby.players.size === 0) {
      lobbies.delete(code);
    } else {
      broadcastLobby(code);
    }
  });
});

const port = process.env.PORT ?? 3000;
await fastify.listen({ port, host: '0.0.0.0' });
console.log(`Server running on port ${port}`);