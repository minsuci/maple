// 별 하나 더 — 랭킹 / 계정 API
// 저장소: Upstash Redis (Vercel 마켓플레이스 연동 시 환경변수가 자동으로 꽂힌다)
// 비밀번호는 PBKDF2 해시로만 저장하고, 어떤 응답에도 해시·솔트·토큰을 내보내지 않는다.

const crypto = require('crypto');

const URL_ENV   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const TOKEN_ENV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CONFIGURED = !!(URL_ENV && TOKEN_ENV);

const HKEY = 'byeol:users';
const ID_RE = /^[가-힣A-Za-z0-9_]{2,10}$/;
const MAX_SAVE = 6000;          // 세이브 JSON 최대 길이
const RATE_MAX = 150;           // IP당 분당 요청

async function redis(cmd) {
  const r = await fetch(URL_ENV, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN_ENV, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.result;
}

const hash = (pw, salt) => crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
function same(a, b) {
  const x = Buffer.from(String(a) || '', 'utf8'), y = Buffer.from(String(b) || '', 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const newToken = () => crypto.randomBytes(24).toString('hex');

// 클라이언트가 보낸 기록을 신뢰하지 않고 형태와 범위를 강제한다
function cleanRec(r) {
  r = r && typeof r === 'object' ? r : {};
  const n = (v, hi) => Math.max(0, Math.min(hi, Math.floor(Number(v) || 0)));
  return {
    star:  n(r.star, 36),
    grade: n(r.grade, 3),
    boss:  n(r.boss, 8),
    ig:    n(r.ig, 2),
    power: n(r.power, 100000),
    hall:  r.hall ? 1 : 0,
    des:   n(r.des, 1000000),
    tries: n(r.tries, 10000000),
    ts:    Date.now()
  };
}
const better = (a, b) =>
  !b ? true :
  a.hall !== b.hall ? a.hall > b.hall :
  a.star !== b.star ? a.star > b.star :
  a.grade !== b.grade ? a.grade > b.grade :
  a.power > b.power;

const publicRow = (id, u) => Object.assign({ id }, u.rec || {});

async function readAll() {
  const flat = await redis(['HGETALL', HKEY]);
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) {}
    }
  } else if (flat && typeof flat === 'object') {
    for (const k in flat) { try { out[k] = JSON.parse(flat[k]); } catch (e) {} }
  }
  return out;
}
const readUser = async id => {
  const raw = await redis(['HGET', HKEY, id]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
};
const writeUser = (id, u) => redis(['HSET', HKEY, id, JSON.stringify(u)]);

async function board() {
  const all = await readAll();
  return Object.keys(all)
    .map(id => publicRow(id, all[id]))
    .filter(r => r.ts && (r.star > 0 || r.tries > 0 || r.boss > 0))   // 아직 아무것도 안 한 계정은 랭킹에 안 띄운다
    .sort((a, b) =>
      (b.hall - a.hall) || (b.star - a.star) || (b.grade - a.grade) ||
      (b.power - a.power) || (a.ts - b.ts))
    .slice(0, 50);
}

async function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = 'byeol:rate:' + ip;
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, 60]);
  return n > RATE_MAX;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!CONFIGURED) {
    return res.status(200).json({
      configured: false,
      board: [],
      hint: 'Vercel 프로젝트에 Upstash Redis 를 연결하면 랭킹이 켜진다.'
    });
  }

  try {
    if (await rateLimited(req)) return res.status(429).json({ error: 'rate_limited' });

    if (req.method === 'GET') {
      return res.status(200).json({ configured: true, board: await board() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const id = String(body.id || '').trim();
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' });

    // ---- 로그인 / 가입 ----
    if (body.action === 'enter') {
      const pw = String(body.pw || '');
      if (pw.length < 4 || pw.length > 64) return res.status(400).json({ error: 'bad_pw_len' });

      let u = await readUser(id);
      if (!u) {                                   // 처음 쓰는 아이디 → 그대로 등록
        const salt = crypto.randomBytes(16).toString('hex');
        u = { salt, hash: hash(pw, salt), token: newToken(), rec: null, save: null, at: Date.now() };
        await writeUser(id, u);
        return res.status(200).json({ ok: true, created: true, token: u.token, rec: null, save: null, board: await board() });
      }
      if (!same(hash(pw, u.salt), u.hash)) return res.status(401).json({ error: 'wrong_pw' });

      // 토큰을 매번 갈아치우면 다른 탭/기기의 세션이 즉시 죽고, 그쪽 자동 저장이
      // 조용히 401로 실패해 진행 상황이 유실된다. 이미 있으면 그대로 쓴다.
      u.token = u.token || newToken();
      await writeUser(id, u);
      return res.status(200).json({ ok: true, created: false, token: u.token, rec: u.rec, save: u.save, board: await board() });
    }

    // ---- 저장된 토큰으로 이어하기 (비밀번호를 다시 묻지 않는다) ----
    if (body.action === 'resume') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!u.token || !same(String(body.token || ''), u.token)) return res.status(401).json({ error: 'bad_token' });
      return res.status(200).json({ ok: true, rec: u.rec, save: u.save, board: await board() });
    }

    // ---- 기록/세이브 저장 (토큰으로만 인증) ----
    if (body.action === 'submit') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!u.token || !same(String(body.token || ''), u.token)) return res.status(401).json({ error: 'bad_token' });

      if (body.rec) {
        const rec = cleanRec(body.rec);
        // 최고 보스는 어떤 기록이 이기든 가장 높은 것을 유지한다
        const topBoss = Math.max((u.rec && u.rec.boss) || 0, rec.boss || 0);
        if (better(rec, u.rec)) u.rec = rec;      // 기록은 더 좋을 때만 갱신
        if (u.rec) u.rec.boss = topBoss;
      }
      if (typeof body.save === 'string' && body.save.length <= MAX_SAVE) u.save = body.save;
      await writeUser(id, u);
      return res.status(200).json({ ok: true, rec: u.rec, board: await board() });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server', message: String(e.message || e) });
  }
};
