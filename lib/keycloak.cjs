'use strict';
/**
 * Đăng nhập Keycloak bằng luồng Authorization Code + PKCE qua HTTP thuần túy
 * (không cần browser, không dùng password-grant vốn đã bị tắt ở client `ris`).
 * Tài khoản bất kỳ đăng nhập được, miễn là user/pass đúng trên Keycloak.
 */
const crypto = require('crypto');

const KC_BASE = 'https://keycloak.bvmathanoi.sotamed.ai:8443';
const REALM = 'sotamed';
const CLIENT_ID = 'ris';
// redirect_uri phải nằm trong danh sách cho phép của client `ris`.
// Dùng origin của web PACS (đã được đăng ký), chỉ cần hứng `code`, không load trang.
const REDIRECT_URI = 'https://ris.bvmathanoi.sotamed.ai:8443/';

const rand = (n) => crypto.randomBytes(n).toString('base64url');
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const esc = (s) => encodeURIComponent(s);

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---- Cookie jar tối thiểu cho luồng login ----
class Jar {
  constructor() { this.cookies = new Map(); }
  store(setCookies) {
    if (!setCookies) return;
    const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const c of arr) {
      const pair = String(c).split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x3D;/gi, '=')
    .replace(/&#x3F;/gi, '?')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function rawFetch(url, { method = 'GET', headers = {}, body = null, jar = null } = {}) {
  const h = { ...headers };
  if (jar && jar.cookies.size) h.Cookie = jar.header();
  const res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
  if (jar) {
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie');
    jar.store(sc);
  }
  return res;
}

function resolveUrl(base, loc) {
  try { return new URL(loc, base).toString(); } catch { return loc; }
}

function parseLoginForm(html) {
  const m = html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
  if (m && m[1]) return { action: decodeHtmlEntities(m[1]) };
  // Keycloakify/React login page: URL nằm trong kcContext JSON, không có <form> tĩnh
  const k = html.match(/"loginAction"\s*:\s*"([^"]+)"/);
  if (k && k[1]) {
    return { action: decodeHtmlEntities(k[1].replace(/\\u0026/gi, '&')) };
  }
  return null;
}

function looksLikeLoginPage(html) {
  return /name="username"/i.test(html) || /id="username"/i.test(html) || /"loginAction"\s*:/.test(html);
}

function parseLoginError(html) {
  const m = html.match(/class="[^"]*kc-feedback-text[^"]*"[^>]*>([\s\S]*?)<\//i)
    || html.match(/id="input-error[^"]*"[^>]*>([\s\S]*?)<\//i);
  if (!m) return null;
  return decodeHtmlEntities(m[1]).replace(/<[^>]*>/g, '').trim().slice(0, 300) || 'Đăng nhập thất bại';
}

async function keycloakLogin(username, password) {
  if (!username || !password) throw new Error('Thiếu username/password');
  const jar = new Jar();
  const verifier = rand(48);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = rand(16);
  const nonce = rand(16);

  const authUrl =
    `${KC_BASE}/realms/${REALM}/protocol/openid-connect/auth` +
    `?client_id=${esc(CLIENT_ID)}&redirect_uri=${esc(REDIRECT_URI)}` +
    `&response_type=code&scope=${esc('openid')}&state=${esc(state)}&nonce=${esc(nonce)}` +
    `&code_challenge=${esc(challenge)}&code_challenge_method=S256`;

  // 1. Mở trang login Keycloak
  let res = await rawFetch(authUrl, { jar });
  let url = authUrl;
  let guard = 0;
  // Theo redirect nội bộ của Keycloak (giữ cookie), tối đa vài bước
  while (res.status >= 300 && res.status < 400 && guard++ < 10) {
    url = resolveUrl(url, res.headers.get('location'));
    if (url.startsWith(REDIRECT_URI)) break;
    res = await rawFetch(url, { jar });
  }
  let html = await res.text();
  if (!looksLikeLoginPage(html)) {
    throw new Error('Không thấy form đăng nhập Keycloak (status ' + res.status + ')');
  }

  // 2. Submit username/password
  const form = parseLoginForm(html);
  if (!form || !form.action) throw new Error('Không parse được form đăng nhập');
  const postUrl = resolveUrl(url, form.action);
  const body = new URLSearchParams({ username, password, credentialId: '' }).toString();
  res = await rawFetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    jar,
  });

  // 3. Theo redirect, hứng `code`
  guard = 0;
  url = postUrl;
  while (guard++ < 15) {
    if (res.status >= 300 && res.status < 400) {
      url = resolveUrl(url, res.headers.get('location'));
      if (url.startsWith(REDIRECT_URI)) {
        const u = new URL(url);
        const code = u.searchParams.get('code');
        const err = u.searchParams.get('error');
        if (code) return finishCodeFlow(code, verifier);
        if (err) throw new Error('Keycloak từ chối: ' + err + ' ' + (u.searchParams.get('error_description') || ''));
        throw new Error('Redirect về app nhưng không có code');
      }
      res = await rawFetch(url, { jar });
      continue;
    }
    if (res.status === 200) {
      html = await res.text();
      if (looksLikeLoginPage(html)) {
        throw new Error(parseLoginError(html) || 'Sai tài khoản hoặc mật khẩu');
      }
      throw new Error('Keycloak trả về trang lạ sau khi submit (status 200)');
    }
    throw new Error('Keycloak trả status ' + res.status + ' khi đăng nhập');
  }
  throw new Error('Quá nhiều redirect khi đăng nhập');

  async function finishCodeFlow(code, codeVerifier) {
    const tokenRes = await rawFetch(`${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }).toString(),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tok.access_token) {
      throw new Error('Đổi code lấy token thất bại: ' + (tok.error_description || tok.error || tokenRes.status));
    }
    const claims = decodeJwt(tok.id_token) || {};
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresIn: tok.expires_in || 300,
      sub: claims.sub || null,
      name: claims.name || claims.preferred_username || username,
      username: claims.preferred_username || username,
    };
  }
}

async function keycloakRefresh(refreshToken) {
  const res = await fetch(`${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
    redirect: 'manual',
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) {
    throw new Error('Refresh token thất bại: ' + (tok.error_description || tok.error || res.status));
  }
  const claims = decodeJwt(tok.id_token) || {};
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || refreshToken,
    expiresIn: tok.expires_in || 300,
    sub: claims.sub || null,
    name: claims.name || claims.preferred_username || '',
    username: claims.preferred_username || '',
  };
}

module.exports = { keycloakLogin, keycloakRefresh, decodeJwt };
