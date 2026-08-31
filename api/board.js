// 별 하나 더 — 랭킹 / 계정 API
// 저장소: Upstash Redis (Vercel 마켓플레이스 연동 시 환경변수가 자동으로 꽂힌다)
// 비밀번호는 PBKDF2 해시로만 저장하고, 어떤 응답에도 해시·솔트·토큰을 내보내지 않는다.

const crypto = require('crypto');

const URL_ENV   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const TOKEN_ENV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CONFIGURED = !!(URL_ENV && TOKEN_ENV);

const HKEY = 'byeol:users';
const FKEY = 'byeol:feedback';  // 피드백 리스트 (최신이 앞)
const ID_RE = /^[가-힣A-Za-z0-9_]{2,10}$/;
const MAX_SAVE = 6000;          // 세이브 JSON 최대 길이
const RATE_MAX = 150;           // IP당 분당 요청
const FB_MAX = 500;             // 피드백 한 편 최대 글자
const FB_KEEP = 400;            // 서버에 남겨두는 편수
const FB_COOL = 60 * 1000;      // 한 사람이 다시 보내기까지

// 마스터 계정. 아이디는 비밀이 아니다 — 비밀번호를 모르면 아무것도 못 한다.
// 아이디가 다르면 Vercel 환경변수 ADMIN_IDS 에 쉼표로 넣으면 된다.
const ADMINS = String(process.env.ADMIN_IDS || '민수')
  .split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = id => ADMINS.indexOf(id) >= 0;

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
    boss:  n(r.boss, 24),
    ach:   n(r.ach, 99),
    lv:    n(r.lv, 300),
    job:   n(r.job, 2),
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

// seen 은 마지막 활동 시각. hash/salt/token/save 는 절대 나가지 않는다.
const publicRow = (id, u) => Object.assign({ id }, u.rec || {}, { seen: u.seen || (u.rec && u.rec.ts) || 0 });

// 토큰 대조 — 여러 곳에서 같은 방식으로 쓴다
function authed(u, token) {
  return !!(u && u.token && same(String(token || ''), u.token));
}

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

      // 로그인과 새 계정을 갈라 받는다. 예전엔 모르는 아이디면 조용히 만들어버려서,
      // 오타 한 번에 빈 계정이 생기고 기록이 사라진 것처럼 보였다.
      // mode 를 안 보내는 옛 클라이언트는 예전처럼 자동으로 만든다.
      const mode = body.mode === 'new' ? 'new' : (body.mode === 'login' ? 'login' : 'auto');
      let u = await readUser(id);
      if (u && mode === 'new') return res.status(409).json({ error: 'taken' });
      if (!u && mode === 'login') return res.status(404).json({ error: 'no_user' });
      if (!u) {                                   // 처음 쓰는 아이디 → 그대로 등록
        const salt = crypto.randomBytes(16).toString('hex');
        u = { salt, hash: hash(pw, salt), token: newToken(), rec: null, save: null, at: Date.now(), seen: Date.now() };
        await writeUser(id, u);
        return res.status(200).json({ ok: true, created: true, admin: isAdmin(id), token: u.token, rec: null, save: null, board: await board() });
      }
      if (!same(hash(pw, u.salt), u.hash)) return res.status(401).json({ error: 'wrong_pw' });

      // 토큰을 매번 갈아치우면 다른 탭/기기의 세션이 즉시 죽고, 그쪽 자동 저장이
      // 조용히 401로 실패해 진행 상황이 유실된다. 이미 있으면 그대로 쓴다.
      u.token = u.token || newToken();
      u.seen = Date.now();
      await writeUser(id, u);
      return res.status(200).json({ ok: true, created: false, admin: isAdmin(id), token: u.token, rec: u.rec, save: u.save, board: await board() });
    }

    // ---- 저장된 토큰으로 이어하기 (비밀번호를 다시 묻지 않는다) ----
    if (body.action === 'resume') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!u.token || !same(String(body.token || ''), u.token)) return res.status(401).json({ error: 'bad_token' });
      return res.status(200).json({ ok: true, admin: isAdmin(id), rec: u.rec, save: u.save, board: await board() });
    }

    // ---- 기록/세이브 저장 (토큰으로만 인증) ----
    if (body.action === 'submit') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!u.token || !same(String(body.token || ''), u.token)) return res.status(401).json({ error: 'bad_token' });

      if (body.rec) {
        const rec = cleanRec(body.rec);
        // 최고 보스는 어떤 기록이 이기든 가장 높은 것을 유지한다
        // 최고 보스·업적·레벨은 어떤 기록이 이기든 가장 높은 것을 유지한다
        const keep = {
          boss: Math.max((u.rec && u.rec.boss) || 0, rec.boss || 0),
          ach:  Math.max((u.rec && u.rec.ach)  || 0, rec.ach  || 0),
          lv:   Math.max((u.rec && u.rec.lv)   || 0, rec.lv   || 0)
        };
        if (better(rec, u.rec)) u.rec = rec;      // 기록은 더 좋을 때만 갱신
        if (u.rec) { u.rec.boss = keep.boss; u.rec.ach = keep.ach; u.rec.lv = keep.lv; }
      }
      if (typeof body.save === 'string' && body.save.length <= MAX_SAVE) u.save = body.save;
      u.seen = Date.now();
      await writeUser(id, u);
      return res.status(200).json({ ok: true, rec: u.rec, board: await board() });
    }

    // ---- 피드백 보내기 ----
    if (body.action === 'feedback') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!authed(u, body.token)) return res.status(401).json({ error: 'bad_token' });

      const text = String(body.text || '').trim().slice(0, FB_MAX);
      if (text.length < 4) return res.status(400).json({ error: 'too_short' });

      const now = Date.now();
      if (u.fbAt && now - u.fbAt < FB_COOL) {
        return res.status(429).json({ error: 'too_soon', wait: Math.ceil((FB_COOL - (now - u.fbAt)) / 1000) });
      }
      u.fbAt = now;
      await writeUser(id, u);

      // 맥락을 같이 남긴다 — 어떤 스펙에서 나온 말인지 알아야 고칠 수 있다
      const r = u.rec || {};
      await redis(['LPUSH', FKEY, JSON.stringify({
        id, text, ts: now, done: 0,
        lv: r.lv | 0, power: r.power | 0, star: r.star | 0, boss: r.boss | 0
      })]);
      await redis(['LTRIM', FKEY, 0, FB_KEEP - 1]);
      return res.status(200).json({ ok: true });
    }

    // ---- 마스터: 피드백 읽기 ----
    if (body.action === 'admin') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!authed(u, body.token)) return res.status(401).json({ error: 'bad_token' });
      if (!isAdmin(id)) return res.status(403).json({ error: 'not_admin' });

      const what = String(body.what || 'feedback');

      if (what === 'feedback') {
        const raw = await redis(['LRANGE', FKEY, 0, FB_KEEP - 1]);
        const list = (Array.isArray(raw) ? raw : []).map(function (s, i) {
          try { const o = JSON.parse(s); o.i = i; return o; } catch (e) { return null; }
        }).filter(Boolean);
        return res.status(200).json({ ok: true, admin: true, feedback: list });
      }

      if (what === 'done') {                 // 처리 표시 — 지우지 않고 표시만 남긴다
        const i = Math.max(0, Math.min(FB_KEEP - 1, Math.floor(Number(body.i) || 0)));
        const raw = await redis(['LINDEX', FKEY, i]);
        if (!raw) return res.status(404).json({ error: 'no_item' });
        let o = null; try { o = JSON.parse(raw); } catch (e) {}
        if (!o) return res.status(400).json({ error: 'bad_item' });
        o.done = o.done ? 0 : 1;
        await redis(['LSET', FKEY, i, JSON.stringify(o)]);
        return res.status(200).json({ ok: true, admin: true, i, done: o.done });
      }

      if (what === 'players') {              // 랭킹 50줄보다 넓게 본다. 여전히 hash/salt/token/save 는 안 나간다.
        const all = await readAll();
        const rows = Object.keys(all).map(function (k) {
          const x = all[k], r = x.rec || {};
          return { id: k, lv: r.lv | 0, power: r.power | 0, star: r.star | 0, grade: r.grade | 0,
                   boss: r.boss | 0, ach: r.ach | 0, tries: r.tries | 0, des: r.des | 0,
                   at: x.at || 0, seen: x.seen || 0, has: x.save ? 1 : 0 };
        }).sort((a, b) => b.seen - a.seen);
        return res.status(200).json({ ok: true, admin: true, players: rows });
      }

      return res.status(400).json({ error: 'bad_what' });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server', message: String(e.message || e) });
  }
};
