import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 60 * 60 * 12; // 방은 12시간 뒤 자동 삭제
const PER = 3;            // 1인당 퀴즈 수
const k = (c, s) => `qb:${c}:${s}`;
const parse = (v) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

async function load(c) {
  const p = redis.pipeline();
  p.get(k(c, "meta"));
  p.hgetall(k(c, "players"));
  p.hgetall(k(c, "quiz"));
  p.hgetall(k(c, "score"));
  const [meta, players, quiz, score] = await p.exec();
  if (!meta) return null;
  const q = {};
  for (const [n, v] of Object.entries(quiz || {})) q[n] = parse(v);
  return { meta: parse(meta), players: players || {}, quiz: q, score: score || {} };
}

function pool(d) {
  const ids = [];
  for (const [n, list] of Object.entries(d.quiz)) list.forEach((_, i) => ids.push(`${n}#${i}`));
  return ids;
}

function view(c, d, me) {
  const m = d.meta;
  const all = pool(d);
  const names = Object.keys(d.players).sort((a, b) => Number(d.players[a]) - Number(d.players[b]));
  return {
    code: c,
    host: m.host,
    phase: m.phase,
    total: all.length,
    remaining: all.filter((id) => !m.used.includes(id)).length,
    canUndo: m.history.length > 0,
    last: m.last || null,
    cur: m.cur
      ? { id: m.cur.id, by: m.cur.by, q: m.cur.q, startedAt: m.cur.startedAt, a: m.cur.by === me ? m.cur.a : undefined }
      : null,
    players: names.map((n) => ({ name: n, score: Number(d.score[n] || 0), submitted: !!d.quiz[n] })),
    now: Date.now(),
  };
}

async function saveMeta(c, meta) {
  const p = redis.pipeline();
  p.set(k(c, "meta"), JSON.stringify(meta), { ex: TTL });
  ["players", "quiz", "score"].forEach((s) => p.expire(k(c, s), TTL));
  await p.exec();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const fail = (msg, code = 400) => res.status(code).json({ error: msg });

  try {
    if (req.method === "GET") {
      const c = clean(req.query.code, 4);
      const d = await load(c);
      if (!d) return fail("없는 방이야", 404);
      return res.json(view(c, d, clean(req.query.me, 10)));
    }
    if (req.method !== "POST") return fail("지원 안 하는 요청", 405);

    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const name = clean(b.name, 10);
    if (!name) return fail("이름을 입력해줘");

    // 방 만들기
    if (b.action === "create") {
      let c = null;
      for (let i = 0; i < 10 && !c; i++) {
        const t = String(Math.floor(1000 + Math.random() * 9000));
        const meta = { host: name, phase: "lobby", cur: null, used: [], history: [], last: null };
        const ok = await redis.set(k(t, "meta"), JSON.stringify(meta), { nx: true, ex: TTL });
        if (ok) c = t;
      }
      if (!c) return fail("방 코드 생성 실패. 다시 눌러줘", 500);
      const p = redis.pipeline();
      p.hset(k(c, "players"), { [name]: Date.now() });
      p.hset(k(c, "score"), { [name]: 0 });
      p.expire(k(c, "players"), TTL);
      p.expire(k(c, "score"), TTL);
      await p.exec();
      return res.json(view(c, await load(c), name));
    }

    const c = clean(b.code, 4);
    const d = await load(c);
    if (!d) return fail("없는 방이야", 404);
    const m = d.meta;
    const isHost = name === m.host;
    const joined = name in d.players;

    switch (b.action) {
      case "join": {
        if (!joined) {
          if (m.phase !== "lobby") return fail("이미 시작한 방이야");
          await redis.hset(k(c, "players"), { [name]: Date.now() });
          await redis.hsetnx(k(c, "score"), name, 0);
          await saveMeta(c, m);
        }
        break;
      }
      case "submit": {
        if (!joined) return fail("방에 먼저 들어와줘");
        if (m.phase !== "lobby") return fail("게임 시작 후엔 수정 못 해");
        const list = (b.quizzes || []).slice(0, PER).map((x) => ({ q: clean(x.q, 200), a: clean(x.a, 100) }));
        if (list.length !== PER || list.some((x) => !x.q)) return fail(`퀴즈 ${PER}개 다 채워줘`);
        await redis.hset(k(c, "quiz"), { [name]: JSON.stringify(list) });
        await saveMeta(c, m);
        break;
      }
      case "start": {
        if (!isHost) return fail("방장만 시작할 수 있어", 403);
        if (Object.keys(d.quiz).length < 2) return fail("퀴즈 낸 사람이 2명 이상이어야 해");
        m.phase = "play";
        m.last = null;
        await saveMeta(c, m);
        break;
      }
      case "draw": {
        if (!isHost) return fail("방장만 뽑을 수 있어", 403);
        if (m.phase !== "play" || m.cur) return fail("지금은 뽑을 수 없어");
        const left = pool(d).filter((id) => !m.used.includes(id));
        if (!left.length) return fail("남은 퀴즈가 없어");
        const id = left[Math.floor(Math.random() * left.length)];
        const [by, i] = [id.slice(0, id.lastIndexOf("#")), Number(id.slice(id.lastIndexOf("#") + 1))];
        const item = d.quiz[by][i];
        m.cur = { id, by, q: item.q, a: item.a, startedAt: Date.now() };
        await saveMeta(c, m);
        break;
      }
      case "resolve": {
        if (!m.cur || b.id !== m.cur.id) return fail("이미 처리된 퀴즈야", 409);
        if (name !== m.cur.by && !isHost) return fail("출제자만 판정할 수 있어", 403);
        const winner = b.winner ? clean(b.winner, 10) : null;
        if (winner && (!(winner in d.players) || winner === m.cur.by)) return fail("정답자를 다시 골라줘");
        const target = winner || m.cur.by;
        await redis.hincrby(k(c, "score"), target, winner ? 1 : -1);
        m.history.push({ id: m.cur.id, winner, by: m.cur.by });
        m.used.push(m.cur.id);
        m.last = { t: Date.now(), text: winner ? `${winner} +1점` : `${m.cur.by} -1점 (아무도 못 맞힘)` };
        m.cur = null;
        if (m.used.length >= pool(d).length) m.phase = "result";
        await saveMeta(c, m);
        break;
      }
      case "undo": {
        if (!isHost) return fail("방장만 되돌릴 수 있어", 403);
        const h = m.history.pop();
        if (!h) return fail("되돌릴 게 없어");
        await redis.hincrby(k(c, "score"), h.winner || h.by, h.winner ? -1 : 1);
        m.used = m.used.filter((id) => id !== h.id);
        m.cur = null;
        m.phase = "play";
        m.last = { t: Date.now(), text: "방장이 직전 판정을 되돌렸어" };
        await saveMeta(c, m);
        break;
      }
      case "end": {
        if (!isHost) return fail("방장만 끝낼 수 있어", 403);
        m.cur = null;
        m.phase = "result";
        await saveMeta(c, m);
        break;
      }
      default:
        return fail("알 수 없는 요청");
    }
    return res.json(view(c, await load(c), name));
  } catch (e) {
    console.error(e);
    return fail("서버 오류. 잠깐 뒤 다시 해줘", 500);
  }
}
