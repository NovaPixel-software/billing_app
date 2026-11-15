// Zero-dependency multi-vendor billing server.
//  - data/users.json        : accounts (admin + vendors), password hashes
//  - data/sessions.json     : login sessions (hashed tokens)
//  - data/brand.json        : login-page branding set by admin
//  - data/ws_<userId>.json  : one billing workspace per user
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3008;
const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUB = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SESSION_DAYS = 30;
fs.mkdirSync(DATA, { recursive: true });

// ---------- tiny json store ----------
const file = n => path.join(DATA, n);
function readJson(n, dflt) { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return dflt; } }
function writeJson(n, obj) {
  const tmp = file(n) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (fs.existsSync(file(n))) fs.copyFileSync(file(n), file(n) + '.bak');
  fs.renameSync(tmp, file(n));
}
const newId = () => crypto.randomBytes(6).toString('hex');
const okId = s => typeof s === 'string' && /^[a-f0-9]{6,32}$/.test(s);

// ---------- passwords & sessions ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function checkPw(pw, u) {
  const h = crypto.scryptSync(String(pw), u.salt, 64);
  const a = Buffer.from(u.hash, 'hex');
  return a.length === h.length && crypto.timingSafeEqual(a, h);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let users = readJson('users.json', null);
let sessions = readJson('sessions.json', {});
let brand = readJson('brand.json', { appName: 'Billing', logo: 'logo.png' });
const saveUsers = () => writeJson('users.json', users);
const saveSessions = () => writeJson('sessions.json', sessions);

function seedWorkspace(companyName) {
  return {
    settings: {
      name: companyName, address: '', phone: '', gst: '', pan: '', logo: '', themeColor: '#3b82f6',
      prefix: 'INV-', nextNo: 1, gstRate: 5, dueDays: 10,
      bankAccount: '', ifsc: '', bankName: '', accountName: companyName,
      terms: 'Payment should be made within 10 days from the date of invoice only to the account below.',
    },
    customers: [], items: [], invoices: [],
  };
}

// First run: create admin; move the old single-user data.json into the admin workspace.
if (!users) {
  const id = newId();
  users = [{ id, username: 'admin', name: 'Administrator', role: 'admin', ...hashPw('admin123'), active: true, mustChange: true, createdAt: new Date().toISOString() }];
  saveUsers();
  const old = path.join(ROOT, 'data.json');
  let ws;
  if (fs.existsSync(old)) {
    ws = JSON.parse(fs.readFileSync(old, 'utf8'));
    fs.renameSync(old, old + '.migrated');
    ws.settings.logo = ws.settings.logo || 'logo.png';
  } else ws = seedWorkspace('My Company');
  ws.settings.themeColor = ws.settings.themeColor || '#3b82f6';
  writeJson('ws_' + id + '.json', ws);
  console.log('First run: admin account created -> username: admin  password: admin123 (must be changed at first login)');
}

// Default vendor: if there is no vendor yet, create one so the admin can try the flow straight away.
if (!users.some(u => u.role === 'vendor')) {
  let dws; try { dws = JSON.parse(fs.readFileSync(path.join(__dirname, 'default_vendor.json'), 'utf8')); } catch { dws = seedWorkspace('Demo Vendor'); }
  const v = { id: newId(), username: 'vendor1', name: dws.settings.name, role: 'vendor', ...hashPw('vendor123'), active: true, mustChange: false, createdAt: new Date().toISOString() };
  users.push(v); saveUsers();
  writeJson('ws_' + v.id + '.json', dws);
  console.log('Default vendor created -> username: vendor1  password: vendor123');
}

// Vendors are never forced to change their password; clear the flag on accounts created before this rule.
if (users.some(u => u.role === 'vendor' && u.mustChange)) { users.forEach(u => { if (u.role === 'vendor') u.mustChange = false; }); saveUsers(); }

// ---------- helpers ----------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 6e6) {
  return new Promise((resolve, reject) => {
    let b = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } });
  });
}
function sessionUser(req) {
  const t = parseCookies(req).sid; if (!t) return null;
  const s = sessions[sha(t)];
  if (!s || s.exp < Date.now()) return null;
  const u = users.find(x => x.id === s.uid);
  return u && u.active ? u : null;
}
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, mustChange: !!u.mustChange });
function calcTotal(inv) {
  const sub = (inv.lines || []).reduce((s, l) => s + (+l.count || 0) * (+l.cost || 0), 0);
  return Math.round(sub * (1 + (+inv.gstRate || 0) / 100));
}
function wsStats(id) {
  const ws = readJson('ws_' + id + '.json', null);
  if (!ws) return { company: '', invoices: 0, billed: 0, pending: 0 };
  let billed = 0, pending = 0;
  ws.invoices.forEach(i => { const t = calcTotal(i); billed += t; if (i.status !== 'paid') pending += t; });
  return { company: ws.settings.name, invoices: ws.invoices.length, billed, pending };
}
function validLogo(s) {
  return s === '' || s === undefined || (typeof s === 'string' && s.length < 2.5e6 &&
    (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || /^[\w.-]+\.(png|jpg|jpeg)$/.test(s)));
}

// login throttle: 5 wrong attempts -> 60s lock (per ip + username)
const fails = {};
const throttled = key => fails[key] && fails[key].n >= 5 && Date.now() < fails[key].until;
function noteFail(key) { const f = fails[key] || (fails[key] = { n: 0, until: 0 }); f.n++; if (f.n >= 5) f.until = Date.now() + 60000; }

// ---------- API ----------
async function api(req, res, url) {
  const m = req.method;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) && !(req.headers['content-type'] || '').includes('application/json'))
    return send(res, 415, 'JSON required');

  if (url === '/api/brand' && m === 'GET') return send(res, 200, brand);

  if (url === '/api/login' && m === 'POST') {
    const b = await readBody(req, 1e4);
    const uname = String(b.username || '').trim().toLowerCase();
    const key = req.socket.remoteAddress + '|' + uname;
    if (throttled(key)) return send(res, 429, 'Too many attempts. Try again in a minute.');
    const u = users.find(x => x.username.toLowerCase() === uname);
    if (!u || !u.active || !checkPw(b.password || '', u)) { noteFail(key); return send(res, 401, 'Wrong username or password'); }
    delete fails[key];
    const token = crypto.randomBytes(32).toString('hex');
    Object.keys(sessions).forEach(k => { if (sessions[k].exp < Date.now()) delete sessions[k]; });
    sessions[sha(token)] = { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 };
    saveSessions();
    return send(res, 200, publicUser(u), { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
  }
  if (url === '/api/logout' && m === 'POST') {
    const t = parseCookies(req).sid; if (t) { delete sessions[sha(t)]; saveSessions(); }
    return send(res, 200, 'ok', { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  const user = sessionUser(req);
  if (!user) return send(res, 401, 'Not signed in');

  if (url === '/api/me' && m === 'GET') return send(res, 200, publicUser(user));

  if (url === '/api/password' && m === 'POST') {
    const b = await readBody(req, 1e4);
    if (!checkPw(b.oldPassword || '', user)) return send(res, 400, 'Current password is wrong');
    if (String(b.newPassword || '').length < 6) return send(res, 400, 'New password must be at least 6 characters');
    if (b.newPassword === b.oldPassword) return send(res, 400, 'New password must be different from the current one');
    Object.assign(user, hashPw(b.newPassword)); user.mustChange = false; saveUsers();
    const cur = sha(parseCookies(req).sid);
    Object.keys(sessions).forEach(k => { if (sessions[k].uid === user.id && k !== cur) delete sessions[k]; });
    saveSessions();
    return send(res, 200, publicUser(user));
  }

  if (user.mustChange) return send(res, 403, 'Change your password first');

  // ----- workspace data (own workspace; admin may open a vendor's via X-Workspace) -----
  if (url === '/api/db') {
    let wid = user.id;
    const asked = req.headers['x-workspace'];
    if (asked && asked !== user.id) {
      if (user.role !== 'admin' || !okId(asked) || !users.some(u => u.id === asked)) return send(res, 403, 'Forbidden');
      wid = asked;
    }
    if (m === 'GET') {
      let ws = readJson('ws_' + wid + '.json', null);
      if (!ws) { ws = seedWorkspace(users.find(u => u.id === wid).name); writeJson('ws_' + wid + '.json', ws); }
      return send(res, 200, ws);
    }
    if (m === 'PUT') {
      const d = await readBody(req);
      if (!d.settings || !Array.isArray(d.invoices) || !Array.isArray(d.customers) || !Array.isArray(d.items)) return send(res, 400, 'bad shape');
      if (!validLogo(d.settings.logo)) return send(res, 400, 'Invalid logo');
      if (!/^#[0-9a-fA-F]{6}$/.test(d.settings.themeColor || '#3b82f6')) return send(res, 400, 'Invalid colour');
      writeJson('ws_' + wid + '.json', d);
      return send(res, 200, 'ok');
    }
  }

  // ----- admin only -----
  if (url.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return send(res, 403, 'Admins only');

    if (url === '/api/admin/users' && m === 'GET')
      return send(res, 200, users.map(u => ({ ...publicUser(u), createdAt: u.createdAt, ...wsStats(u.id) })));

    if (url === '/api/admin/users' && m === 'POST') {
      const b = await readBody(req, 1e4);
      const username = String(b.username || '').trim();
      const company = String(b.company || '').trim();
      if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) return send(res, 400, 'Username: 3-30 letters / numbers / . _ -');
      if (!company) return send(res, 400, 'Company name is required');
      if (String(b.password || '').length < 6) return send(res, 400, 'Password must be at least 6 characters');
      if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return send(res, 400, 'Username already taken');
      const u = { id: newId(), username, name: company, role: 'vendor', ...hashPw(b.password), active: true, mustChange: false, createdAt: new Date().toISOString() };
      users.push(u); saveUsers();
      writeJson('ws_' + u.id + '.json', seedWorkspace(company));
      return send(res, 200, publicUser(u));
    }

    const mm = url.match(/^\/api\/admin\/users\/([a-f0-9]+)$/);
    if (mm) {
      const u = users.find(x => x.id === mm[1]);
      if (!u) return send(res, 404, 'Not found');
      if (m === 'PATCH') {
        const b = await readBody(req, 1e4);
        if (typeof b.active === 'boolean') {
          if (u.id === user.id) return send(res, 400, 'You cannot disable yourself');
          u.active = b.active;
          if (!b.active) Object.keys(sessions).forEach(k => { if (sessions[k].uid === u.id) delete sessions[k]; });
        }
        if (b.password !== undefined) {
          if (String(b.password).length < 6) return send(res, 400, 'Password must be at least 6 characters');
          Object.assign(u, hashPw(b.password)); u.mustChange = u.role === 'admin' && u.id !== user.id;
          Object.keys(sessions).forEach(k => { if (sessions[k].uid === u.id) delete sessions[k]; });
        }
        saveUsers(); saveSessions();
        return send(res, 200, publicUser(u));
      }
      if (m === 'DELETE') {
        if (u.id === user.id) return send(res, 400, 'You cannot delete yourself');
        users = users.filter(x => x.id !== u.id); saveUsers();
        Object.keys(sessions).forEach(k => { if (sessions[k].uid === u.id) delete sessions[k]; }); saveSessions();
        const f = file('ws_' + u.id + '.json');
        if (fs.existsSync(f)) fs.renameSync(f, file('deleted_' + u.id + '_' + Date.now() + '.json')); // keep a copy, never hard-delete
        return send(res, 200, 'ok');
      }
    }

    if (url === '/api/admin/brand' && m === 'PUT') {
      const b = await readBody(req);
      if (!validLogo(b.logo)) return send(res, 400, 'Invalid logo');
      brand = { appName: String(b.appName || 'Billing').slice(0, 60), logo: b.logo || '' };
      writeJson('brand.json', brand);
      return send(res, 200, brand);
    }
  }
  return send(res, 404, 'Not found');
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) return await api(req, res, url);
  } catch (e) { return send(res, e.message === 'too large' ? 413 : 400, e.message || 'error'); }
  const f = path.join(PUB, url === '/' ? 'index.html' : decodeURIComponent(url));
  if (!f.startsWith(PUB)) return send(res, 403, 'Forbidden');
  fs.readFile(f, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Billing app running: http://localhost:${PORT}`));
