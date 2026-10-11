'use strict';
/**
 * Server automation RIS qua REST API — không dùng browser/UI automation.
 *  - POST /api/login {username,password}: OIDC Authorization Code + PKCE qua HTTP,
 *    tài khoản bất kỳ (miễn đúng trên Keycloak).
 *  - GET  /api/worklist
 *  - POST /api/run {studyId?, description?, conclusion?, confirmOverlap?, dryRun?}
 * Chạy: node server.cjs  (mặc định port 8000, đổi bằng PORT=...)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Máy chủ nội bộ dùng chứng chỉ riêng: tắt verify TLS trừ khi user cấu hình khác.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { keycloakLogin, keycloakRefresh } = require('./lib/keycloak.cjs');
const ris = require('./lib/ris.cjs');

const PORT = Number(process.env.PORT || 8000);
const sessions = new Map(); // sid -> {accessToken, refreshToken, exp, sub, name, username}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('Body quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Body không phải JSON')); }
    });
    req.on('error', reject);
  });
}

function getSession(req) {
  const sid = parseCookies(req).ris_sid;
  return sid ? sessions.get(sid) || null : null;
}

async function ensureToken(sess) {
  if (!sess) {
    const err = new Error('Chưa đăng nhập');
    err.status = 401;
    throw err;
  }
  if (Date.now() > sess.exp - 30000) {
    if (!sess.refreshToken) {
      const err = new Error('Token hết hạn, vui lòng đăng nhập lại');
      err.status = 401;
      throw err;
    }
    const t = await keycloakRefresh(sess.refreshToken);
    sess.accessToken = t.accessToken;
    sess.refreshToken = t.refreshToken || sess.refreshToken;
    sess.exp = Date.now() + (t.expiresIn || 300) * 1000;
    if (t.sub) sess.sub = t.sub;
  }
  return sess.accessToken;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': INDEX_HTML.length });
      res.end(INDEX_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { username, password } = await readJson(req);
      const t = await keycloakLogin(username, password);
      const sid = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        exp: Date.now() + (t.expiresIn || 300) * 1000,
        sub: t.sub, name: t.name, username: t.username,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `ris_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`,
      });
      res.end(JSON.stringify({ ok: true, user: { name: t.name, username: t.username } }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const sid = parseCookies(req).ris_sid;
      if (sid) sessions.delete(sid);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const sess = getSession(req);
      if (!sess) { sendJson(res, 401, { ok: false, error: 'Chưa đăng nhập' }); return; }
      sendJson(res, 200, { ok: true, user: { name: sess.name, username: sess.username } });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/worklist') {
      const sess = getSession(req);
      const token = await ensureToken(sess);
      const onlyCS1 = url.searchParams.get('onlyCS1') !== '0';
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 3, 1), 31);
      const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);
      const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize')) || 10, 1), 100);
      const q = (url.searchParams.get('q') || '').slice(0, 100);
      const wl = await ris.getWorklist(token, { onlyCS1, days, page, pageSize, q });
      const items = ((wl && wl.items) || []).map((s) => ({
        id: s.id,
        orderNumber: s.order && s.order.orderNumber,
        patientName: s.patient && s.patient.fullName,
        patientId: s.patient && s.patient.patientId,
        procedure: s.procedure && s.procedure.name,
        modality: s.modality,
        deviceName: s.device && s.device.name,
        imageStatus: s.imageStatus,
        readStatus: s.readStatus,
        orderDate: s.order && s.order.orderDate,
        hasDevice: !!(s.device && s.device.id),
      }));
      sendJson(res, 200, { ok: true, total: wl.totalItems || items.length, page, pageSize, onlyCS1: wl.onlyCS1, from: wl.from, to: wl.to, items });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const sess = getSession(req);
      const token = await ensureToken(sess);
      const body = await readJson(req);
      const result = await ris.runAutomation(token, { sub: sess.sub, name: sess.name }, {
        studyId: body.studyId || null,
        description: body.description !== undefined ? body.description : ris.DEFAULT_DESCRIPTION,
        conclusion: body.conclusion !== undefined ? body.conclusion : ris.DEFAULT_CONCLUSION,
        confirmOverlap: !!body.confirmOverlap,
        dryRun: !!body.dryRun,
        onlyCS1: body.onlyCS1 !== false,
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Không tìm thấy ' + url.pathname });
  } catch (e) {
    const code = e.status === 401 ? 401 : 500;
    sendJson(res, code, { ok: false, error: e.message, steps: e.steps || undefined, overlap: e.overlap || undefined });
  }
});

server.listen(PORT, () => {
  console.log(`ris-api-app đang chạy tại http://localhost:${PORT}`);
});
