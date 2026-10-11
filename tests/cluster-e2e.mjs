// Verifies a running cluster: directory + nodes in two regions.
// Start them (see docs/CLUSTER.md), then:  SF_DIR=https://dir.example.com node tests/cluster-e2e.mjs
const DIR = process.env.SF_DIR || 'http://127.0.0.1:8097';
const APP = 'smokeapp';
const ORIGIN = 'https://preview.construct.net';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra) =>
{
	console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
	if (!cond) fails++;
};
const post = async (path, body) =>
{
	const r = await fetch(DIR + path, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
		body: JSON.stringify(body)
	});
	return { status: r.status, cors: r.headers.get('access-control-allow-origin'), json: await r.json().catch(() => null) };
};
const client = (url, ticket) => new Promise((res, rej) =>
{
	const ws = new WebSocket(url + '?v=1&app=' + APP + '&ticket=' + encodeURIComponent(ticket));
	const msgs = [];
	ws.onmessage = (ev) => msgs.push(JSON.parse(ev.data));
	ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: 'E2E' }));
	const t = setInterval(() =>
	{
		const w = msgs.find((m) => m.t === 'welcome');
		if (w) { clearInterval(t); res({ ws, msgs, welcome: w }); }
	}, 20);
	setTimeout(() => { clearInterval(t); rej(new Error('no welcome: ' + JSON.stringify(msgs.map((m) => m.t)))); }, 4000);
});
const wait = (c, pred, ms) => new Promise((res, rej) =>
{
	const t = setInterval(() =>
	{
		const m = c.msgs.find(pred);
		if (m) { clearInterval(t); res(m); }
	}, 20);
	setTimeout(() => { clearInterval(t); rej(new Error('timeout, got: ' + JSON.stringify(c.msgs.map((x) => x.t)))); }, ms);
});

// 1. the game page is a foreign origin: the browser sends a preflight first
const pf = await fetch(DIR + '/assign', {
	method: 'OPTIONS',
	headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
});
ok('preflight -> 204 + allow-origin', pf.status === 204 && pf.headers.get('access-control-allow-origin') === '*',
	pf.status + ' ' + pf.headers.get('access-control-allow-origin'));

// 2. the region list the client measures
const reg = await (await fetch(DIR + '/regions')).json();
ok('both regions are listed', reg.regions.length === 2 &&
	reg.regions[0].region === 'eu' && reg.regions[1].region === 'ru', reg.regions);

// 3. a pinned region picks a node of that region
const ru = await post('/assign', { app: APP, region: 'ru' });
ok('assign region=ru -> a ru node', ru.status === 200 && ru.json.region === 'ru' &&
	reg.regions.some((r) => r.url === ru.json.url), ru.json);
ok('the answer names the region', ru.json.region === 'ru', ru.json.region);
ok('the answer is CORS-readable', ru.cors === '*', ru.cors);

// 4. the ticket is accepted by that very node
const a = await client(ru.json.url, ru.json.ticket).catch((e) => { ok('ticket accepted', false, e.message); return null; });
if (a)
{
	ok('ticket accepted (welcome, proto 1)', a.welcome.proto === 1 && !!a.welcome.userId);

	// 5. create a room on the ru node
	a.ws.send(JSON.stringify({ t: 'room.join', id: 1, room: 'cluster-e2e', create: true, maxPlayers: 4 }));
	const joined = await wait(a, (m) => m.t === 'room.joined', 3000);
	ok('room created on the ru node', !!joined.roomId, joined.roomId);

	// the directory learns about rooms from the 5 s heartbeat
	await sleep(6000);
	const roomNode = ru.json.url;

	// 6. the room wins over a region hint: everyone must land where the room lives
	const byId = await post('/assign', { app: APP, room: joined.roomId, region: 'eu' });
	ok('an existing room beats the region hint', byId.json.url === roomNode && byId.json.region === 'ru',
		[byId.json.url, byId.json.region]);
	const byName = await post('/assign', { app: APP, room: 'cluster-e2e', region: 'eu' });
	ok('join by name goes to the same node', byName.json.url === roomNode, byName.json.url);

	// 7. a region nobody runs is reported, not silently swapped
	const bad = await post('/assign', { app: APP, region: 'us' });
	ok('a region without nodes -> 503', bad.status === 503, bad.status);

	// 8. a second client lands in the same room on the same node
	const b = await client(byName.json.url, byName.json.ticket);
	b.ws.send(JSON.stringify({ t: 'room.join', id: 1, room: 'cluster-e2e' }));
	const j2 = await wait(b, (m) => m.t === 'room.joined', 3000);
	ok('the second client is in the same room', j2.you === 2 && j2.hostId === 1, [j2.you, j2.hostId]);
	b.ws.close();
	a.ws.close();
}

console.log(fails === 0 ? 'CLUSTER E2E OK' : 'CLUSTER E2E FAILED (' + fails + ')');
process.exit(fails === 0 ? 0 : 1);
