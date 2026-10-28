// Login da interface: um único dono (e-mail configurado em data/config.json ou GTD_OWNER_EMAIL) + senha.
// Integrações (Claude/MCP, webhooks, Lovable) continuam usando o token; a interface usa um cookie de sessão.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { GtdError } from './store.mjs';

const COOKIE = 'gtd_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MIN = 15;
const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };

const b64 = buf => Buffer.from(buf).toString('base64url');
const normEmail = e => String(e || '').trim().toLowerCase();
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(hash)}`;
}
export function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = scryptSync(String(pw), Buffer.from(salt, 'base64url'), want.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(got, want);
}

/** Pedido feito no próprio computador (não veio por túnel/proxy). */
export function isLocalRequest(req) {
  const ip = req.socket?.remoteAddress || '';
  const viaProxy = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'].some(h => req.headers[h]);
  return !viaProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}
const clientIp = req => String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '?').trim();
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '') || !!req.socket?.encrypted;

export function createAuth({ cfg, cfgFile, ownerEmail }) {
  const save = () => { if (cfgFile) writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); };
  if (!cfg.session_secret) { cfg.session_secret = b64(randomBytes(32)); cfg.session_version = 1; save(); }
  const owner = () => normEmail(ownerEmail || cfg.owner_email);
  const fails = new Map(); // ip → { n, until }

  const sign = payload => b64(createHmac('sha256', cfg.session_secret).update(payload).digest());
  function makeCookie(req, email) {
    const payload = b64(JSON.stringify({ e: email, v: cfg.session_version || 1, exp: Date.now() + SESSION_DAYS * 86400000 }));
    return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`;
  }
  const clearCookie = req => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;

  /** E-mail da sessão válida, ou null. */
  function session(req) {
    const raw = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
    if (!raw) return null;
    const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
    if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (s.exp < Date.now() || s.v !== (cfg.session_version || 1) || normEmail(s.e) !== owner()) return null;
      return s.e;
    } catch { return null; }
  }

  function checkLock(req) {
    const f = fails.get(clientIp(req));
    if (f && f.until > Date.now()) {
      const min = Math.ceil((f.until - Date.now()) / 60000);
      throw new GtdError(429, `Muitas tentativas erradas. Tente de novo em ${min} min.`);
    }
  }
  function fail(req) {
    const ip = clientIp(req), f = fails.get(ip) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MIN * 60000; f.n = 0; }
    fails.set(ip, f);
  }
  function validNewPassword(pw) {
    if (String(pw || '').length < MIN_PASSWORD) throw new GtdError(400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  }

  return {
    session,
    passwordSet: () => !!cfg.password_hash,
    status(req) {
      const email = session(req);
      if (email) return { logged: true, email };
      const local = isLocalRequest(req);
      return { logged: false, setup: !cfg.password_hash && local, setup_remote: !cfg.password_hash && !local };
    },
    setup(req, { email, password } = {}) {
      if (cfg.password_hash) throw new GtdError(409, 'A senha já foi criada. Use Entrar.');
      if (!isLocalRequest(req)) throw new GtdError(403, 'Crie a senha no computador onde o GTD está instalado.');
      checkLock(req);
      const e = normEmail(email);
      if (owner() && e !== owner()) { fail(req); throw new GtdError(403, 'Este GTD só aceita o e-mail do dono.'); }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new GtdError(400, 'Informe um e-mail válido.');
      validNewPassword(password);
      cfg.owner_email = owner() || e;
      cfg.password_hash = hashPassword(password);
      save();
      return { cookie: makeCookie(req, cfg.owner_email), email: cfg.owner_email };
    },
    login(req, { email, password } = {}) {
      checkLock(req);
      if (!cfg.password_hash) throw new GtdError(409, 'A senha ainda não foi criada. Abra o GTD no computador onde ele está instalado.');
      const okEmail = owner() && safeEq(normEmail(email), owner());
      const okPass = verifyPassword(password, cfg.password_hash);
      if (!okEmail || !okPass) { fail(req); throw new GtdError(401, 'E-mail ou senha incorretos.'); }
      fails.delete(clientIp(req));
      return { cookie: makeCookie(req, owner()), email: owner() };
    },
    changePassword(req, { current, password } = {}) {
      if (!session(req)) throw new GtdError(401, 'Entre primeiro.');
      checkLock(req);
      if (!verifyPassword(current, cfg.password_hash)) { fail(req); throw new GtdError(401, 'Senha atual incorreta.'); }
      validNewPassword(password);
      cfg.password_hash = hashPassword(password);
      cfg.session_version = (cfg.session_version || 1) + 1; // encerra as outras sessões
      save();
      return { cookie: makeCookie(req, owner()) };
    },
    clearCookie,
  };
}
