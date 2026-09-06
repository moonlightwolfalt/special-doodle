import http from 'http';
import { promises as fs } from 'fs';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, 'mope_mega');
const PORT = Number(process.env.PORT || 9339);

// ---------------------------------------------------------------------------
// Biome ids used by the merged (live) client.
//   rect biome id (u16 in object custom data) -> color
//   LAND=1 #3FBA54, OCEAN=12 #4854a2, ARCTIC=16 #c4dee7, DESERT=79 #c8b745
//   curBiome enum (u8): 0 land, 1 ocean, 2 arctic, 4 desert
// ---------------------------------------------------------------------------
const BIOME = {
  LAND: { rectId: 1, curBiome: 0 },
  OCEAN: { rectId: 12, curBiome: 1 },
  ARCTIC: { rectId: 16, curBiome: 2 },
  DESERT: { rectId: 79, curBiome: 4 },
};

// World layout (world units, origin top-left, x right / y down).
//   ARCTIC: top band       y 0..1200
//   DESERT: bottom band    y 8400..9600
//   OCEAN:  left/right of land, vertical span 1200..8400 ONLY (never overlaps
//           arctic at the top or desert at the bottom)
//   LAND:   center block between the two ocean strips and the bands
const WORLD = { w: 16000, h: 9600 };

const rect = (x, y, w, h) => ({ cx: x, cy: y, rectW: w, rectH: h });

const LAYOUT = {
  land: { ...rect(8000, 4800, 11200, 7200), biome: BIOME.LAND },
  oceanWest: { ...rect(1200, 4800, 2400, 7200), biome: BIOME.OCEAN },
  oceanEast: { ...rect(14800, 4800, 2400, 7200), biome: BIOME.OCEAN },
  arctic: { ...rect(8000, 600, 16000, 1200), biome: BIOME.ARCTIC },
  desert: { ...rect(8000, 9000, 16000, 1200), biome: BIOME.DESERT },
};
// "land is the first biome to work on": send land first.
const BIOME_ORDER = ['land', 'oceanWest', 'oceanEast', 'arctic', 'desert'];

// Game object types (verified from the live client).
const OTYPE_BIOME_RECT = 0x93; // 147
const OTYPE_TREE = 0x65; // 101
const FOOD = { coco: 0x1e, banana: 0x1d, fir: 0x30 };

// ---------------------------------------------------------------------------
// Tiny binary writer (mirrors the client's _0x34c762 semantics).
// ---------------------------------------------------------------------------
class Writer {
  constructor(size) {
    this.buf = Buffer.alloc(size);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n > this.buf.length) {
      const nb = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
      this.buf.copy(nb, 0, 0, this.len);
      this.buf = nb;
    }
  }
  u8(v) { this.ensure(1); this.buf.writeUInt8(v & 0xff, this.len); this.len += 1; }
  u16(v) { this.ensure(2); this.buf.writeUInt16BE(v & 0xffff, this.len); this.len += 2; }
  u32(v) { this.ensure(4); this.buf.writeUInt32BE(v >>> 0, this.len); this.len += 4; }
  str(s) {
    const b = Buffer.from(s || '', 'utf8');
    this.u16(b.length);
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  bytes(buf) { this.ensure(buf.length); buf.copy(this.buf, this.len); this.len += buf.length; }
  result() { return this.buf.subarray(0, this.len); }
}

// ---------------------------------------------------------------------------
// World / game-object generation
// ---------------------------------------------------------------------------
let nextId = 0x1000;
const allocId = () => ++nextId;

// A biome rect object (oType 147) in "newly visible" wire format.
function biomeRectObj(rectSpec) {
  const w = new Writer(96);
  w.u16(OTYPE_BIOME_RECT);
  w.u32(allocId());
  w.u32(Math.round(((rectSpec.rectW + rectSpec.rectH) / 2) * 4)); // rad/4
  w.u16(Math.round(rectSpec.cx * 4)); // x/4
  w.u16(Math.round(rectSpec.cy * 4)); // y/4
  w.u8(rectSpec.biome.curBiome);
  w.u8(1); // mopeSeasonID
  w.u16(0); // animalType
  w.u16(0); // speciesType
  w.u16(0); // speciesSubType
  w.u8(0x04); // bitgroup: [spawnedByID][isRect][angleUpdate][batchDraw] = 0,1,0,0
  w.u16(Math.round(rectSpec.rectW));
  w.u16(Math.round(rectSpec.rectH));
  w.u8(0); // specType (property 0x6)
  w.u8(0); // specType2 (property 0x7)
  w.u8(1); // custom isRect == 1
  w.str('#00000000'); // biomeColor (forceBiomeColor=0, so color comes from rectId)
  w.u16(rectSpec.biome.rectId);
  w.u8(0x00); // bitgroup: forceBiomeColor=0 + 4x jaggedSides=0
  return w.result();
}

// A static tree object (oType 101) in serverInfo "static" wire format.
function treeStaticObj(t) {
  const w = new Writer(32);
  w.u8(OTYPE_TREE);
  w.u32(t.id);
  w.u32(Math.round(t.rad * 4));
  w.u16(Math.round(t.x * 4));
  w.u16(Math.round(t.y * 4));
  w.u8(0); // curBiome (land)
  w.u16(t.foodType);
  w.u8(t.canopy ? 1 : 0);
  w.u8(0); // eventType
  return w.result();
}

// Live game-object generation for trees on the land biome.
function generateTrees(count) {
  const land = LAYOUT.land;
  const out = [];
  const foods = [FOOD.coco, FOOD.banana, FOOD.fir];
  const minX = land.cx - land.rectW / 2 + 120;
  const maxX = land.cx + land.rectW / 2 - 120;
  const minY = land.cy - land.rectH / 2 + 120;
  const maxY = land.cy + land.rectH / 2 - 120;
  for (let i = 0; i < count; i++) {
    out.push({
      id: allocId(),
      x: minX + Math.random() * (maxX - minX),
      y: minY + Math.random() * (maxY - minY),
      rad: 60 + Math.random() * 60,
      foodType: foods[i % foods.length],
      canopy: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Protocol messages (server -> client)
// ---------------------------------------------------------------------------
const MSG_SERVERINFO = 0x02;
const MSG_CONNECTED = 0x03;
const MSG_GAMEDIMS = 0x11;
const MSG_WORLD = 0x04;
const MSG_READY_TO_PLAY = 0x41;
const MSG_ALIVE = 0x06;

function msgServerInfo(sessionId, staticObjs) {
  const w = new Writer(128 + staticObjs.reduce((a, b) => a + b.length, 0));
  w.u8(MSG_SERVERINFO);
  w.str(sessionId || '');
  w.u16(0x128); // gameVersion == $config.gameVersion (0x128) so no reload
  w.u8(0); // gameMode
  w.u8(1); // season
  w.str('localtest-1');
  w.u8(0); // isAliveInGame
  w.u16(staticObjs.length);
  for (const o of staticObjs) w.bytes(o);
  return w.result();
}

function msgGameDims() {
  const w = new Writer(1 + 10);
  w.u8(MSG_GAMEDIMS);
  w.u16(WORLD.w);
  w.u16(WORLD.h);
  w.u16(8000 * 4); // camX (client /4 -> world x)
  w.u16(4800 * 4); // camY
  w.u16(1000); // camZoom (/1000 -> 1.0)
  return w.result();
}

function msgConnected() {
  const w = new Writer(1);
  w.u8(MSG_CONNECTED);
  return w.result();
}

function msgWorldData(biomeObjs) {
  const size = 1 + 1 + 2 + biomeObjs.reduce((a, b) => a + b.length, 0) + 2 + 2;
  const w = new Writer(size);
  w.u8(MSG_WORLD);
  w.u8(0); // settings count
  w.u16(biomeObjs.length); // newly visible count
  for (const o of biomeObjs) w.bytes(o);
  w.u16(0); // updates
  w.u16(0); // removed
  return w.result();
}

function msgAlive() {
  const w = new Writer(1);
  w.u8(MSG_ALIVE);
  return w.result();
}

function msgReadyToPlay() {
  const w = new Writer(1);
  w.u8(MSG_READY_TO_PLAY);
  return w.result();
}

// ---------------------------------------------------------------------------
// Minimal RFC6455 WebSocket (no deps): masked client frames, unmasked server
// ---------------------------------------------------------------------------
class WsConn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => {
      this.closed = true;
      this.onClose && this.onClose();
    });
    socket.on('error', () => {});
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      let mask;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = b.subarray(off + len);
      if (opcode === 0x8) {
        this.sendFrame(0x8, Buffer.from([0x03, 0xe8]));
        this.socket.end();
        return;
      } else if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
      } else if (opcode === 0x2 || opcode === 0x1) {
        if (fin && this.onMessage) this.onMessage(payload);
      }
    }
  }
  sendFrame(opcode, payload) {
    if (this.closed) return;
    const header = [0x80 | opcode];
    if (payload.length < 126) {
      header.push(payload.length);
    } else if (payload.length < 65536) {
      header.push(126);
      const h = Buffer.alloc(2);
      h.writeUInt16BE(payload.length);
      header.push(...h);
    } else {
      header.push(127);
      const h = Buffer.alloc(8);
      h.writeBigUInt64BE(BigInt(payload.length));
      header.push(...h);
    }
    this.socket.write(Buffer.concat([Buffer.from(header), payload]));
  }
  send(payload) {
    this.sendFrame(0x2, payload);
  }
}

// ---------------------------------------------------------------------------
// Game server logic
// ---------------------------------------------------------------------------
const trees = generateTrees(Number(process.env.TREE_COUNT || 40));
const staticObjs = trees.map(treeStaticObj);

function handleGameMessage(conn, payload) {
  if (!payload.length) return;
  const type = payload[0];
  switch (type) {
    case 0x01: {
      // Join: [u8 1][u16 screenW][u16 screenH][u16 0xfa][string sessionId]
      const sessionId = payload.length >= 8 ? payload.subarray(7).toString('utf8') : '';
      console.log('[game] join sessionId=' + sessionId + ' hex=' + payload.toString('hex'));
      conn.send(msgServerInfo(sessionId, staticObjs));
      conn.send(msgGameDims());
      conn.send(msgWorldData(BIOME_ORDER.map((k) => biomeRectObj(LAYOUT[k]))));
      conn.send(msgConnected());
      break;
    }
    case 0x71:
      console.log('[game] play/ready received hex=' + payload.toString('hex'));
      conn.send(msgReadyToPlay());
      conn.send(msgAlive());
      break;
    default:
      console.log('[game] msg type 0x' + type.toString(16) + ' len=' + payload.length + ' hex=' + payload.toString('hex'));
      break;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WS routing on one port
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.txt': 'text/plain', '.manifest': 'text/cache-manifest',
};

// ---------------------------------------------------------------------------
// Local account server (email/password login + registration).
// Endpoints mirror the live client's account API:
//   POST /auth/register/email   {email, password, name}
//   POST /auth/login/email      {email, password} OR {accessToken:"{json}"}
//   POST /auth/@me              {userId, token, ...}
//   GET  /playerSettings_update ?userId&passwordToken&itemId
// ---------------------------------------------------------------------------
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const INFINITE_EMAIL = 'moonlightwolf12575@gmail.com';
const INFINITE_VALUE = Number.MAX_SAFE_INTEGER; // effectively infinite
const DEFAULT_PASSWORD = 'moonlight123';

function loadAccounts() {
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    return Array.isArray(raw.accounts) ? raw.accounts : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts }, null, 2));
}

const hashPassword = (email, password, salt) =>
  crypto
    .createHash('sha256')
    .update(salt + ':' + email.toLowerCase() + ':' + password)
    .digest('hex');

function accountData(acc) {
  const infinite = acc.email === INFINITE_EMAIL;
  return {
    userId: acc.userId,
    token: acc.token,
    userName: acc.name || acc.email,
    avatar: acc.avatar || '',
    coins: infinite ? INFINITE_VALUE : acc.coins,
    gems: infinite ? INFINITE_VALUE : acc.gems,
    level: acc.level || 0,
    xp: acc.xp || 0,
    xpNextLvl: acc.xpNextLvl || 0,
    hasVip: !!acc.hasVip,
    hasAutoRenew: !!acc.hasAutoRenew,
  };
}

function findAccount(accounts, email) {
  return accounts.find((a) => a.email === email.toLowerCase());
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function handleApi(req, res, url, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const send = (obj) => {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const accounts = loadAccounts();

  if (pathname === '/auth/register/email' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send({ success: false, error: 'invalid_email' });
    if (password.length < 4) return send({ success: false, error: 'password_too_short' });
    if (findAccount(accounts, email)) return send({ success: false, error: 'account_exists' });
    const acc = {
      userId: 'u' + crypto.randomBytes(8).toString('hex'),
      email,
      name: name || email,
      salt: crypto.randomBytes(8).toString('hex'),
      passwordHash: '',
      token: crypto.randomBytes(24).toString('hex'),
      coins: 500,
      gems: 10,
      level: 0,
      xp: 0,
      xpNextLvl: 0,
      avatar: '',
    };
    acc.passwordHash = hashPassword(email, password, acc.salt);
    accounts.push(acc);
    saveAccounts(accounts);
    console.log('[accounts] registered ' + email);
    return send({ success: true, data: accountData(acc) });
  }

  if (pathname === '/auth/login/email' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    let email = String(body.email || '').trim().toLowerCase();
    let password = String(body.password || '');
    if (!email && body.accessToken) {
      try {
        const creds = JSON.parse(body.accessToken);
        email = String(creds.email || '').trim().toLowerCase();
        password = String(creds.password || '');
      } catch {
        return send({ success: false, error: 'invalid_credentials' });
      }
    }
    const acc = findAccount(accounts, email);
    if (!acc || hashPassword(email, password, acc.salt) !== acc.passwordHash) {
      return send({ success: false, error: 'invalid_credentials' });
    }
    acc.token = crypto.randomBytes(24).toString('hex');
    saveAccounts(accounts);
    console.log('[accounts] login ' + email + (email === INFINITE_EMAIL ? ' (INFINITE coins/gems)' : ''));
    return send({ success: true, data: accountData(acc) });
  }

  if (pathname === '/auth/@me' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const acc = accounts.find((a) => a.userId === body.userId && a.token === body.token);
    if (!acc) return send({ success: false, error: 'invalid_session' });
    return send({ success: true, data: accountData(acc), coins: accountData(acc).coins });
  }

  if (pathname === '/playerSettings_update') {
    return send({ success: true, reason: 'ok' });
  }

  if (pathname === '/shop/get') {
    // Client expects { items: [], settings: [] } (used directly by $.ajax success).
    return send({ items: [], settings: [] });
  }

  if (pathname === '/shop/purchases') {
    return send({ success: true, data: {} });
  }

  if (pathname === '/shop/wardrobe/save') {
    return send({ success: true, data: {} });
  }

  if (pathname === '/shop/buy') {
    return send({ success: true, data: {} });
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    return send({ success: true });
  }

  if (pathname === '/addCoins') {
    const byId = accounts.find((a) => a.userId === url.searchParams.get('userId'));
    return send({ success: true, data: byId ? accountData(byId) : {} });
  }

  if (pathname === '/resetAccount') {
    return send({ success: true, data: {} });
  }

  if (pathname === '/servers/get') {
    // Client reduces totalPlayerCount across the array and matches by id.
    const servers = [
      { id: 'localtest-1', totalPlayerCount: 1 },
      { id: 'prod-lnd-us-ny-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-us-da-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-us-la-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-br-sp-1', totalPlayerCount: 0 },
      { id: 'prod-ovh-de-ff-1', totalPlayerCount: 0 },
      { id: 'prod-ovh-fr-pr-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-sw-sh-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-sg-sg-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-au-sd-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-us-ch-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-us-sea-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-us-nh-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-us-va-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-us-mia-1', totalPlayerCount: 0 },
      { id: 'prod-ovh-nl-am-1', totalPlayerCount: 0 },
      { id: 'prod-ovh-uk-lo-1', totalPlayerCount: 0 },
      { id: 'prod-ovh-jp-tk-1', totalPlayerCount: 0 },
      { id: 'prod-lnd-ar-ba-1', totalPlayerCount: 0 },
      { id: 'prod-ovh-is-re-1', totalPlayerCount: 0 },
    ];
    return send(servers);
  }

  if (pathname.startsWith('/xsolla/getVip')) {
    return send({ success: false });
  }

  if (pathname.startsWith('/xsolla/getPackets')) {
    return send({ success: false, data: null });
  }

  if (pathname.startsWith('/xsolla/getToken') || pathname.startsWith('/xsolla/cancelSubscription')) {
    return send({ success: true, data: {} });
  }

  return send({ success: false, error: 'not_available_in_local' });
}

function ensureInfiniteAccount() {
  const accounts = loadAccounts();
  if (!findAccount(accounts, INFINITE_EMAIL)) {
    const salt = crypto.randomBytes(8).toString('hex');
    accounts.push({
      userId: 'u' + crypto.randomBytes(8).toString('hex'),
      email: INFINITE_EMAIL,
      name: 'Moonlight Wolf',
      salt,
      passwordHash: hashPassword(INFINITE_EMAIL, DEFAULT_PASSWORD, salt),
      token: crypto.randomBytes(24).toString('hex'),
      coins: INFINITE_VALUE,
      gems: INFINITE_VALUE,
      level: 0,
      xp: 0,
      xpNextLvl: 0,
      avatar: '',
    });
    saveAccounts(accounts);
  }
  console.log('[accounts] infinite account: ' + INFINITE_EMAIL);
  console.log('[accounts] default password for it: ' + DEFAULT_PASSWORD);
}
ensureInfiniteAccount();

function upgradeWs(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
  );
  const isPing = req.url === '/ping';
  let conn;
  const handler = (payload) => {
    if (isPing) {
      if (payload[0] === 0xff) conn.send(Buffer.from([0xff]));
    } else {
      handleGameMessage(conn, payload);
    }
  };
  conn = new WsConn(socket, handler);
  if (head && head.length) conn._onData(head);
  return conn;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (
    p === '/playerSettings_update' ||
    p === '/addCoins' ||
    p === '/resetAccount' ||
    p === '/servers/get' ||
    p.startsWith('/auth/') ||
    p.startsWith('/shop/') ||
    p.startsWith('/xsolla/')
  ) {
    return handleApi(req, res, url, p);
  }
  if (p === '/') p = '/index.html';
  const filePath = path.join(WEB_ROOT, p);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    upgradeWs(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log('[localtest] http + ws on http://127.0.0.1:' + PORT);
  console.log('[localtest] game ws: ws://127.0.0.1:' + PORT + '/  |  ping ws: ws://127.0.0.1:' + PORT + '/ping');
  console.log('[localtest] biome layout:', BIOME_ORDER.join(' -> '));
  console.log('[localtest] trees generated:', trees.length);
});
