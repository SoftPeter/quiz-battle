import { Redis } from "@upstash/redis";

// 문자열 그대로 받아서 CAS(비교 후 저장)에 사용
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  automaticDeserialization: false,
});

const TTL = 60 * 60 * 12; // 방은 12시간 뒤 자동 삭제
const PER = 3;            // 1인당 퀴즈 수
const key = (c) => `qb:${c}`;
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

// 값이 그대로일 때만 저장 (동시 제출 시 덮어쓰기 방지)
const CAS = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end`;

class Fail extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

async function read(c) {
  const raw = await redis.get(key(c));   // 명령 1개
  return raw ? { raw, st: JSON.parse(raw) } : null;
}

async function update(c, fn) {
  for (let i = 0; i < 6; i++) {
    const d = await read(c);
    if (!d) throw new Fail("없는 방이야", 404);
    fn(d.st);
    const next = JSON.stringify(d.st);
    if (next === d.raw) return d.st;
    const ok = await redis.eval(CAS, [key(c)], [d.raw, next, String(TTL)]);
    if (Number(ok) === 1) return d.st;
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 70));
  }
  throw new Fail("동시에 너무 많이 눌렸어. 다시 눌러줘", 409);
}

const pool = (st) => Object.entries(st.quiz).flatMap(([n, l]) => l.map((_, i) => `${n}#${i}`));

function view(c, st, me) {
  const all = pool(st);
  return {
    code: c,
    host: st.host,
    phase: st.phase,
    total: all.length,
    remaining: all.filter((id) => !st.used.includes(id)).length,
    canUndo: st.history.length > 0,
    last: st.last,
    cur: st.cur ? { id: st.cur.id, by: st.cur.by, q: st.cur.q, startedAt: st.cur.startedAt, a: st.cur.by === me ? st.cur.a : undefined } : null,
    players: st.players.map((n) => ({ name: n, score: st.score[n] || 0, submitted: !!st.quiz[n] })),
    now: Date.now(),
  };
}

const actions = {
  join(st, name) {
    if (st.players.includes(name)) return;
    if (st.phase !== "lobby") throw new Fail("이미 시작한 방이야");
    if (st.players.length >= 20) throw new Fail("방이 꽉 찼어");
    st.players.push(name);
    st.score[name] = 0;
  },
  submit(st, name, b) {
    if (!st.players.includes(name)) throw new Fail("방에 먼저 들어와줘");
    if (st.phase !== "lobby") throw new Fail("게임 시작 후엔 수정 못 해");
    const list = (b.quizzes || []).slice(0, PER).map((x) => ({ q: clean(x.q, 200), a: clean(x.a, 100) }));
    if (list.length !== PER || list.some((x) => !x.q)) throw new Fail(`퀴즈 ${PER}개 다 채워줘`);
    st.quiz[name] = list;
  },
  start(st, name) {
    if (name !== st.host) throw new Fail("방장만 시작할 수 있어", 403);
    if (Object.keys(st.quiz).length < 2) throw new Fail("퀴즈 낸 사람이 2명 이상이어야 해");
    st.phase = "play";
    st.last = null;
  },
  draw(st, name) {
    if (name !== st.host) throw new Fail("방장만 뽑을 수 있어", 403);
    if (st.phase !== "play" || st.cur) throw new Fail("지금은 뽑을 수 없어");
    const left = pool(st).filter((id) => !st.used.includes(id));
    if (!left.length) throw new Fail("남은 퀴즈가 없어");
    const id = left[Math.floor(Math.random() * left.length)];
    const cut = id.lastIndexOf("#");
    const by = id.slice(0, cut), item = st.quiz[by][Number(id.slice(cut + 1))];
    st.cur = { id, by, q: item.q, a: item.a, startedAt: Date.now() };
  },
  resolve(st, name, b) {
    if (!st.cur || b.id !== st.cur.id) throw new Fail("이미 처리된 퀴즈야", 409);
    if (name !== st.cur.by) throw new Fail("출제자만 판정할 수 있어", 403);
    const winner = b.winner ? clean(b.winner, 10) : null;
    if (winner && (!st.players.includes(winner) || winner === st.cur.by)) throw new Fail("정답자를 다시 골라줘");
    const target = winner || st.cur.by;
    st.score[target] = (st.score[target] || 0) + (winner ? 1 : -1);
    st.history.push({ id: st.cur.id, winner, by: st.cur.by });
    st.used.push(st.cur.id);
    st.last = { t: Date.now(), text: winner ? `${winner} +1점` : `${st.cur.by} -1점 (아무도 못 맞힘)` };
    st.cur = null;
    if (st.used.length >= pool(st).length) st.phase = "result";
  },
  undo(st, name) {
    if (name !== st.host) throw new Fail("방장만 되돌릴 수 있어", 403);
    const h = st.history.pop();
    if (!h) throw new Fail("되돌릴 게 없어");
    const target = h.winner || h.by;
    st.score[target] = (st.score[target] || 0) + (h.winner ? -1 : 1);
    st.used = st.used.filter((id) => id !== h.id);
    st.cur = null;
    st.phase = "play";
    st.last = { t: Date.now(), text: "방장이 직전 판정을 되돌렸어" };
  },
  end(st, name) {
    if (name !== st.host) throw new Fail("방장만 끝낼 수 있어", 403);
    st.cur = null;
    st.phase = "result";
  },
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const c = clean(req.query.code, 4);
      const d = await read(c);
      if (!d) throw new Fail("없는 방이야", 404);
      return res.json(view(c, d.st, clean(req.query.me, 10)));
    }
    if (req.method !== "POST") throw new Fail("지원 안 하는 요청", 405);

    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const name = clean(b.name, 10);
    if (!name) throw new Fail("이름을 입력해줘");

    if (b.action === "create") {
      const st = { host: name, phase: "lobby", players: [name], quiz: {}, score: { [name]: 0 }, cur: null, used: [], history: [], last: null };
      for (let i = 0; i < 10; i++) {
        const c = String(Math.floor(1000 + Math.random() * 9000));
        const ok = await redis.set(key(c), JSON.stringify(st), { nx: true, ex: TTL });
        if (ok) return res.json(view(c, st, name));
      }
      throw new Fail("방 코드 생성 실패. 다시 눌러줘", 500);
    }

    const fn = actions[b.action];
    if (!fn) throw new Fail("알 수 없는 요청");
    const c = clean(b.code, 4);
    const st = await update(c, (s) => fn(s, name, b));
    return res.json(view(c, st, name));
  } catch (e) {
    if (e instanceof Fail) return res.status(e.code).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: "서버 오류. 잠깐 뒤 다시 해줘" });
  }
}
