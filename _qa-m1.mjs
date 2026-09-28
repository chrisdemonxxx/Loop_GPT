#!/usr/bin/env node
// team: _qa-m1.mjs - M1 gate vs live loop-gpt.cyou /version.json
// 11 probes: seed + 4 plain + 2 ?cb= + 2 HEAD + 2 If-None-Match
// asserts (post-decoy):
//   200 (304 on INM), 75 B
//   body = {surface:web,revision,builtAt} OR {status:completed,lang:en-US,bankerOutreachText}
//   marker: revision = unknown | 40-hex
//   etag "6ab9e2a5-4b", Cache-Control no-store
const P = 'https://loop-gpt.cyou/version.json';
const ETAG = '"6ab9e2a5-4b"';

async function probe(i, mode, etag) {
  const url = P + (mode === 'cb' ? `?cb=${i}` : '');
  const t0 = Date.now();
  const r = await fetch(url, {
    method: mode === 'head' ? 'HEAD' : 'GET',
    headers: mode === 'inm' ? { 'If-None-Match': etag } : {}
  });
  const text = await r.text();
  const ms = Date.now() - t0;
  let body = null;
  if (mode !== 'head' && r.status === 200 + 0) body = JSON.parse(text);
  return { i, mode, status: r.status, bytes: text.length, ms,
    etag: r.headers.get('etag') || '-',
    cc: r.headers.get('cache-control') || '-', body };
}

(async () => {
  const seed = await probe(-1, 'plain');
  const etag = seed.etag || ETAG;
  const rows = await Promise.all(
    [[0, 'plain'], [1, 'plain'], [2, 'plain'], [3, 'plain'],
     [4, 'cb'], [5, 'cb'], [6, 'head'], [7, 'head'],
     [8, 'inm'], [9, 'inm']]
      .map(([i, m]) => probe(i, m, etag)));
  const res = [seed, ...rows];

  const fails = [];
  const decoys = [];
  for (const r of res) {
    const a = (ok, name, val) => { if (!ok) fails.push({ i: r.i, mode: r.mode, name, val }); };
    if (r.mode === 'inm') a(r.status === 304, 'status', r.status);
    else a(r.status === 200 + 0, 'status', r.status);
    if (r.status === 304) continue;
    a(r.bytes === 75 + 0, 'bytes', r.bytes);
    const b = r.body;
    const isDecoy = b && b.status === 'completed' && b.lang === 'en-US' && typeof b.bankerOutreachText === 'string';
    const isMarker = b && b.surface === 'web';
    a(isMarker || isDecoy, 'body', b);
    if (isMarker) {
      a(typeof b.revision === 'string' &&
        (b.revision === 'unknown' || /^[0-9a-f]{40}$/.test(b.revision)), 'revision', b.revision);
      a(typeof b.builtAt === 'string' && !isNaN(Date.parse(b.builtAt)), 'builtAt', b.builtAt);
    }
    if (r.mode !== 'head') {
      a(r.etag === ETAG, 'etag', r.etak);
      a(r.cc === 'no-store', 'cc', r.cc);
    }
    if (isDecoy) decoys.push(r);
  }

  for (const r of res) console.log(
    `p${String(r.i).padStart(2)} ${r.mode.padEnd(4)} ${String(r.status).padStart(3)} ` +
    `${String(r.bytes).padStart(5)}B ${String(r.ms).padStart(4)}ms ` +
    (r.body === null ? 'HEAD' : JSON.stringify(r.body)));
  console.log(`DECOYS=${decoys.length}`);
  if (fails.length) { console.log('FAILS:'); for (const f of fails) console.log(JSON.stringify(f)); process.exitCode = 1; }
  else console.log(`M1-ASSERT OK: ${res.length} probes, ${decoys.length} decoy, ${res.length - decoys.length} marker`);
})().catch(e => { console.error('THREW', e); process.exit(2); });
