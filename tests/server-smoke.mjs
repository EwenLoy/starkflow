// Живой smoke-тест StarkFlow: проверяет реальный сервер по протоколу (Node 24+, global WebSocket).
const BASE = process.env.SF_BASE || 'http://127.0.0.1:8080';
const WS = process.env.SF_WS || 'ws://127.0.0.1:8080/ws';
// Уникальные app и комната на каждый запуск: иначе повторный прогон подряд попадёт
// в живую комнату прошлого прогона (emptyTTL по умолчанию 60 с) и тест упадёт.
const APP = 'smoke-' + Date.now().toString(36);
const ROOM = 'boss-' + Date.now().toString(36);

const wsUrl = (q = `v=1&app=${APP}`) => `${WS}?${q}`;

let passed = 0, failed = 0;
const ok = (n, x = '') => { passed++; console.log(`  ok   ${n}${x ? '  ' + x : ''}`); };
const bad = (n, x = '') => { failed++; console.log(`  FAIL ${n}  ${x}`); };
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok(n, g); else bad(n, `got ${g}, want ${w}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const c = { ws, inbox: [], waiters: [] };
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const i = c.waiters.findIndex(w => w.pred(m));
      if (i >= 0) { const [w] = c.waiters.splice(i, 1); w.resolve(m); } else c.inbox.push(m);
    });
    ws.addEventListener('error', () => reject(new Error('ws error: ' + url)));
    ws.addEventListener('close', () => { for (const w of c.waiters.splice(0)) w.reject(new Error('closed')); });
    ws.addEventListener('open', () => {
      c.send = (o) => ws.send(JSON.stringify(o));
      c.next = (pred, ms = 4000) => {
        const i = c.inbox.findIndex(pred);
        if (i >= 0) return Promise.resolve(c.inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred, resolve: res, reject: rej };
          c.waiters.push(w);
          setTimeout(() => {
            const j = c.waiters.indexOf(w);
            if (j >= 0) { c.waiters.splice(j, 1); rej(new Error('timeout waiting: ' + pred.toString())); }
          }, ms);
        });
      };
      c.nextT = (t, ms) => c.next(m => m.t === t, ms);
      c.expectErr = async (msg, code, label, ms) => {
        c.send(msg);
        eq(label, (await c.nextT('err', ms)).code, code);
      };
      resolve(c);
    });
  });
}

const schema = {
  boss_hp: { kind: 'num', mode: 'add', min: 0, max: 1000, maxDelta: 50 },
  motd: { kind: 'str', mode: 'const' },
  ready: { kind: 'bool', mode: 'set' },
};

(async () => {
  try {
    console.log(`\nStarkFlow smoke against ${BASE}\n`);

    // --- HTTP ---
    const h = await fetch(`${BASE}/health`);
    eq('GET /health', (await h.text()).trim(), 'ok');
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    eq('GET / (тестовая страница)', page.status === 200 && html.toLowerCase().includes('<!doctype html'), true);

    // --- версия протокола ---
    const V = await open(`${WS}?v=2&app=smoke`);
    eq('неверная версия протокола -> 100', (await V.nextT('err')).code, 100);
    V.ws.close();

    // --- A: hello -> welcome ---
    const A = await open(wsUrl());
    A.send({ t: 'hello', name: 'Alice' });
    const wA = await A.nextT('welcome');
    eq('welcome: proto = 1', wA.proto, 1);
    eq('welcome: есть userId и token', typeof wA.userId === 'string' && wA.userId.length > 0 && wA.token.length > 0, true);

    // --- A: создание комнаты ---
    A.send({
      t: 'room.join', id: 1, room: ROOM, create: true, maxPlayers: 4, strict: true,
      schema, init: { boss_hp: 100, motd: 'hi', ready: false },
    });
    const jA = await A.nextT('room.joined');
    eq('room.joined: you = 1, hostId = 1', [jA.you, jA.hostId], [1, 1]);
    eq('room.joined: initialState', jA.state, { boss_hp: 100, motd: 'hi', ready: false });
    eq('room.joined: maxPlayers', jA.maxPlayers, 4);

    // --- повторный join -> 303 ---
    await A.expectErr({ t: 'room.join', id: 2, room: 'smoke2' }, 303, 'повторный join -> 303');

    // --- state.add: писатель тоже получает state.changed и ok ---
    A.send({ t: 'state.add', id: 3, key: 'boss_hp', value: -10 });
    const chA = await A.nextT('state.changed');
    eq('state.changed у писателя', [chA.key, chA.old, chA.value, chA.by], ['boss_hp', 100, 90, 1]);
    eq('ok на add', (await A.nextT('ok')).id, 3);

    // --- B входит в ту же комнату ---
    const B = await open(wsUrl());
    B.send({ t: 'hello', name: 'Bob' });
    const wB = await B.nextT('welcome');
    B.send({ t: 'room.join', id: 1, room: ROOM });
    const jB = await B.nextT('room.joined');
    eq('B: resumed = false, you = 2', [jB.resumed, jB.you], [false, 2]);
    eq('B видит текущий стейт', jB.state.boss_hp, 90);
    eq('A получил player.joined (id 2)', (await A.nextT('player.joined')).player.id, 2);

    // --- запись B видна обоим ---
    B.send({ t: 'state.add', id: 2, key: 'boss_hp', value: -10 });
    const chA2 = await A.nextT('state.changed');
    eq('A видит удар B', [chA2.value, chA2.by], [80, 2]);
    eq('B видит свой удар', (await B.nextT('state.changed')).value, 80);

    // --- правила ключей ---
    await A.expectErr({ t: 'state.set', id: 4, key: 'boss_hp', value: 5 }, 402, 'set по ключу mode=add -> 402');
    await A.expectErr({ t: 'state.add', id: 5, key: 'boss_hp', value: -100 }, 403, 'maxDelta 50, дельта -100 -> 403');
    await A.expectErr({ t: 'state.add', id: 6, key: 'boss_hp', value: 51 }, 403, 'maxDelta 50, дельта +51 -> 403');
    await A.expectErr({ t: 'state.add', id: 7, key: 'motd', value: 1 }, 402, 'const-ключ -> 402');
    await A.expectErr({ t: 'state.set', id: 8, key: 'nope', value: 1 }, 400, 'strict: неизвестный ключ -> 400');
    await A.expectErr({ t: 'state.set', id: 9, key: 'bad key!', value: 1 }, 400, 'плохое имя ключа -> 400');

    // --- clamp по min ---
    A.send({ t: 'state.add', id: 10, key: 'boss_hp', value: -50 });
    eq('80 - 50 = 30', (await A.nextT('state.changed')).value, 30);
    A.send({ t: 'state.add', id: 11, key: 'boss_hp', value: -50 });
    eq('30 - 50 зажимается в min = 0', (await A.nextT('state.changed')).value, 0);

    // --- toggle ---
    A.send({ t: 'state.toggle', id: 12, key: 'ready' });
    eq('toggle ready -> true', (await A.nextT('state.changed')).value, true);

    // --- события ---
    A.send({ t: 'event', code: 7, data: { x: 1 }, to: 'all' });
    const evA = await A.nextT('event'), evB = await B.nextT('event');
    eq('event to all: A', [evA.code, evA.from], [7, 1]);
    eq('event to all: B', [evB.code, evB.from], [7, 1]);
    A.send({ t: 'event', code: 8, data: 1 });
    eq('event по умолчанию = others: B', (await B.nextT('event')).code, 8);
    await sleep(200);
    eq('A не получает свой others-event', A.inbox.filter(m => m.t === 'event').length, 0);

    // --- свойства игрока ---
    B.send({ t: 'player.set', id: 20, key: 'color', value: 'red' });
    const pp = await A.nextT('player.props');
    eq('player.props broadcast', [pp.id, pp.key, pp.value], [2, 'color', 'red']);

    // --- обрыв и повторный вход после реконнекта ---
    B.ws.close();
    eq('player.suspended id 2', (await A.nextT('player.suspended')).id, 2);
    const B2 = await open(wsUrl());
    B2.send({ t: 'hello', token: wB.token, name: 'Bob' });
    const wB2 = await B2.nextT('welcome');
    eq('rejoin: тот же userId', wB2.userId, wB.userId);
    B2.send({ t: 'room.join', id: 1, room: ROOM });
    const jB2 = await B2.nextT('room.joined');
    eq('rejoin: resumed = true, тот же id 2', [jB2.resumed, jB2.you], [true, 2]);
    eq('rejoin: стейт сохранился', jB2.state, { boss_hp: 0, motd: 'hi', ready: true });
    eq('A получил player.resumed', (await A.nextT('player.resumed')).player.id, 2);

    // --- подпись токена ---
    const B3 = await open(wsUrl());
    B3.send({ t: 'hello', token: wB.token.slice(0, -2) + 'xx' });
    eq('подделанный токен -> 200', (await B3.nextT('err')).code, 200);

    // --- порядок сообщений и ping ---
    const C = await open(wsUrl());
    C.send({ t: 'ping', ts: 1 });
    eq('сообщение до hello -> 102', (await C.nextT('err')).code, 102);
    A.send({ t: 'ping', ts: 12345 });
    eq('pong возвращает ts', (await A.nextT('pong')).ts, 12345);

    // --- список комнат ---
    A.send({ t: 'room.list', id: 30 });
    const rl = await A.nextT('room.list.result');
    eq('room.list.result', rl.rooms.map(r => [r.room, r.players, r.maxPlayers]), [[ROOM, 2, 4]]);
    eq('room.list.result: id запроса вернулся', rl.id, 30);

    // --- комната не найдена ---
    const D = await open(wsUrl());
    D.send({ t: 'hello' });
    await D.nextT('welcome');
    D.send({ t: 'room.join', id: 1, room: 'nosuch' });
    eq('join без create в несуществующую -> 300', (await D.nextT('err')).code, 300);

    // --- изоляция приложений: app=other не видит smoke1 ---
    const E = await open(`${WS}?v=1&app=other`);
    E.send({ t: 'hello' });
    await E.nextT('welcome');
    E.send({ t: 'room.list', id: 1 });
    eq('app=other: список комнат пуст', (await E.nextT('room.list.result')).rooms, []);

    for (const c of [A, B2, B3, C, D, E]) c.ws.close();
    await sleep(200);
  } catch (e) {
    bad('исключение', e && e.message ? e.message : String(e));
  }
  console.log(`\nИтого: ${passed} ok, ${failed} FAIL\n`);
  process.exit(failed ? 1 : 0);
})();
