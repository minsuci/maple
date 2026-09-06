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
// 세이브 JSON 최대 길이. 6000 이었는데 클라이언트는 20000 까지 보내고 있었다 -
// 가방(최대 30칸)이 스무 칸쯤 차면 6265 자가 되어 그때부터 서버가 조용히
// 안 받았다. ok:true 를 돌려주니 아무도 몰랐고, 다른 기기에서 들어가면
// 옛 세이브가 복원되어 장비가 초기화된 것처럼 보였다. 클라이언트 상한 위로 올린다.
const MAX_SAVE = 24000;
const RATE_MAX = 150;           // IP당 분당 요청
const FB_MAX = 500;             // 피드백 한 편 최대 글자
const FB_KEEP = 400;            // 서버에 남겨두는 편수
const FB_COOL = 60 * 1000;      // 한 사람이 다시 보내기까지
// 비밀번호 틀린 횟수를 계정마다 센다. IP 제한(분당 150)만으로는
// 네 자리 비밀번호가 한 시간이면 다 털린다. 창을 두고 시도를 조인다.
const FAIL_MAX = 8;             // 이 횟수를 넘기면
const FAIL_WIN = 900;           // 15분 동안 그 아이디로는 못 들어온다

// 마스터 계정. 아이디는 비밀이 아니다 — 비밀번호를 모르면 아무것도 못 한다.
// 아이디가 다르면 Vercel 환경변수 ADMIN_IDS 에 쉼표로 넣으면 된다.
const ADMINS = String(process.env.ADMIN_IDS || '맹수학')
  .split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = id => ADMINS.indexOf(id) >= 0;

// ---- 유니언 ----
// 계정 여럿을 한 묶음으로 걸면 서로의 전투력을 올려준다. 하나가 대표고
// 나머지가 부캐다. 보너스는 한쪽으로만 가지 않는다 - 각자 자기를 뺀
// 나머지의 기여를 합쳐 받는다.
//
// 기여도는 그 계정의 '기본 전투력'(rec.bp — 유니언을 빼고 잰 값)으로 센다.
// 완성된 전투력으로 재면 A 가 B 를 올리고 그 B 가 다시 A 를 올려 서로
// 부풀린다. 기본값으로 재면 그 고리가 아예 안 생긴다.
const UNION_MAX = 5;        // 대표 하나가 걸 수 있는 부캐 수
const UNION_PER = 4;        // 부캐 하나가 줄 수 있는 최대 %
const UNION_CAP = 20;       // 다 합쳐도 여기까지
const UNION_REF = 20000;    // 이 전투력에서 한 칸이 꽉 찬다 (지금 천장)
// 로그 곡선이다. 중간까지 키우면 값의 대부분이 들어오고 마지막이 더디다 —
// 부캐 하나를 끝까지 미는 것보다 여럿을 중간까지 키우는 게 낫게.
const unionPctOf = bp => {
  const p = Math.max(0, Number(bp) || 0);
  if (p <= 100) return 0;
  const r = Math.log(p / 100) / Math.log(UNION_REF / 100);
  return Math.min(UNION_PER, UNION_PER * r);
};
const r2 = v => Math.round(v * 100) / 100;

// 묶음 하나를 통째로 읽어 각자의 몫을 센다. 최대 여섯 계정이라 그냥 하나씩 읽는다.
async function unionOf(id, u) {
  const solo = { main: id, role: 'main', pct: 0, members: [], max: UNION_MAX, cap: UNION_CAP, per: UNION_PER };
  if (!u) return solo;
  let mainId = id, mainU = u;
  if (u.uMain) {
    const m = await readUser(u.uMain);
    // 한쪽만 남은 끊어진 고리는 없는 것으로 본다
    if (!m || !Array.isArray(m.uAlts) || m.uAlts.indexOf(id) < 0) return solo;
    mainId = u.uMain; mainU = m;
  }
  const alts = Array.isArray(mainU.uAlts) ? mainU.uAlts.slice(0, UNION_MAX) : [];
  const ids = [mainId].concat(alts);
  const members = [];
  for (const m of ids) {
    const mu = m === id ? u : (m === mainId ? mainU : await readUser(m));
    const bp = (mu && mu.rec && mu.rec.bp) | 0;
    members.push({ id: m, bp: bp, pct: r2(unionPctOf(bp)), me: m === id });
  }
  let pct = 0;
  members.forEach(m => { if (!m.me) pct += unionPctOf(m.bp); });
  return { main: mainId, role: u.uMain ? 'alt' : 'main', pct: r2(Math.min(UNION_CAP, pct)),
           members: members, max: UNION_MAX, cap: UNION_CAP, per: UNION_PER };
}

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
    boss:  n(r.boss, 200),      // 100+보스*3+난이도 — 스물두 마리 x 세 난이도
    ach:   n(r.ach, 99),
    lv:    n(r.lv, 300),
    job:   n(r.job, 2),
    // 부위 한 칸 = [성수치, 장비등급, 네줄여부,
    //              [마스터리 총점,주력,보스,경험치,메소], [[옵션,등급,수치],...]]
    // 옵션 열쇠는 클라이언트가 OPT 에서 찾아 쓴다. 여기서는 모양과 범위만 본다 -
    // 모르는 열쇠가 와도 화면에서 그냥 건너뛴다.
    gear:  Array.isArray(r.gear) ? r.gear.slice(0, 8).map(function (g) {
             if (!Array.isArray(g)) return [0, 0, 0, [0, 0, 0, 0, 0], []];
             const m = Array.isArray(g[3]) ? g[3] : [];
             const L = Array.isArray(g[4]) ? g[4] : [];
             return [
               n(g[0], 36), n(g[1], 3), n(g[2], 1),
               [n(m[0], 999), n(m[1], 80), n(m[2], 80), n(m[3], 80), n(m[4], 80)],
               L.slice(0, 4).map(function (l) {
                 if (!Array.isArray(l)) return null;
                 const k = String(l[0] || '');
                 if (!/^[a-z]{2,3}$/.test(k)) return null;
                 return [k, n(l[1], 3), Math.max(0, Math.min(99999, Number(l[2]) || 0))];
               }).filter(Boolean)
             ];
           }) : [],
    mst:   n(r.mst, 999),
    fbest: n(r.fbest, 99999),
    ig:    n(r.ig, 2),
    power: n(r.power, 100000),
    bp:    n(r.bp, 100000),     // 유니언을 뺀 전투력 — 유니언 계산은 이걸로만 한다
    des:   n(r.des, 1000000),
    tries: n(r.tries, 10000000),
    ts:    Date.now()
  };
}
const better = (a, b) =>
  !b ? true :
  a.star !== b.star ? a.star > b.star :
  a.grade !== b.grade ? a.grade > b.grade :
  a.power > b.power;

// seen 은 마지막 활동 시각. hash/salt/token/save 는 절대 나가지 않는다.
// um 은 그 계정이 속한 묶음의 대표 아이디다. 같은 유니언이면 값이 같으니
// 순위표에서 한 식구를 알아볼 수 있다. 안 묶였으면 빈 값.
const unionTag = (id, u) =>
  u.uMain ? String(u.uMain)
          : (Array.isArray(u.uAlts) && u.uAlts.length ? id : '');
const publicRow = (id, u) => Object.assign({ id }, u.rec || {},
  { seen: u.seen || (u.rec && u.rec.ts) || 0, um: unionTag(id, u) });

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
  const rows = Object.keys(all)
    .map(id => publicRow(id, all[id]))
    .filter(r => r.ts && (r.star > 0 || r.tries > 0 || r.boss > 0))   // 아직 아무것도 안 한 계정은 랭킹에 안 띄운다
    .filter(r => !isAdmin(r.id));                                    // 마스터는 뭐든 만들 수 있으니 순위에서 뺀다
  const main = rows.slice().sort((a, b) =>
      (b.boss - a.boss) || (b.star - a.star) || (b.grade - a.grade) ||
      (b.power - a.power) || (a.ts - b.ts)).slice(0, 50);
  // 시련의 숲 순위는 정렬 기준이 달라서, 보스 상위 50 만 보내면 숲만 잘하는
  // 사람이 통째로 잘린다. 숲 상위 30 을 합집합으로 얹는다.
  const forest = rows.slice().sort((a, b) => (b.fbest | 0) - (a.fbest | 0))
    .filter(r => (r.fbest | 0) > 0).slice(0, 30);
  const seen = {};
  const out = [];
  main.concat(forest).forEach(function (r) {
    if (seen[r.id]) return; seen[r.id] = 1; out.push(r);
  });
  return out;
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

      const fkey = 'byeol:fail:' + id;
      const fails = Number(await redis(['GET', fkey])) || 0;
      if (fails >= FAIL_MAX) {
        const ttl = Number(await redis(['TTL', fkey])) || FAIL_WIN;
        return res.status(429).json({ error: 'locked', wait: Math.max(1, ttl) });
      }

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
        return res.status(200).json({ ok: true, created: true, admin: isAdmin(id), token: u.token, rec: null, save: null, board: await board(), union: await unionOf(id, u) });
      }
      if (!same(hash(pw, u.salt), u.hash)) {
        const n = await redis(['INCR', fkey]);
        if (n === 1) await redis(['EXPIRE', fkey, FAIL_WIN]);
        return res.status(401).json({ error: 'wrong_pw', left: Math.max(0, FAIL_MAX - n) });
      }
      await redis(['DEL', fkey]);                 // 맞았으면 센 걸 지운다

      // 토큰을 매번 갈아치우면 다른 탭/기기의 세션이 즉시 죽고, 그쪽 자동 저장이
      // 조용히 401로 실패해 진행 상황이 유실된다. 이미 있으면 그대로 쓴다.
      u.token = u.token || newToken();
      u.seen = Date.now();
      await writeUser(id, u);
      return res.status(200).json({ ok: true, created: false, admin: isAdmin(id), token: u.token, rec: u.rec, save: u.save, board: await board(), union: await unionOf(id, u) });
    }

    // ---- 저장된 토큰으로 이어하기 (비밀번호를 다시 묻지 않는다) ----
    if (body.action === 'resume') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!u.token || !same(String(body.token || ''), u.token)) return res.status(401).json({ error: 'bad_token' });
      return res.status(200).json({ ok: true, admin: isAdmin(id), rec: u.rec, save: u.save, board: await board(), union: await unionOf(id, u) });
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
      // 못 받았으면 못 받았다고 말한다. 조용히 버리면 아무도 모른다.
      let saved = null;
      if (typeof body.save === 'string') {
        if (body.save.length <= MAX_SAVE) { u.save = body.save; u.saveAt = Date.now(); saved = true; }
        else saved = false;
      }
      u.seen = Date.now();
      // 올라온 전투력을 그대로 믿지 않는다. 기본 전투력에 서버가 센 유니언을
      // 곱해 여기서 다시 만든다 - 안 그러면 브라우저에서 유니언 값만 고쳐
      // 순위표를 올릴 수 있다. bp 를 안 보내는 옛 클라이언트는 그냥 둔다.
      const un = await unionOf(id, u);
      if (u.rec && u.rec.bp) {
        u.rec.power = Math.min(100000, Math.round(u.rec.bp * (1 + un.pct / 100)));
      }
      await writeUser(id, u);
      return res.status(200).json({ ok: true, rec: u.rec, board: await board(), union: un,
                                    saved: saved, saveMax: MAX_SAVE, saveAt: u.saveAt || 0 });
    }

    // ---- 유니언 걸고 풀기 ----
    if (body.action === 'union') {
      const u = await readUser(id);
      if (!u) return res.status(404).json({ error: 'no_user' });
      if (!authed(u, body.token)) return res.status(401).json({ error: 'bad_token' });
      const op = String(body.op || 'get');

      if (op === 'get') return res.status(200).json({ ok: true, union: await unionOf(id, u) });

      if (op === 'link') {
        if (u.uMain) return res.status(409).json({ error: 'is_alt' });      // 부캐는 부캐를 못 건다
        const altId = String(body.altId || '').trim();
        if (!ID_RE.test(altId)) return res.status(400).json({ error: 'bad_id' });
        if (altId === id) return res.status(400).json({ error: 'self' });
        u.uAlts = Array.isArray(u.uAlts) ? u.uAlts : [];
        if (u.uAlts.indexOf(altId) >= 0) return res.status(409).json({ error: 'already' });
        if (u.uAlts.length >= UNION_MAX) return res.status(409).json({ error: 'full' });
        const a = await readUser(altId);
        if (!a) return res.status(404).json({ error: 'no_alt' });
        if (a.uMain) return res.status(409).json({ error: 'alt_taken' });
        if (Array.isArray(a.uAlts) && a.uAlts.length) return res.status(409).json({ error: 'alt_is_main' });

        // 그 계정의 비밀번호를 받는다. 안 받으면 남의 센 계정을 제 부캐로 걸어
        // 스펙만 빨아올 수 있다. 로그인과 같은 잠금을 건다 - 여기가 비밀번호를
        // 찍어보는 뒷문이 되면 안 된다.
        const fkey = 'byeol:fail:' + altId;
        const fails = Number(await redis(['GET', fkey])) || 0;
        if (fails >= FAIL_MAX) {
          const ttl = Number(await redis(['TTL', fkey])) || FAIL_WIN;
          return res.status(429).json({ error: 'locked', wait: Math.max(1, ttl) });
        }
        if (!same(hash(String(body.altPw || ''), a.salt), a.hash)) {
          const n = await redis(['INCR', fkey]);
          if (n === 1) await redis(['EXPIRE', fkey, FAIL_WIN]);
          return res.status(401).json({ error: 'wrong_pw', left: Math.max(0, FAIL_MAX - n) });
        }
        await redis(['DEL', fkey]);

        a.uMain = id; u.uAlts.push(altId);
        await writeUser(altId, a);
        await writeUser(id, u);
        return res.status(200).json({ ok: true, union: await unionOf(id, u), board: await board() });
      }

      if (op === 'unlink') {
        const altId = String(body.altId || '').trim();
        // 부캐는 제 발로 나갈 수 있다. 걸리고 나면 못 빠져나오면 안 된다.
        if (u.uMain) {
          const m = await readUser(u.uMain);
          if (m && Array.isArray(m.uAlts)) {
            m.uAlts = m.uAlts.filter(x => x !== id);
            await writeUser(u.uMain, m);
          }
          delete u.uMain;
          await writeUser(id, u);
          return res.status(200).json({ ok: true, union: await unionOf(id, u), board: await board() });
        }
        if (!ID_RE.test(altId)) return res.status(400).json({ error: 'bad_id' });
        u.uAlts = (Array.isArray(u.uAlts) ? u.uAlts : []).filter(x => x !== altId);
        const a = await readUser(altId);
        if (a && a.uMain === id) { delete a.uMain; await writeUser(altId, a); }
        await writeUser(id, u);
        return res.status(200).json({ ok: true, union: await unionOf(id, u), board: await board() });
      }
      return res.status(400).json({ error: 'bad_op' });
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

      // 복구용. 마스터만, 토큰까지 맞아야 여기까지 온다.
      // 세이브를 통째로 주고받는 자리라 아이디 모양과 길이를 다시 본다.
      if (what === 'getsave' || what === 'putsave') {
        const tid = String(body.target || '');
        if (!ID_RE.test(tid)) return res.status(400).json({ error: 'bad_target' });
        const t = await readUser(tid);
        if (!t) return res.status(404).json({ error: 'no_user' });
        if (what === 'getsave') {
          return res.status(200).json({ ok: true, admin: true, id: tid, save: t.save || null,
                                        rec: t.rec || null, seen: t.seen || 0, saveAt: t.saveAt || 0 });
        }
        const blob = String(body.save || '');
        if (blob.length > MAX_SAVE) return res.status(413).json({ error: 'too_big', max: MAX_SAVE });
        try { JSON.parse(blob); } catch (e) { return res.status(400).json({ error: 'bad_json' }); }
        t.save = blob; t.saveAt = Date.now();
        await writeUser(tid, t);
        return res.status(200).json({ ok: true, admin: true, id: tid, saveAt: t.saveAt });
      }

      return res.status(400).json({ error: 'bad_what' });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server', message: String(e.message || e) });
  }
};
