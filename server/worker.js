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
  for (const sql of TABLES) await db.prepare(sql).run();
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
  const html = '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>พูดพิมพ์</title>' +
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
    '<style>' + SITE_CSS + '</style></head><body><div class="w"><header><a href="/" style="display:flex;align-items:center;gap:12px;color:inherit;text-decoration:none">' + LOGO + '<b>พูดพิมพ์ <small>PoodPim</small></b></a>' +
    '<nav><a href="/">หน้าแรก</a><a href="/privacy">นโยบายความเป็นส่วนตัว</a><a href="/terms">ข้อกำหนด</a></nav></header>' + body + '</div></body></html>';
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function contactEmail(env) {
  const e = String(env.CONTACT_EMAIL || '').trim();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(e) ? e : '';
}

function contact(env) {
  const e = contactEmail(env);
  return e ? '<a href="mailto:' + esc(e) + '">' + esc(e) + '</a>' : '<b>(ผู้ดูแลยังไม่ได้ใส่อีเมลติดต่อ / contact email not set yet)</b>';
}

const DOWNLOAD = 'https://github.com/s09194831-a11y/poodpim/releases/latest/download/poodpim-windows.zip';
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
<title>พูดพิมพ์ พูดภาษาไทยแทนพิมพ์ ได้ทุกโปรแกรม</title>
<meta name="description" content="พูดพิมพ์ โปรแกรมพิมพ์ด้วยเสียงภาษาไทยบน Windows กดคีย์ลัดค้างไว้ พูด ปล่อยมือ ข้อความขึ้นตรงที่คุณพิมพ์ ถอดเสียงในเครื่องคุณเอง ฟรี 2,500 คำทุกสัปดาห์">
<link rel="canonical" href="{{ORIGIN}}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="พูดพิมพ์">
<meta property="og:locale" content="th_TH">
<meta property="og:title" content="พูดพิมพ์ พูดภาษาไทยแทนพิมพ์ ได้ทุกโปรแกรม">
<meta property="og:description" content="พิมพ์ภาษาไทยด้วยเสียงบน Windows กดคีย์ลัดค้างไว้ พูด ปล่อย ข้อความขึ้นในทุกโปรแกรม ถอดเสียงในเครื่องคุณเอง ฟรี 2,500 คำทุกสัปดาห์">
<meta property="og:url" content="{{ORIGIN}}/">
<meta property="og:image" content="{{ORIGIN}}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="พูดพิมพ์ พูดภาษาไทย ข้อความขึ้นเอง">
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
<a class="logo" href="/"><svg><use href="#pp"/></svg>พูดพิมพ์</a>
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
<div class="fine"><span>ฟรี 2,500 คำทุกสัปดาห์</span><span>ไม่ต้องใช้บัตร</span><span>เสียงไม่ออกจากเครื่องคุณ</span></div>
<p id="soon">ไฟล์ติดตั้งกำลังจะเปิดให้ดาวน์โหลดเร็วๆ นี้ กลับมาที่หน้านี้อีกครั้งนะครับ</p>
<div class="stage" id="demo" aria-label="ตัวอย่างการใช้พูดพิมพ์">
<div class="win">
<div class="win-bar"><span class="dots"><i></i><i></i><i></i></span><span class="av" id="av">ท</span><b id="wt">แชทกับทีม</b></div>
<div class="msgs" id="msgs"></div>
<div class="composer"><div class="field" id="field"><span id="typed"></span><span class="caret"></span><span class="ph" id="ph">พิมพ์ข้อความ</span></div><span class="send" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg></span></div>
<div class="pill" id="pill"><svg><use href="#pp"/></svg><span class="bars"><i></i><i></i><i></i><i></i><i></i></span></div>
</div>
<div class="said">
<div class="said-h">ที่คุณพูด</div>
<div class="said-box"><p class="raw" id="raw"></p></div>
<div class="said-h">พูดพิมพ์จัดให้</div>
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
<div class="row v"><div class="lab"><span>พูดกับพูดพิมพ์</span><b>~150 คำ/นาที</b></div><div class="bar"><i data-w="100"></i></div></div>
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
<p class="sub">พูดพิมพ์ถอดเสียงด้วยคอมของคุณเอง ไม่ส่งเสียงหรือข้อความขึ้นอินเทอร์เน็ต <a href="/privacy">อ่านนโยบายความเป็นส่วนตัว</a></p>
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
<section class="block" id="faq" style="padding-top:0"><div class="wrap center">
<div class="kicker reveal">คำถามที่พบบ่อย</div>
<h2 class="reveal">มีคำถาม <em>ตอบให้ตรงนี้</em></h2>
<div class="faq" style="text-align:left">
<details><summary>ใช้กับโปรแกรมไหนได้บ้าง</summary><p>ได้ทุกโปรแกรมที่มีช่องให้พิมพ์ ทั้ง LINE, Facebook, Claude, ChatGPT, Word, Excel, Gmail และทุกเว็บใน Chrome หรือ Edge</p></details>
<details><summary>ต้องต่ออินเทอร์เน็ตไหม</summary><p>ต้องต่อเน็ตไว้ เพื่อเช็กบัญชีและนับจำนวนคำ แต่เสียงและข้อความถอดในเครื่องคุณ ไม่ถูกส่งขึ้นอินเทอร์เน็ต</p></details>
<details><summary>คอมแบบไหนใช้ได้</summary><p>Windows 10 หรือ 11 แบบ 64 บิต ที่ว่างราว 300 MB เครื่องทั่วไปถอดเสียงพูด 10 วินาทีเสร็จในไม่ถึง 1 วินาที ตอนนี้ยังไม่มีรุ่น Mac และมือถือ</p></details>
<details><summary>ติดตั้งแล้ว Windows ขึ้นหน้าจอสีฟ้าเตือน</summary><p>กด "ข้อมูลเพิ่มเติม" แล้วกด "เรียกใช้อยู่ดี" ขึ้นแบบนี้เพราะโปรแกรมยังไม่ได้ซื้อใบรับรองผู้พัฒนา ไม่ได้แปลว่ามีไวรัส</p></details>
<details><summary>พูดไทยปนอังกฤษได้ไหม</summary><p>ได้ คำอังกฤษที่คนไทยพูดบ่อยกว่า 600 คำ เช่น meeting, deadline, Excel จะเขียนเป็นตัวอังกฤษให้เอง คำอื่นเพิ่มเองได้ในหน้าคลังคำ</p></details>
<details><summary>ฟรีจริงไหม ต้องผูกบัตรไหม</summary><p>ฟรีจริง 2,500 คำทุกสัปดาห์ตลอดไป ไม่ต้องผูกบัตร แค่เข้าสู่ระบบด้วยบัญชี Google</p></details>
<details><summary>ถอนการติดตั้งยังไง</summary><p>การตั้งค่า > แอป > แอปที่ติดตั้ง > พูดพิมพ์ (PoodPim) > ถอนการติดตั้ง ระบบจะลบทุกอย่างออกให้หมด</p></details>
</div>
</div></section>
<section class="block" style="padding-top:0"><div class="wrap">
<div class="final reveal">
<svg class="logo-big"><use href="#pp"/></svg>
<h2>ลองพูดดูสักประโยค</h2>
<p class="sub" style="margin-inline:auto">ติดตั้งไม่ถึงนาที เข้าสู่ระบบด้วย Google แล้วพูดได้เลย</p>
<div class="cta"><a class="btn btn-p" href="{{DL}}"><svg><use href="#dl"/></svg>ดาวน์โหลดฟรีสำหรับ Windows</a></div>
<div class="fine"><span>รุ่น {{VERSION}}</span><span>{{SIZE}}</span><span>Windows 10 และ 11</span></div>
</div>
</div></section>
</main>
<footer><div class="wrap">
<a class="logo" href="/" style="font-size:18px"><svg style="width:28px;height:28px"><use href="#pp"/></svg>พูดพิมพ์</a>
<span>© 2026 พูดพิมพ์</span>
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
  return site('นโยบายความเป็นส่วนตัว พูดพิมพ์', '<h1>นโยบายความเป็นส่วนตัว</h1><p>ปรับปรุงล่าสุด ' + UPDATED + '</p>' +
    '<p>พูดพิมพ์ (PoodPim) เป็นโปรแกรมพิมพ์ภาษาไทยด้วยเสียงบน Windows หน้านี้อธิบายว่าเราเก็บข้อมูลอะไร เพื่ออะไร และคุณขอลบได้อย่างไร ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 ติดต่อผู้ดูแล: ' + c + '</p>' +
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
    '<li>ยกเลิกสิทธิ์ที่ให้พูดพิมพ์ได้ที่ <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a></li></ul>' +
    '<p>การใช้ข้อมูลที่ได้รับจาก Google API ของพูดพิมพ์เป็นไปตาม Google API Services User Data Policy รวมถึงข้อกำหนด Limited Use</p>' +
    '<div class="en"><h2>Privacy policy (English)</h2><p>Last updated ' + UPDATED + '. Contact: ' + c + '.</p>' +
    '<p><b>We never collect</b> your voice, audio or the text you dictate or type. Speech is transcribed on your own computer and is not sent to our server. We never see or store your Google password (you type it on Google\'s own page), and we do not access your contacts, files or any other Google data.</p>' +
    '<p><b>We store</b>: your Google name, email address and Google account ID number (not your password) when you sign in; a hashed sign-in key; weekly word counts linked to a one-way hashed machine ID and install ID, with the time of the last update; temporary sign-in records that are deleted within one hour; and, if you buy Pro, the order number, amount, status and time. If you pay by PromptPay we see the transfer slip you send us (sender name, bank, time) and use it only to confirm or refund the payment;' + (slipOn(env) ? ' if you upload the slip on the payment page, the image is sent to SlipOK (a Thai slip-checking service) to check it with the bank, and we keep only the transfer reference number, amount and time, not the image;' : '') + ' card payments go through Stripe and we never see your card number.</p>' +
    '<p>We also count downloads of the app per day and per source (for example TikTok) as plain totals, not linked to any person, account or IP address.</p>' +
    '<p><b>We use it</b> to count the free weekly word allowance, keep that count when the app is reinstalled, combine counts for one account across computers, show your account name in the app, and link Pro purchases to your account. We do not sell, rent or share your data and do not use it for advertising.</p>' +
    '<p><b>Storage and retention</b>: data is stored on Cloudflare, our hosting provider. Google is used to confirm your identity, and these pages load fonts from Google Fonts (your browser contacts Google directly, as usual on the web). The server looks at IP addresses only to block abnormal request floods, keeps them in memory for at most 10 minutes and never writes them to the database. We keep your account and word counts while you use the service or until you ask us to delete them.</p>' +
    '<p><b>Your choices</b>: email us from your sign-in address to see, correct or delete your data; we delete within 30 days. Signing out in the app deletes your sign-in key on the server. You can remove PoodPim\'s access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>' +
    '<p>PoodPim\'s use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p></div>');
}

function termsPage(env) {
  return site('ข้อกำหนดการใช้งาน พูดพิมพ์', '<h1>ข้อกำหนดการใช้งาน</h1><p>ปรับปรุงล่าสุด ' + UPDATED + '</p><ul>' +
    '<li>พูดพิมพ์ให้ใช้ฟรี 2,500 คำต่อสัปดาห์ต่อบัญชีและต่อเครื่อง ต้องต่ออินเทอร์เน็ตและเข้าสู่ระบบด้วย Google</li>' +
    '<li>ห้ามแก้ไขโปรแกรมหรือปลอมข้อมูลเพื่อเลี่ยงการนับคำ เราระงับบัญชีที่ทำแบบนั้นได้</li>' +
    '<li><b>Pro:</b> จ่ายครั้งเดียว ' + PRICE.launch / 100 + ' บาทสำหรับ ' + PRICE.seats + ' คนแรก จากนั้น ' + PRICE.normal / 100 + ' บาท ไม่มีรายเดือน บัญชี Google ที่ซื้อพิมพ์ได้ไม่จำกัดคำตลอดอายุของบริการ จ่ายด้วยพร้อมเพย์ (หรือบัตรผ่าน Stripe เมื่อเปิดให้ใช้) ยอดโอนพร้อมเพย์บวกเศษไม่เกิน 99 สตางค์ไว้จับคู่การโอนกับรายการ ได้สิทธิ์เมื่อเรายืนยันว่าได้รับเงินแล้ว ' + (slipOn(env) ? '(ทันทีเมื่อสลิปผ่านการตรวจอัตโนมัติในหน้าจ่ายเงิน หรือโดยปกติภายใน 24 ชั่วโมง)' : 'โดยปกติภายใน 24 ชั่วโมง') + ' ไม่มีสินค้าจัดส่ง</li>' +
    '<li><b>คืนเงิน:</b> ขอคืนเงินเต็มจำนวนได้ภายใน 7 วันหลังซื้อ ส่งอีเมลจากบัญชีที่ซื้อมาที่ ' + contact(env) + ' เมื่อคืนเงินแล้วบัญชีนั้นกลับเป็นแบบฟรี</li>' +
    '<li>ข้อความที่ถอดจากเสียงอาจผิดได้ ตรวจก่อนส่งทุกครั้ง เราไม่รับผิดชอบความเสียหายจากข้อความที่ถอดผิด</li>' +
    '<li>บริการอาจหยุดชั่วคราวหรือเปลี่ยนแปลงได้ เราจะแจ้งในหน้านี้เมื่อข้อกำหนดเปลี่ยน</li>' +
    '<li>ติดต่อ: ' + contact(env) + ' อ่านเรื่องข้อมูลส่วนตัวใน<a href="/privacy">นโยบายความเป็นส่วนตัว</a></li></ul>' +
    '<div class="en"><h2>Terms of use (English)</h2><p>PoodPim is free for 2,500 words per week per account and per computer and requires an internet connection and Google sign-in. ' +
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
  if (!p) return page('ยังเข้าสู่ระบบด้วยวิธีนี้ไม่ได้', 'ผู้ดูแลยังไม่ได้เปิดการเข้าสู่ระบบแบบนี้ กลับไปที่พูดพิมพ์แล้วลองอีกวิธี');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{32}$/.test(state) || !/^[0-9a-f]{64}$/.test(challenge)) {
    return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่พูดพิมพ์แล้วกดเข้าสู่ระบบอีกครั้ง');
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
  if (!p || !/^[0-9a-f]{32}$/.test(id)) return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่พูดพิมพ์แล้วกดเข้าสู่ระบบอีกครั้ง');
  const row = await withDB(env.DB, () => env.DB.prepare('SELECT * FROM logins WHERE id = ?1 AND provider = ?2 AND code IS NULL').bind(id, p.key).first());
  if (!row || Date.now() - row.created > LOGIN_TTL) {
    return page('หมดเวลาเข้าสู่ระบบ', 'กลับไปที่พูดพิมพ์แล้วกดเข้าสู่ระบบอีกครั้ง');
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

const USAGE_DB_MS = 3000;
class Degraded extends Error {}
function inTime(p, deadline) {
  let t;
  const late = new Promise((_, no) => { t = setTimeout(() => no(new Degraded('db_timeout')), Math.max(1, deadline - Date.now())); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

async function usage(req, env) {
  try {
    return await usageCount(req, env, Date.now() + USAGE_DB_MS);
  } catch (e) {
    return json({ error: 'degraded' }, 503);
  }
}

async function usageCount(req, env, deadline) {
  const who = await inTime(whoami(req, env.DB), deadline);
  if (who === null) return json({ error: 'login' }, 401); // กุญแจเข้าระบบถูกยกเลิก ให้โปรแกรมเข้าสู่ระบบใหม่
  const { body: b, error } = await readJSON(req);
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
          product_data: { name: 'พูดพิมพ์ Pro (จ่ายครั้งเดียว ใช้ตลอด)', description: 'พิมพ์ด้วยเสียงไม่จำกัดคำ สำหรับบัญชี ' + maskEmail(who.email) },
        },
      }],
      success_url: url.origin + '/paid?s={CHECKOUT_SESSION_ID}',
      cancel_url: url.origin + '/buy/cancel',
      expires_at: Math.floor((now + ORDER_TTL) / 1000),
      metadata: { app: 'poodpim', user: who.id },
      payment_intent_data: { description: 'PoodPim Pro', metadata: { app: 'poodpim', user: who.id } },
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
  wrong_receiver: 'สลิปนี้ไม่ได้โอนเข้าพร้อมเพย์ของพูดพิมพ์ ตรวจว่าสแกน QR ในหน้านี้',
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
  return site('ซื้อ Pro พูดพิมพ์', BUY_CSS + '<h1>พูดพิมพ์ Pro ' + p.amount / 100 + ' บาท จ่ายครั้งเดียว</h1>' + priceLine(p) +
    (!method ? '<div class="card"><p>ยังไม่เปิดขาย เร็วๆ นี้</p></div>' :
      '<div class="card"><form method="post" action="/buy"><p><b>อีเมล Google ที่ใช้เข้าสู่ระบบในโปรแกรมพูดพิมพ์</b></p>' +
      (msg ? '<p style="color:#c0392b">' + esc(msg) + '</p>' : '') +
      '<p><input type="email" name="email" required autocomplete="email" placeholder="you@gmail.com"></p><p><button class="btn" type="submit">ไปหน้าจ่ายเงิน</button></p>' +
      '<p>ยังไม่เคยใช้พูดพิมพ์? <a href="/">ดาวน์โหลดโปรแกรม</a> แล้วเข้าสู่ระบบด้วย Google ก่อน หรือกด <b>อัปเกรดเป็น Pro</b> ในโปรแกรมได้เลย</p></form></div>' +
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
  if (!who) return buyPage(env, 'ยังไม่พบบัญชีนี้ในพูดพิมพ์ เปิดโปรแกรมแล้วเข้าสู่ระบบด้วย Google อีเมลนี้ก่อน แล้วกลับมาที่หน้านี้');
  const r = await startOrder(env, url, who);
  if (r.body.pro) return page('บัญชีนี้เป็น Pro แล้ว', 'พิมพ์ด้วยเสียงได้ไม่จำกัดอยู่แล้ว ไม่ต้องซื้อซ้ำ', 200);
  if (!r.body.url) return page('ยังซื้อไม่ได้ตอนนี้', 'ระบบรับเงินขัดข้องชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่', r.status);
  return new Response(null, { status: 303, headers: { location: r.body.url, 'cache-control': 'no-store' } });
}

async function ppPage(url, env) {
  const code = String(url.searchParams.get('c') || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่พูดพิมพ์ แล้วกดอัปเกรดเป็น Pro อีกครั้ง');
  const o = await withDB(env.DB, () => env.DB.prepare(
    'SELECT orders.status AS status, orders.amount AS amount, users.email AS email, pro.user IS NOT NULL AS pro FROM orders JOIN users ON users.id = orders.user ' +
    'LEFT JOIN pro ON pro.user = orders.user WHERE orders.id = ?1'
  ).bind('pp_' + code).first());
  if (!o) return page('ไม่พบรหัสนี้', 'กลับไปที่พูดพิมพ์ แล้วกดอัปเกรดเป็น Pro อีกครั้ง', 404);
  const who = esc(maskEmail(o.email));
  if (o.pro || o.status === 'paid') {
    return site('เป็น Pro แล้ว พูดพิมพ์', '<h1>เป็น Pro แล้ว ขอบคุณที่สนับสนุนครับ</h1><p>บัญชี <b>' + who + '</b> พิมพ์ด้วยเสียงได้ไม่จำกัดคำ ใช้ได้ตลอด</p>' +
      '<p>กลับไปที่พูดพิมพ์แล้วพูดต่อได้เลย โปรแกรมจะเห็น Pro ในการพูดครั้งถัดไป</p>');
  }
  const payload = promptpayPayload(env.PROMPTPAY_ID, o.amount);
  if (!payload || o.status !== 'waiting') return page('รหัสนี้ใช้จ่ายไม่ได้แล้ว', 'กลับไปที่พูดพิมพ์ แล้วกดอัปเกรดเป็น Pro อีกครั้งเพื่อรับรหัสใหม่', 200);
  const baht = thb(o.amount);
  const name = payee(env);
  const mail = String(env.CONTACT_EMAIL || '').trim();
  const mailto = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(mail)
    ? 'mailto:' + mail + '?subject=' + encodeURIComponent('สลิปซื้อ Pro รหัส ' + code) + '&body=' + encodeURIComponent('รหัสอ้างอิง: ' + code + '\nยอด: ' + baht + ' บาท\n(แนบรูปสลิปมากับอีเมลนี้)') : '';
  const line = /^https:\/\/(lin\.ee|line\.me)\/[\w\-./~@%?=]+$/.test(String(env.LINE_OA_URL || '').trim()) ? String(env.LINE_OA_URL).trim() : '';
  const send = [mailto ? '<a class="btn" href="' + esc(mailto) + '">ส่งสลิปทางอีเมล</a>' : '', line ? '<a class="btn" href="' + esc(line) + '">ส่งสลิปทาง LINE</a>' : ''].filter(Boolean).join(' ');
  return site('จ่ายค่า Pro ด้วยพร้อมเพย์ พูดพิมพ์', BUY_CSS + '<h1>จ่ายค่า Pro ด้วยพร้อมเพย์</h1><p>สำหรับบัญชี <b>' + who + '</b></p>' +
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
  if (!SESSION_ID.test(id)) return page('ลิงก์ไม่ถูกต้อง', 'กลับไปที่พูดพิมพ์ แล้วกดอัปเกรดเป็น Pro อีกครั้ง');
  const find = () => env.DB.prepare('SELECT orders.status AS status, users.email AS email FROM orders JOIN users ON users.id = orders.user WHERE orders.id = ?1').bind(id).first();
  let o = await withDB(env.DB, find);
  if (!o) return page('ไม่พบรายการนี้', 'กลับไปที่พูดพิมพ์ แล้วกดอัปเกรดเป็น Pro อีกครั้ง', 404);
  if (o.status !== 'paid' && o.status !== 'refunded' && stripeOn(env)) {
    try {
      await settle(env, await stripeAPI(env, 'GET', 'checkout/sessions/' + id));
      o = await find();
    } catch (e) { /* ถาม Stripe ไม่ได้ตอนนี้ webhook จะมาเปิดให้ */ }
  }
  const who = esc(maskEmail(o.email));
  if (o.status === 'paid') {
    return site('เป็น Pro แล้ว พูดพิมพ์', '<h1>เป็น Pro แล้ว ขอบคุณที่สนับสนุนครับ</h1>' +
      '<p>บัญชี <b>' + who + '</b> พิมพ์ด้วยเสียงได้ไม่จำกัดคำ ใช้ได้ตลอด ไม่มีรายเดือน</p>' +
      '<p>ปิดหน้านี้แล้วกลับไปที่พูดพิมพ์ กดคีย์ลัดพูดต่อได้เลย โปรแกรมจะเห็น Pro ในการพูดครั้งถัดไป ใบเสร็จส่งไปทางอีเมลของคุณ</p>' +
      '<p>มีปัญหาติดต่อ ' + contact(env) + '</p>');
  }
  if (o.status === 'refunded') return page('รายการนี้คืนเงินแล้ว', 'บัญชีนี้กลับเป็นแบบฟรีแล้ว อยากซื้อใหม่กดอัปเกรดในพูดพิมพ์ได้เลย', 200);
  if (o.status === 'expired') return page('ยังไม่ได้รับเงิน', 'หน้าจ่ายเงินนี้หมดอายุแล้วและยังไม่มีการตัดเงิน กลับไปที่พูดพิมพ์แล้วกดอัปเกรดใหม่อีกครั้ง', 200);
  return site('กำลังยืนยันการจ่ายเงิน พูดพิมพ์', '<h1>กำลังยืนยันการจ่ายเงิน</h1><p>รอสักครู่ หน้านี้จะรีเฟรชเองทุก 5 วินาที ถ้าจ่ายแล้วแต่ยังขึ้นหน้านี้นานเกิน 10 นาที ติดต่อ ' + contact(env) + '</p>' +
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
  'var ERR={wrong_key:"รหัสผ่านไม่ถูก",busy:"ลองผิดหลายครั้ง รอ 10 นาที",no_code:"ไม่พบรหัสนี้",no_account:"อีเมลนี้ยังไม่เคยเข้าสู่ระบบพูดพิมพ์",bad_request:"พิมพ์รหัส 6 ตัว หรืออีเมล",no_admin:"ยังไม่ได้ตั้ง ADMIN_KEY ใน Cloudflare",locked:"มีคนใส่รหัสผิดหลายครั้ง ล็อกไว้ 1 ชั่วโมง"};' +
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
    '<title>แอดมิน พูดพิมพ์</title><style>' + SITE_CSS + '.btn{background:var(--acc);color:var(--card);border:0;border-radius:999px;padding:9px 18px;font:inherit;font-weight:600;margin:6px 8px 0 0;cursor:pointer}' +
    '.btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}input{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);width:100%;max-width:340px}</style></head>' +
    '<body><div class="w"><h1>แอดมิน พูดพิมพ์</h1><p id="msg" role="status"></p>' +
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
  return site('ตรวจเซิร์ฟเวอร์ พูดพิมพ์', '<h1>ตรวจเซิร์ฟเวอร์</h1><p>หน้านี้ลองเรียกสิ่งที่โปรแกรมพูดพิมพ์ใช้ 6 อย่าง รอสักครู่จนบรรทัดล่างสุดขึ้นผล</p>' +
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
  if (env.DB && !tooMany(req, 'dl')) {
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
  return new Response('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /admin\nDisallow: /check\nSitemap: ' + url.origin + '/sitemap.xml\n',
    { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}

function sitemap(url) {
  const u = ['/', '/privacy', '/terms'].map((p) => '<url><loc>' + esc(url.origin + p) + '</loc></url>').join('');
  return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + u + '</urlset>',
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}

const OG_PNG = 'iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAMAAAB4notuAAAWfmNhQlgAABZ+anVtYgAAAB5qdW1kYzJwYQARABCAAACqADibcQNjMnBhAAAAFlhqdW1iAAAAR2p1bWRjMm1hABEAEIAAAKoAOJtxA3VybjpjMnBhOjYxZjcxYjcyLWQ3MDItNDEwMC1iMjRiLWI5MGIwMjA1ZWNhOAAAAAOTanVtYgAAAClqdW1kYzJhcwARABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAuGp1bWIAAABEanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5pbmdyZWRpZW50LnYzAAAAABhjMnNoikXFKFrwmpEsnmYXlCJk6QAAAGxjYm9yo2lkYzpmb3JtYXRpaW1hZ2UvcG5namluc3RhbmNlSUR4LHhtcDppaWQ6ZjAxOWUyY2MtNTY1MS00Y2IzLWFmNWMtNTU2YWU2YzE2ZGM3bHJlbGF0aW9uc2hpcGhwYXJlbnRPZgAAAeJqdW1iAAAAQWp1bWRjYm9yABEAEIAAAKoAOJtxE2MycGEuYWN0aW9ucy52MgAAAAAYYzJzaFUqFDnErX0M55pElvnhVwUAAAGZY2JvcqJnYWN0aW9uc4KiZmFjdGlvbmtjMnBhLm9wZW5lZGpwYXJhbWV0ZXJzoWtpbmdyZWRpZW50c4GiY3VybHgtc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5pbmdyZWRpZW50LnYzZGhhc2hYIHfqNLDtKW9bC+SgO1sGnh7yWUGrUmkdJZsJZwGyjLr2pGZhY3Rpb254HWNvbS5hbnRocm9waWMuY2xhdWRlLnByb3ZpZGVkanBhcmFtZXRlcnOheB9jb20uYW50aHJvcGljLm9yaWdpbi1jb25maWRlbmNlZ3Vua25vd25rZGVzY3JpcHRpb254ZkNsYXVkZSBwcm92aWRlZCB0aGlzIGZpbGUgYXQgdGhlIHJlcXVlc3Qgb2YgYSB1c2VyIGFuZCBtYXkgaGF2ZSBjcmVhdGVkIG9yIG1vZGlmaWVkIHRoZSBmaWxlIGNvbnRlbnRzLm1zb2Z0d2FyZUFnZW50oWRuYW1lZkNsYXVkZXJhbGxBY3Rpb25zSW5jbHVkZWT1AAAAyGp1bWIAAABAanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5oYXNoLmRhdGEAAAAAGGMyc2jcGeOUcHoV9gIwMlSSfTiAAAAAgGNib3KlY2FsZ2ZzaGEyNTZjcGFkTQAAAAAAAAAAAAAAAABkaGFzaFggPcFMYdQKH81LXSaWVLXmvLPhRxIW7wEr47CSZ8NPPnJkbmFtZW5qdW1iZiBtYW5pZmVzdGpleGNsdXNpb25zgaJlc3RhcnQYIWZsZW5ndGgZFooAAAI+anVtYgAAACdqdW1kYzJjbAARABCAAACqADibcQNjMnBhLmNsYWltLnYyAAAAAg9jYm9ypWNhbGdmc2hhMjU2aXNpZ25hdHVyZXhNc2VsZiNqdW1iZj0vYzJwYS91cm46YzJwYTo2MWY3MWI3Mi1kNzAyLTQxMDAtYjI0Yi1iOTBiMDIwNWVjYTgvYzJwYS5zaWduYXR1cmVqaW5zdGFuY2VJRHgseG1wOmlpZDpkNmYwYjkyNS02NDQxLTQ5YzMtYmJkMy1kNWY4MjhkOWIyMDdyY3JlYXRlZF9hc3NlcnRpb25zg6JjdXJseC1zZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmluZ3JlZGllbnQudjNkaGFzaFggd+o0sO0pb1sL5KA7WwaeHvJZQatSaR0lmwlnAbKMuvaiY3VybHgqc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5hY3Rpb25zLnYyZGhhc2hYIBHU3t909vyPzFMPC98loA2IzH9098hmtMylQEq+K9/UomN1cmx4KXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaGFzaC5kYXRhZGhhc2hYIMtj3WpFwWQLWcGbmherD7LlksWADur4XxIoNIYF2Co/dGNsYWltX2dlbmVyYXRvcl9pbmZvo2RuYW1lb0FudGhyb3BpYyBGaWxlc2d2ZXJzaW9uZTEuMC4wa3NwZWNWZXJzaW9uZTIuNC4wAAAQOGp1bWIAAAAoanVtZGMyY3MAEQAQgAAAqgA4m3EDYzJwYS5zaWduYXR1cmUAAAAQCGNib3LShFkCEqIBJhghWQIKMIICBjCCAY2gAwIBAgIUQOWgCu7COdC+uIP6BkIFPWdVEwAwCgYIKoZIzj0EAwMwSTEXMBUGA1UEChMOQW50aHJvcGljLCBQQkMxLjAsBgNVBAMTJUFudGhyb3BpYyBDb250ZW50IENyZWRlbnRpYWxzIFJvb3QgQ0EwHhcNMjYwODA3MTg0MzU2WhcNMjgwODA2MTk0MzU2WjBEMRcwFQYDVQQKEw5BbnRocm9waWMsIFBCQzEpMCcGA1UEAxMgQW50aHJvcGljIENsYXVkZSBDb250ZW50IFNpZ25pbmcwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASYegpry1AYBRTVNL1CpTlbROnY3dey+UrsF9C3phYrATN3ZHf93Mo8RQN0KOUuOn19P4oWNFWe5n2/She9N7eTo1gwVjAOBgNVHQ8BAf8EBAMCB4AwFQYDVR0lBA4wDAYKKwYBBAGD6F4CATAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFM5R4gSBTmRbI/jjxM+aPpzB11zCMAoGCCqGSM49BAMDA2cAMGQCMDFzHRSeAXrSy1WOzkbhPZ6Km2wGTmZ/2gK18k8BQGXyqz88Rdrz6CTX9flAnYNVxgIwcF9c3fVhqmJKpi+UhasNUMko69cyX6STPfta3Q8EjyzDjzoyrol46FP6VFHhvUcJoWNwYWRZDZ4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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';
function ogImage() {
  return new Response(Uint8Array.from(atob(OG_PNG), (c) => c.charCodeAt(0)),
    { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}

async function handle(req, env) {
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
  try { await prune(env.DB, Date.now()); } catch (e) { /* ลบไม่ได้รอบนี้ ไว้รอบหน้า */ }

  if (route === 'GET /auth/start') {
    if (tooMany(req, 'start')) return page('กดเข้าสู่ระบบถี่เกินไป', 'รอสักครู่แล้วกดเข้าสู่ระบบในพูดพิมพ์อีกครั้ง', 429);
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
  if (route === 'GET /buy/cancel') return page('ยังไม่ได้จ่ายเงิน', 'ยกเลิกแล้ว ไม่มีการตัดเงิน ปิดหน้านี้แล้วกลับไปที่พูดพิมพ์ได้เลย อยากซื้อเมื่อไหร่กดอัปเกรดเป็น Pro ในโปรแกรมอีกครั้ง', 200);
  if (route === 'GET /paid') return paidPage(url, env);
  if (route === 'POST /stripe/webhook') return stripeWebhook(req, env);
  if (route === 'GET /admin') return adminPage(env);
  if (route === 'POST /api/admin') return adminAPI(req, env);
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      const path = new URL(req.url).pathname;
      return path.startsWith('/auth/') && req.method === 'GET' ? page('เซิร์ฟเวอร์ขัดข้องชั่วคราว', 'รอสักครู่แล้วกดเข้าสู่ระบบในพูดพิมพ์อีกครั้ง', 503) : json({ error: 'server' }, 503);
    }
  },
};
