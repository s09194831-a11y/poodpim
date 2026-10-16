// PoodPim counter + Google login + website (Cloudflare Worker). Needs D1 binding DB, secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, text variables CONTACT_EMAIL, DOWNLOAD_URL.
const LIMIT = 2500;            // คำต่อสัปดาห์ของแบบฟรี (ตรงกับในโปรแกรม)
const MAX_USED = 10000000;
const HOUR = 3600000;
const LOGIN_TTL = 10 * 60000;  // กดเข้าสู่ระบบแล้วต้องทำให้เสร็จภายใน 10 นาที
const RATE = { usage: 3000, start: 30, buy: 30, admin: 10, slip: 20, dl: 60 }; // ครั้งต่อ IP ต่อ 10 นาที (คนใช้จริงเช็กราว 2 ครั้งต่อการพูดหนึ่งครั้ง)

const PROVIDERS = {
  google: {
    name: 'Google', id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET', scope: 'openid email profile',
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    iss: ['https://accounts.google.com', 'accounts.google.com'], extra: { prompt: 'select_account', hl: 'th' },
  },
  line: {
    name: 'LINE', id: 'LINE_CHANNEL_ID', secret: 'LINE_CHANNEL_SECRET', scope: 'openid profile',
    auth: 'https://access.line.me/oauth2/v2.1/authorize', token: 'https://api.line.me/oauth2/v2.1/token',
    iss: ['https://access.line.me'], extra: { ui_locales: 'th-TH' },
  },
};

function provider(env, p) {
  const c = Object.prototype.hasOwnProperty.call(PROVIDERS, p) ? PROVIDERS[p] : null;
  if (!c || !env[c.id] || !env[c.secret]) return null;
  const P = p.toUpperCase();
  return { ...c, key: p, clientId: String(env[c.id]).trim(), clientSecret: String(env[c.secret]).trim(),
    authURL: env[P + '_AUTH_URL'] || c.auth, tokenURL: env[P + '_TOKEN_URL'] || c.token };
}

const TABLES = [
  'CREATE TABLE IF NOT EXISTS counts (m TEXT NOT NULL, week TEXT NOT NULL, i TEXT NOT NULL, u TEXT NOT NULL DEFAULT \'\', used INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (m, week, i))',
  'CREATE INDEX IF NOT EXISTS counts_user ON counts (u, week)',
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, provider TEXT NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL DEFAULT \'\', email TEXT NOT NULL DEFAULT \'\', created INTEGER NOT NULL, UNIQUE (provider, sub))',
  'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS logins (id TEXT PRIMARY KEY, provider TEXT NOT NULL, port INTEGER NOT NULL, state TEXT NOT NULL, challenge TEXT NOT NULL, code TEXT, user TEXT, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS logins_code ON logins (code)',
  'CREATE TABLE IF NOT EXISTS pro (user TEXT PRIMARY KEY, since INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT \'\')',
  'CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user TEXT NOT NULL, amount INTEGER NOT NULL, url TEXT NOT NULL DEFAULT \'\', status TEXT NOT NULL, pi TEXT NOT NULL DEFAULT \'\', created INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS orders_user ON orders (user, status)',
  'CREATE INDEX IF NOT EXISTS orders_pi ON orders (pi)',
  'CREATE TABLE IF NOT EXISTS slips (ref TEXT PRIMARY KEY, order_id TEXT NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS slip_calls (at INTEGER NOT NULL, code TEXT NOT NULL DEFAULT \'\')',
  'CREATE TABLE IF NOT EXISTS admin_fails (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS downloads (day TEXT NOT NULL, src TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, src))',
];

let tableReady = false;

async function ensureTable(db) {
  if (tableReady) return;
  let done = false;
  if (typeof db.batch === 'function') {
    try {
      await db.batch(TABLES.map((sql) => db.prepare(sql)));
      done = true;
    } catch (e) { /* ลองทีละคำสั่ง */ }
  }
  if (!done) for (const sql of TABLES) await db.prepare(sql).run();
  tableReady = true;
}

async function withDB(db, fn) {
  try {
    await ensureTable(db);
    return await fn();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    tableReady = false;
    await ensureTable(db);
    return await fn();
  }
}

function mondayOf(t) {
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function weekOK(week, now) {
  return week === mondayOf(now - 12 * HOUR) || week === mondayOf(now + 14 * HOUR);
}

const hits = new Map();
function tooMany(req, kind) {
  const ip = req.headers.get('cf-connecting-ip') || '';
  if (!ip) return false;
  const now = Date.now(), key = kind + ' ' + ip;
  let h = hits.get(key);
  if (!h || Math.abs(now - h.at) > LOGIN_TTL) {
    if (hits.size > 20000) hits.clear();
    h = { at: now, n: 0 };
    hits.set(key, h);
  }
  return ++h.n > RATE[kind];
}

function limited(req, kind) {
  const h = hits.get(kind + ' ' + (req.headers.get('cf-connecting-ip') || ''));
  return !!h && Math.abs(Date.now() - h.at) <= LOGIN_TTL && h.n >= RATE[kind];
}

let pruned = 0;
async function prune(db, now) {
  if (Math.abs(now - pruned) < LOGIN_TTL) return;
  pruned = now;
  await db.prepare('DELETE FROM logins WHERE created < ?1').bind(now - 6 * LOGIN_TTL).run();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page(title, msg, status = 400) {
  const html = '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TokType</title>' +
    '<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f5;color:#141413;font:16px/1.7 "Leelawadee UI","Segoe UI",system-ui,sans-serif;padding:0 16px}' +
    'main{max-width:420px;display:grid;gap:10px}h1{font-size:22px;margin:0}p{margin:0;color:#4a4945}' +
    '@media (prefers-color-scheme:dark){body{background:#262624;color:#faf9f5}p{color:#c8c6bd}}</style></head>' +
    '<body><main><h1>' + esc(title) + '</h1><p>' + esc(msg) + '</p></main></body></html>';
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const UPDATED = '10 ตุลาคม 2569 (10 October 2026)';
const LOGO = '<svg viewBox="0 0 100 100" width="44" height="44" aria-hidden="true"><defs><linearGradient id="t" x1=".1" y1="0" x2=".9" y2="1"><stop offset="0" stop-color="#e8916c"/><stop offset=".5" stop-color="#d97757"/><stop offset="1" stop-color="#bd5a38"/></linearGradient></defs>' +
  '<rect x="4" y="4" width="92" height="92" rx="23" fill="url(#t)"/><g fill="none" stroke="#fff" stroke-width="9.5" stroke-linecap="round" stroke-linejoin="round"><path d="M36.5 30V61A7 7 0 0 0 50.5 61V44"/><path d="M50.5 61A7 7 0 0 0 64.5 61V30"/><path d="M22 45V56"/><path d="M79 41V58"/></g></svg>';
const SITE_CSS = ':root{--bg:#faf9f5;--fg:#141413;--mut:#5d5b55;--line:#e6e2d6;--card:#fff;--acc:#a94f31}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#262624;--fg:#faf9f5;--mut:#c2bfb5;--line:#45443f;--card:#30302d;--acc:#ee9a7c;color-scheme:dark}}' +
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 "IBM Plex Sans Thai","Leelawadee UI","Segoe UI",Tahoma,sans-serif}h1,h2,header b{font-family:Anuphan,"IBM Plex Sans Thai","Leelawadee UI",sans-serif}' +
  '.w{max-width:760px;margin:0 auto;padding:28px 16px 56px}header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header b{font-size:22px}' +
  'nav{margin-left:auto;display:flex;gap:16px;flex-wrap:wrap;font-size:15px}a{color:var(--acc)}h1{font-size:30px;line-height:1.3;margin:28px 0 8px}' +
  'h2{font-size:20px;margin:28px 0 6px}p,li{color:var(--mut)}p{margin:8px 0}ul{padding-left:22px;margin:8px 0}' +
  '.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin:16px 0}' +
  '.en{border-top:1px solid var(--line);margin-top:36px;padding-top:8px}footer{margin-top:36px;font-size:13px;color:var(--mut);overflow-wrap:anywhere}code{font-size:12.5px}';

function site(title, body) {
  const html = '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anuphan:wght@600;700&family=IBM+Plex+Sans+Thai:wght@400;600&display=swap">' +
    '<style>' + SITE_CSS + '</style></head><body><div class="w"><header><a href="/" style="display:flex;align-items:center;gap:12px;color:inherit;text-decoration:none">' + LOGO + '<b>TokType</b></a>' +
    '<nav><a href="/">หน้าแรก</a><a href="/privacy">นโยบายความเป็นส่วนตัว</a><a href="/terms">ข้อกำหนด</a></nav></header>' + body + '</div></body></html>';
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function contactEmails(env) {
  const out = [];
  for (const v of [env.CONTACT_EMAIL, env.CONTACT_EMAIL_2]) {
    const e = String(v || '').trim();
    if (/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(e) && !out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e);
  }
  return out;
}

function contactEmail(env) {
  return contactEmails(env)[0] || '';
}

function contact(env) {
  const list = contactEmails(env);
  return list.length ? list.map((e) => '<a href="mailto:' + esc(e) + '">' + esc(e) + '</a>').join(' / ') : '<b>(ผู้ดูแลยังไม่ได้ใส่อีเมลติดต่อ / contact email not set yet)</b>';
}

const DOWNLOAD = 'https://github.com/s09194831-a11y/poodpim/releases/latest/download/toktype-windows.zip';
function homePage(status, env, url) {
  const from = srcOf(url);
  const fill = {
    DL: dlTarget(env) ? '/download' + (from ? '?from=' + from : '') : '#soon',
    STATUS: esc(JSON.stringify(status)),
    CONTACT: contact(env),
    VERSION: esc(String(env.APP_VERSION || '0.5.2').slice(0, 20)),
    SIZE: esc(String(env.APP_SIZE || '140 MB').slice(0, 20)),
    ORIGIN: esc(url.origin),
    VERIFY: verifyTag(env),
  };
  const html = HOME.replace(/\{\{(DL|STATUS|CONTACT|VERSION|SIZE|ORIGIN|VERIFY)\}\}/g, (m, k) => fill[k]);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const HOME = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TokType พูดภาษาไทยแทนพิมพ์ ได้ทุกโปรแกรม</title>
<meta name="description" content="TokType โปรแกรมพิมพ์ด้วยเสียงภาษาไทยบน Windows กดคีย์ลัดค้างไว้ พูด ปล่อยมือ ข้อความขึ้นตรงที่คุณพิมพ์ ถอดเสียงในเครื่องคุณเอง ฟรี 2,500 คำทุกสัปดาห์">
<link rel="canonical" href="{{ORIGIN}}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="TokType">
<meta property="og:locale" content="th_TH">
<meta property="og:title" content="TokType พูดภาษาไทยแทนพิมพ์ ได้ทุกโปรแกรม">
<meta property="og:description" content="พิมพ์ภาษาไทยด้วยเสียงบน Windows กดคีย์ลัดค้างไว้ พูด ปล่อย ข้อความขึ้นในทุกโปรแกรม ถอดเสียงในเครื่องคุณเอง ฟรี 2,500 คำทุกสัปดาห์">
<meta property="og:url" content="{{ORIGIN}}/">
<meta property="og:image" content="{{ORIGIN}}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="TokType พูดภาษาไทย ข้อความขึ้นเอง">
<meta name="twitter:card" content="summary_large_image">
{{VERIFY}}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect x='4' y='4' width='92' height='92' rx='23' fill='%23d97757'/%3E%3Cg fill='none' stroke='%23fff' stroke-width='9.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M36.5 30V61A7 7 0 0 0 50.5 61V44'/%3E%3Cpath d='M50.5 61A7 7 0 0 0 64.5 61V30'/%3E%3Cpath d='M22 45V56'/%3E%3Cpath d='M79 41V58'/%3E%3C/g%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anuphan:wght@500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600&display=swap">
<style>
:root{--bg:#faf9f5;--bg2:#f2efe6;--card:#fff;--ink:#1f1e1c;--mut:#67635a;--line:#e5e0d3;--acc:#c96442;--acc2:#d97757;--acc-ink:#a94f31;--wash:#f7e4da;--stage:#262624;--stage2:#1d1c1a;--win:#302f2c;--win2:#3a3935;--wink:#f2efe6;--winm:#a8a397;--ok:#2e7d4f;--shadow:0 30px 60px -30px rgba(60,40,20,.35)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1f1e1c;--bg2:#262624;--card:#2b2a27;--ink:#f2efe6;--mut:#b3aea2;--line:#3d3c38;--acc:#d97757;--acc2:#e8916c;--acc-ink:#ee9a7c;--wash:#3f2c25;--stage:#2b2a27;--stage2:#191817;--ok:#6fcf97;--shadow:0 30px 60px -30px rgba(0,0,0,.7);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#1f1e1c;--bg2:#262624;--card:#2b2a27;--ink:#f2efe6;--mut:#b3aea2;--line:#3d3c38;--acc:#d97757;--acc2:#e8916c;--acc-ink:#ee9a7c;--wash:#3f2c25;--stage:#2b2a27;--stage2:#191817;--ok:#6fcf97;--shadow:0 30px 60px -30px rgba(0,0,0,.7);color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.75 "IBM Plex Sans Thai","Leelawadee UI",Tahoma,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}
h1,h2,h3{font-family:Anuphan,"IBM Plex Sans Thai","Leelawadee UI",sans-serif;line-height:1.2;text-wrap:balance;margin:0}
p{margin:0}
.wrap{max-width:1120px;margin:0 auto;padding-inline:20px}
.logo{display:inline-flex;align-items:center;gap:10px;text-decoration:none;font:700 21px/1 Anuphan,sans-serif}
.logo svg{width:34px;height:34px;flex:none}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;border-radius:999px;padding:15px 26px;font:600 17px/1 "IBM Plex Sans Thai",sans-serif;text-decoration:none;border:0;cursor:pointer;transition:transform .15s,box-shadow .15s,background .15s}
.btn svg{width:20px;height:20px;flex:none}
.btn-p{background:var(--acc);color:#fff;box-shadow:0 14px 30px -12px rgba(201,100,66,.75)}
.btn-p:hover{background:#b8573a;transform:translateY(-1px)}
.btn-g{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line)}
.btn-g:hover{box-shadow:inset 0 0 0 1.5px var(--mut)}
.btn-sm{padding:10px 18px;font-size:15px}
.top{position:sticky;top:0;z-index:20;border-bottom:1px solid transparent;transition:border-color .2s,background .2s}
.top.scrolled{background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom-color:var(--line)}
.top .wrap{display:flex;align-items:center;gap:28px;height:68px}
.top nav{display:flex;gap:26px;margin-left:auto;font-size:15.5px}
.top nav a{text-decoration:none;color:var(--mut)}
.top nav a:hover{color:var(--ink)}
@media (max-width:820px){.top nav{display:none}.top .btn-sm{margin-left:auto}}
.hero{position:relative;padding-block:64px 32px;text-align:center;isolation:isolate}
.hero::before{content:"";position:absolute;left:50%;top:-140px;width:min(1100px,100%);height:720px;transform:translateX(-50%);z-index:-1;background:radial-gradient(closest-side,color-mix(in srgb,var(--acc2) 20%,transparent),transparent)}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:7px 15px;border-radius:999px;background:var(--card);box-shadow:inset 0 0 0 1px var(--line);font-size:14.5px;color:var(--mut)}
.eyebrow b{color:var(--acc-ink);font-weight:600}
.hero h1{font-size:clamp(42px,7vw,82px);font-weight:700;letter-spacing:-.01em;margin-top:22px}
.hero h1 .hl{color:var(--acc);position:relative;white-space:nowrap}
.hero h1 .hl svg{position:absolute;left:0;right:0;bottom:-.16em;width:100%;height:.3em;overflow:visible}
.hero .lead{max-width:640px;margin:22px auto 0;font-size:clamp(17px,2vw,20px);color:var(--mut)}
.cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:32px}
.fine{margin-top:16px;font-size:14px;color:var(--mut);display:flex;gap:6px 16px;justify-content:center;flex-wrap:wrap}
.fine span{display:inline-flex;align-items:center;gap:6px}
.fine span::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--acc2)}
#soon{max-width:560px;margin:18px auto 0;padding:12px 16px;border-radius:14px;background:var(--wash);color:var(--acc-ink);font-size:15px}
#soon:not(:target){display:none}
.stage{position:relative;margin:48px auto 0;max-width:1040px;border-radius:30px;padding:30px;background:linear-gradient(160deg,var(--stage),var(--stage2));box-shadow:var(--shadow);display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:26px;text-align:left;color:var(--wink);overflow:hidden}
.stage::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(500px 220px at 85% 0%,rgba(217,119,87,.18),transparent 70%)}
.win{position:relative;z-index:1;background:var(--win);border-radius:18px;box-shadow:0 0 0 1px rgba(255,255,255,.06);display:flex;flex-direction:column;min-height:360px;min-width:0}
.win-bar{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.07);font-size:14.5px}
.win-bar .dots{display:flex;gap:6px}.win-bar .dots i{width:10px;height:10px;border-radius:50%;background:#56544f}
.win-bar b{font-weight:600}
.win-bar .av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#e8916c,#bd5a38);display:grid;place-items:center;font-size:12px;color:#fff;font-weight:600}
.msgs{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:10px;padding:18px 16px;min-height:0}
.bub{max-width:82%;padding:10px 14px;border-radius:16px;font-size:15.5px;line-height:1.55;animation:pop .35s ease}
.bub.them{background:var(--win2);border-bottom-left-radius:5px;align-self:flex-start}
.bub.me{background:var(--acc);color:#fff;border-bottom-right-radius:5px;align-self:flex-end}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.composer{display:flex;gap:10px;align-items:center;padding:12px;border-top:1px solid rgba(255,255,255,.07)}
.field{flex:1;min-height:46px;border-radius:14px;background:rgba(255,255,255,.06);padding:11px 14px;font-size:15.5px;line-height:1.5;position:relative;min-width:0;overflow-wrap:anywhere}
.field .ph{color:var(--winm)}
.field .caret{display:inline-block;width:2px;height:1.15em;background:var(--acc2);vertical-align:-3px;margin-left:1px;animation:blink 1s steps(1) infinite}
.field.flash{animation:flash .9s ease}
@keyframes flash{0%{background:rgba(217,119,87,.35)}100%{background:rgba(255,255,255,.06)}}
@keyframes blink{50%{opacity:0}}
.send{width:42px;height:42px;border-radius:50%;border:0;background:var(--acc);color:#fff;display:grid;place-items:center;flex:none}
.send svg{width:18px;height:18px}
.said{position:relative;z-index:1;display:flex;flex-direction:column;gap:14px;min-width:0}
.said-h{font-size:13.5px;color:var(--winm)}
.said-box{background:rgba(255,255,255,.04);border-radius:18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);padding:18px;min-height:150px}
.raw{font-size:19px;line-height:1.7;color:#e9e5db}
.raw .w{transition:color .4s,opacity .4s}
.raw.done .cut{text-decoration:line-through;text-decoration-color:var(--acc2);text-decoration-thickness:2px;opacity:.45}
.raw.done .fix{color:#f4b393;background:rgba(217,119,87,.16);border-radius:6px;padding:0 3px}
.tags{display:flex;flex-wrap:wrap;gap:8px}
.tag{font-size:13.5px;padding:6px 12px;border-radius:999px;background:rgba(217,119,87,.16);color:#f4b393;animation:pop .35s ease}
.keyrow{display:flex;align-items:center;gap:12px;font-size:14.5px;color:var(--winm);margin-top:auto}
kbd{font:600 14px/1 "IBM Plex Sans Thai",sans-serif;padding:10px 14px;border-radius:10px;background:#3d3c38;color:#f2efe6;box-shadow:0 4px 0 #1a1918;transition:transform .1s,box-shadow .1s,background .1s;display:inline-block}
kbd.on{transform:translateY(3px);box-shadow:0 1px 0 #1a1918;background:var(--acc)}
.pill{position:absolute;z-index:3;left:50%;bottom:84px;transform:translate(-50%,20px);opacity:0;display:flex;align-items:center;gap:9px;padding:8px 14px 8px 8px;border-radius:999px;background:#151413;box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.08);transition:opacity .25s,transform .25s}
.pill.show{opacity:1;transform:translate(-50%,0)}
.pill svg{width:28px;height:28px}
.bars{display:flex;align-items:center;gap:3px;height:22px}
.bars i{width:3.5px;border-radius:3px;background:var(--acc2);height:5px;transition:height .12s}
.pill.listen .bars i{animation:wave .9s ease-in-out infinite}
.pill.listen .bars i:nth-child(2){animation-delay:.12s}.pill.listen .bars i:nth-child(3){animation-delay:.24s}.pill.listen .bars i:nth-child(4){animation-delay:.36s}.pill.listen .bars i:nth-child(5){animation-delay:.48s}
@keyframes wave{0%,100%{height:5px}50%{height:20px}}
.pill.done{box-shadow:0 0 0 6px rgba(217,119,87,.25),0 10px 30px rgba(0,0,0,.45)}
@media (max-width:820px){.stage{grid-template-columns:minmax(0,1fr);padding:16px;border-radius:24px}.win{min-height:320px}.said-box{min-height:120px}.raw{font-size:17px}}
.apps{padding-block:56px 8px;text-align:center}
.apps p{color:var(--mut);font-size:15.5px}
.marquee{margin-top:18px;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)}
.track{display:flex;gap:12px;width:max-content;animation:slide 38s linear infinite}
.chip{padding:10px 18px;border-radius:999px;background:var(--card);box-shadow:inset 0 0 0 1px var(--line);font-weight:500;white-space:nowrap;font-size:15.5px}
@keyframes slide{to{transform:translateX(-50%)}}
section.block{padding-block:88px}
.kicker{font-size:15px;color:var(--acc-ink);font-weight:600}
.block h2{font-size:clamp(30px,4.2vw,48px);font-weight:700;margin-top:10px}
.block h2 em{font-style:normal;color:var(--acc)}
.sub{color:var(--mut);margin-top:14px;max-width:620px}
.center{text-align:center}.center .sub{margin-inline:auto}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-top:44px}
.step{background:var(--card);border-radius:22px;padding:26px;box-shadow:inset 0 0 0 1px var(--line);display:flex;flex-direction:column;gap:14px}
.step .n{font:700 15px/1 Anuphan,sans-serif;color:var(--acc-ink)}
.step h3{font-size:23px}
.step p{color:var(--mut);font-size:16px}
.step .vis{height:96px;border-radius:16px;background:var(--bg2);display:grid;place-items:center}
.step .vis kbd{font-size:16px;padding:12px 18px;animation:press 2.4s ease-in-out infinite}
@keyframes press{0%,15%{transform:none;box-shadow:0 4px 0 #1a1918;background:#3d3c38}25%,70%{transform:translateY(3px);box-shadow:0 1px 0 #1a1918;background:var(--acc)}80%,100%{transform:none;box-shadow:0 4px 0 #1a1918;background:#3d3c38}}
.step .vis .bars{height:44px;gap:5px}.step .vis .bars i{width:6px;animation:wave 1s ease-in-out infinite}
.step .vis .bars i:nth-child(2n){animation-delay:.15s}.step .vis .bars i:nth-child(3n){animation-delay:.3s}
.step .vis .out{font-size:16px;background:var(--card);padding:10px 14px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line)}
.step .vis .out i{display:inline-block;width:2px;height:1.1em;background:var(--acc);vertical-align:-3px;animation:blink 1s steps(1) infinite}
@media (max-width:820px){.steps{grid-template-columns:minmax(0,1fr)}}
.speed{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:48px;align-items:center}
.meter{display:flex;flex-direction:column;gap:22px}
.meter .row{display:grid;gap:8px}
.meter .lab{display:flex;justify-content:space-between;font-size:15.5px}
.meter .lab b{font-family:Anuphan,sans-serif;font-variant-numeric:tabular-nums}
.meter .bar{height:16px;border-radius:99px;background:var(--bg2);overflow:hidden}
.meter .bar i{display:block;height:100%;width:0;border-radius:99px;background:var(--mut);transition:width 1.6s cubic-bezier(.2,.8,.2,1)}
.meter .row.v .bar i{background:linear-gradient(90deg,var(--acc),var(--acc2))}
.meter .note{font-size:13.5px;color:var(--mut)}
@media (max-width:820px){.speed{grid-template-columns:minmax(0,1fr);gap:28px}}
.smart{margin-top:40px;display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:20px;align-items:stretch}
.tabs{display:flex;flex-direction:column;gap:8px}
.tabs button{all:unset;cursor:pointer;padding:16px 18px;border-radius:16px;display:grid;gap:2px;transition:background .15s}
.tabs button b{font:600 19px/1.3 Anuphan,sans-serif}
.tabs button span{font-size:15px;color:var(--mut)}
.tabs button:hover{background:var(--bg2)}
.tabs button[aria-selected="true"]{background:var(--card);box-shadow:inset 0 0 0 1px var(--line),0 10px 24px -18px rgba(60,40,20,.5)}
.tabs button[aria-selected="true"] b{color:var(--acc-ink)}
.tabs button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.xpanel{background:var(--stage);color:var(--wink);border-radius:24px;padding:30px;display:flex;flex-direction:column;justify-content:center;gap:16px;min-height:300px}
.xpanel .lbl{font-size:13.5px;color:var(--winm)}
.xpanel .said-t{font-size:20px;color:#cfcabe}
.xpanel .arrow{width:36px;height:36px;border-radius:50%;background:rgba(217,119,87,.18);display:grid;place-items:center;color:#f4b393}
.xpanel .got{font:600 clamp(21px,2.6vw,27px)/1.5 "IBM Plex Sans Thai",sans-serif;white-space:pre-line}
.xpanel .got mark{background:rgba(217,119,87,.22);color:#f6c0a4;border-radius:6px;padding:0 4px}
@media (max-width:820px){.smart{grid-template-columns:minmax(0,1fr)}.tabs{flex-direction:row;overflow-x:auto;padding-bottom:4px}.tabs button{flex:none;padding:12px 16px}.tabs button span{display:none}}
.priv{background:var(--stage);color:var(--wink);border-radius:32px;padding:clamp(28px,5vw,64px);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:center;position:relative;overflow:hidden}
.priv::before{content:"";position:absolute;inset:auto -10% -40% auto;width:520px;height:520px;border-radius:50%;background:radial-gradient(closest-side,rgba(217,119,87,.25),transparent)}
.priv h2{color:#fff}.priv .sub{color:#c9c4b8}
.priv ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;position:relative}
.priv li{display:grid;grid-template-columns:40px minmax(0,1fr);gap:14px;align-items:start;background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);border-radius:18px;padding:16px}
.priv li i{width:40px;height:40px;border-radius:12px;background:rgba(217,119,87,.18);display:grid;place-items:center;color:#f4b393;font-style:normal}
.priv li i svg{width:20px;height:20px}
.priv li b{display:block;font-weight:600;color:#fff}
.priv li span{color:#c9c4b8;font-size:15.5px}
.priv a{color:#f4b393}
@media (max-width:820px){.priv{grid-template-columns:minmax(0,1fr)}}
.plans{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:44px auto 0;max-width:780px;align-items:stretch}
.plan{background:var(--card);border-radius:24px;padding:28px;box-shadow:inset 0 0 0 1px var(--line);display:flex;flex-direction:column;gap:16px;position:relative}
.plan.best{box-shadow:inset 0 0 0 2px var(--acc),0 30px 50px -36px rgba(201,100,66,.7)}
.plan .badge{position:absolute;top:-13px;left:28px;background:var(--acc);color:#fff;font-size:13px;font-weight:600;padding:5px 12px;border-radius:999px}
.plan h3{font-size:22px}
.plan .desc{color:var(--mut);font-size:15px;margin-top:-8px}
.price{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.price b{font:700 44px/1 Anuphan,sans-serif;font-variant-numeric:tabular-nums}
.price small{font-size:16px;color:var(--mut)}
.price s{color:var(--mut);font-size:17px}
.plan ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px;font-size:15.5px}
.plan li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px}
.plan li::before{content:"";width:18px;height:18px;margin-top:5px;border-radius:50%;background:var(--wash) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23c96442' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 12.5l4 4 8-9'/%3E%3C/svg%3E") center/12px no-repeat}
.plan .btn{margin-top:auto}
.plan .soon{margin-top:auto;text-align:center;font-size:14.5px;color:var(--mut);padding:13px;border-radius:999px;background:var(--bg2)}
.plans-note{margin-top:20px;text-align:center;font-size:14px;color:var(--mut)}
@media (max-width:700px){.plans{grid-template-columns:minmax(0,1fr)}}
.faq{max-width:780px;margin:40px auto 0;display:flex;flex-direction:column;gap:10px}
.faq details{background:var(--card);border-radius:18px;box-shadow:inset 0 0 0 1px var(--line);padding:4px 22px}
.faq summary{cursor:pointer;list-style:none;padding:16px 0;font-weight:600;display:flex;justify-content:space-between;gap:16px;align-items:center}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font:500 24px/1 Anuphan,sans-serif;color:var(--acc);transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{color:var(--mut);padding-bottom:18px}
.final{text-align:center;border-radius:32px;padding:clamp(40px,7vw,80px) 24px;background:radial-gradient(600px 260px at 50% 0%,color-mix(in srgb,var(--acc2) 28%,transparent),transparent 70%),var(--bg2);box-shadow:inset 0 0 0 1px var(--line)}
.final h2{font-size:clamp(30px,4.6vw,52px)}
.final .logo-big{width:76px;height:76px;margin:0 auto 22px;filter:drop-shadow(0 16px 24px rgba(201,100,66,.35))}
footer{padding-block:48px 56px;color:var(--mut);font-size:14.5px}
footer .wrap{display:flex;flex-wrap:wrap;gap:16px 28px;align-items:center}
footer nav{display:flex;gap:20px;flex-wrap:wrap;margin-left:auto}
footer a{color:var(--mut)}
footer .status{flex-basis:100%;font:12px/1.5 ui-monospace,Consolas,monospace;opacity:.75;overflow-wrap:anywhere}
.reveal{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s ease}
.reveal.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.reveal{opacity:1;transform:none}}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<linearGradient id="lg" x1=".1" y1="0" x2=".9" y2="1"><stop offset="0" stop-color="#e8916c"/><stop offset=".5" stop-color="#d97757"/><stop offset="1" stop-color="#bd5a38"/></linearGradient>
<symbol id="pp" viewBox="0 0 100 100"><rect x="4" y="4" width="92" height="92" rx="23" fill="url(#lg)"/><g fill="none" stroke="#fff" stroke-width="9.5" stroke-linecap="round" stroke-linejoin="round"><path d="M36.5 30V61A7 7 0 0 0 50.5 61V44"/><path d="M50.5 61A7 7 0 0 0 64.5 61V30"/><path d="M22 45V56"/><path d="M79 41V58"/></g></symbol>
<symbol id="dl" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 19.5h14"/></g></symbol>
</defs></svg>
<header class="top" id="top"><div class="wrap">
<a class="logo" href="/"><svg><use href="#pp"/></svg>TokType</a>
<nav><a href="#how">วิธีใช้</a><a href="#smart">เข้าใจภาษาไทย</a><a href="#privacy">ความเป็นส่วนตัว</a><a href="#pricing">ราคา</a><a href="#faq">คำถาม</a></nav>
<a class="btn btn-p btn-sm" href="{{DL}}"><svg><use href="#dl"/></svg>ดาวน์โหลดฟรี</a>
</div></header>
<main>
<section class="hero"><div class="wrap">
<span class="eyebrow"><b>ใหม่</b> พิมพ์ด้วยเสียงภาษาไทย บน Windows</span>
<h1>พูดแทนพิมพ์<br><span class="hl">ได้ทุกโปรแกรม<svg viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true"><path d="M4 14C70 5 150 3 296 10" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity=".45"/></svg></span></h1>
<p class="lead">กดคีย์ลัดค้างไว้ พูดภาษาไทย ปล่อยมือ ข้อความที่เรียบร้อยแล้วขึ้นตรงที่คุณกำลังพิมพ์ ทั้งแชท อีเมล เอกสาร และ AI</p>
<div class="cta">
<a class="btn btn-p" href="{{DL}}"><svg><use href="#dl"/></svg>ดาวน์โหลดฟรีสำหรับ Windows</a>
<a class="btn btn-g" href="#how">ดูวิธีใช้</a>
</div>
<div class="fine"><span>Windows 10 ขึ้นไป</span><span>ฟรี 2,500 คำทุกสัปดาห์</span><span>ไม่ต้องใช้บัตร</span><span>เสียงไม่ออกจากเครื่องคุณ</span></div>
<p id="soon">ไฟล์ติดตั้งกำลังจะเปิดให้ดาวน์โหลดเร็วๆ นี้ กลับมาที่หน้านี้อีกครั้งนะครับ</p>
<div class="stage" id="demo" aria-label="ตัวอย่างการใช้ TokType">
<div class="win">
<div class="win-bar"><span class="dots"><i></i><i></i><i></i></span><span class="av" id="av">ท</span><b id="wt">แชทกับทีม</b></div>
<div class="msgs" id="msgs"></div>
<div class="composer"><div class="field" id="field"><span id="typed"></span><span class="caret"></span><span class="ph" id="ph">พิมพ์ข้อความ</span></div><span class="send" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg></span></div>
<div class="pill" id="pill"><svg><use href="#pp"/></svg><span class="bars"><i></i><i></i><i></i><i></i><i></i></span></div>
</div>
<div class="said">
<div class="said-h">ที่คุณพูด</div>
<div class="said-box"><p class="raw" id="raw"></p></div>
<div class="said-h">TokType จัดให้</div>
<div class="tags" id="tags"></div>
<div class="keyrow"><kbd id="key">Ctrl ขวา</kbd><span id="kt">กดค้างไว้แล้วพูด</span></div>
</div>
</div>
</div></section>
<section class="apps"><div class="wrap">
<p>ใช้ได้ทุกที่ที่มีช่องให้พิมพ์</p>
<div class="marquee"><div class="track" id="track"></div></div>
</div></section>
<section class="block" id="how"><div class="wrap center">
<div class="kicker reveal">ใช้ง่ายใน 3 ขั้น</div>
<h2 class="reveal">กดค้าง พูด <em>ปล่อย</em></h2>
<p class="sub reveal">ไม่ต้องสลับหน้าจอ ไม่ต้องคัดลอกมาวาง คลิกช่องที่จะพิมพ์ในโปรแกรมไหนก็ได้ แล้วพูดได้เลย</p>
<div class="steps">
<div class="step reveal"><div class="vis"><kbd>Ctrl ขวา</kbd></div><span class="n">1</span><h3>กดคีย์ลัดค้างไว้</h3><p>ตั้งเป็นปุ่มอื่นได้ เช่น F8 หรือ Ctrl + Space</p></div>
<div class="step reveal"><div class="vis"><span class="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div><span class="n">2</span><h3>พูดภาษาไทยตามปกติ</h3><p>พูดไทยปนอังกฤษได้ พูดยาวไม่อยากกดค้าง แตะสองครั้งแล้วพูดต่อได้เลย</p></div>
<div class="step reveal"><div class="vis"><span class="out">ส่งของพรุ่งนี้นะครับ<i></i></span></div><span class="n">3</span><h3>ปล่อยมือ ข้อความขึ้นเอง</h3><p>ข้อความขึ้นในราว 1 วินาที ตรงตำแหน่งที่เคอร์เซอร์กระพริบอยู่</p></div>
</div>
</div></section>
<section class="block" style="padding-top:0"><div class="wrap speed">
<div>
<div class="kicker reveal">เร็วกว่าพิมพ์</div>
<h2 class="reveal">พูดได้เร็วกว่า<br><em>พิมพ์หลายเท่า</em></h2>
<p class="sub reveal">คนเราพูดเร็วกว่าพิมพ์บนคีย์บอร์ดมาก ยิ่งภาษาไทยที่ต้องกด Shift หาสระและวรรณยุกต์ ยิ่งเห็นความต่าง</p>
</div>
<div class="meter reveal" id="meter">
<div class="row"><div class="lab"><span>พิมพ์บนคีย์บอร์ด</span><b>~40 คำ/นาที</b></div><div class="bar"><i data-w="26"></i></div></div>
<div class="row v"><div class="lab"><span>พูดกับ TokType</span><b>~150 คำ/นาที</b></div><div class="bar"><i data-w="100"></i></div></div>
<p class="note">ตัวเลขเฉลี่ยทั่วไปของการพิมพ์และการพูด แต่ละคนเร็วไม่เท่ากัน</p>
</div>
</div></section>
<section class="block" id="smart" style="padding-top:0"><div class="wrap">
<div class="kicker reveal">เข้าใจภาษาไทย</div>
<h2 class="reveal">ไม่ใช่แค่ถอดเสียง <em>แต่เกลาให้ด้วย</em></h2>
<p class="sub reveal">พูดแบบที่พูดจริง แล้วได้ข้อความแบบที่อยากส่งจริง ตัวอย่างด้านล่างคือผลจากโปรแกรมจริง</p>
<div class="smart reveal">
<div class="tabs" role="tablist" id="tabs"></div>
<div class="xpanel" role="tabpanel" id="panel">
<div class="lbl">ที่พูด</div><p class="said-t" id="p-said"></p>
<span class="arrow" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg></span>
<div class="lbl">ที่ได้</div><p class="got" id="p-got"></p>
</div>
</div>
</div></section>
<section class="block" id="privacy" style="padding-top:0"><div class="wrap">
<div class="priv reveal">
<div>
<div class="kicker" style="color:#f4b393">ความเป็นส่วนตัว</div>
<h2 style="margin-top:10px;font-size:clamp(30px,4.2vw,46px)">เสียงของคุณ<br>ไม่ออกจากเครื่องคุณ</h2>
<p class="sub">TokType ถอดเสียงด้วยคอมของคุณเอง ไม่ส่งเสียงหรือข้อความขึ้นอินเทอร์เน็ต <a href="/privacy">อ่านนโยบายความเป็นส่วนตัว</a></p>
</div>
<ul>
<li><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg></i><div><b>ถอดเสียงในคอมของคุณ</b><span>ตัวถอดเสียงภาษาไทยติดตั้งมากับโปรแกรม ไม่มีใครได้ยินเสียงคุณ</span></div></li>
<li><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h7"/><path d="M16 15l5 5"/><path d="M21 15l-5 5"/></svg></i><div><b>ไม่เก็บข้อความที่คุณพูด</b><span>ประวัติอยู่แค่ในโปรแกรม ปิดแล้วหายไป</span></div></li>
<li><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg></i><div><b>เซิร์ฟเวอร์รู้แค่จำนวนคำ</b><span>ใช้บัญชี Google เข้าสู่ระบบ เพื่อนับโควตาฟรีรายสัปดาห์เท่านั้น</span></div></li>
</ul>
</div>
</div></section>
<section class="block" id="pricing" style="padding-top:0"><div class="wrap center">
<div class="kicker reveal">ราคา</div>
<h2 class="reveal">เริ่มฟรี <em>ใช้ได้ตลอด</em></h2>
<p class="sub reveal">ฟรี 2,500 คำทุกสัปดาห์</p>
<div class="plans" style="text-align:left">
<div class="plan reveal"><h3>ฟรี</h3><p class="desc">สำหรับใช้ทุกวัน</p><div class="price"><b>0</b><small>บาท</small></div>
<ul><li>2,500 คำทุกสัปดาห์ เริ่มนับใหม่ทุกวันจันทร์</li><li>ถอดเสียงในเครื่อง เสียงไม่ออกไปไหน</li><li>คำสั่งเสียงครบทุกคำสั่ง</li><li>ทุกสไตล์ ทั่วไป แชท ทางการ รายการ</li><li>คลังคำ เพิ่มคำของคุณเองได้</li></ul>
<a class="btn btn-g" href="{{DL}}">ดาวน์โหลดฟรี</a></div>
<div class="plan best reveal"><span class="badge">ราคาเปิดตัว 100 คนแรก</span><h3>Pro</h3><p class="desc">จ่ายครั้งเดียว ใช้ได้ตลอด</p><div class="price"><b>290</b><small>บาท</small><s>490 บาท</s></div>
<ul><li>พิมพ์ไม่จำกัดจำนวนคำ ไม่ต้องรอวันจันทร์</li><li>ทุกอย่างในแบบฟรี</li><li>จ่ายครั้งเดียว ไม่มีรายเดือน</li><li>อัปเดตฟรีตลอด</li></ul>
<span class="soon">เปิดขายเร็วๆ นี้</span></div>
</div>
<p class="plans-note reveal">ทุกฟีเจอร์ใช้ได้ในแบบฟรี Pro เพิ่มแค่ไม่จำกัดจำนวนคำ ราคาอาจเปลี่ยนก่อนเปิดขาย</p>
</div></section>
<section class="block" id="spec" style="padding-top:0"><div class="wrap center">
<div class="kicker reveal">สเปคคอม</div>
<h2 class="reveal">คอมแบบไหน <em>ใช้ได้</em></h2>
<p class="sub reveal" style="margin-inline:auto">คอม Windows 10 ขึ้นไป ที่เปิดเว็บใน Chrome ได้ไม่อืด ส่วนใหญ่ใช้ได้เลย</p>
<div class="plans" style="text-align:left">
<div class="plan reveal"><h3>ขั้นต่ำ</h3><p class="desc">ใช้ได้</p>
<ul><li>Windows 10 ขึ้นไป แบบ 64 บิต</li><li>ซีพียู 2 คอร์ขึ้นไป</li><li>แรม 4 GB</li><li>ที่ว่าง 600 MB ตอนติดตั้ง ติดตั้งเสร็จใช้ราว 200 MB</li><li>ไมค์อะไรก็ได้ ไมค์ในโน้ตบุ๊กก็ได้</li><li>ต่ออินเทอร์เน็ต เน็ตช้าก็ได้</li></ul></div>
<div class="plan reveal"><h3>แนะนำ</h3><p class="desc">ลื่นที่สุด</p>
<ul><li>ซีพียู 4 เธรดขึ้นไป เช่น Core i3 หรือ Ryzen 3 ขึ้นไป</li><li>แรม 8 GB ขึ้นไป</li><li>หูฟังมีไมค์ ถ้าที่นั่งเสียงดัง</li></ul></div>
</div>
<p class="plans-note reveal">ยังใช้กับ Mac, มือถือ, Chromebook, Windows 7/8 และ Windows 32 บิตไม่ได้<br>คอมรุ่นเก่ามากอาจรอนานขึ้นเล็กน้อยหลังพูดจบ</p>
</div></section>
<section class="block" id="faq" style="padding-top:0"><div class="wrap center">
<div class="kicker reveal">คำถามที่พบบ่อย</div>
<h2 class="reveal">มีคำถาม <em>ตอบให้ตรงนี้</em></h2>
<div class="faq" style="text-align:left">
<details><summary>ใช้กับโปรแกรมไหนได้บ้าง</summary><p>ได้ทุกโปรแกรมที่มีช่องให้พิมพ์ ทั้ง LINE, Facebook, Claude, ChatGPT, Word, Excel, Gmail และทุกเว็บใน Chrome หรือ Edge</p></details>
<details><summary>ต้องต่ออินเทอร์เน็ตไหม</summary><p>ต้องต่อเน็ตไว้ เพื่อเช็กบัญชีและนับจำนวนคำ แต่เสียงและข้อความถอดในเครื่องคุณ ไม่ถูกส่งขึ้นอินเทอร์เน็ต</p></details>
<details><summary>คอมแบบไหนใช้ได้</summary><p>Windows 10 ขึ้นไป แบบ 64 บิต แรม 4 GB ขึ้นไป ที่ว่าง 600 MB ตอนติดตั้ง เครื่องทั่วไปถอดเสียงพูด 10 วินาทีเสร็จในไม่ถึง 1 วินาที ตอนนี้ยังไม่มีรุ่น Mac และมือถือ ดูทั้งหมดที่ <a href="#spec">สเปคคอม</a></p></details>
<details><summary>ติดตั้งแล้ว Windows ขึ้นหน้าจอสีฟ้าเตือน</summary><p>กด "ข้อมูลเพิ่มเติม" แล้วกด "เรียกใช้อยู่ดี" ขึ้นแบบนี้เพราะโปรแกรมยังไม่ได้ซื้อใบรับรองผู้พัฒนา ไม่ได้แปลว่ามีไวรัส</p></details>
<details><summary>พูดไทยปนอังกฤษได้ไหม</summary><p>ได้ คำอังกฤษที่คนไทยพูดบ่อยกว่า 600 คำ เช่น meeting, deadline, Excel จะเขียนเป็นตัวอังกฤษให้เอง คำอื่นเพิ่มเองได้ในหน้าคลังคำ</p></details>
<details><summary>ฟรีจริงไหม ต้องผูกบัตรไหม</summary><p>ฟรีจริง 2,500 คำทุกสัปดาห์ตลอดไป ไม่ต้องผูกบัตร แค่เข้าสู่ระบบด้วยบัญชี Google</p></details>
<details><summary>ถอนการติดตั้งยังไง</summary><p>การตั้งค่า > แอป > แอปที่ติดตั้ง > TokType (รุ่นก่อนหน้าชื่อ พูดพิมพ์) > ถอนการติดตั้ง ระบบจะลบทุกอย่างออกให้หมด</p></details>
</div>
</div></section>
<section class="block" style="padding-top:0"><div class="wrap">
<div class="final reveal">
<svg class="logo-big"><use href="#pp"/></svg>
<h2>ลองพูดดูสักประโยค</h2>
<p class="sub" style="margin-inline:auto">ติดตั้งไม่ถึงนาที เข้าสู่ระบบด้วย Google แล้วพูดได้เลย</p>
<div class="cta"><a class="btn btn-p" href="{{DL}}"><svg><use href="#dl"/></svg>ดาวน์โหลดฟรีสำหรับ Windows</a></div>
<div class="fine"><span>รุ่น {{VERSION}}</span><span>{{SIZE}}</span><span>Windows 10 ขึ้นไป</span></div>
</div>
</div></section>
</main>
<footer><div class="wrap">
<a class="logo" href="/" style="font-size:18px"><svg style="width:28px;height:28px"><use href="#pp"/></svg>TokType</a>
<span>© 2026 TokType</span>
<nav><a href="/privacy">นโยบายความเป็นส่วนตัว</a><a href="/terms">ข้อกำหนดการใช้งาน</a><span>ติดต่อ: {{CONTACT}}</span></nav>
<div class="status">สถานะเซิร์ฟเวอร์ / server status: {{STATUS}}</div>
</div></footer>
<script>
(function(){
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var $=function(id){return document.getElementById(id);};
var top=$('top');addEventListener('scroll',function(){top.classList.toggle('scrolled',scrollY>8);},{passive:true});
var apps=['LINE','Facebook','Messenger','Claude','ChatGPT','Gemini','Gmail','Outlook','Word','Excel','PowerPoint','Google Docs','Notion','Canva','Discord','Teams','Chrome','Edge','Notepad'];
var tr=$('track');apps.concat(apps).forEach(function(a){var s=document.createElement('span');s.className='chip';s.textContent=a;tr.appendChild(s);});
var io='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;e.target.classList.add('in');if(e.target.id==='meter'){[].forEach.call(e.target.querySelectorAll('i[data-w]'),function(i){i.style.width=i.getAttribute('data-w')+'%';});}io.unobserve(e.target);});},{threshold:.15}):null;
[].forEach.call(document.querySelectorAll('.reveal'),function(el){if(io)io.observe(el);else{el.classList.add('in');}});
if(!io){[].forEach.call(document.querySelectorAll('i[data-w]'),function(i){i.style.width=i.getAttribute('data-w')+'%';});}
var T=[
['ตัวเลข','พูดเป็นคำ ได้เป็นตัวเลข','โอนเงินสองพันห้าร้อยบาทแล้วนะ','โอนเงิน <mark>2,500</mark> บาทแล้วนะ'],
['คำอังกฤษ','คำทับศัพท์เป็นตัวอังกฤษ','ฝากอัปเดตฟีดแบ็กลูกค้าในเอ็กเซลด้วยนะ','ฝาก <mark>update feedback</mark> ลูกค้าใน <mark>Excel</mark> ด้วยนะ'],
['พูดแก้','พูดผิดแล้วแก้ได้ทันที','ส่งของวันพุธ เอ้ย วันพฤหัสนะครับ','ส่งของ<mark>วันพฤหัส</mark>นะครับ'],
['คำติดปาก','ตัดเอ่อ อืม ออกให้','เอ่อ ประชุมพรุ่งนี้ขอเลื่อนเป็นบ่ายสองนะครับ','ประชุมพรุ่งนี้ขอเลื่อนเป็นบ่ายสองนะครับ'],
['เครื่องหมาย','เติม , และ ? ให้เอง','ซื้อนม ไข่ และขนมปัง ไปด้วยกันไหม','ซื้อนม<mark>,</mark> ไข่ และขนมปัง ไปด้วยกันไหม<mark>?</mark>'],
['คำสั่งเสียง','อีโมจิและขึ้นบรรทัดใหม่','ขอบคุณมากครับ อีโมจิไหว้','ขอบคุณมากครับ <mark>🙏</mark>']
];
var tabs=$('tabs');
T.forEach(function(t,i){var b=document.createElement('button');b.setAttribute('role','tab');b.innerHTML='<b></b><span></span>';b.firstChild.textContent=t[0];b.lastChild.textContent=t[1];b.onclick=function(){pick(i,true);};tabs.appendChild(b);});
var cur=0,auto=true;
function pick(i,user){cur=i;if(user)auto=false;[].forEach.call(tabs.children,function(b,k){b.setAttribute('aria-selected',k===i?'true':'false');});$('p-said').textContent='"'+T[i][2]+'"';$('p-got').innerHTML=T[i][3];}
pick(0);
if(!reduce)setInterval(function(){if(auto)pick((cur+1)%T.length);},4200);
var S=[
{t:'แชทกับทีม',a:'ท',them:'พรุ่งนี้ประชุมกี่โมงดีครับ',raw:[['อืม ','cut'],['พรุ่งนี้ประชุม'],['บ่ายสามโมง เอ้ย ','cut'],['บ่ายสี่โมง','fix'],['นะครับ ทุกคนสะดวกไหม']],out:'พรุ่งนี้ประชุมบ่าย 4 โมงนะครับ ทุกคนสะดวกไหม?',tags:['ตัด "อืม" ออก','พูดแก้ บ่ายสาม เป็นบ่าย 4','เติม ? ให้']},
{t:'กลุ่มเพื่อน',a:'พ',them:'ค่าตั๋วคอนเสิร์ตคนละ 2,500 นะ',raw:[['โอนเงิน'],['สองพันห้าร้อย','fix'],['บาทแล้วนะ ขอบคุณครับ '],['อีโมจิไหว้','fix']],out:'โอนเงิน 2,500 บาทแล้วนะ ขอบคุณครับ 🙏',tags:['สองพันห้าร้อย เป็น 2,500','อีโมจิไหว้ เป็น 🙏']},
{t:'ถาม AI',a:'AI',them:'มีอะไรให้ช่วยไหมครับ',raw:[['ช่วยสรุป'],['มีตติ้ง','fix'],['เมื่อวาน แล้วดู'],['เดดไลน์','fix'],[' '],['โปรเจกต์','fix'],['ให้หน่อย']],out:'ช่วยสรุป meeting เมื่อวานแล้วดู deadline project ให้หน่อย',tags:['มีตติ้ง เป็น meeting','เดดไลน์ เป็น deadline','โปรเจกต์ เป็น project']}
];
var msgs=$('msgs'),typed=$('typed'),ph=$('ph'),raw=$('raw'),tags=$('tags'),key=$('key'),kt=$('kt'),pill=$('pill'),field=$('field');
function bub(text,who){var d=document.createElement('div');d.className='bub '+who;d.textContent=text;msgs.appendChild(d);while(msgs.children.length>4)msgs.removeChild(msgs.firstChild);}
function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}
function setScene(s){$('wt').textContent=s.t;$('av').textContent=s.a;msgs.innerHTML='';bub(s.them,'them');typed.textContent='';ph.hidden=false;raw.innerHTML='';raw.classList.remove('done');tags.innerHTML='';}
function finalState(s){setScene(s);s.raw.forEach(function(p){var w=document.createElement('span');w.className='w '+(p[1]||'');w.textContent=p[0];raw.appendChild(w);});raw.classList.add('done');s.tags.forEach(function(t){var g=document.createElement('span');g.className='tag';g.textContent=t;tags.appendChild(g);});ph.hidden=true;typed.textContent=s.out;}
if(reduce||!window.Promise){finalState(S[0]);return;}
var visible=true;
if('IntersectionObserver' in window){new IntersectionObserver(function(es){visible=es[0].isIntersecting;}).observe($('demo'));}
async function run(){
for(var k=0;;k=(k+1)%S.length){
var s=S[k];setScene(s);await wait(1100);
while(!visible||document.hidden)await wait(400);
key.classList.add('on');kt.textContent='กำลังฟัง...';pill.className='pill show listen';
await wait(350);
for(var i=0;i<s.raw.length;i++){var p=s.raw[i],w=document.createElement('span');w.className='w '+(p[1]||'');raw.appendChild(w);for(var c=0;c<p[0].length;c+=2){w.textContent=p[0].slice(0,c+2);await wait(55);}}
await wait(450);
key.classList.remove('on');kt.textContent='ปล่อยมือ';pill.className='pill show';
raw.classList.add('done');await wait(500);
pill.className='pill show done';ph.hidden=true;typed.textContent=s.out;field.classList.remove('flash');void field.offsetWidth;field.classList.add('flash');
for(var j=0;j<s.tags.length;j++){var g=document.createElement('span');g.className='tag';g.textContent=s.tags[j];tags.appendChild(g);await wait(260);}
await wait(500);pill.className='pill';kt.textContent='กดค้างไว้แล้วพูด';
await wait(1500);bub(s.out,'me');typed.textContent='';ph.hidden=false;
await wait(2600);
}
}
run();
})();
</script>
</body>
</html>`;

function privacyPage(env) {
  const c = contact(env);
  return site('นโยบายความเป็นส่วนตัว TokType', '<h1>นโยบายความเป็นส่วนตัว</h1><p>ปรับปรุงล่าสุด ' + UPDATED + '</p>' +
    '<p>TokType (ชื่อเดิม พูดพิมพ์) เป็นโปรแกรมพิมพ์ภาษาไทยด้วยเสียงบน Windows หน้านี้อธิบายว่าเราเก็บข้อมูลอะไร เพื่ออะไร และคุณขอลบได้อย่างไร ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 ติดต่อผู้ดูแล: ' + c + '</p>' +
    '<h2>สิ่งที่เราไม่เก็บ</h2><ul><li>เสียงพูด ไฟล์เสียง และข้อความที่คุณพูดหรือพิมพ์ เสียงถูกถอดเป็นข้อความในเครื่องของคุณ ไม่ถูกส่งมาที่เซิร์ฟเวอร์</li>' +
    '<li>รหัสผ่าน Google ของคุณ เราไม่เห็นและไม่เก็บ เพราะคุณพิมพ์รหัสผ่านในหน้าของ Google เองโดยตรง</li><li>รายชื่อผู้ติดต่อ ไฟล์ หรือข้อมูลอื่นในบัญชี Google ของคุณ</li></ul>' +
    '<h2>สิ่งที่เราเก็บ</h2><ul><li><b>บัญชี:</b> เมื่อเข้าสู่ระบบด้วย Google เราได้รับชื่อ อีเมล และหมายเลขบัญชี Google ของคุณ (เลขประจำบัญชีที่ Google ให้ ไม่ใช่รหัสผ่าน)</li>' +
    '<li><b>กุญแจเข้าระบบ:</b> เก็บแบบแปลงแล้ว (แฮช) ใช้จำว่าโปรแกรมในเครื่องของคุณเข้าสู่ระบบอยู่</li>' +
    '<li><b>จำนวนคำ:</b> จำนวนคำที่ใช้ในแต่ละสัปดาห์ คู่กับเลขประจำเครื่องและเลขการติดตั้งที่แปลงแล้ว (ย้อนกลับเป็นเลขจริงไม่ได้) และเวลาที่อัปเดต</li>' +
    '<li><b>ข้อมูลชั่วคราวตอนเข้าสู่ระบบ:</b> ลบเองภายใน 1 ชั่วโมง</li>' +
    '<li><b>การซื้อ Pro:</b> เราเก็บหมายเลขรายการ จำนวนเงิน สถานะ และเวลา คู่กับบัญชีของคุณ ถ้าโอนพร้อมเพย์ เราเห็นสลิปที่คุณส่งมา (ชื่อผู้โอน ธนาคาร เวลา) ใช้ตรวจการจ่ายเงินและคืนเงินเท่านั้น' + (slipOn(env) ? ' ถ้าอัปโหลดสลิปในหน้าจ่ายเงิน รูปสลิปจะถูกส่งให้ SlipOK (บริการตรวจสลิปในไทย) ตรวจกับธนาคาร เราไม่เก็บรูป เก็บแค่เลขที่รายการโอน ยอด และเวลา' : '') + ' ถ้าจ่ายผ่าน Stripe เราไม่เห็นเลขบัตร Stripe เก็บข้อมูลการจ่ายตามนโยบายของ Stripe</li>' +
    '<li><b>ยอดดาวน์โหลด:</b> นับจำนวนครั้งที่กดดาวน์โหลดโปรแกรมต่อวันและต่อช่องทางที่มา (เช่น TikTok) เป็นตัวเลขรวมเท่านั้น ไม่ผูกกับตัวคน บัญชี หรือ IP</li></ul>' +
    '<h2>ใช้เพื่ออะไร</h2><ul><li>นับโควตาฟรีรายสัปดาห์ และกันไม่ให้ตัวนับเริ่มใหม่เมื่อลบหรือติดตั้งโปรแกรมใหม่</li><li>รวมจำนวนคำของบัญชีเดียวกันในหลายเครื่อง และแสดงชื่อบัญชีในโปรแกรม</li>' +
    '<li>ผูกสิทธิ์ Pro ที่ซื้อกับบัญชีของคุณ</li></ul><p>เราไม่ขาย ไม่ให้เช่า และไม่ส่งต่อข้อมูลของคุณให้ใคร ไม่ใช้ทำโฆษณา</p>' +
    '<h2>เก็บที่ไหน นานเท่าไหร่</h2><p>ข้อมูลเก็บบน Cloudflare ซึ่งเป็นผู้ให้บริการเซิร์ฟเวอร์ของเรา Google ใช้ยืนยันตัวตนตอนเข้าสู่ระบบ และหน้าเว็บนี้โหลดฟอนต์จาก Google Fonts (เบราว์เซอร์ของคุณติดต่อ Google โดยตรงตามปกติของเว็บ) เราเก็บบัญชีและจำนวนคำไว้ตราบที่คุณยังใช้บริการ หรือจนกว่าคุณขอให้ลบ เซิร์ฟเวอร์ดูที่อยู่ IP เพื่อกันการเรียกถี่ผิดปกติ จำไว้ในหน่วยความจำไม่เกิน 10 นาที ไม่บันทึกลงฐานข้อมูล</p>' +
    '<h2>สิทธิ์ของคุณ</h2><ul><li>ขอดู แก้ไข หรือลบข้อมูลของคุณ ส่งอีเมลจากบัญชีที่ใช้เข้าสู่ระบบมาที่ ' + c + ' เราจะลบภายใน 30 วัน</li>' +
    '<li>ออกจากระบบในโปรแกรม (ตั้งค่า > บัญชี > ออกจากระบบ) กุญแจเข้าระบบในเซิร์ฟเวอร์จะถูกลบทันที</li>' +
    '<li>ยกเลิกสิทธิ์ที่ให้ TokType ได้ที่ <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a></li></ul>' +
    '<p>การใช้ข้อมูลที่ได้รับจาก Google API ของ TokType เป็นไปตาม Google API Services User Data Policy รวมถึงข้อกำหนด Limited Use</p>' +
    '<div class="en"><h2>Privacy policy (English)</h2><p>Last updated ' + UPDATED + '. Contact: ' + c + '.</p>' +
    '<p><b>We never collect</b> your voice, audio or the text you dictate or type. Speech is transcribed on your own computer and is not sent to our server. We never see or store your Google password (you type it on Google\'s own page), and we do not access your contacts, files or any other Google data.</p>' +
    '<p><b>We store</b>: your Google name, email address and Google account ID number (not your password) when you sign in; a hashed sign-in key; weekly word counts linked to a one-way hashed machine ID and install ID, with the time of the last update; temporary sign-in records that are deleted within one hour; and, if you buy Pro, the order number, amount, status and time. If you pay by PromptPay we see the transfer slip you send us (sender name, bank, time) and use it only to confirm or refund the payment;' + (slipOn(env) ? ' if you upload the slip on the payment page, the image is sent to SlipOK (a Thai slip-checking service) to check it with the bank, and we keep only the transfer reference number, amount and time, not the image;' : '') + ' card payments go through Stripe and we never see your card number.</p>' +
    '<p>We also count downloads of the app per day and per source (for example TikTok) as plain totals, not linked to any person, account or IP address.</p>' +
    '<p><b>We use it</b> to count the free weekly word allowance, keep that count when the app is reinstalled, combine counts for one account across computers, show your account name in the app, and link Pro purchases to your account. We do not sell, rent or share your data and do not use it for advertising.</p>' +
    '<p><b>Storage and retention</b>: data is stored on Cloudflare, our hosting provider. Google is used to confirm your identity, and these pages load fonts from Google Fonts (your browser contacts Google directly, as usual on the web). The server looks at IP addresses only to block abnormal request floods, keeps them in memory for at most 10 minutes and never writes them to the database. We keep your account and word counts while you use the service or until you ask us to delete them.</p>' +
    '<p><b>Your choices</b>: email us from your sign-in address to see, correct or delete your data; we delete within 30 days. Signing out in the app deletes your sign-in key on the server. You can remove TokType\'s access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>' +
    '<p>TokType\'s use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p></div>');
}

function termsPage(env) {
  return site('ข้อกำหนดการใช้งาน TokType', '<h1>ข้อกำหนดการใช้งาน</h1><p>ปรับปรุงล่าสุด ' + UPDATED + '</p><ul>' +
    '<li>TokType ให้ใช้ฟรี 2,500 คำต่อสัปดาห์ต่อบัญชีและต่อเครื่อง ต้องต่ออินเทอร์เน็ตและเข้าสู่ระบบด้วย Google</li>' +
    '<li>ห้ามแก้ไขโปรแกรมหรือปลอมข้อมูลเพื่อเลี่ยงการนับคำ เราระงับบัญชีที่ทำแบบนั้นได้</li>' +
    '<li><b>Pro:</b> จ่ายครั้งเดียว ' + PRICE.launch / 100 + ' บาทสำหรับ ' + PRICE.seats + ' คนแรก จากนั้น ' + PRICE.normal / 100 + ' บาท ไม่มีรายเดือน บัญชี Google ที่ซื้อพิมพ์ได้ไม่จำกัดคำตลอดอายุของบริการ จ่ายด้วยพร้อมเพย์ (หรือบัตรผ่าน Stripe เมื่อเปิดให้ใช้) ยอดโอนพร้อมเพย์บวกเศษไม่เกิน 99 สตางค์ไว้จับคู่การโอนกับรายการ ได้สิทธิ์เมื่อเรายืนยันว่าได้รับเงินแล้ว ' + (slipOn(env) ? '(ทันทีเมื่อสลิปผ่านการตรวจอัตโนมัติในหน้าจ่ายเงิน หรือโดยปกติภายใน 24 ชั่วโมง)' : 'โดยปกติภายใน 24 ชั่วโมง') + ' ไม่มีสินค้าจัดส่ง</li>' +
    '<li><b>คืนเงิน:</b> ขอคืนเงินเต็มจำนวนได้ภายใน 7 วันหลังซื้อ ส่งอีเมลจากบัญชีที่ซื้อมาที่ ' + contact(env) + ' เมื่อคืนเงินแล้วบัญชีนั้นกลับเป็นแบบฟรี</li>' +
    '<li>ข้อความที่ถอดจากเสียงอาจผิดได้ ตรวจก่อนส่งทุกครั้ง เราไม่รับผิดชอบความเสียหายจากข้อความที่ถอดผิด</li>' +
    '<li>บริการอาจหยุดชั่วคราวหรือเปลี่ยนแปลงได้ เราจะแจ้งในหน้านี้เมื่อข้อกำหนดเปลี่ยน</li>' +
    '<li>ติดต่อ: ' + contact(env) + ' อ่านเรื่องข้อมูลส่วนตัวใน<a href="/privacy">นโยบายความเป็นส่วนตัว</a></li></ul>' +
    '<div class="en"><h2>Terms of use (English)</h2><p>TokType (formerly PoodPim) is free for 2,500 words per week per account and per computer and requires an internet connection and Google sign-in. ' +
    'Do not modify the app or fake data to avoid the word count; we may suspend accounts that do. ' +
    'Pro is a one-time payment (' + PRICE.launch / 100 + ' THB for the first ' + PRICE.seats + ' buyers, then ' + PRICE.normal / 100 + ' THB, no subscription) that gives the Google account that bought it unlimited words for the life of the service. Pay by PromptPay (or by card through Stripe once available); PromptPay amounts include up to 99 satang extra so each transfer matches one order; Pro is unlocked once we confirm the payment, ' + (slipOn(env) ? 'right away when the slip check on the payment page passes, otherwise normally within 24 hours;' : 'normally within 24 hours;') + ' nothing is shipped. ' +
    'Refunds: email us from the buying account within 7 days of purchase for a full refund; the account then returns to the free plan. Transcriptions can be wrong, so check text before sending; we are not liable for losses caused by transcription errors. ' +
    'The service may change or pause; changes to these terms are posted on this page. Contact: ' + contact(env) + '.</p></div>');
}

function wantsHTML(req) {
  return (req.headers.get('accept') || '').includes('text/html');
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function lineSignatureOK(t, secret) {
  const parts = String(t || '').split('.');
  if (parts.length !== 3) return false;
  try {
    const head = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (parts[0].length % 4)) % 4)));
    if (head.alg !== 'HS256') return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (parts[2].length % 4)) % 4)), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(parts[0] + '.' + parts[1]));
  } catch (e) {
    return false;
  }
}

function jwtPayload(t) {
  const part = String(t || '').split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch (e) {
    return null;
  }
}

async function whoami(req, db) {
  const h = req.headers.get('authorization') || '';
  if (!h) return undefined;
  const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
  if (!m) return null;
  const hash = await sha256(m[1]);
  return withDB(db, () => db.prepare(
    'SELECT users.id AS id, users.name AS name, users.email AS email, users.provider AS provider, pro.user IS NOT NULL AS pro ' +
    'FROM sessions JOIN users ON users.id = sessions.user LEFT JOIN pro ON pro.user = users.id WHERE sessions.token = ?1'
  ).bind(hash).first());
}

function account(u) {
  return { id: u.id, name: u.name, email: u.email, provider: u.provider, pro: !!u.pro };
}

async function readJSON(req, max = 1000) {
  const text = await req.text();
  if (text.length > max) return { error: json({ error: 'too_large' }, 413) };
  try { return { body: JSON.parse(text) }; } catch (e) { return { error: json({ error: 'bad_json' }, 400) }; }
}

async function authStart(url, env) {
  const p = provider(env, url.searchParams.get('p') || '');
  const port = Number(url.searchParams.get('port'));
  const state = url.searchParams.get('state') || '';
  const challenge = url.searchParams.get('challenge') || '';
  if (!p) return page('ยังเข้าสู่ระบบด้วยวิธีนี้ไม่ได้', 'ผู้ดูแลยังไม่ได้เปิดการเข้าสู่ระบบแบบนี้ กลับไปที่ TokType แล้วลองอีกวิธี');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{32}$/.test(state) || !/^[0-9a-f]{64}$/.test(challenge)) {
    return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่ TokType แล้วกดเข้าสู่ระบบอีกครั้ง');
  }
  const id = randomHex(16);
  const now = Date.now();
  await withDB(env.DB, async () => {
    await env.DB.prepare('INSERT INTO logins (id, provider, port, state, challenge, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, p.key, port, state, challenge, now).run();
  });
  const q = new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: url.origin + '/auth/callback/' + p.key, scope: p.scope, state: id, ...p.extra });
  return redirect(p.authURL + '?' + q.toString());
}

async function authCallback(url, env, key) {
  const p = provider(env, key);
  const id = url.searchParams.get('state') || '';
  if (!p || !/^[0-9a-f]{32}$/.test(id)) return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่ TokType แล้วกดเข้าสู่ระบบอีกครั้ง');
  const row = await withDB(env.DB, () => env.DB.prepare('SELECT * FROM logins WHERE id = ?1 AND provider = ?2 AND code IS NULL').bind(id, p.key).first());
  if (!row || Date.now() - row.created > LOGIN_TTL) {
    return page('หมดเวลาเข้าสู่ระบบ', 'กลับไปที่ TokType แล้วกดเข้าสู่ระบบอีกครั้ง');
  }
  const back = (q) => redirect('http://127.0.0.1:' + row.port + '/auth/done?' + new URLSearchParams({ state: row.state, ...q }).toString());
  const fail = async (reason) => {
    await env.DB.prepare('DELETE FROM logins WHERE id = ?1').bind(id).run();
    return back({ error: reason });
  };
  const code = url.searchParams.get('code') || '';
  if (url.searchParams.get('error') || !code) return fail('cancelled');

  let tok;
  try {
    const res = await fetch(p.tokenURL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: url.origin + '/auth/callback/' + p.key, client_id: p.clientId, client_secret: p.clientSecret }).toString(),
    });
    tok = await res.json();
    if (!res.ok) return fail('provider');
  } catch (e) {
    return fail('provider');
  }
  if (p.key === 'line' && !(await lineSignatureOK(tok && tok.id_token, p.clientSecret))) return fail('provider');
  const info = jwtPayload(tok && tok.id_token);
  const aud = info && (Array.isArray(info.aud) ? info.aud : [info.aud]);
  if (!info || !info.sub || !aud.includes(p.clientId) || !p.iss.includes(info.iss) || !(info.exp * 1000 > Date.now() - 300000)) {
    return fail('provider');
  }
  const name = String(info.name || '').slice(0, 100);
  const email = info.email && info.email_verified !== false ? String(info.email).slice(0, 200) : '';
  const user = await env.DB.prepare(
    'INSERT INTO users (id, provider, sub, name, email, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
    'ON CONFLICT (provider, sub) DO UPDATE SET name = excluded.name, email = CASE WHEN excluded.email != \'\' THEN excluded.email ELSE users.email END RETURNING id'
  ).bind(randomHex(16), p.key, String(info.sub).slice(0, 200), name, email, Date.now()).first();
  const once = randomHex(32);
  await env.DB.prepare('UPDATE logins SET code = ?1, user = ?2 WHERE id = ?3').bind(await sha256(once), user.id, id).run();
  return back({ code: once });
}

async function authRedeem(req, env) {
  const { body, error } = await readJSON(req);
  if (error) return error;
  const code = String((body && body.code) || '');
  const verifier = String((body && body.verifier) || '');
  if (!/^[0-9a-f]{64}$/.test(code) || !/^[0-9a-f]{64}$/.test(verifier)) return json({ error: 'bad_request' }, 400);
  const row = await withDB(env.DB, async () => env.DB.prepare('DELETE FROM logins WHERE code = ?1 RETURNING *').bind(await sha256(code)).first());
  if (!row) return json({ error: 'bad_code' }, 400);
  if (Date.now() - row.created > LOGIN_TTL || (await sha256(verifier)) !== row.challenge) return json({ error: 'bad_code' }, 400);
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token, user, created) VALUES (?1, ?2, ?3)').bind(await sha256(token), row.user, Date.now()).run();
  const u = await env.DB.prepare('SELECT users.*, pro.user IS NOT NULL AS pro FROM users LEFT JOIN pro ON pro.user = users.id WHERE users.id = ?1').bind(row.user).first();
  return json({ token, account: account(u) });
}

const USAGE_DB_MS = 4500;
class Degraded extends Error {}
function inTime(p, deadline) {
  let t;
  const late = new Promise((_, no) => { t = setTimeout(() => no(new Degraded('db_timeout')), Math.max(1, deadline - Date.now())); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

async function usage(req, env) {
  const parsed = await readJSON(req);
  try {
    return await usageCount(req, env, parsed, Date.now() + USAGE_DB_MS);
  } catch (e) {
    return json({ error: 'degraded' }, 503);
  }
}

async function usageCount(req, env, parsed, deadline) {
  const who = await inTime(whoami(req, env.DB), deadline);
  if (who === null) return json({ error: 'login' }, 401); // กุญแจเข้าระบบถูกยกเลิก ให้โปรแกรมเข้าสู่ระบบใหม่
  const { body: b, error } = parsed;
  if (error) return error;
  const m = String((b && b.m) || '');
  const inst = String((b && b.i) || '');
  const week = String((b && b.week) || '');
  const used = Number(b && b.used);
  if (!/^[0-9a-f]{64}$/.test(m) || !/^[0-9a-f]{32}$/.test(inst) || !/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isInteger(used) || used < 0 || used > MAX_USED) {
    return json({ error: 'bad_request' }, 400);
  }
  const now = Date.now();
  if (!weekOK(week, now)) return json({ error: 'bad_week' }, 400);
  const u = who ? who.id : '';

  let failed = false;
  const row = await inTime(withDB(env.DB, async () => {
    if (u) {
      try {
        await env.DB.prepare(
          'INSERT INTO counts (m, week, i, u, used, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
          'ON CONFLICT (m, week, i) DO UPDATE SET used = excluded.used, updated = excluded.updated, ' +
          'u = CASE WHEN counts.u = \'\' THEN excluded.u ELSE counts.u END WHERE excluded.used > counts.used'
        ).bind(m, week, inst, u, used, now).run();
      } catch (e) {
        if (/no such table/i.test(String(e && e.message))) throw e;
        failed = true; // เขียนไม่ได้ ยังตอบจากยอดที่อ่านได้ บวกยอดที่โปรแกรมส่งมารอบนี้
      }
    }
    const r = await env.DB.prepare(
      'SELECT COALESCE(SUM(used), 0) AS machine, COALESCE(MAX(CASE WHEN i = ?3 THEN used END), 0) AS own FROM counts WHERE m = ?1 AND week = ?2'
    ).bind(m, week, inst).first();
    r.account = 0;
    if (u) {
      const a = await env.DB.prepare('SELECT COALESCE(SUM(used), 0) AS total FROM counts WHERE u = ?1 AND week = ?2').bind(u, week).first();
      r.account = a.total;
    }
    return r;
  }), deadline);
  if (failed && used > row.own) {
    const add = used - row.own;
    row.own += add; row.machine += add; row.account += add;
  }
  return json({ week, used: Math.max(row.machine, row.account), own: row.own, machine: row.machine, account: row.account, limit: LIMIT, pro: !!(who && who.pro) });
}

const PRICE = { launch: 29000, normal: 49000, seats: 100 }; // สตางค์
const ORDER_TTL = 60 * 60000;         // หน้าจ่ายเงินของ Stripe หมดอายุใน 1 ชั่วโมง
const WAIT_REUSE = 3 * 24 * HOUR;     // กดซื้อซ้ำภายใน 3 วันได้รหัสอ้างอิงพร้อมเพย์เดิม
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ไม่มี I O 0 1 ที่อ่านสับสน

function stripeOn(env) {
  return !!String(env.STRIPE_KEY || '').trim();
}

const QR_ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const QR_MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];

function qrRaw(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}

function qrMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function qrEcc(data, degree) {
  const div = new Array(degree).fill(0);
  div[degree - 1] = 1;
  for (let i = 0, root = 1; i < degree; i++, root = qrMul(root, 2)) {
    for (let j = 0; j < degree; j++) {
      div[j] = qrMul(div[j], root);
      if (j + 1 < degree) div[j] ^= div[j + 1];
    }
  }
  const r = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= qrMul(c, f); });
  }
  return r;
}

function qrPenalty(m, n) {
  let score = 0;
  const line = (get) => {
    let color = false, run = 0, s = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    const add = (len) => { if (hist[0] === 0) len += n; hist.pop(); hist.unshift(len); };
    const finder = () => {
      const k = hist[1], core = k > 0 && hist[2] === k && hist[3] === k * 3 && hist[4] === k && hist[5] === k;
      return (core && hist[0] >= k * 4 && hist[6] >= k ? 1 : 0) + (core && hist[6] >= k * 4 && hist[0] >= k ? 1 : 0);
    };
    for (let i = 0; i < n; i++) {
      if (get(i) === color) {
        run++;
        if (run === 5) s += 3; else if (run > 5) s++;
      } else {
        add(run);
        if (!color) s += finder() * 40;
        color = get(i);
        run = 1;
      }
    }
    if (color) { add(run); run = 0; }
    add(run + n);
    return s + finder() * 40;
  };
  for (let y = 0; y < n; y++) score += line((x) => m[y][x]);
  for (let x = 0; x < n; x++) score += line((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  return score + (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
}

function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const dataLen = (ver) => Math.floor(qrRaw(ver) / 8) - QR_ECC[ver] * QR_BLOCKS[ver];
  let v = 1;
  while (4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataLen(v) * 8) {
    if (++v > 10) throw new Error('qr: text too long');
  }
  const cap = dataLen(v) * 8, bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const nb = QR_BLOCKS[v], ecl = QR_ECC[v], raw = Math.floor(qrRaw(v) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1));
    k += d.length;
    const e = qrEcc(d, ecl);
    if (i < nShort) d.push(0);
    blocks.push(d.concat(e));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });
  const n = v * 4 + 17;
  const mod = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fixed[y][x] = true; };
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  if (v > 1) {
    const na = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2, pos = [6];
    for (let p = n - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const format = (mask) => {
    let r = mask; // ระดับแก้ผิด M = 00
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((mask << 10) | r) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
    set(8, n - 8, true);
  };
  format(0);
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const c = ((b >>> i) & 1) === 1, a = n - 11 + (i % 3), q = Math.floor(i / 3);
      set(a, q, c); set(q, a, c);
    }
  }
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (!fixed[y][x] && i < cw.length * 8) { mod[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
  const apply = (mk) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fixed[y][x] && QR_MASKS[mk](x, y)) mod[y][x] = !mod[y][x]; };
  let best = 0, bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    apply(mk);
    format(mk);
    const s = qrPenalty(mod, n);
    if (s < bestScore) { bestScore = s; best = mk; }
    apply(mk);
  }
  apply(best);
  format(best);
  return mod;
}

function qrSVG(text, px) {
  const m = qrMatrix(text), n = m.length, q = 4, size = n + q * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="QR พร้อมเพย์">' +
    '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
}

function promptpayTarget(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '');
  if (/^0\d{9}$/.test(d)) return ['01', '0066' + d.slice(1)];
  if (/^\d{15}$/.test(d)) return ['03', d];
  return null;
}

function crc16(s) {
  let c = 0xffff;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}

function promptpayPayload(id, satang) {
  const t = promptpayTarget(id);
  if (!t) return '';
  const f = (tag, val) => tag + String(val.length).padStart(2, '0') + val;
  const s = f('00', '01') + f('01', '12') + f('29', f('00', 'A000000677010111') + f(t[0], t[1])) + f('58', 'TH') + f('53', '764') + f('54', (satang / 100).toFixed(2)) + '6304';
  return s + crc16(s);
}

async function priceNow(db) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE status = \'paid\'').first();
  const n = Number((r && r.n) || 0);
  return { amount: n < PRICE.seats ? PRICE.launch : PRICE.normal, left: Math.max(0, PRICE.seats - n) };
}

function payMethod(env) {
  if (stripeOn(env)) return env.STRIPE_WEBHOOK_SECRET ? 'stripe' : '';
  return promptpayTarget(env.PROMPTPAY_ID) && payee(env) ? 'promptpay' : '';
}

function payee(env) {
  return String(env.PROMPTPAY_NAME || '').trim().slice(0, 80);
}

function maskEmail(e) {
  const m = /^([^@]{1,3})[^@]*(@.+)$/.exec(String(e || ''));
  return m ? m[1] + '•••' + m[2] : 'บัญชีของคุณ';
}

function newCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

async function stripeAPI(env, method, path, params) {
  const form = (obj, prefix = '', out = new URLSearchParams()) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      const key = prefix ? prefix + '[' + k + ']' : k;
      if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
    }
    return out;
  };
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method,
    headers: { authorization: 'Bearer ' + String(env.STRIPE_KEY).trim(), 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : form(params || {}).toString(),
  });
  let j = null;
  try { j = await res.json(); } catch (e) { j = null; }
  if (!res.ok || !j) throw new Error('stripe ' + res.status + ' ' + String((j && j.error && j.error.message) || '').slice(0, 200));
  return j;
}

async function startOrder(env, url, who) {
  if (who.pro) return { status: 200, body: { pro: true } };
  const method = payMethod(env);
  if (!method) return { status: 503, body: { error: 'no_payment' } };
  const now = Date.now();
  if (method === 'promptpay') {
    const old = await withDB(env.DB, () => env.DB.prepare(
      'SELECT id, amount FROM orders WHERE user = ?1 AND status = \'waiting\' AND created > ?2 ORDER BY created DESC LIMIT 1'
    ).bind(who.id, now - WAIT_REUSE).first());
    if (old) return { status: 200, body: { url: url.origin + '/buy/pp?c=' + old.id.slice(3), price: old.amount / 100, method, code: old.id.slice(3), slip: slipOn(env) } };
    const amount = await orderAmount(env.DB, now);
    for (let k = 0; k < 5; k++) {
      const code = newCode();
      try {
        await env.DB.prepare('INSERT INTO orders (id, user, amount, url, status, created) VALUES (?1, ?2, ?3, \'\', \'waiting\', ?4)').bind('pp_' + code, who.id, amount, now).run();
        return { status: 200, body: { url: url.origin + '/buy/pp?c=' + code, price: amount / 100, method, code, slip: slipOn(env) } };
      } catch (e) {
        if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
      }
    }
    return { status: 503, body: { error: 'server' } };
  }
  const open = await withDB(env.DB, () => env.DB.prepare(
    'SELECT url, amount FROM orders WHERE user = ?1 AND status = \'open\' AND created > ?2 ORDER BY created DESC LIMIT 1'
  ).bind(who.id, now - ORDER_TTL + 10 * 60000).first());
  if (open && open.url) return { status: 200, body: { url: open.url, price: open.amount / 100, method } };
  const { amount } = await priceNow(env.DB);
  let s;
  try {
    s = await stripeAPI(env, 'POST', 'checkout/sessions', {
      mode: 'payment',
      locale: 'th',
      client_reference_id: who.id,
      customer_email: /^[^@\s]+@[^@\s]+$/.test(who.email || '') ? who.email : undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'thb',
          unit_amount: amount,
          product_data: { name: 'TokType Pro (จ่ายครั้งเดียว ใช้ตลอด)', description: 'พิมพ์ด้วยเสียงไม่จำกัดคำ สำหรับบัญชี ' + maskEmail(who.email) },
        },
      }],
      success_url: url.origin + '/paid?s={CHECKOUT_SESSION_ID}',
      cancel_url: url.origin + '/buy/cancel',
      expires_at: Math.floor((now + ORDER_TTL) / 1000),
      metadata: { app: 'poodpim', user: who.id },
      payment_intent_data: { description: 'TokType Pro', metadata: { app: 'poodpim', user: who.id } },
    });
  } catch (e) {
    return { status: 502, body: { error: 'payment_down', detail: String(e && e.message).replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, '[key]').slice(0, 200) } };
  }
  if (!s || !SESSION_ID.test(String(s.id)) || !/^https:\/\//.test(String(s.url))) return { status: 502, body: { error: 'payment_down' } };
  await env.DB.prepare('INSERT INTO orders (id, user, amount, url, status, created) VALUES (?1, ?2, ?3, ?4, \'open\', ?5)')
    .bind(s.id, who.id, amount, s.url, now).run();
  return { status: 200, body: { url: s.url, price: amount / 100, method } };
}

async function buy(req, env, url) {
  const who = await whoami(req, env.DB);
  if (!who) return json({ error: 'login' }, 401);
  const r = await startOrder(env, url, who);
  return json(r.body, r.status);
}

async function grantOrder(env, id, user, pi = '') {
  const now = Date.now();
  await env.DB.prepare('UPDATE orders SET status = \'paid\', pi = CASE WHEN ?2 != \'\' THEN ?2 ELSE pi END, paid = CASE WHEN paid = 0 THEN ?3 ELSE paid END WHERE id = ?1 AND status != \'refunded\'')
    .bind(id, pi, now).run();
  await env.DB.prepare('INSERT OR IGNORE INTO pro (user, since, note) VALUES (?1, ?2, ?3)').bind(user, now, (id.startsWith('pp_') ? 'promptpay ' + id.slice(3) : 'stripe ' + id)).run();
}

async function revokeOrder(env, o) {
  await env.DB.prepare('UPDATE orders SET status = \'refunded\' WHERE id = ?1').bind(o.id).run();
  await env.DB.prepare('DELETE FROM pro WHERE user = ?1 AND (note = ?2 OR note = ?3)').bind(o.user, 'stripe ' + o.id, 'promptpay ' + o.id.slice(3)).run();
  const other = await env.DB.prepare('SELECT id FROM orders WHERE user = ?1 AND status = \'paid\' LIMIT 1').bind(o.user).first();
  if (other) await grantOrder(env, other.id, o.user);
}

async function settle(env, s) {
  const id = String((s && s.id) || '');
  if (!SESSION_ID.test(id)) return null;
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first();
  if (!o) return null; // ไม่ใช่รายการที่เซิร์ฟเวอร์นี้สร้าง
  if (o.status === 'refunded' || s.payment_status !== 'paid' || s.mode !== 'payment' || s.client_reference_id !== o.user) return o;
  if (s.livemode !== true && String(env.STRIPE_TEST || '') !== '1') return o; // เงินทดสอบของ Stripe ห้ามเปิด Pro จริง
  await grantOrder(env, id, o.user, typeof s.payment_intent === 'string' ? s.payment_intent : String((s.payment_intent && s.payment_intent.id) || ''));
  return { ...o, status: 'paid' };
}

async function stripeSignatureOK(body, header, secrets, now) {
  let t = '';
  const sigs = [];
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (!/^\d{1,12}$/.test(t) || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const head = new TextEncoder().encode(t + '.');
  const data = new Uint8Array(head.length + body.length);
  data.set(head);
  data.set(body, head.length);
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    for (const s of sigs) {
      if (await crypto.subtle.verify('HMAC', key, Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16)), data)) return true;
    }
  }
  return false;
}

async function stripeWebhook(req, env) {
  const secrets = String(env.STRIPE_WEBHOOK_SECRET || '').split(/[\s,]+/).filter(Boolean);
  if (!secrets.length) return json({ error: 'no_payment' }, 503);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > 256 * 1024) return json({ error: 'too_large' }, 413);
  if (!(await stripeSignatureOK(body, req.headers.get('stripe-signature'), secrets, Date.now()))) return json({ error: 'bad_signature' }, 400);
  let ev;
  try { ev = JSON.parse(new TextDecoder().decode(body)); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const type = String((ev && ev.type) || '');
  const o = (ev && ev.data && ev.data.object) || {};
  await withDB(env.DB, async () => {
    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') await settle(env, o);
    else if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
      await env.DB.prepare('UPDATE orders SET status = \'expired\' WHERE id = ?1 AND status = \'open\'').bind(String(o.id || '')).run();
    } else if (type === 'charge.refunded' && o.refunded === true && /^pi_[A-Za-z0-9]{8,200}$/.test(String(o.payment_intent || ''))) {
      const paid = await env.DB.prepare('SELECT * FROM orders WHERE pi = ?1 AND status = \'paid\'').bind(String(o.payment_intent)).first();
      if (paid) await revokeOrder(env, paid);
    }
  });
  return json({ received: true });
}

const SLIPOK = 'https://api.slipok.com/api/line/apikey/';
const SLIP_MAX = 5 * 1024 * 1024;
const SLIP_TYPES = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const SLIP_SKEW = 2 * 60000;

function promptpayPhone(env) {
  const d = String(env.PROMPTPAY_ID || '').replace(/\D/g, '');
  return /^0\d{9}$/.test(d) ? d : '';
}

function slipOn(env) {
  return payMethod(env) === 'promptpay' && !!promptpayPhone(env) && !!String(env.SLIPOK_KEY || '').trim() && /^\d{1,12}$/.test(String(env.SLIPOK_BRANCH || '').trim());
}

function thb(satang) {
  return (Number(satang) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function orderAmount(db, now) {
  const { amount } = await priceNow(db);
  const rows = await db.prepare('SELECT amount FROM orders WHERE status = \'waiting\' AND created > ?1 AND amount > ?2 AND amount < ?3')
    .bind(now - WAIT_REUSE, amount, amount + 100).all();
  const used = new Set((rows.results || []).map((r) => Number(r.amount) - amount));
  for (let s = 1; s < 100; s++) if (!used.has(s)) return amount + s;
  return amount + 1 + Math.floor(Math.random() * 99);
}

function proxyMatch(value, phone) {
  let s = String(value || '').toLowerCase().replace(/[\s\-().]/g, '');
  if (s.startsWith('+66')) s = '0' + s.slice(3);
  else if (/^66/.test(s) && s.length === 11) s = '0' + s.slice(2);
  if (!/^[0-9x*•#]+$/.test(s) || s.replace(/\D/g, '').length < 3) return '';
  if (s.length === phone.length) return [...s].every((c, i) => !/\d/.test(c) || c === phone[i]) ? 'yes' : 'no';
  const tail = /(\d{3,})$/.exec(s);
  if (!tail) return '';
  return phone.endsWith(tail[1]) ? 'yes' : 'no';
}

function receiverMatch(r, phone) {
  const p = r && r.proxy;
  if (!p || !p.value) return '';
  if (p.type && !/^(MSISDN|MOBILE|PHONE)$/i.test(String(p.type))) return 'no';
  return proxyMatch(p.value, phone);
}

function nameTokens(s) {
  let t = String(s || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase().trim();
  t = t.replace(/^(น\.\s?ส\.|ด\.\s?ช\.|ด\.\s?ญ\.)\s*/, '').replace(/^(นางสาว|นาง|นาย)(\s+|(?=[ก-ฮ]))/, '');
  const w = t.split(/\s+/).filter(Boolean);
  if (w.length && /^(mr|mrs|ms|miss|dr)\.?$/.test(w[0])) w.shift();
  return w.map((x) => x.replace(/[.*•]+$/, '')).filter(Boolean);
}

function payeeNameMatch(r, payeeName) {
  const want = nameTokens(payeeName);
  if (!want.length || want[0].length < 2) return false;
  return [r && r.displayName, r && r.name].some((v) => {
    const got = nameTokens(v);
    if (!got.length || got[0] !== want[0]) return false;
    if (got.length < 2) return true;
    return want.length >= 2 && got[1].length > 0 && want[1].startsWith(got[1]);
  });
}

const SLIP_CAP = 90, SLIP_PER_CODE = 5;
async function reserveSlip(db, now, left, code) {
  try {
    await db.prepare('DELETE FROM slip_calls WHERE at < ?1').bind(now - 40 * 24 * HOUR).run();
    const r = await db.prepare('INSERT INTO slip_calls (at, code) SELECT ?1, ?6 WHERE (SELECT COUNT(*) FROM slip_calls WHERE at > ?2) < ?3 ' +
      'AND (SELECT COUNT(*) FROM slip_calls WHERE at > ?4) < ?5 AND (SELECT COUNT(*) FROM slip_calls WHERE code = ?6) < ?7')
      .bind(now, now - 31 * 24 * HOUR, SLIP_CAP, now - 2 * 60000, Math.floor(Number(left) || 0), code, SLIP_PER_CODE).run();
    return !!(r && r.meta && r.meta.changes === 1);
  } catch (e) {
    return false;
  }
}

function slipTime(d) {
  const iso = Date.parse(String(d.transTimestamp || ''));
  if (Number.isFinite(iso)) return iso;
  const a = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d.transDate || '')), b = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(d.transTime || ''));
  return a && b ? Date.UTC(+a[1], +a[2] - 1, +a[3], +b[1] - 7, +b[2], +b[3]) : NaN;
}

const SLIP_MSG = {
  ok: 'สลิปผ่านแล้ว เปิด Pro ให้บัญชีนี้แล้ว',
  already: 'บัญชีนี้เป็น Pro แล้ว',
  off: 'ตอนนี้ยังตรวจสลิปอัตโนมัติไม่ได้ ส่งสลิปทางอีเมลแทน',
  closed: 'รหัสนี้ใช้จ่ายไม่ได้แล้ว กดอัปเกรดเป็น Pro ในโปรแกรมอีกครั้ง',
  bad_file: 'ใช้รูปสลิปแบบ .jpg .png หรือ .webp ขนาดไม่เกิน 5 MB',
  no_qr: 'อ่าน QR บนสลิปไม่ได้ ใช้รูปสลิปเต็มใบที่บันทึกจากแอปธนาคาร อย่าครอปมุมที่มี QR ออก',
  not_found: 'ธนาคารไม่พบรายการโอนนี้ ถ้าเพิ่งโอน รอ 1-2 นาทีแล้วลองใหม่',
  wait: 'สลิปจากธนาคารนี้ต้องรอสักครู่หลังโอน แล้วอัปโหลดอีกครั้ง',
  bank_down: 'ระบบธนาคารขัดข้องชั่วคราว ลองใหม่ในอีก 15 นาที',
  wrong_receiver: 'สลิปนี้ไม่ได้โอนเข้าพร้อมเพย์ของ TokType ตรวจว่าสแกน QR ในหน้านี้',
  wrong_amount: 'ยอดในสลิปไม่ตรงกับยอดของรหัสนี้ (ต้องตรงทุกสตางค์) ถ้าโอนไปแล้ว ส่งสลิปทางอีเมล เราคืนเงินหรือเปิด Pro ให้',
  old_slip: 'สลิปนี้โอนก่อนได้รหัสนี้ ใช้สลิปของการโอนตามหน้านี้',
  used: 'สลิปนี้ใช้เปิด Pro ไปแล้ว ใช้ซ้ำไม่ได้',
  manual: 'ตรวจอัตโนมัติไม่ได้ตอนนี้ ส่งสลิปทางอีเมล แล้วเราเปิด Pro ให้ภายใน 24 ชั่วโมง',
  busy: 'ลองหลายครั้งเกินไป รอ 10 นาทีแล้วลองใหม่',
};
const SLIP_STATUS = { ok: 200, already: 200, off: 503, closed: 409, used: 409, manual: 503, bank_down: 503, busy: 429 };

function slipReply(error, msg) {
  const ok = error === 'ok' || error === 'already';
  return json(ok ? { ok: true, msg: SLIP_MSG[error] } : { error, msg: msg || SLIP_MSG[error] }, SLIP_STATUS[error] || 400);
}

async function claimSlip(env, o, ref, now) {
  try {
    await env.DB.prepare('INSERT INTO slips (ref, order_id, amount, at) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND status = \'waiting\')')
      .bind(ref, o.id, o.amount, now).run();
  } catch (e) {
    if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
  }
  const s = await env.DB.prepare('SELECT order_id FROM slips WHERE ref = ?1').bind(ref).first();
  if (!s) {
    const cur = await env.DB.prepare('SELECT status FROM orders WHERE id = ?1').bind(o.id).first();
    return cur && cur.status === 'paid' ? 'already' : 'closed';
  }
  if (s.order_id !== o.id) return 'used';
  await grantOrder(env, o.id, o.user, 'slip ' + ref);
  return 'ok';
}

async function slipCheck(req, env, url) {
  if (!slipOn(env)) return slipReply('off');
  const code = String(url.searchParams.get('c') || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) return slipReply('closed');
  const o = await withDB(env.DB, () => env.DB.prepare('SELECT id, user, amount, status, created FROM orders WHERE id = ?1').bind('pp_' + code).first());
  if (!o) return slipReply('closed');
  if (o.status === 'paid') return slipReply('already');
  if (o.status !== 'waiting') return slipReply('closed');
  const type = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!SLIP_TYPES[type] || Number(req.headers.get('content-length') || 0) > SLIP_MAX) return slipReply('bad_file');
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 100 || buf.byteLength > SLIP_MAX) return slipReply('bad_file');
  const q = await slipQuota(env);
  if (!q || !(q.quota > 0)) return slipReply('manual'); // โควตาฟรีเดือนนี้หมด หรือถาม SlipOK ไม่ได้
  if (!(await reserveSlip(env.DB, Date.now(), q.quota, code))) return slipReply('manual'); // ส่งครบ SLIP_CAP ใน 31 วัน หรือรหัสนี้ส่งครบ SLIP_PER_CODE แล้ว

  let j = null;
  try {
    const fd = new FormData();
    fd.append('files', new Blob([buf], { type }), 'slip.' + SLIP_TYPES[type]);
    fd.append('log', 'true');
    const res = await fetch(SLIPOK + String(env.SLIPOK_BRANCH).trim(), {
      method: 'POST', headers: { 'x-authorization': String(env.SLIPOK_KEY).trim() }, body: fd, signal: AbortSignal.timeout(20000),
    });
    j = await res.json();
  } catch (e) {
    return slipReply('manual');
  }
  const errCode = Number(j && j.code);
  const raw = j && j.data && typeof j.data === 'object' ? j.data : null;
  const d = raw && (j.success === true || errCode === 1012) ? (raw.transRef ? raw : raw.data) : null;
  if (!d || typeof d !== 'object') {
    if (errCode === 1014) return slipReply('wrong_receiver');
    if (errCode === 1011) return slipReply('not_found');
    if (errCode === 1009) return slipReply('bank_down');
    if (errCode === 1010) {
      const n = Number(raw && raw.delay);
      return slipReply('wait', n > 0 && n < 120 ? 'สลิปจากธนาคารนี้ต้องรอประมาณ ' + n + ' นาทีหลังโอน แล้วอัปโหลดอีกครั้ง' : '');
    }
    if ([1000, 1005, 1006, 1007, 1008].includes(errCode)) return slipReply('no_qr');
    return slipReply('manual'); // 1001-1004 (สาขา กุญแจ แพ็กเกจ โควตา) หรือคำตอบแปลกๆ
  }

  const ref = String(d.transRef || '').trim();
  const paid = Math.round(Number(d.amount) * 100);
  const t = slipTime(d), now = Date.now();
  if (!/^[A-Za-z0-9]{6,64}$/.test(ref) || !Number.isFinite(paid)) return slipReply('manual');
  if (paid !== Number(o.amount)) {
    return slipReply('wrong_amount', 'ยอดในสลิป ' + thb(paid) + ' บาท ไม่ตรงกับยอดของรหัสนี้ ' + thb(o.amount) + ' บาท (ต้องตรงทุกสตางค์) ถ้าโอนไปแล้ว ส่งสลิปทางอีเมล เราคืนเงินหรือเปิด Pro ให้');
  }
  const who = receiverMatch(d.receiver, promptpayPhone(env));
  if (who !== 'yes') return slipReply(who === 'no' ? 'wrong_receiver' : 'manual');
  if (!payeeNameMatch(d.receiver, payee(env))) return slipReply('manual');
  if (!Number.isFinite(t) || t > now + 10 * 60000) return slipReply('manual');
  if (t < Number(o.created) - SLIP_SKEW) return slipReply('old_slip');
  return slipReply(await claimSlip(env, o, ref, now));
}

async function slipQuota(env) {
  if (!slipOn(env)) return null;
  try {
    const res = await fetch(SLIPOK + String(env.SLIPOK_BRANCH).trim() + '/quota', { headers: { 'x-authorization': String(env.SLIPOK_KEY).trim() }, signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    const q = Number(j && j.data && j.data.quota), over = Number((j && j.data && j.data.overQuota) || 0);
    return { quota: j && j.success && Number.isFinite(q) ? (over > 0 ? 0 : Math.max(0, q)) : null };
  } catch (e) {
    return { quota: null };
  }
}

const SLIP_JS = '(function(){var f=document.getElementById("slip"),b=document.getElementById("slipgo"),m=document.getElementById("slipmsg"),busy=false;' +
  'function say(t,bad){m.textContent=t;m.className=bad?"bad":"ok";}' +
  'function go(){var x=f.files&&f.files[0];if(busy)return;if(!x){say("เลือกรูปสลิปก่อน",true);return;}if(x.size>5242880){say("รูปใหญ่เกิน 5 MB",true);return;}' +
  'busy=true;b.disabled=true;say("กำลังตรวจกับธนาคาร...",false);' +
  'fetch("/api/slip?c=@CODE@",{method:"POST",headers:{"content-type":x.type||"application/octet-stream"},body:x})' +
  '.then(function(r){return r.json();}).then(function(j){say(j.msg||"ตรวจไม่ได้ ลองใหม่",!j.ok);if(j.ok){setTimeout(function(){location.reload();},1500);}else{busy=false;b.disabled=false;}})' +
  '.catch(function(){say("ต่อเน็ตไม่ได้ ลองใหม่",true);busy=false;b.disabled=false;});}' +
  'b.onclick=go;f.onchange=go;})();';

function slipSteps(code, send, env) {
  return '<li>โอนเสร็จแล้ว อัปโหลดรูปสลิปที่นี่ ระบบตรวจกับธนาคารแล้วเปิด Pro ให้ทันที' +
    '<style>#slipmsg.ok{color:#2e7d4f}#slipmsg.bad{color:#c0392b}@media (prefers-color-scheme:dark){#slipmsg.ok{color:#8fd9a8}#slipmsg.bad{color:#ff9a8f}}</style>' +
    '<div class="card c"><p><input type="file" id="slip" accept="image/*" aria-label="รูปสลิป"></p><p><button class="btn" type="button" id="slipgo">ตรวจสลิป</button></p>' +
    '<p id="slipmsg" role="status" aria-live="polite"></p></div>' +
    'อัปโหลดไม่ผ่าน? ส่งสลิปพร้อมรหัสอ้างอิง <b>' + code + '</b> มาให้เรา' + (send ? '<br>' + send : ' ที่ ' + contact(env)) + '</li>' +
    '<li>สลิปผ่านแล้ว Pro เปิดทันที (ถ้าส่งทางอีเมล เราเปิดให้ภายใน 24 ชั่วโมง) ไม่ต้องทำอะไรเพิ่ม โปรแกรมจะเห็น Pro เองตอนพูดครั้งถัดไป</li></ol>' +
    '<script>' + SLIP_JS.replace('@CODE@', code) + '</script>';
}

const BUY_CSS = '<style>.qr{display:block;margin:8px auto;max-width:100%;height:auto;border-radius:12px}.big{font-size:30px;font-weight:700;color:var(--fg);margin:4px 0}' +
  '.code{font:700 34px/1.3 ui-monospace,Consolas,monospace;letter-spacing:6px;color:var(--fg)}.btn{display:inline-block;background:var(--acc);color:var(--card);text-decoration:none;border:0;border-radius:999px;padding:10px 20px;font:inherit;font-weight:600;cursor:pointer}' +
  'input[type=email]{width:100%;max-width:360px;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg)}.c{text-align:center}ol li{margin:6px 0}</style>';

function priceLine(p) {
  return '<p>พิมพ์ด้วยเสียงไม่จำกัดคำ ใช้ได้ตลอด ไม่มีรายเดือน' + (p.left > 0 ? ' ราคาเปิดตัวสำหรับ ' + PRICE.seats + ' คนแรก เหลืออีก ' + p.left + ' ที่ จากนั้น ' + PRICE.normal / 100 + ' บาท' : '') + '</p>';
}

async function buyPage(env, msg = '') {
  const p = await withDB(env.DB, () => priceNow(env.DB));
  const method = payMethod(env);
  return site('ซื้อ Pro TokType', BUY_CSS + '<h1>TokType Pro ' + p.amount / 100 + ' บาท จ่ายครั้งเดียว</h1>' + priceLine(p) +
    (!method ? '<div class="card"><p>ยังไม่เปิดขาย เร็วๆ นี้</p></div>' :
      '<div class="card"><form method="post" action="/buy"><p><b>อีเมล Google ที่ใช้เข้าสู่ระบบในโปรแกรม TokType</b></p>' +
      (msg ? '<p style="color:#c0392b">' + esc(msg) + '</p>' : '') +
      '<p><input type="email" name="email" required autocomplete="email" placeholder="you@gmail.com"></p><p><button class="btn" type="submit">ไปหน้าจ่ายเงิน</button></p>' +
      '<p>ยังไม่เคยใช้ TokType? <a href="/">ดาวน์โหลดโปรแกรม</a> แล้วเข้าสู่ระบบด้วย Google ก่อน หรือกด <b>อัปเกรดเป็น Pro</b> ในโปรแกรมได้เลย</p></form></div>' +
      '<p>จ่ายด้วย' + (method === 'stripe' ? 'พร้อมเพย์หรือบัตร' : 'พร้อมเพย์ (บัตรเครดิตเร็วๆ นี้)') + ' ขอคืนเงินได้ภายใน 7 วัน อ่าน<a href="/terms">ข้อกำหนด</a> ติดต่อ ' + contact(env) + '</p>'));
}

async function buyWeb(req, env, url) {
  const text = await req.text();
  if (text.length > 1000) return page('ข้อมูลยาวเกินไป', 'กลับไปลองใหม่');
  const email = String(new URLSearchParams(text).get('email') || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return buyPage(env, 'อีเมลไม่ถูกต้อง');
  const who = await withDB(env.DB, () => env.DB.prepare(
    'SELECT users.id AS id, users.email AS email, users.provider AS provider, pro.user IS NOT NULL AS pro FROM users LEFT JOIN pro ON pro.user = users.id ' +
    'WHERE users.provider = \'google\' AND lower(users.email) = ?1 ORDER BY users.created LIMIT 1'
  ).bind(email).first());
  if (!who) return buyPage(env, 'ยังไม่พบบัญชีนี้ใน TokType เปิดโปรแกรมแล้วเข้าสู่ระบบด้วย Google อีเมลนี้ก่อน แล้วกลับมาที่หน้านี้');
  const r = await startOrder(env, url, who);
  if (r.body.pro) return page('บัญชีนี้เป็น Pro แล้ว', 'พิมพ์ด้วยเสียงได้ไม่จำกัดอยู่แล้ว ไม่ต้องซื้อซ้ำ', 200);
  if (!r.body.url) return page('ยังซื้อไม่ได้ตอนนี้', 'ระบบรับเงินขัดข้องชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่', r.status);
  return new Response(null, { status: 303, headers: { location: r.body.url, 'cache-control': 'no-store' } });
}

async function ppPage(url, env) {
  const code = String(url.searchParams.get('c') || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่ TokType แล้วกดอัปเกรดเป็น Pro อีกครั้ง');
  const o = await withDB(env.DB, () => env.DB.prepare(
    'SELECT orders.status AS status, orders.amount AS amount, users.email AS email, pro.user IS NOT NULL AS pro FROM orders JOIN users ON users.id = orders.user ' +
    'LEFT JOIN pro ON pro.user = orders.user WHERE orders.id = ?1'
  ).bind('pp_' + code).first());
  if (!o) return page('ไม่พบรหัสนี้', 'กลับไปที่ TokType แล้วกดอัปเกรดเป็น Pro อีกครั้ง', 404);
  const who = esc(maskEmail(o.email));
  if (o.pro || o.status === 'paid') {
    return site('เป็น Pro แล้ว TokType', '<h1>เป็น Pro แล้ว ขอบคุณที่สนับสนุนครับ</h1><p>บัญชี <b>' + who + '</b> พิมพ์ด้วยเสียงได้ไม่จำกัดคำ ใช้ได้ตลอด</p>' +
      '<p>กลับไปที่ TokType แล้วพูดต่อได้เลย โปรแกรมจะเห็น Pro ในการพูดครั้งถัดไป</p>');
  }
  const payload = promptpayPayload(env.PROMPTPAY_ID, o.amount);
  if (!payload || o.status !== 'waiting') return page('รหัสนี้ใช้จ่ายไม่ได้แล้ว', 'กลับไปที่ TokType แล้วกดอัปเกรดเป็น Pro อีกครั้งเพื่อรับรหัสใหม่', 200);
  const baht = thb(o.amount);
  const name = payee(env);
  const mail = contactEmail(env);
  const mailto = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(mail)
    ? 'mailto:' + mail + '?subject=' + encodeURIComponent('สลิปซื้อ Pro รหัส ' + code) + '&body=' + encodeURIComponent('รหัสอ้างอิง: ' + code + '\nยอด: ' + baht + ' บาท\n(แนบรูปสลิปมากับอีเมลนี้)') : '';
  const line = /^https:\/\/(lin\.ee|line\.me)\/[\w\-./~@%?=]+$/.test(String(env.LINE_OA_URL || '').trim()) ? String(env.LINE_OA_URL).trim() : '';
  const send = [mailto ? '<a class="btn" href="' + esc(mailto) + '">ส่งสลิปทางอีเมล</a>' : '', line ? '<a class="btn" href="' + esc(line) + '">ส่งสลิปทาง LINE</a>' : ''].filter(Boolean).join(' ');
  return site('จ่ายค่า Pro ด้วยพร้อมเพย์ TokType', BUY_CSS + '<h1>จ่ายค่า Pro ด้วยพร้อมเพย์</h1><p>สำหรับบัญชี <b>' + who + '</b></p>' +
    '<div class="card c">' + qrSVG(payload, 260).replace('<svg ', '<svg class="qr" ') + '<p class="big">' + baht + ' บาท</p><p>โอนให้ตรงทุกสตางค์ เศษสตางค์ไว้จับคู่การโอนกับรหัสนี้ สแกน QR แล้วยอดขึ้นเอง</p>' +
    (name ? '<p>ชื่อบัญชีผู้รับ: <b>' + esc(name) + '</b></p>' : '') + '</div>' +
    '<div class="card c"><p>รหัสอ้างอิงของคุณ</p><p class="code">' + code + '</p></div>' +
    '<ol><li>เปิดแอปธนาคารในมือถือ กด <b>สแกน</b> แล้วสแกน QR นี้ ยอด ' + baht + ' บาทจะขึ้นเอง ' + (name ? 'ตรวจว่าชื่อผู้รับตรงกับด้านบน' : 'ตรวจชื่อผู้รับ') + 'ก่อนกดยืนยัน<br>เปิดหน้านี้ในมือถืออยู่? แคปหน้าจอไว้ แล้วในแอปธนาคารกดสแกน เลือกรูปจากอัลบั้ม</li>' +
    (slipOn(env) ? slipSteps(code, send, env) :
    '<li>โอนเสร็จแล้ว ส่งรูปสลิปพร้อมรหัสอ้างอิง <b>' + code + '</b> มาให้เรา' + (send ? '<br>' + send : ' ที่ ' + contact(env)) + '</li>' +
    '<li>เราตรวจยอดเงินเข้าแล้วเปิด Pro ให้บัญชีนี้ภายใน 24 ชั่วโมง ไม่ต้องทำอะไรเพิ่ม โปรแกรมจะเห็น Pro เองตอนพูดครั้งถัดไป</li></ol>') +
    '<p>โอนครั้งเดียวพอ ถ้าโอนผิดหรือโอนซ้ำ ติดต่อ ' + contact(env) + ' เราคืนเงินให้ จ่ายด้วยบัตรเครดิตหรือเดบิต: เร็วๆ นี้</p>');
}

async function paidPage(url, env) {
  const id = url.searchParams.get('s') || '';
  if (!SESSION_ID.test(id)) return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่ TokType แล้วกดอัปเกรดเป็น Pro อีกครั้ง');
  const find = () => env.DB.prepare('SELECT orders.status AS status, users.email AS email FROM orders JOIN users ON users.id = orders.user WHERE orders.id = ?1').bind(id).first();
  let o = await withDB(env.DB, find);
  if (!o) return page('ไม่พบรายการนี้', 'กลับไปที่ TokType แล้วกดอัปเกรดเป็น Pro อีกครั้ง', 404);
  if (o.status !== 'paid' && o.status !== 'refunded' && stripeOn(env)) {
    try {
      await settle(env, await stripeAPI(env, 'GET', 'checkout/sessions/' + id));
      o = await find();
    } catch (e) { /* ถาม Stripe ไม่ได้ตอนนี้ webhook จะมาเปิดให้ */ }
  }
  const who = esc(maskEmail(o.email));
  if (o.status === 'paid') {
    return site('เป็น Pro แล้ว TokType', '<h1>เป็น Pro แล้ว ขอบคุณที่สนับสนุนครับ</h1>' +
      '<p>บัญชี <b>' + who + '</b> พิมพ์ด้วยเสียงได้ไม่จำกัดคำ ใช้ได้ตลอด ไม่มีรายเดือน</p>' +
      '<p>ปิดหน้านี้แล้วกลับไปที่ TokType กดคีย์ลัดพูดต่อได้เลย โปรแกรมจะเห็น Pro ในการพูดครั้งถัดไป ใบเสร็จส่งไปทางอีเมลของคุณ</p>' +
      '<p>มีปัญหาติดต่อ ' + contact(env) + '</p>');
  }
  if (o.status === 'refunded') return page('รายการนี้คืนเงินแล้ว', 'บัญชีนี้กลับเป็นแบบฟรีแล้ว อยากซื้อใหม่กดอัปเกรดใน TokType ได้เลย', 200);
  if (o.status === 'expired') return page('ยังไม่ได้รับเงิน', 'หน้าจ่ายเงินนี้หมดอายุแล้วและยังไม่มีการตัดเงิน กลับไปที่ TokType แล้วกดอัปเกรดใหม่อีกครั้ง', 200);
  return site('กำลังยืนยันการจ่ายเงิน TokType', '<h1>กำลังยืนยันการจ่ายเงิน</h1><p>รอสักครู่ หน้านี้จะรีเฟรชเองทุก 5 วินาที ถ้าจ่ายแล้วแต่ยังขึ้นหน้านี้นานเกิน 10 นาที ติดต่อ ' + contact(env) + '</p>' +
    '<script>setTimeout(function(){location.reload();},5000);</script>');
}

const ADMIN_FAILS = 200;

function adminOn(env) {
  return String(env.ADMIN_KEY || '').length >= 16;
}

async function adminAPI(req, env) {
  if (!adminOn(env)) return json({ error: 'no_admin' }, 503);
  if (limited(req, 'admin')) return json({ error: 'busy' }, 429);
  const { body: b, error } = await readJSON(req);
  if (error) return error;
  const now = Date.now();
  const fails = await withDB(env.DB, () => env.DB.prepare('SELECT n, since FROM admin_fails WHERE id = 1').first());
  if (fails && now - fails.since < HOUR && fails.n >= ADMIN_FAILS) return json({ error: 'locked' }, 429);
  if ((await sha256(String((b && b.key) || ''))) !== (await sha256(String(env.ADMIN_KEY)))) {
    tooMany(req, 'admin');
    await env.DB.prepare('INSERT INTO admin_fails (id, n, since) VALUES (1, 1, ?1) ON CONFLICT(id) DO UPDATE SET ' +
      'n = CASE WHEN ?1 - since >= ?2 THEN 1 ELSE n + 1 END, since = CASE WHEN ?1 - since >= ?2 THEN ?1 ELSE since END').bind(now, HOUR).run();
    return limited(req, 'admin') ? json({ error: 'busy' }, 429) : json({ error: 'wrong_key' }, 403);
  }
  const action = String((b && b.action) || 'list');
  return withDB(env.DB, async () => {
    const DB = env.DB;
    if (action === 'list') {
      const rows = await DB.prepare(
        'SELECT orders.id AS id, orders.amount AS amount, orders.status AS status, orders.created AS created, orders.paid AS paid, users.email AS email ' +
        'FROM orders JOIN users ON users.id = orders.user WHERE (orders.status = \'waiting\' AND orders.created > ?1) OR orders.status IN (\'paid\', \'refunded\') ORDER BY orders.created DESC LIMIT 300'
      ).bind(now - 14 * 24 * HOUR).all();
      const sum = await DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM orders WHERE status = \'paid\'').first();
      const p = await priceNow(DB);
      return json({
        orders: (rows.results || []).map((r) => ({ code: r.id.startsWith('pp_') ? r.id.slice(3) : '', stripe: !r.id.startsWith('pp_'), email: r.email, baht: r.amount / 100, status: r.status, created: r.created, paid: r.paid })),
        sold: sum.n, total: sum.total / 100, price: p.amount / 100, launch_left: p.left, method: payMethod(env), payee: payee(env), slip: await slipQuota(env),
      });
    }
    const code = String((b && b.code) || '').trim().toUpperCase();
    const email = String((b && b.email) || '').trim().toLowerCase();
    if (action === 'grant') {
      if (/^[A-Z2-9]{6}$/.test(code)) {
        const o = await DB.prepare('SELECT orders.*, users.email AS email FROM orders JOIN users ON users.id = orders.user WHERE orders.id = ?1').bind('pp_' + code).first();
        if (!o) return json({ error: 'no_code' }, 404);
        await DB.prepare('UPDATE orders SET status = \'waiting\' WHERE id = ?1 AND status = \'refunded\'').bind(o.id).run();
        await grantOrder(env, o.id, o.user);
        return json({ ok: true, email: o.email, code });
      }
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        const u = await DB.prepare('SELECT id, email FROM users WHERE provider = \'google\' AND lower(email) = ?1 ORDER BY created LIMIT 1').bind(email).first();
        if (!u) return json({ error: 'no_account' }, 404);
        const { amount } = await priceNow(DB);
        const id = 'pp_' + newCode();
        await DB.prepare('INSERT INTO orders (id, user, amount, url, status, created) VALUES (?1, ?2, ?3, \'\', \'waiting\', ?4)').bind(id, u.id, amount, now).run();
        await grantOrder(env, id, u.id);
        return json({ ok: true, email: u.email, code: id.slice(3) });
      }
      return json({ error: 'bad_request' }, 400);
    }
    if (action === 'revoke' && /^[A-Z2-9]{6}$/.test(code)) {
      const o = await DB.prepare('SELECT * FROM orders WHERE id = ?1 AND status = \'paid\'').bind('pp_' + code).first();
      if (!o) return json({ error: 'no_code' }, 404);
      await revokeOrder(env, o);
      return json({ ok: true, code });
    }
    return json({ error: 'bad_request' }, 400);
  });
}

const ADMIN_JS = '(function(){var K="poodpim-admin",key="";try{key=localStorage.getItem(K)||"";}catch(e){}' +
  'var $=function(i){return document.getElementById(i);};' +
  'function api(body){body.key=key;return fetch("/api/admin",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){j._s=r.status;return j;});});}' +
  'function t(ms){return ms?new Date(ms).toLocaleString("th-TH",{dateStyle:"medium",timeStyle:"short"}):"";}' +
  'var ST={waiting:"รอเงินเข้า",paid:"เปิด Pro แล้ว",refunded:"ยกเลิกแล้ว"};' +
  'function msg(s,bad){var m=$("msg");m.textContent=s;m.style.color=bad?"#c0392b":"#2e7d4f";}' +
  'var ERR={wrong_key:"รหัสผ่านไม่ถูก",busy:"ลองผิดหลายครั้ง รอ 10 นาที",no_code:"ไม่พบรหัสนี้",no_account:"อีเมลนี้ยังไม่เคยเข้าสู่ระบบ TokType",bad_request:"พิมพ์รหัส 6 ตัว หรืออีเมล",no_admin:"ยังไม่ได้ตั้ง ADMIN_KEY ใน Cloudflare",locked:"มีคนใส่รหัสผิดหลายครั้ง ล็อกไว้ 1 ชั่วโมง"};' +
  'function load(){api({action:"list"}).then(function(j){if(j.error){$("login").hidden=false;$("main").hidden=true;if(key)msg(ERR[j.error]||j.error,true);return;}' +
  'try{localStorage.setItem(K,key);}catch(e){}$("login").hidden=true;$("main").hidden=false;' +
  '$("sum").textContent="ขายแล้ว "+j.sold+" รายการ รวม "+j.total.toLocaleString()+" บาท · ราคาตอนนี้ "+j.price+" บาท"+(j.launch_left>0?" (ราคาเปิดตัวเหลือ "+j.launch_left+" ที่)":"")+" · รับเงินด้วย "+(j.method==="stripe"?"Stripe":j.method==="promptpay"?"พร้อมเพย์เข้าบัญชี "+j.payee:"ยังไม่เปิดขาย")+(j.slip?" · ตรวจสลิปอัตโนมัติ: "+(j.slip.quota==null?"ถาม SlipOK ไม่ได้ ตอนนี้คนซื้อต้องส่งสลิปทางอีเมล":"เหลือ "+j.slip.quota+" สลิปเดือนนี้"):"");' +
  'var L=$("list");L.textContent="";if(!j.orders.length){L.textContent="ยังไม่มีรายการ";}' +
  'j.orders.forEach(function(o){var d=document.createElement("div");d.className="card";' +
  'var h=document.createElement("b");h.textContent=(o.code||"Stripe")+" · "+o.baht.toFixed(2)+" บาท · "+ST[o.status];d.appendChild(h);' +
  'var p=document.createElement("p");p.textContent=o.email+" · กดซื้อ "+t(o.created)+(o.paid?" · เปิด "+t(o.paid):"");d.appendChild(p);' +
  'if(o.code&&o.status!=="paid"){var g=document.createElement("button");g.className="btn";g.textContent="เปิด Pro";g.onclick=function(){if(confirm("เช็กในแอปธนาคารแล้วว่ามีเงิน "+o.baht.toFixed(2)+" บาทเข้าจริง?\\n(อย่าดูแค่สลิป)"))act("grant",o.code);};d.appendChild(g);}' +
  'if(o.code&&o.status==="paid"){var r=document.createElement("button");r.className="btn ghost";r.textContent="ยกเลิก Pro (คืนเงินแล้ว)";r.onclick=function(){if(confirm("คืนเงินให้ "+o.email+" แล้ว และจะยกเลิก Pro?"))act("revoke",o.code);};d.appendChild(r);}' +
  'L.appendChild(d);});});}' +
  'function act(a,code,email){api({action:a,code:code||"",email:email||""}).then(function(j){if(j.error)msg(ERR[j.error]||j.error,true);else msg((a==="grant"?"เปิด Pro ให้ ":"ยกเลิก Pro ของ ")+(j.email||j.code)+" แล้ว");load();});}' +
  '$("go").onclick=function(){key=$("key").value;load();};' +
  '$("find").onclick=function(){var v=$("q").value.trim();if(!v)return;var isMail=v.indexOf("@")>0;if(confirm("เช็กในแอปธนาคารแล้วว่าเงินเข้าจริง?\\nเปิด Pro ให้ "+v))act("grant",isMail?"":v,isMail?v:"");};' +
  '$("out").onclick=function(){key="";try{localStorage.removeItem(K);}catch(e){}location.reload();};' +
  'if(key)load();})();';

function adminPage(env) {
  if (!adminOn(env)) return page('ยังไม่เปิดหน้าแอดมิน', 'ตั้ง ADMIN_KEY (แบบ Secret ยาวอย่างน้อย 16 ตัว) ใน Cloudflare ก่อน', 503);
  const html = '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>แอดมิน TokType</title><style>' + SITE_CSS + '.btn{background:var(--acc);color:var(--card);border:0;border-radius:999px;padding:9px 18px;font:inherit;font-weight:600;margin:6px 8px 0 0;cursor:pointer}' +
    '.btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}input{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);width:100%;max-width:340px}</style></head>' +
    '<body><div class="w"><h1>แอดมิน TokType</h1><p id="msg" role="status"></p>' +
    '<div id="login" class="card"><p>รหัสผ่านแอดมิน (ADMIN_KEY ที่ตั้งใน Cloudflare)</p><p><input id="key" type="password" autocomplete="current-password"></p><button id="go" class="btn">เข้าใช้</button></div>' +
    '<div id="main" hidden><p id="sum"></p><div class="card"><p><b>ก่อนกดเปิด Pro ทุกครั้ง:</b> เปิดแอปธนาคาร เช็กว่ามีเงินเข้าจริงตามยอด อย่าดูแค่สลิป สลิปปลอมทำได้ง่าย</p>' +
    '<p>เปิด Pro จากรหัสอ้างอิง 6 ตัว หรืออีเมล Google ของคนซื้อ</p><p><input id="q" placeholder="เช่น K7M2QX หรือ name@gmail.com"></p><button id="find" class="btn">เปิด Pro</button></div>' +
    '<h2>รายการล่าสุด</h2><div id="list"></div><p><button id="out" class="btn ghost">ออกจากระบบแอดมิน</button></p></div></div>' +
    '<script>' + ADMIN_JS + '</script></body></html>';
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" } });
}

const CHECK_JS = '(async function(){var list=document.getElementById("list"),sum=document.getElementById("sum"),bad=0;' +
  'function row(n,ok,info){var li=document.createElement("li");li.textContent=(ok?"ผ่าน ":"ไม่ผ่าน ")+n+(info?" ("+info+")":"");li.style.color=ok?"#2e7d4f":"#c0392b";list.appendChild(li);if(!ok)bad++;}' +
  'function monday(add){var d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7)+add);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}' +
  'function hex(n){var s="";while(s.length<n)s+=Math.floor(Math.random()*16).toString(16);return s;}' +
  'async function usage(week){var r=await fetch("/api/usage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({m:"f".repeat(64),i:"f".repeat(32),week:week,used:0})});var j={};try{j=await r.json();}catch(e){}return{status:r.status,j:j};}' +
  'try{var s=await(await fetch("/",{headers:{accept:"application/json"}})).json();row("1. สถานะเซิร์ฟเวอร์",s.ready===true&&s.db===true&&s.google===true&&s.limit===2500,JSON.stringify(s));}catch(e){row("1. สถานะเซิร์ฟเวอร์",false,String(e));}' +
  'try{var a=await usage(monday(0));row("2. นับคำสัปดาห์นี้",a.status===200&&a.j.limit===2500&&a.j.week===monday(0)&&a.j.pro===false,a.status+" "+JSON.stringify(a.j));}catch(e){row("2. นับคำสัปดาห์นี้",false,String(e));}' +
  'try{var b=await usage(monday(14));row("3. ไม่รับสัปดาห์ที่ยังไม่ถึง",b.status===400&&b.j.error==="bad_week",b.status+" "+JSON.stringify(b.j));}catch(e){row("3. ไม่รับสัปดาห์ที่ยังไม่ถึง",false,String(e));}' +
  'try{var c=await fetch("/auth/start?p=google&port=50000&state="+hex(32)+"&challenge="+hex(64),{redirect:"manual"});row("4. ปุ่มเข้าสู่ระบบ Google",c.type==="opaqueredirect",c.type+" "+c.status);}catch(e){row("4. ปุ่มเข้าสู่ระบบ Google",false,String(e));}' +
  'try{var d=await fetch("/auth/redeem",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:hex(64),verifier:hex(64)})});var dj={};try{dj=await d.json();}catch(e){}row("5. รับรหัสเข้าสู่ระบบ",d.status===400&&dj.error==="bad_code",d.status+" "+JSON.stringify(dj));}catch(e){row("5. รับรหัสเข้าสู่ระบบ",false,String(e));}' +
  'try{var f=await fetch("/api/price");var fj={};try{fj=await f.json();}catch(e){}row("6. ราคา Pro",f.status===200&&(fj.price===290||fj.price===490)&&fj.normal===490&&typeof fj.launch_left==="number",f.status+" "+JSON.stringify(fj));}catch(e){row("6. ราคา Pro",false,String(e));}' +
  'sum.textContent=bad?"ไม่ผ่าน "+bad+" ข้อ":"ผ่านทุกข้อ";sum.style.color=bad?"#c0392b":"#2e7d4f";})();';

function checkPage() {
  return site('ตรวจเซิร์ฟเวอร์ TokType', '<h1>ตรวจเซิร์ฟเวอร์</h1><p>หน้านี้ลองเรียกสิ่งที่โปรแกรม TokType ใช้ 6 อย่าง รอสักครู่จนบรรทัดล่างสุดขึ้นผล</p>' +
    '<ul id="list" style="overflow-wrap:anywhere"></ul><p id="sum" style="font-size:22px;font-weight:700">กำลังตรวจ...</p><script>' + CHECK_JS + '</script>');
}

const SOURCES = ['web', 'tiktok', 'fb', 'ig', 'yt', 'pantip', 'x', 'review', 'line', 'thaiware', 'app'];
function srcOf(url) {
  const s = String(url.searchParams.get('from') || '').toLowerCase();
  return SOURCES.includes(s) ? s : '';
}

function dlTarget(env) {
  const dl = String(env.DOWNLOAD_URL || DOWNLOAD).trim();
  return /^https:\/\/[^\s"'<>]+$/.test(dl) ? dl : dl === 'none' ? '' : DOWNLOAD;
}

async function download(req, env, url) {
  const to = dlTarget(env);
  if (!to) return redirect('/?web=1#soon');
  if (env.DB && !isBot(req) && !tooMany(req, 'dl')) { // บอทค้นหาและตัวทำตัวอย่างลิงก์ (LINE, Facebook) ได้ไฟล์แต่ไม่นับ
    const src = srcOf(url) || (url.searchParams.has('from') ? 'other' : 'web');
    try {
      await withDB(env.DB, () => env.DB.prepare('INSERT INTO downloads (day, src, n) VALUES (?1, ?2, 1) ON CONFLICT (day, src) DO UPDATE SET n = n + 1')
        .bind(new Date(Date.now()).toISOString().slice(0, 10), src).run());
    } catch (e) { /* ไม่นับรอบนี้ */ }
  }
  return redirect(to);
}

function isBot(req) {
  return /facebookexternalhit|facebot|line-poker|twitterbot|discordbot|telegrambot|slackbot|whatsapp|linkedinbot|googlebot|google-inspectiontool|bingbot|applebot|duckduckbot|pinterest|skypeuripreview|embedly/i
    .test(req.headers.get('user-agent') || '');
}

function verifyTag(env) {
  const v = String(env.GOOGLE_SITE_VERIFICATION || '').trim();
  return /^[A-Za-z0-9_-]{10,100}$/.test(v) ? '<meta name="google-site-verification" content="' + v + '">' : '';
}

function robots(url) {
  return new Response('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /admin\nDisallow: /check\nDisallow: /download\nDisallow: /buy\nSitemap: ' + url.origin + '/sitemap.xml\n',
    { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}

function sitemap(url) {
  const u = ['/', '/privacy', '/terms'].map((p) => '<url><loc>' + esc(url.origin + p) + '</loc></url>').join('');
  return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + u + '</urlset>',
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}

const OG_PNG = 'iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAMAAAB4notuAAAWfmNhQlgAABZ+anVtYgAAAB5qdW1kYzJwYQARABCAAACqADibcQNjMnBhAAAAFlhqdW1iAAAAR2p1bWRjMm1hABEAEIAAAKoAOJtxA3VybjpjMnBhOjBkNjQzNTgyLTUxODAtNGQ1YS05ZDA3LWQ2MTcwZGRhMDFlNgAAAAOTanVtYgAAAClqdW1kYzJhcwARABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAuGp1bWIAAABEanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5pbmdyZWRpZW50LnYzAAAAABhjMnNo9GX98huMkbNRdbTiipROQQAAAGxjYm9yo2lkYzpmb3JtYXRpaW1hZ2UvcG5namluc3RhbmNlSUR4LHhtcDppaWQ6ZmIxNDEwOTUtM2E4OC00OTUwLWI2ZGMtZjg2Y2ZiZmMyMWJlbHJlbGF0aW9uc2hpcGhwYXJlbnRPZgAAAeJqdW1iAAAAQWp1bWRjYm9yABEAEIAAAKoAOJtxE2MycGEuYWN0aW9ucy52MgAAAAAYYzJzaOvAAgX4QPKRfImiIsipH1MAAAGZY2JvcqJnYWN0aW9uc4KiZmFjdGlvbmtjMnBhLm9wZW5lZGpwYXJhbWV0ZXJzoWtpbmdyZWRpZW50c4GiY3VybHgtc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5pbmdyZWRpZW50LnYzZGhhc2hYIIdMf1lE9bVCmZO3KtkazbSmAy7HjC9aoCICeCirwC0UpGZhY3Rpb254HWNvbS5hbnRocm9waWMuY2xhdWRlLnByb3ZpZGVkanBhcmFtZXRlcnOheB9jb20uYW50aHJvcGljLm9yaWdpbi1jb25maWRlbmNlZ3Vua25vd25rZGVzY3JpcHRpb254ZkNsYXVkZSBwcm92aWRlZCB0aGlzIGZpbGUgYXQgdGhlIHJlcXVlc3Qgb2YgYSB1c2VyIGFuZCBtYXkgaGF2ZSBjcmVhdGVkIG9yIG1vZGlmaWVkIHRoZSBmaWxlIGNvbnRlbnRzLm1zb2Z0d2FyZUFnZW50oWRuYW1lZkNsYXVkZXJhbGxBY3Rpb25zSW5jbHVkZWT1AAAAyGp1bWIAAABAanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5oYXNoLmRhdGEAAAAAGGMyc2ge+rugECzcbdP+DGpP3+tGAAAAgGNib3KlY2FsZ2ZzaGEyNTZjcGFkTQAAAAAAAAAAAAAAAABkaGFzaFggUffiZK6g2AhombPTseRg3LCiOaZPaQz8QxnwmLFC2ZFkbmFtZW5qdW1iZiBtYW5pZmVzdGpleGNsdXNpb25zgaJlc3RhcnQYIWZsZW5ndGgZFooAAAI+anVtYgAAACdqdW1kYzJjbAARABCAAACqADibcQNjMnBhLmNsYWltLnYyAAAAAg9jYm9ypWNhbGdmc2hhMjU2aXNpZ25hdHVyZXhNc2VsZiNqdW1iZj0vYzJwYS91cm46YzJwYTowZDY0MzU4Mi01MTgwLTRkNWEtOWQwNy1kNjE3MGRkYTAxZTYvYzJwYS5zaWduYXR1cmVqaW5zdGFuY2VJRHgseG1wOmlpZDo3ZTZlYTViYS04NGQ3LTRmYTAtYTliNS03ZWM4NTQ3ODE0YzRyY3JlYXRlZF9hc3NlcnRpb25zg6JjdXJseC1zZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmluZ3JlZGllbnQudjNkaGFzaFggh0x/WUT1tUKZk7cq2RrNtKYDLseML1qgIgJ4KKvALRSiY3VybHgqc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5hY3Rpb25zLnYyZGhhc2hYILI5XE1ppVCL7pnMhn+gYYi6reYSCb++oPDFAqw9bxsNomN1cmx4KXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaGFzaC5kYXRhZGhhc2hYIPuhNmKtfMesTTrsiNLGqgtn8DnZ39ka+Fc3ryp2cjCJdGNsYWltX2dlbmVyYXRvcl9pbmZvo2RuYW1lb0FudGhyb3BpYyBGaWxlc2d2ZXJzaW9uZTEuMC4wa3NwZWNWZXJzaW9uZTIuNC4wAAAQOGp1bWIAAAAoanVtZGMyY3MAEQAQgAAAqgA4m3EDYzJwYS5zaWduYXR1cmUAAAAQCGNib3LShFkCEqIBJhghWQIKMIICBjCCAY2gAwIBAgIUQOWgCu7COdC+uIP6BkIFPWdVEwAwCgYIKoZIzj0EAwMwSTEXMBUGA1UEChMOQW50aHJvcGljLCBQQkMxLjAsBgNVBAMTJUFudGhyb3BpYyBDb250ZW50IENyZWRlbnRpYWxzIFJvb3QgQ0EwHhcNMjYwODA3MTg0MzU2WhcNMjgwODA2MTk0MzU2WjBEMRcwFQYDVQQKEw5BbnRocm9waWMsIFBCQzEpMCcGA1UEAxMgQW50aHJvcGljIENsYXVkZSBDb250ZW50IFNpZ25pbmcwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASYegpry1AYBRTVNL1CpTlbROnY3dey+UrsF9C3phYrATN3ZHf93Mo8RQN0KOUuOn19P4oWNFWe5n2/She9N7eTo1gwVjAOBgNVHQ8BAf8EBAMCB4AwFQYDVR0lBA4wDAYKKwYBBAGD6F4CATAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFM5R4gSBTmRbI/jjxM+aPpzB11zCMAoGCCqGSM49BAMDA2cAMGQCMDFzHRSeAXrSy1WOzkbhPZ6Km2wGTmZ/2gK18k8BQGXyqz88Rdrz6CTX9flAnYNVxgIwcF9c3fVhqmJKpi+UhasNUMko69cyX6STPfta3Q8EjyzDjzoyrol46FP6VFHhvUcJoWNwYWRZDZ4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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';
function ogImage() {
  return new Response(Uint8Array.from(atob(OG_PNG), (c) => c.charCodeAt(0)),
    { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const route = req.method + ' ' + path;

  if (route === 'GET /' || route === 'GET /api/usage') {
    let ready = false;
    if (env.DB) {
      try { await ensureTable(env.DB); ready = true; } catch (e) { ready = false; }
    }
    const status = { service: 'poodpim-counter', ready, db: !!env.DB, limit: LIMIT, google: !!provider(env, 'google'), line: !!provider(env, 'line'), pay: !!payMethod(env) };
    if (contactEmail(env)) status.contact = contactEmail(env);
    return path === '/' && (wantsHTML(req) || url.searchParams.has('web') || url.searchParams.has('from') || isBot(req)) ? homePage(status, env, url) : json(status);
  }
  if (route === 'GET /privacy') return privacyPage(env);
  if (route === 'GET /check') return checkPage();
  if (route === 'GET /terms') return termsPage(env);
  if (route === 'GET /download') return download(req, env, url);
  if (route === 'GET /og.png') return ogImage();
  if (route === 'GET /robots.txt') return robots(url);
  if (route === 'GET /sitemap.xml') return sitemap(url);
  if (!env.DB) return path.startsWith('/auth/') && req.method === 'GET' ? page('เซิร์ฟเวอร์ยังไม่พร้อม', 'ยังไม่ได้ผูกฐานข้อมูล', 503) : json({ error: 'no_db' }, 503);
  const tidy = prune(env.DB, Date.now()).catch(() => {});
  if (route !== 'POST /api/usage') await tidy;
  else if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(tidy);

  if (route === 'GET /auth/start') {
    if (tooMany(req, 'start')) return page('กดเข้าสู่ระบบถี่เกินไป', 'รอสักครู่แล้วกดเข้าสู่ระบบใน TokType อีกครั้ง', 429);
    return authStart(url, env);
  }
  if (req.method === 'GET' && path.startsWith('/auth/callback/')) return authCallback(url, env, path.slice('/auth/callback/'.length));
  if (route === 'POST /auth/redeem') return authRedeem(req, env);
  if (route === 'POST /auth/logout') {
    const h = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('authorization') || '');
    if (h) await withDB(env.DB, async () => env.DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(await sha256(h[1])).run());
    return json({ ok: true });
  }
  if (route === 'GET /api/me') {
    const who = await whoami(req, env.DB);
    return who ? json({ account: account(who) }) : json({ error: 'login' }, 401);
  }
  if (route === 'POST /api/usage') return tooMany(req, 'usage') ? json({ error: 'busy' }, 429) : usage(req, env);
  if (route === 'POST /api/buy') return tooMany(req, 'buy') ? json({ error: 'busy' }, 429) : buy(req, env, url);
  if (route === 'GET /api/price') {
    const p = await withDB(env.DB, () => priceNow(env.DB));
    return json({ price: p.amount / 100, normal: PRICE.normal / 100, launch_left: p.left, method: payMethod(env) });
  }
  if (route === 'GET /buy') return buyPage(env);
  if (route === 'POST /buy') return tooMany(req, 'buy') ? page('กดถี่เกินไป', 'รอสักครู่แล้วลองใหม่', 429) : buyWeb(req, env, url);
  if (route === 'GET /buy/pp') return ppPage(url, env);
  if (route === 'POST /api/slip') return tooMany(req, 'slip') ? slipReply('busy') : slipCheck(req, env, url);
  if (route === 'GET /buy/cancel') return page('ยังไม่ได้จ่ายเงิน', 'ยกเลิกแล้ว ไม่มีการตัดเงิน ปิดหน้านี้แล้วกลับไปที่ TokType ได้เลย อยากซื้อเมื่อไหร่กดอัปเกรดเป็น Pro ในโปรแกรมอีกครั้ง', 200);
  if (route === 'GET /paid') return paidPage(url, env);
  if (route === 'POST /stripe/webhook') return stripeWebhook(req, env);
  if (route === 'GET /admin') return adminPage(env);
  if (route === 'POST /api/admin') return adminAPI(req, env);
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      const path = new URL(req.url).pathname;
      return path.startsWith('/auth/') && req.method === 'GET' ? page('เซิร์ฟเวอร์ขัดข้องชั่วคราว', 'รอสักครู่แล้วกดเข้าสู่ระบบใน TokType อีกครั้ง', 503) : json({ error: 'server' }, 503);
    }
  },
};
