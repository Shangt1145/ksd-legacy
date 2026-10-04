/* ==========================================================================
 * KG 联机 WebSocket 服务（零依赖，只用 node 内置模块）
 *
 * 为什么不用 ws 包：这个项目是"双击 .cmd 就能玩"的绿色包，不能要求 npm install。
 * 所以这里手写 RFC6455 的握手与帧编解码（只做联机对战需要的子集）：
 *   - 握手：Sec-WebSocket-Key → SHA1(key + GUID) → base64
 *   - 帧：文本帧收发、分片发送、ping/pong、close
 *   - 掩码：客户端→服务端的帧必须带掩码，服务端→客户端不能带（协议规定）
 *
 * 房间模型（房主即权威）：
 *   create  → 建房，服务端保存房主发来的一份"权威快照"（卡池/效果/卡图/卡组）
 *   join    → 按房间码加入，服务端把权威快照原样回放给加入方（含分片进度）
 *   move    → 对局动作转发（房主↔加入方，服务端只转发不改写）
 *   hash    → 状态指纹比对（服务端帮忙判"不同步"）
 * ========================================================================== */
'use strict';
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ------------------------------------------------------------------ 握手 */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/* ------------------------------------------------------------------ 帧编码 */
function encodeFrame(payloadBuf, opcode) {
  opcode = opcode == null ? 0x1 : opcode;
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);              // 高 32 位恒为 0（消息不会到 4GB）
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;                 // FIN=1
  return Buffer.concat([header, payloadBuf]);
}

function encodeText(str) { return encodeFrame(Buffer.from(str, 'utf8'), 0x1); }
function encodeClose(code, reason) {
  const b = Buffer.alloc(2 + Buffer.byteLength(reason || '', 'utf8'));
  b.writeUInt16BE(code || 1000, 0);
  if (reason) b.write(reason, 2, 'utf8');
  return encodeFrame(b, 0x8);
}
function encodePong(data) { return encodeFrame(data || Buffer.alloc(0), 0xA); }

/* 解析一个应用层消息：把"带掩码的客户端帧"解成 {opcode, payload}
 * 返回 null 表示"数据还不够一个完整帧"，调用方把数据留在缓冲里等下一片 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off); off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const hi = buf.readUInt32BE(off), lo = buf.readUInt32BE(off + 4);
    len = hi * 4294967296 + lo; off += 8;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4); off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin: fin, opcode: opcode, masked: masked, payload: payload, size: off + len };
}

/* ------------------------------------------------------------------ 连接 */
class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.room = null;
    this.role = null;                 // 'host' | 'guest'
    this.alive = true;
    this.frags = [];                  // 分片消息重组
    this.fragOpcode = 0;
    this.onMessage = null;
    this.onClose = null;
    this.isAlive = true;
  }

  /* 二进制帧发送（卡图分片）：原样透传，不做任何编码/解码 */
  sendRaw(buf, opcode) {
    if (!this.alive) return false;
    try { this.socket.write(encodeFrame(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), opcode == null ? 0x2 : opcode)); return true; }
    catch (e) { return false; }
  }

  send(msg) {
    if (!this.alive) return false;
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    try {
      this.socket.write(encodeText(text));
      return true;
    } catch (e) {
      this.close(1011, 'write failed');
      return false;
    }
  }

  ping() {
    if (!this.alive) return;
    try { this.socket.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch (e) { /* 心跳失败交给 close 处理 */ }
  }

  close(code, reason) {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.write(encodeClose(code, reason)); } catch (e) { /* 已经断了就算了 */ }
    try { this.socket.end(); } catch (e) { /* 同上 */ }
    if (this.onClose) this.onClose();
  }

  // 收到数据：拆帧 → 按 opcode 处理（文本/分片/心跳/关闭）
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const f = decodeFrame(this.buf);
      if (!f) break;
      this.buf = this.buf.slice(f.size);
      if (f.opcode === 0x8) { this.close(1000, 'bye'); return; }          // close
      if (f.opcode === 0x9) { try { this.socket.write(encodePong(f.payload)); } catch (e) { } continue; }  // ping→pong
      if (f.opcode === 0xA) { this.isAlive = true; continue; }            // pong
      if (f.opcode === 0x0) {                                             // continuation
        this.frags.push(f.payload);
        if (f.fin) { this.deliver(Buffer.concat(this.frags), this.fragOpcode); this.frags = []; }
        continue;
      }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (f.fin) { this.deliver(f.payload, f.opcode); continue; }
        this.frags = [f.payload]; this.fragOpcode = f.opcode;             // 分片开始
      }
    }
  }

  deliver(payload, opcode) {
    if (!this.onMessage) return;
    /* ★ 二进制帧（opcode 0x2）= 卡图分片（2026-09-27）。
     *   以前这里 `opcode !== 0x1 return` 把二进制帧**静默丢掉**，所以卡图只能走
     *   JSON + base64：一张 500KB 的图变成 670KB 的字符串，几百张图一张一张串行传，
     *   跨网（UU 云联机）的客机根本加载不完 —— 这就是"客机加载不出来"的根因。
     *   现在：客户端发 [4 字节 JSON 头长度][JSON 头][裸字节]，服务端只负责
     *   原样转发给房间里另一个人（不解码图片，不关心内容）。 */
    if (opcode === 0x2 || opcode === 0x0) { this.onMessage(payload, true); return; }
    if (opcode !== 0x1) return;                                           // 其余（ping/pong/close）不走这里
    let msg = null;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { msg = null; }
    if (!msg) { this.send({ type: 'error', error: '消息不是合法 JSON' }); return; }
    this.onMessage(msg);
  }
}

/* ------------------------------------------------------------------ 房间 */
function makeRoomCode() {
  // 去掉容易看错的字符（0/O/1/I），4 位足够（同一台机器上的局域网局）
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

class Room {
  constructor(code, host) {
    this.code = code;
    this.host = host;
    this.guest = null;
    this.snapshot = null;             // 房主发来的权威快照（分片重组后）
    this.snapMeta = null;
    this.createdAt = Date.now();
  }
  broadcast(msg, except) {
    [this.host, this.guest].forEach(c => { if (c && c !== except) c.send(msg); });
  }
  peerOf(conn) { return conn === this.host ? this.guest : this.host; }
  isEmpty() { return !this.host && !this.guest; }
}

/* ------------------------------------------------------------------ 服务挂载 */
/* 把联机能力挂到一个已存在的 http server 上（与静态文件服务共用端口）。
 * 返回 { connections, rooms, close }，方便测试里主动收尾。 */
function attach(server, opts) {
  opts = opts || {};
  const log = opts.log || function () { };
  const connections = new Set();
  const rooms = new Map();

  server.on('upgrade', function (req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    // 只接管 /kg-ws 这一条路径，其它路径的 upgrade 一律拒绝（不干扰别的用途）
    const url = String(req.url || '').split('?')[0];
    if (!key || url !== '/kg-ws') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(String(key).trim()) + '\r\n\r\n'
    );
    socket.setNoDelay(true);

    const conn = new Conn(socket);
    connections.add(conn);
    log('联机：新连接（当前 ' + connections.size + ' 条）');

    // 第二个参数 bin=true 表示这是二进制帧（卡图分片），原样转发给对方
    conn.onMessage = function (msg, bin) { handle(conn, msg, bin); };
    conn.onClose = function () {
      connections.delete(conn);
      const room = conn.room && rooms.get(conn.room);
      if (room) {
        const peer = room.peerOf(conn);
        if (peer) peer.send({ type: 'peer-left', reason: '对方已断开' });
        if (room.host === conn) room.host = null; else room.guest = null;
        if (room.isEmpty()) { rooms.delete(room.code); log('联机：房间 ' + room.code + ' 已回收'); }
      }
      log('联机：连接断开（剩余 ' + connections.size + ' 条）');
    };

    socket.on('data', function (chunk) { conn.feed(chunk); });
    socket.on('error', function () { conn.close(1011, 'socket error'); });
    socket.on('close', function () { conn.close(1000, 'closed'); });
    if (head && head.length) conn.feed(head);
  });

  /* ---------------------------------------------------------- 消息处理 */
  function handle(conn, m, bin) {
    /* ★ 二进制帧 = 卡图分片（2026-09-27）：不解码、不校验，原样转给对方。
     *   分片格式由客户端约定：[4 字节大端 = 头部 JSON 长度][头部 JSON][裸图片字节]。
     *   服务端只做转发，所以图片格式升级（png/jpg/webp）不用改这里。 */
    if (bin) {
      const room = conn.room && rooms.get(conn.room);
      if (!room) return;
      const peer = room.peerOf(conn);
      if (peer && peer.alive) peer.sendRaw(m, 0x2);
      return;
    }
    switch (m.type) {
      case 'create': {
        let code = m.code && /^[A-Z0-9]{4}$/.test(m.code) ? m.code : null;
        if (!code) { do { code = makeRoomCode(); } while (rooms.has(code)); }
        if (rooms.has(code)) { conn.send({ type: 'error', error: '房间码已被占用，换一个' }); return; }
        const room = new Room(code, conn);
        rooms.set(code, room);
        conn.room = code; conn.role = 'host';
        conn.send({ type: 'created', code: code, id: conn.id || (conn.id = 'h' + Date.now().toString(36)) });
        log('联机：建房 ' + code);
        return;
      }
      case 'join': {
        const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) { conn.send({ type: 'error', error: '没有这个房间码' }); return; }
        if (room.guest) { conn.send({ type: 'error', error: '房间已满' }); return; }
        room.guest = conn;
        conn.room = room.code; conn.role = 'guest';
        conn.send({ type: 'joined', code: room.code });
        // 把房主已经发过的权威快照回放给加入方（可能还在传，分片单独处理）
        if (room.snapMeta) conn.send({ type: 'snapshot-begin', meta: room.snapMeta });
        if (room.snapshot) conn.send({ type: 'snapshot', data: room.snapshot });
        room.host.send({ type: 'peer-joined' });
        log('联机：' + room.code + ' 有人加入');
        return;
      }
      case 'snapshot-begin':
        if (conn.room) { const r = rooms.get(conn.room); if (r) r.snapMeta = m.meta || null; }
        conn.send({ type: m.ack ? 'ack' : 'snapshot-begin-ok', seq: m.seq });
        return;
      case 'snapshot':
        if (conn.room) { const r = rooms.get(conn.room); if (r) r.snapshot = m.data; }
        conn.send({ type: 'ack', seq: m.seq });
        return;
      case 'relay': {                       // 对局动作 / 握手消息：原样转发给对方
        const room = conn.room && rooms.get(conn.room);
        if (!room) { conn.send({ type: 'error', error: '不在房间里' }); return; }
        const peer = room.peerOf(conn);
        if (!peer) { conn.send({ type: 'peer-left', reason: '对方不在房间里' }); return; }
        peer.send({ type: 'relay', from: conn.role, payload: m.payload });
        return;
      }
      case 'ping':
        conn.send({ type: 'pong', t: m.t });
        return;
      case 'leave': {
        const room = conn.room && rooms.get(conn.room);
        if (room) {
          const peer = room.peerOf(conn);
          if (peer) peer.send({ type: 'peer-left', reason: '对方退出了房间' });
          if (room.host === conn) room.host = null; else room.guest = null;
          if (room.isEmpty()) rooms.delete(room.code);
        }
        conn.room = null;
        conn.send({ type: 'left' });
        return;
      }
      case 'list': {
        conn.send({ type: 'rooms', rooms: Array.from(rooms.values()).map(r => ({ code: r.code, hasGuest: !!r.guest })) });
        return;
      }
      default:
        conn.send({ type: 'error', error: '未知消息类型：' + m.type });
    }
  }

  // 心跳：定期 ping，踢掉已经死掉的连接（局域网里拔网线/关窗口不会发 close）
  const beat = setInterval(function () {
    connections.forEach(function (c) {
      if (!c.isAlive) { c.close(1001, 'ping timeout'); return; }
      c.isAlive = false;
      c.ping();
    });
  }, 20000);
  if (beat.unref) beat.unref();

  return {
    connections: connections,
    rooms: rooms,
    close() { clearInterval(beat); connections.forEach(c => c.close(1001, 'server closing')); },
  };
}

module.exports = { attach, encodeText, encodeClose, encodeFrame, decodeFrame, acceptKey, makeRoomCode };
