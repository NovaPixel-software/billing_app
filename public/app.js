'use strict';
let db = null;
const $app = document.getElementById('app');

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const today = () => new Date().toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = d => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${dd}-${MON[+m - 1]}-${y.slice(2)}`; };
const monthLabel = k => { const [y, m] = k.split('-'); return `${MON[+m - 1]} ${y}`; };
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

// Tax + discount maths. Old invoices (no per-line GST, no discounts, no tax type) work out exactly as before.
const pct = v => Math.min(100, Math.max(0, +v || 0));
const hasOwnGst = l => l.gst !== undefined && l.gst !== null && l.gst !== '';
const num = v => String(+(+v || 0).toFixed(2)); // 5 -> "5", 2.5 -> "2.5"
function lineCalc(inv, l) {
  const gross = (+l.count || 0) * (+l.cost || 0);
  const lineDisc = gross * pct(l.disc) / 100;
  const amount = gross - lineDisc; // shown in the Amount column
  const invDisc = amount * pct(inv.discount) / 100; // discount on the whole bill, spread over every line
  const taxable = amount - invDisc;
  const rate = hasOwnGst(l) ? Math.max(0, +l.gst || 0) : (+inv.gstRate || 0);
  return { gross, lineDisc, amount, invDisc, taxable, rate, tax: taxable * rate / 100 };
}
function calc(inv) {
  let gross = 0, lineDisc = 0, amount = 0, invDisc = 0, sub = 0, gst = 0; const by = {};
  inv.lines.forEach(l => {
    const c = lineCalc(inv, l);
    gross += c.gross; lineDisc += c.lineDisc; amount += c.amount; invDisc += c.invDisc; sub += c.taxable; gst += c.tax;
    const b = by[c.rate] || (by[c.rate] = { rate: c.rate, taxable: 0, tax: 0 }); b.taxable += c.taxable; b.tax += c.tax;
  });
  const inter = inv.taxType === 'inter', total = sub + gst;
  const all = Object.values(by).sort((a, b) => a.rate - b.rate), taxed = all.filter(b => b.rate > 0);
  return {
    gross, lineDisc, amount, invDisc, sub, gst, inter, igst: inter ? gst : 0, cgst: inter ? 0 : gst / 2, sgst: inter ? 0 : gst / 2,
    rates: taxed.length ? taxed : all.slice(0, 1), mixed: all.length > 1, total, rounded: Math.round(total),
  };
}
const UNITS = ['pcs', 'nos', 'kg', 'g', 'ltr', 'ml', 'box', 'pack', 'dozen', 'set', 'pair', 'mtr', 'sq.ft', 'hrs', 'days', 'month', 'job'];
const TAX_TYPES = [['intra', 'CGST + SGST', 'customer in the same state'], ['inter', 'IGST', 'customer in another state']];
// unit menu: the standard list, plus any unit this business already uses, plus "Other…" to type a new one
function pickUnit(anchor, cur, onPick) {
  const known = UNITS.concat(db.items.map(i => i.unit).filter(Boolean)).filter((u, i, a) => a.indexOf(u) === i);
  openMenu(anchor, [{ v: '', t: 'No unit' }, ...known.map(u => ({ v: u, t: u })), { v: '\u0000', t: 'Other…', s: 'type your own unit' }], cur || '', v => {
    if (v === '\u0000') { v = (prompt('Unit name (for example: roll, bag, sq.m)', '') || '').trim().slice(0, 12); if (!v) return; }
    onPick(v);
  }, { search: true });
}
const showUnit = (btn, v) => { const sp = btn.firstElementChild; sp.textContent = v || 'Select'; sp.className = v ? '' : 'muted'; };
const colOn = k => !db || !db.settings.cols || db.settings.cols[k] !== false; // optional invoice columns: hsn, unit, itemGst, disc
const stateOf = g => /^\d{2}/.test(String(g || '').trim()) ? String(g).trim().slice(0, 2) : ''; // first two digits of a GSTIN = state code
const ONE_PAGE_LINES = 25; // an invoice with up to this many lines always prints on a single A4 page
const isOverdue = inv => inv.status !== 'paid' && addDays(inv.date, +db.settings.dueDays || 10) < today();
const statusOf = inv => inv.status === 'paid' ? 'paid' : isOverdue(inv) ? 'overdue' : 'unpaid';

const lineDates = () => !db || db.settings.lineDates !== false;

// ---------- router ----------
function route() {
  if (!me || !db) return; // not signed in yet: the login screen is showing
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, arg] = h.split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + (page === 'menu' ? 'items' : page)));
  const views = { dashboard, invoices, new: () => editor(), edit: () => editor(arg), view: () => viewInvoice(arg), customers, items, menu: itemMenu, settings, vendors };
  (views[page] || dashboard)();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- dashboard ----------
const dash = { range: null, tab: 'monthly', mode: 'amt' };
const pad2 = n => String(n).padStart(2, '0');
const isoD = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthKeyOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
function compact(n) {
  n = Math.round(n);
  const f = (v, s) => v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2).replace(/\.?0+$/, '') + s;
  if (n >= 1e7) return f(n / 1e7, ' Cr');
  if (n >= 1e5) return f(n / 1e5, ' L');
  if (n >= 1e3) return f(n / 1e3, 'k');
  return String(n);
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function dashRange(r) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const y = t.getFullYear(), m = t.getMonth();
  const first = (yy, mm) => new Date(yy, mm, 1), last = (yy, mm) => new Date(yy, mm + 1, 0);
  const mk = (a, b, label, pa, pb, plabel) => ({ from: isoD(a), to: isoD(b), label, pfrom: pa && isoD(pa), pto: pb && isoD(pb), plabel });
  if (r === 'all') return { from: '0000-00-00', to: '9999-99-99', label: 'All time' };
  if (r === 'month') return mk(first(y, m), last(y, m), 'This month', first(y, m - 1), last(y, m - 1), 'last month');
  if (r === 'last') return mk(first(y, m - 1), last(y, m - 1), 'Last month', first(y, m - 2), last(y, m - 2), 'the month before');
  if (r === 'q3') return mk(first(y, m - 2), last(y, m), 'Last 3 months', first(y, m - 5), last(y, m - 3), 'the 3 months before');
  if (r === 'fy') { const fy = m >= 3 ? y : y - 1; return mk(new Date(fy, 3, 1), new Date(fy + 1, 2, 31), `FY ${fy}-${String(fy + 1).slice(2)}`, new Date(fy - 1, 3, 1), new Date(fy, 2, 31), 'last FY'); }
  const [yy, mm] = r.split('-').map(Number);
  return mk(first(yy, mm - 1), last(yy, mm - 1), monthLabel(r), first(yy, mm - 2), last(yy, mm - 2), monthLabel(monthKeyOf(first(yy, mm - 2))));
}

function dashboard() {
  const invs = db.invoices;
  const sum = (a, f) => a.reduce((s, i) => s + f(i), 0);
  const tot = i => calc(i).rounded;
  const months = [...new Set(invs.map(i => i.date.slice(0, 7)))].sort().reverse();
  if (dash.range === null) dash.range = months.includes(monthKeyOf(new Date())) ? 'month' : 'all';
  const R = dashRange(dash.range);
  const within = (d, a, b) => d >= a && d <= b;
  const cur = invs.filter(i => within(i.date, R.from, R.to));
  const prev = R.pfrom ? invs.filter(i => within(i.date, R.pfrom, R.pto)) : null;
  const todayIso = isoD(new Date());

  // ---- KPIs ----
  const billed = sum(cur, tot), gst = sum(cur, i => calc(i).gst);
  const prevBilled = prev ? sum(prev, tot) : null, prevGst = prev ? sum(prev, i => calc(i).gst) : null;
  const paidIn = (a, b) => invs.filter(i => i.status === 'paid' && within(i.paidDate || i.date, a, b));
  const recvList = paidIn(R.from, R.to), received = sum(recvList, tot);
  const prevRecv = prev ? sum(paidIn(R.pfrom, R.pto), tot) : null;
  const unpaidAll = invs.filter(i => i.status !== 'paid');
  const outstanding = sum(unpaidAll, tot);
  const overdueList = unpaidAll.filter(isOverdue), overdueAmt = sum(overdueList, tot);
  const delta = (a, b, invert) => {
    if (b === null || b === undefined) return '<span class="muted">&nbsp;</span>';
    if (b === 0) return a > 0 ? '<span class="delta up">▲ new</span>' : '<span class="muted">no change</span>';
    const p = (a - b) / b * 100, good = invert ? p <= 0 : p >= 0;
    return `<span class="delta ${good ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}%</span> <span class="muted">vs ${esc(R.plabel)}</span>`;
  };

  // ---- trend chart (stacked: received vs pending) ----
  const small = window.innerWidth < 640;
  const firstD = invs.length ? invs.reduce((m, i) => i.date < m ? i.date : m, invs[0].date) : todayIso;
  const spanM = (new Date().getFullYear() - +firstD.slice(0, 4)) * 12 + new Date().getMonth() - (+firstD.slice(5, 7) - 1) + 1;
  const nM = small ? 6 : Math.min(12, Math.max(6, spanM));
  const endD = (dash.range === 'all' || R.to >= todayIso) ? new Date() : new Date(+R.to.slice(0, 4), +R.to.slice(5, 7) - 1, 1);
  const keys = [];
  for (let k = nM - 1; k >= 0; k--) keys.push(monthKeyOf(new Date(endD.getFullYear(), endD.getMonth() - k, 1)));
  const byM = Object.fromEntries(keys.map(k => [k, { paid: 0, unpaid: 0, n: 0 }]));
  invs.forEach(i => { const k = i.date.slice(0, 7); if (byM[k]) { byM[k][i.status === 'paid' ? 'paid' : 'unpaid'] += tot(i); byM[k].n++; } });
  const W = small ? 360 : 720, H = small ? 230 : 250, L = small ? 40 : 46, B = 28, T = 20, RR = 6;
  const maxV = Math.max(1, ...keys.map(k => byM[k].paid + byM[k].unpaid));
  const step = niceStep(maxV / 4), top = step * Math.ceil(maxV / step);
  const bw = (W - L - RR) / keys.length, yy = v => T + (H - T - B) * (1 - v / top);
  const selected = k => k + '-31' >= R.from && k + '-01' <= R.to;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales per month">`;
  for (let v = 0; v <= top + 1; v += step) svg += `<line x1="${L}" x2="${W - RR}" y1="${yy(v)}" y2="${yy(v)}" class="gl"/><text x="${L - 6}" y="${yy(v) + 4}" text-anchor="end" class="ax">${compact(v)}</text>`;
  keys.forEach((k, i) => {
    const d = byM[k], x = L + i * bw + bw * 0.16, w = bw * 0.68, op = selected(k) ? 1 : 0.55, t = d.paid + d.unpaid;
    svg += `<g opacity="${op}"><title>${monthLabel(k)}: billed ₹${money0(t)} (received ₹${money0(d.paid)}, pending ₹${money0(d.unpaid)}) · ${d.n} invoice(s)</title>`;
    if (d.paid) svg += `<rect x="${x}" y="${yy(d.paid)}" width="${w}" height="${yy(0) - yy(d.paid)}" class="b-paid"/>`;
    if (d.unpaid) svg += `<rect x="${x}" y="${yy(t)}" width="${w}" height="${yy(d.paid) - yy(t)}" class="b-unpaid"/>`;
    if (!t) svg += `<rect x="${x}" y="${yy(0) - 2}" width="${w}" height="2" class="b-empty"/>`;
    else svg += `<text x="${x + w / 2}" y="${yy(t) - 5}" text-anchor="middle" class="vl">${compact(t)}</text>`;
    svg += `<text x="${x + w / 2}" y="${H - 9}" text-anchor="middle" class="ax">${MON[+k.slice(5) - 1]}</text></g>`;
  });
  svg += '</svg>';

  // ---- collection status donut ----
  const sp = { paid: 0, unpaid: 0, overdue: 0 }, sn = { paid: 0, unpaid: 0, overdue: 0 };
  cur.forEach(i => { const s = statusOf(i); sp[s] += tot(i); sn[s]++; });
  const spTot = sp.paid + sp.unpaid + sp.overdue;
  let acc = 0;
  const seg = (v, c) => { const a = acc / spTot * 100, b = (acc + v) / spTot * 100; acc += v; return `${c} ${a}% ${b}%`; };
  const donut = spTot ? `conic-gradient(${seg(sp.paid, 'var(--green)')},${seg(sp.unpaid, '#e8b923')},${seg(sp.overdue, 'var(--red)')})` : 'var(--line)';
  const legend = (c, label, k) => `<div class="lg"><i style="background:${c}"></i><span>${label} <span class="muted">(${sn[k]})</span></span><b>₹${money0(sp[k])}</b></div>`;

  // ---- ranked lists ----
  const itemMap = {}, custMap = {};
  cur.forEach(i => {
    custMap[i.billTo.name] = (custMap[i.billTo.name] || 0) + tot(i);
    i.lines.forEach(l => { const s = itemMap[l.item] || (itemMap[l.item] = { qty: 0, amt: 0 }); s.qty += +l.count || 0; s.amt += (+l.count || 0) * (+l.cost || 0); });
  });
  const itemRows = Object.entries(itemMap).sort((a, b) => b[1].amt - a[1].amt), itemTotal = sum(itemRows, r => r[1].amt) || 1;
  const custRows = Object.entries(custMap).sort((a, b) => b[1] - a[1]), custTotal = sum(custRows, r => r[1]) || 1;
  const rk = (rows, max, sub, val) => rows.length ? rows.map(([n, v], i) =>
    `<div class="rk"><div class="top"><span class="nm" title="${esc(n)}"><em>${i + 1}</em>${esc(n)}</span><b>₹${money0(val(v))}</b></div><div class="tr"><i style="width:${val(v) / max * 100}%"></i></div><div class="sub">${sub(v)}</div></div>`).join('') : '<p class="muted">No sales in this period</p>';

  // ---- needs attention + recent ----
  const dueOf = i => addDays(i.date, +db.settings.dueDays || 10);
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
  const attn = unpaidAll.slice().sort((a, b) => dueOf(a).localeCompare(dueOf(b))).slice(0, 6);
  const attnHtml = attn.length ? attn.map(i => {
    const dd = daysBetween(todayIso, dueOf(i));
    const when = dd < 0 ? `<span class="red">${-dd} day${dd === -1 ? '' : 's'} overdue</span>` : dd === 0 ? '<span class="amber">due today</span>' : `<span class="muted">due in ${dd} day${dd === 1 ? '' : 's'}</span>`;
    return `<div class="li"><a href="#/view/${i.id}" class="who"><b>${esc(i.no)}</b> · ${esc(i.billTo.name)}<small>${when}</small></a><b class="amt">₹${money0(tot(i))}</b><button class="btn sm" data-paid="${i.id}">Mark paid</button></div>`;
  }).join('') + (unpaidAll.length > 6 ? `<a class="more" href="#/invoices">View all ${unpaidAll.length} unpaid →</a>` : '') : '<p class="muted" style="margin:6px 0 0">🎉 Nothing pending. All invoices are paid.</p>';
  const recent = invs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.no.localeCompare(a.no)).slice(0, 6);
  const recentHtml = recent.length ? recent.map(i => `<a class="li" href="#/view/${i.id}"><span class="who"><b>${esc(i.no)}</b> · ${esc(i.billTo.name)}<small class="muted">${fmtDate(i.date)}</small></span><b class="amt">₹${money0(tot(i))}</b><span class="badge ${statusOf(i)}">${statusOf(i)}</span></a>`).join('') + '<a class="more" href="#/invoices">All invoices →</a>' : '<p class="muted">No invoices yet</p>';

  // ---- reports (tabs) ----
  let report = '';
  if (dash.tab === 'monthly') {
    const mrows = [...months].reverse().map(k => {
      const a = invs.filter(i => i.date.startsWith(k)); let q = 0; a.forEach(i => i.lines.forEach(l => q += +l.count || 0));
      return { k, n: a.length, q, sub: sum(a, i => calc(i).sub), gst: sum(a, i => calc(i).gst), total: sum(a, tot), paid: sum(a.filter(i => i.status === 'paid'), tot) };
    });
    const T2 = mrows.reduce((x, m) => ({ n: x.n + m.n, q: x.q + m.q, sub: x.sub + m.sub, gst: x.gst + m.gst, total: x.total + m.total, paid: x.paid + m.paid }), { n: 0, q: 0, sub: 0, gst: 0, total: 0, paid: 0 });
    report = mrows.length ? `<div class="scroll"><table class="mon"><thead><tr><th>Month</th><th class="n">Invoices</th><th class="n">Qty</th><th class="n">Sales (before GST)</th><th class="n">GST</th><th class="n">Total billed</th><th class="n">Received</th><th class="n">Pending</th></tr></thead><tbody>
      ${mrows.slice().reverse().map(m => `<tr><td><b>${monthLabel(m.k)}</b></td><td class="n">${m.n}</td><td class="n">${money0(m.q)}</td><td class="n">₹${money(m.sub)}</td><td class="n">₹${money(m.gst)}</td><td class="n"><b>₹${money0(m.total)}</b></td><td class="n" style="color:var(--green)">₹${money0(m.paid)}</td><td class="n">₹${money0(m.total - m.paid)}</td></tr>`).join('')}
      <tr class="tf"><td>Total</td><td class="n">${T2.n}</td><td class="n">${money0(T2.q)}</td><td class="n">₹${money(T2.sub)}</td><td class="n">₹${money(T2.gst)}</td><td class="n">₹${money0(T2.total)}</td><td class="n">₹${money0(T2.paid)}</td><td class="n">₹${money0(T2.total - T2.paid)}</td></tr></tbody></table></div>` : '<p class="muted">No invoices yet</p>';
  } else if (dash.tab === 'items') {
    report = itemRows.length ? `<p class="muted" style="margin:0 0 8px">${esc(R.label)}</p><div class="scroll"><table class="itw"><thead><tr><th>#</th><th>Item</th><th class="n">Qty sold</th><th class="n">Avg rate</th><th class="n">Sales (before GST)</th><th style="width:26%">Share</th></tr></thead><tbody>
      ${itemRows.map(([n, v], i) => `<tr><td class="muted">${i + 1}</td><td>${esc(n)}</td><td class="n">${money0(v.qty)}</td><td class="n">₹${money(v.amt / (v.qty || 1))}</td><td class="n"><b>₹${money0(v.amt)}</b></td><td><div class="hb" style="margin:0"><span class="tr"><i style="width:${v.amt / itemRows[0][1].amt * 100}%"></i></span><span class="am" style="width:46px">${(v.amt / itemTotal * 100).toFixed(1)}%</span></div></td></tr>`).join('')}
      <tr class="tf"><td></td><td>Total</td><td class="n">${money0(sum(itemRows, r => r[1].qty))}</td><td></td><td class="n">₹${money0(itemTotal)}</td><td></td></tr></tbody></table></div>` : '<p class="muted">No sales in this period</p>';
  } else {
    const allM = [...months].reverse(), matrix = {};
    invs.forEach(i => i.lines.forEach(l => { const m = i.date.slice(0, 7), r = matrix[l.item] || (matrix[l.item] = {}); r[m] = (r[m] || 0) + (dash.mode === 'qty' ? (+l.count || 0) : (+l.count || 0) * (+l.cost || 0)); }));
    const mr = Object.entries(matrix).map(([n, r]) => [n, r, Object.values(r).reduce((a, b) => a + b, 0)]).sort((a, b) => b[2] - a[2]);
    report = mr.length ? `<div class="seg" style="margin:0 0 10px"><button class="${dash.mode === 'qty' ? '' : 'on'}" data-mode="amt">Sales ₹</button><button class="${dash.mode === 'qty' ? 'on' : ''}" data-mode="qty">Quantity</button></div><div class="scroll"><table><thead><tr><th>Item</th>${allM.map(k => `<th class="n">${monthLabel(k)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>
      ${mr.map(([n, r, t]) => `<tr><td>${esc(n)}</td>${allM.map(k => `<td class="n">${r[k] ? money0(r[k]) : '<span class="muted">–</span>'}</td>`).join('')}<td class="n"><b>${money0(t)}</b></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No data</p>';
  }

  // ---- render ----
  const chips = [['month', 'This month'], ['last', 'Last month'], ['q3', '3 months'], ['fy', 'This FY'], ['all', 'All time']];
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  $app.innerHTML = `
  <div class="dash-head"><div><h1 style="margin:0">${greet} 👋</h1><div class="muted">${esc(db.settings.name)} · showing <b>${esc(R.label)}</b></div></div>
    <button class="sel period" id="period" type="button"><span><i class="cal"></i>${esc((chips.find(c => c[0] === dash.range) || [0, monthLabel(dash.range)])[1])}</span></button></div>
  <div class="grid kpis">
    <div class="card kpi"><div class="l">Total sales</div><div class="v">₹${money0(billed)}</div><div class="d">${delta(billed, prevBilled)}</div><div class="s">${cur.length} invoice${cur.length === 1 ? '' : 's'} · incl. GST ₹${money0(gst)}</div></div>
    <div class="card kpi"><div class="l">Received</div><div class="v" style="color:var(--green)">₹${money0(received)}</div><div class="d">${delta(received, prevRecv)}</div><div class="s">${recvList.length} payment${recvList.length === 1 ? '' : 's'} in this period</div></div>
    <div class="card kpi ${overdueList.length ? 'warn' : ''}"><div class="l">Outstanding (all time)</div><div class="v" style="color:${overdueList.length ? 'var(--red)' : 'inherit'}">₹${money0(outstanding)}</div><div class="d">${overdueList.length ? `<span class="delta down">${overdueList.length} overdue · ₹${money0(overdueAmt)}</span>` : '<span class="delta up">Nothing overdue</span>'}</div><div class="s">${unpaidAll.length} unpaid invoice${unpaidAll.length === 1 ? '' : 's'}</div></div>
  </div>
  <div class="g-chart">
    <div class="card"><div class="hd2"><h2>Sales trend</h2><div class="key"><span><i class="k-paid"></i>Received</span><span><i class="k-unpaid"></i>Pending</span></div></div><div class="trend">${svg}</div></div>
    <div class="card"><h2>Collection status</h2><p class="muted" style="margin:-6px 0 12px;font-size:12px">Invoices in ${esc(R.label.toLowerCase())}</p>
      <div class="donut" style="background:${donut}"><b>${spTot ? Math.round(sp.paid / spTot * 100) : 0}%<small>collected</small></b></div>
      <div class="legend">${legend('var(--green)', 'Paid', 'paid')}${legend('#e8b923', 'Unpaid', 'unpaid')}${legend('var(--red)', 'Overdue', 'overdue')}</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>Top items</h2>${rk(itemRows.slice(0, 6), itemRows[0] ? itemRows[0][1].amt : 1, v => `${money0(v.qty)} sold · ${(v.amt / itemTotal * 100).toFixed(1)}% of sales`, v => v.amt)}${itemRows.length > 6 ? '<button class="more link" data-tab="items">See all items →</button>' : ''}</div>
    <div class="card"><h2>Top customers</h2>${rk(custRows.slice(0, 6), custRows[0] ? custRows[0][1] : 1, v => `${(v / custTotal * 100).toFixed(1)}% of billed`, v => v)}</div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>⏰ Needs attention</h2>${attnHtml}</div>
    <div class="card"><h2>Recent invoices</h2>${recentHtml}</div>
  </div>
  <div class="card"><div class="tabs" role="tablist">${[['monthly', 'Monthly sales'], ['items', 'Item-wise sales'], ['matrix', 'Item × Month']].map(([k, l]) => `<button class="tab ${dash.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>${report}</div>`;

  // ---- events ----
  document.getElementById('period').onclick = e => openMenu(e.currentTarget, [...chips.map(([v, t]) => ({ v, t })), ...(months.length ? [{ head: 'Pick a month' }, ...months.map(m => ({ v: m, t: monthLabel(m) }))] : [])], dash.range, v => { dash.range = v; dashboard(); }, { right: true });
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { dash.tab = b.dataset.tab; dashboard(); });
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { dash.mode = b.dataset.mode; dashboard(); });
  document.querySelectorAll('[data-paid]').forEach(b => b.onclick = async () => {
    const inv = db.invoices.find(i => i.id === b.dataset.paid); inv.status = 'paid'; inv.paidDate = todayIso; b.disabled = true; await save(); dashboard();
  });
  if (!invs.length) $app.insertAdjacentHTML('afterbegin', `<div class="card" style="border-left:6px solid var(--brand-d)"><h2>Welcome 👋</h2><p style="margin:0 0 10px">Get started in 3 steps:</p><ol style="margin:0 0 12px;padding-left:20px"><li>Fill your company details, logo and bank info in <a href="#/settings"><b>Settings</b></a></li><li>Add what you sell in <a href="#/items"><b>Items</b></a></li><li>Create your first bill with <a href="#/new"><b>+ New invoice</b></a></li></ol></div>`);
}

// ---------- generic dropdown menu ----------
let _menu = null;
function closeMenu() {
  if (!_menu) return; const m = _menu; _menu = null; m.el.remove(); m.anchor.classList.remove('open');
  document.removeEventListener('mousedown', m.out, true); document.removeEventListener('keydown', m.key, true);
  removeEventListener('resize', m.pos); removeEventListener('scroll', m.scr, true);
}
function openMenu(anchor, items, cur, onPick, opts = {}) {
  const again = _menu && _menu.anchor === anchor; closeMenu(); if (again) return;
  const el = document.createElement('div'); el.className = 'ddp menu';
  el.innerHTML = (opts.search ? '<input class="ddq" placeholder="Search" autocomplete="off">' : '') + '<div class="ddl"></div>';
  document.body.appendChild(el); anchor.classList.add('open');
  const list = el.querySelector('.ddl'), q = el.querySelector('.ddq');
  let shown = [], idx = -1;
  const render = () => {
    const t = q ? q.value.trim().toLowerCase() : '';
    shown = items.filter(i => i.head ? !t : !t || (i.t + ' ' + (i.s || '')).toLowerCase().includes(t));
    idx = shown.findIndex(i => i.v === cur && !i.head);
    list.innerHTML = shown.map((i, k) => i.head ? `<div class="ddh">${esc(i.head)}</div>` : `<div class="ddi${i.v === cur ? ' cur' : ''}${k === idx ? ' on' : ''}" data-k="${k}"><div><b>${esc(i.t)}</b>${i.s ? `<small>${esc(i.s)}</small>` : ''}</div>${i.v === cur ? '<span>✓</span>' : ''}</div>`).join('') || '<div class="ddn">Nothing found</div>';
    const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const pos = () => {
    const r = anchor.getBoundingClientRect(), w = Math.max(r.width, 240), left = Math.min(Math.max(8, opts.right ? r.right - w : r.left), innerWidth - w - 8);
    const below = innerHeight - r.bottom, up = below < 260 && r.top > below;
    el.style.left = left + 'px'; el.style.width = w + 'px'; el.style.maxHeight = Math.max(160, Math.min(380, (up ? r.top : below) - 14)) + 'px';
    if (up) { el.style.top = 'auto'; el.style.bottom = (innerHeight - r.top + 4) + 'px'; } else { el.style.bottom = 'auto'; el.style.top = (r.bottom + 4) + 'px'; }
  };
  const move = d => {
    const ks = shown.map((i, k) => i.head ? -1 : k).filter(k => k >= 0); if (!ks.length) return;
    const p = ks.indexOf(idx); idx = ks[(p + d + ks.length) % ks.length];
    list.querySelectorAll('.ddi').forEach(n => n.classList.toggle('on', +n.dataset.k === idx));
    const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const pick = k => { const it = shown[k]; if (!it || it.head) return; closeMenu(); onPick(it.v); };
  const m = _menu = {
    el, anchor, pos,
    out: e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); },
    key: e => {
      if (e.key === 'Escape') { closeMenu(); anchor.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); pick(idx); }
    },
    scr: e => { if (!el.contains(e.target)) pos(); },
  };
  list.onmousedown = e => { e.preventDefault(); const n = e.target.closest('.ddi'); if (n) pick(+n.dataset.k); };
  if (q) q.oninput = render;
  document.addEventListener('mousedown', m.out, true); document.addEventListener('keydown', m.key, true);
  addEventListener('resize', pos); addEventListener('scroll', m.scr, true);
  render(); pos(); if (q && !matchMedia('(pointer:coarse)').matches) q.focus();
}
addEventListener('hashchange', closeMenu);

// ---------- invoice list ----------
function invoices() {
  let q = '', st = 'all';
  const draw = () => {
    const rows = db.invoices.filter(i => (st === 'all' || statusOf(i) === st) &&
      (i.no + i.billTo.name).toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.date.localeCompare(a.date) || b.no.localeCompare(a.no));
    document.getElementById('rows').innerHTML = rows.map(i => `<tr class="click" onclick="location.hash='#/view/${i.id}'"><td>${esc(i.no)}<small class="dt">${fmtDate(i.date)}</small></td><td style="white-space:nowrap">${fmtDate(i.date)}</td><td>${esc(i.billTo.name)}</td><td class="n">₹${money0(calc(i).rounded)}</td><td><span class="badge ${statusOf(i)}">${statusOf(i)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No invoices</td></tr>';
  };
  $app.innerHTML = `<h1>Invoices</h1><div class="toolbar"><input id="q" placeholder="Search invoice no. or customer">
    <div class="seg" id="st">${[['all', 'All'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid']].map(([k, l]) => `<button class="${k === 'all' ? 'on' : ''}" data-st="${k}">${l}<em>${k === 'all' ? db.invoices.length : db.invoices.filter(i => statusOf(i) === k).length}</em></button>`).join('')}</div></div>
    <div class="card"><table class="inv"><tr><th>Invoice</th><th>Date</th><th>Customer</th><th class="n">Total</th><th>Status</th></tr><tbody id="rows"></tbody></table></div>`;
  document.getElementById('q').oninput = e => { q = e.target.value; draw(); };
  document.querySelectorAll('#st [data-st]').forEach(b => b.onclick = () => { st = b.dataset.st; document.querySelectorAll('#st button').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  draw();
}

// ---------- invoice editor ----------
function editor(id) {
  const existing = id && db.invoices.find(i => i.id === id);
  const s = db.settings;
  const blank = { name: '', address: '', gst: '' };
  const newLine = d => ({ date: d || today(), item: '', hsn: '', count: 1, unit: '', cost: 0, disc: '', gst: '' });
  const inv = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: uid('inv'), no: s.prefix + s.nextNo, date: today(), customerId: '', billTo: { ...blank }, shipTo: { ...blank },
    lines: [newLine()], gstRate: s.gstRate, taxType: 'intra', discount: 0, status: 'unpaid', paidDate: '',
  };
  if (!inv.taxType) inv.taxType = 'intra';
  let sameShip = JSON.stringify(inv.billTo) === JSON.stringify(inv.shipTo);
  // a column shows when it is switched on in Settings, or when this invoice already uses it
  const LD = lineDates();
  const H = colOn('hsn') || inv.lines.some(l => l.hsn), U = colOn('unit') || inv.lines.some(l => l.unit);
  const G = colOn('itemGst') || inv.lines.some(hasOwnGst), D = colOn('disc') || inv.lines.some(l => +l.disc) || +inv.discount > 0;
  // other state than ours -> IGST, same state -> CGST + SGST (only when both GST numbers are known)
  const autoTax = () => { const a = stateOf(s.gst), b = stateOf(inv.billTo.gst); if (a && b) inv.taxType = a === b ? 'intra' : 'inter'; };
  const showTax = () => { const b = document.getElementById('taxType'); if (b) { b.dataset.v = inv.taxType; b.firstElementChild.textContent = (TAX_TYPES.find(t => t[0] === inv.taxType) || TAX_TYPES[0])[1]; } };
  const applyItem = (l, it) => { l.cost = it.rate; l.hsn = it.hsn || ''; l.unit = it.unit || ''; l.gst = hasOwnGst(it) ? it.gst : ''; };
  const fillRow = (tr, l) => { ['cost', 'hsn', 'gst'].forEach(f => { const e = tr.querySelector(`[data-l$=".${f}"]`); if (e) e.value = l[f] ?? ''; }); const ub = tr.querySelector('[data-lu]'); if (ub) showUnit(ub, l.unit); };

  const party = (k, title) => `<div class="card" style="flex:1;min-width:260px"><h2>${title}</h2>
    <div class="field"><label>Name</label><input data-p="${k}.name" value="${esc(inv[k].name)}" placeholder="Enter name"></div>
    <div class="field"><label>Address</label><textarea data-p="${k}.address" placeholder="Enter address">${esc(inv[k].address)}</textarea></div>
    <div class="field"><label>GST No.</label><input data-p="${k}.gst" value="${esc(inv[k].gst)}" placeholder="Enter GST No. (optional)"></div></div>`;

  const draw = () => {
    $app.innerHTML = `<h1>${existing ? 'Edit invoice ' + esc(inv.no) : 'New invoice'}</h1>
    <div class="card"><div class="row">
      <div class="field"><label>Invoice No.</label><input id="no" value="${esc(inv.no)}" placeholder="Enter invoice no."></div>
      <div class="field"><label>Date</label><input id="date" type="date" value="${inv.date}"></div>
      <div class="field"><label>Customer (autofill)</label><button class="sel" id="cust" type="button"><span>${esc((db.customers.find(c => c.id === inv.customerId) || {}).name || 'Select customer')}</span></button></div>
      <div class="field"><label>GST % (${G ? 'default for items' : 'total'})</label><input id="gstRate" type="number" step="0.01" min="0" value="${inv.gstRate}" placeholder="0"></div>
      <div class="field"><label>Tax type</label><button type="button" class="sel" id="taxType"><span></span></button></div></div></div>
    <div class="row" style="align-items:stretch">${party('billTo', 'Bill To')}${sameShip ? '' : party('shipTo', 'Ship To')}</div>
    <label style="margin-bottom:12px"><input type="checkbox" id="same" ${sameShip ? 'checked' : ''} style="width:auto"> Ship To same as Bill To</label>
    <div class="card">
      <table class="stack lines2"><thead><tr>${LD ? '<th style="width:132px">Date</th>' : ''}<th>Item</th>${H ? '<th style="width:98px">HSN/SAC</th>' : ''}<th class="n" style="width:70px">Qty</th>${U ? '<th style="width:88px">Unit</th>' : ''}<th class="n" style="width:92px">Rate (₹)</th>${D ? '<th class="n" style="width:70px">Disc %</th>' : ''}${G ? '<th class="n" style="width:92px">GST %</th>' : ''}<th class="n" style="width:100px">Amount</th><th style="width:40px"></th></tr></thead><tbody>
      ${inv.lines.map((l, i) => `<tr>${LD ? `<td data-k="Date"><input type="date" data-l="${i}.date" value="${l.date || ''}"></td>` : ''}
        <td data-k="Item" class="c-item"><input class="itemin" autocomplete="off" placeholder="Select or enter item" data-l="${i}.item" value="${esc(l.item)}"></td>
        ${H ? `<td data-k="HSN/SAC"><input data-l="${i}.hsn" value="${esc(l.hsn || '')}" placeholder="Optional"></td>` : ''}
        <td data-k="Qty"><input type="number" class="n" step="any" data-l="${i}.count" value="${l.count}" placeholder="0"></td>
        ${U ? `<td data-k="Unit"><button type="button" class="sel" data-lu="${i}"><span${l.unit ? '' : ' class="muted"'}>${esc(l.unit || 'Select')}</span></button></td>` : ''}
        <td data-k="Rate (₹)"><input type="number" class="n" step="0.01" data-l="${i}.cost" value="${l.cost}" placeholder="0"></td>
        ${D ? `<td data-k="Disc %"><input type="number" class="n" step="0.01" min="0" max="100" data-l="${i}.disc" value="${+l.disc || ''}" placeholder="0"></td>` : ''}
        ${G ? `<td data-k="GST %"><input type="number" class="n" step="0.01" min="0" data-l="${i}.gst" value="${hasOwnGst(l) ? l.gst : ''}" placeholder="Optional"></td>` : ''}
        <td data-k="Amount" class="n c-amt" id="lt${i}">${money(lineCalc(inv, l).amount)}</td>
        <td class="c-del"><button class="btn sm danger" data-del="${i}" title="Remove this line">✕</button></td></tr>`).join('')}</tbody></table>
      <div class="row" style="align-items:flex-end;margin:10px 0">
        <div style="flex:1"><button class="btn" id="add">+ Add line</button><span class="muted" id="lncount" style="font-size:12.5px;margin-left:10px"></span></div>
        ${D ? `<div class="field" style="flex:0 0 210px;margin:0"><label>Discount on whole bill (%)</label><input id="disc" type="number" class="n" step="0.01" min="0" max="100" value="${+inv.discount || ''}" placeholder="0"></div>` : ''}</div>
      <div class="totals" id="totals"></div></div>
    <div class="actions"><button class="btn primary" id="save">Save invoice</button><a class="btn" href="#/invoices">Cancel</a></div>`;
    bind(); totals();
  };
  const totals = () => {
    const c = calc(inv), row = (a, b, cls) => `<div${cls ? ` class="${cls}"` : ''}><span>${a}</span><span>${b}</span></div>`;
    const less = c.lineDisc || c.invDisc;
    let h = '';
    if (less) h += row('Gross amount', '₹' + money(c.gross));
    if (c.lineDisc) h += row('Item discounts', '− ₹' + money(c.lineDisc));
    if (c.invDisc) h += row(`Discount @ ${num(inv.discount)}%`, '− ₹' + money(c.invDisc));
    h += row(less ? 'Taxable value' : 'Sub-total', '₹' + money(c.sub));
    c.rates.forEach(b => {
      if (c.inter) h += row(`IGST @ ${num(b.rate)}%`, '₹' + money(b.tax));
      else h += row(`CGST @ ${num(b.rate / 2)}%`, '₹' + money(b.tax / 2)) + row(`SGST @ ${num(b.rate / 2)}%`, '₹' + money(b.tax / 2));
    });
    h += row('Total inc GST', '₹' + money(c.total)) + row('Invoice total', '₹' + money0(c.rounded), 'big');
    document.getElementById('totals').innerHTML = h;
    inv.lines.forEach((l, i) => { const e = document.getElementById('lt' + i); if (e) e.textContent = money(lineCalc(inv, l).amount); });
    const n = inv.lines.length, lc = document.getElementById('lncount');
    if (lc) lc.textContent = n <= ONE_PAGE_LINES ? `${n} of ${ONE_PAGE_LINES} lines · prints on one page` : `${n} lines · more than ${ONE_PAGE_LINES}, so it prints on more than one page`;
  };
  const bind = () => {
    const $ = s => document.getElementById(s);
    $('no').oninput = e => inv.no = e.target.value;
    $('date').oninput = e => inv.date = e.target.value;
    $('gstRate').oninput = e => { inv.gstRate = +e.target.value; totals(); };
    showTax();
    $('taxType').onclick = e => openMenu(e.currentTarget, TAX_TYPES.map(([v, t, d]) => ({ v, t, s: d })), inv.taxType, v => { inv.taxType = v; showTax(); totals(); });
    document.querySelectorAll('[data-lu]').forEach(b => b.onclick = () => pickUnit(b, inv.lines[+b.dataset.lu].unit, v => { inv.lines[+b.dataset.lu].unit = v; showUnit(b, v); }));
    if ($('disc')) $('disc').oninput = e => { inv.discount = e.target.value; totals(); };
    $('cust').onclick = e => openMenu(e.currentTarget, db.customers.map(c => ({ v: c.id, t: c.name, s: (c.address || '').split('\n')[0] })), inv.customerId, v => {
      const c = db.customers.find(x => x.id === v); inv.customerId = v;
      if (c) { inv.billTo = { name: c.name, address: c.address, gst: c.gst }; inv.shipTo = { ...inv.billTo, address: c.shipAddress || c.address }; sameShip = !c.shipAddress || c.shipAddress === c.address; autoTax(); draw(); }
    }, { search: db.customers.length > 6 });
    $('same').onchange = e => { sameShip = e.target.checked; if (sameShip) inv.shipTo = { ...inv.billTo }; draw(); };
    document.querySelectorAll('[data-p]').forEach(el => el.oninput = () => {
      const [k, f] = el.dataset.p.split('.'); inv[k][f] = el.value; if (sameShip && k === 'billTo') inv.shipTo[f] = el.value;
      if (k === 'billTo' && f === 'gst') { autoTax(); showTax(); totals(); }
    });
    document.querySelectorAll('[data-l]').forEach(el => el.oninput = () => {
      const [i, f] = el.dataset.l.split('.'); const l = inv.lines[+i]; l[f] = el.value;
      if (f === 'item') { const it = db.items.find(x => x.name === el.value); if (it) { applyItem(l, it); fillRow(el.closest('tr'), l); } }
      totals();
    });
    // custom item dropdown (searchable, shows details + rate)
    document.querySelectorAll('.ddp').forEach(n => n.remove());
    const dd = document.createElement('div'); dd.className = 'ddp'; dd.hidden = true; document.body.appendChild(dd);
    let ddInp = null, ddIdx = -1, ddList = [];
    const ddClose = () => { dd.hidden = true; ddInp = null; };
    const ddPlace = () => {
      if (!ddInp) return; const r = ddInp.getBoundingClientRect();
      const w = Math.max(r.width, 280), left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      const below = innerHeight - r.bottom, up = below < 220 && r.top > below;
      dd.style.left = left + 'px'; dd.style.width = w + 'px';
      dd.style.maxHeight = Math.max(140, Math.min(300, (up ? r.top : below) - 14)) + 'px';
      if (up) { dd.style.top = 'auto'; dd.style.bottom = (innerHeight - r.top + 4) + 'px'; } else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
    };
    const ddPick = it => {
      const tr = ddInp.closest('tr'), i = +ddInp.dataset.l.split('.')[0], l = inv.lines[i];
      l.item = it.name; applyItem(l, it); ddInp.value = it.name; fillRow(tr, l);
      totals(); ddClose(); const q = tr.querySelector('[data-l$=".count"]'); if (q) { q.focus(); q.select(); }
    };
    const ddShow = inp => {
      ddInp = inp; const q = inp.value.trim().toLowerCase();
      ddList = db.items.filter(it => !q || (it.name + ' ' + (it.details || '') + ' ' + (it.hsn || '')).toLowerCase().includes(q)).slice(0, 60);
      ddIdx = ddList.findIndex(it => it.name.toLowerCase() === q);
      const exact = db.items.some(it => it.name.toLowerCase() === q);
      dd.innerHTML = (ddList.length ? ddList.map((it, k) => `<div class="ddi${k === ddIdx ? ' on' : ''}" data-k="${k}"><div><b>${esc(it.name)}</b>${it.details ? `<small>${esc(it.details)}</small>` : ''}</div><span>₹${money(it.rate)}${it.unit ? ' / ' + esc(it.unit) : ''}</span></div>`).join('') : '<div class="ddn">No matching item</div>')
        + (q && !exact ? `<div class="ddn add">＋ “${esc(inp.value.trim())}” will be saved as a new item</div>` : '');
      dd.hidden = false; ddPlace();
      const on = dd.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const ddMove = d => { if (!ddList.length) return; ddIdx = (ddIdx + d + ddList.length) % ddList.length; dd.querySelectorAll('.ddi').forEach((n, k) => n.classList.toggle('on', k === ddIdx)); const on = dd.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' }); };
    dd.onmousedown = e => { e.preventDefault(); const n = e.target.closest('.ddi'); if (n && ddInp) ddPick(ddList[+n.dataset.k]); };
    document.querySelectorAll('.itemin').forEach(inp => {
      inp.addEventListener('focus', () => ddShow(inp));
      inp.addEventListener('click', () => { if (dd.hidden || ddInp !== inp) ddShow(inp); });
      inp.addEventListener('input', () => ddShow(inp));
      inp.addEventListener('blur', () => setTimeout(() => { if (ddInp === inp) ddClose(); }, 120));
      inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (dd.hidden) ddShow(inp); else ddMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); ddMove(-1); }
        else if (e.key === 'Enter' && !dd.hidden && ddIdx >= 0 && ddList[ddIdx]) { e.preventDefault(); ddPick(ddList[ddIdx]); }
        else if (e.key === 'Escape' || e.key === 'Tab') ddClose();
      });
    });
    addEventListener('scroll', () => ddPlace(), true); addEventListener('resize', () => ddPlace());
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { inv.lines.splice(+b.dataset.del, 1); draw(); });
    $('add').onclick = () => { const last = inv.lines[inv.lines.length - 1]; inv.lines.push(newLine(last ? last.date : today())); draw(); };
    $('save').onclick = async () => {
      if (!inv.billTo.name.trim()) return alert('Bill To name is required');
      inv.lines = inv.lines.filter(l => l.item.trim());
      if (!inv.lines.length) return alert('Add at least one item');
      if (sameShip) inv.shipTo = { ...inv.billTo };
      inv.discount = pct(inv.discount);
      inv.lines.forEach(l => {
        l.count = +l.count; l.cost = +l.cost;
        l.disc = pct(l.disc); if (!l.disc) delete l.disc;
        if (hasOwnGst(l)) l.gst = Math.max(0, +l.gst || 0); else delete l.gst;
        l.hsn = String(l.hsn || '').trim(); if (!l.hsn) delete l.hsn;
        l.unit = String(l.unit || '').trim(); if (!l.unit) delete l.unit;
      });
      if (db.invoices.some(i => i.no === inv.no && i.id !== inv.id)) return alert('Invoice number already exists');
      // remember new customers / items / rates
      let c = db.customers.find(x => x.name.toLowerCase() === inv.billTo.name.trim().toLowerCase());
      if (!c) { c = { id: uid('c'), ...inv.billTo, shipAddress: inv.shipTo.address && inv.shipTo.address !== inv.billTo.address ? inv.shipTo.address : '' }; db.customers.push(c); }
      inv.customerId = c.id;
      inv.lines.forEach(l => { const it = db.items.find(x => x.name === l.item); if (!it) db.items.push({ id: uid('i'), name: l.item, details: '', hsn: l.hsn || '', unit: l.unit || '', rate: l.cost, gst: hasOwnGst(l) ? l.gst : '' }); });
      if (existing) db.invoices[db.invoices.findIndex(i => i.id === inv.id)] = inv; else db.invoices.push(inv);
      const m = inv.no.startsWith(db.settings.prefix) && /^\d+$/.test(inv.no.slice(db.settings.prefix.length)) ? +inv.no.slice(db.settings.prefix.length) : 0;
      if (m >= db.settings.nextNo) db.settings.nextNo = m + 1;
      await save(); location.hash = '#/view/' + inv.id;
    };
  };
  draw();
}

// ---------- invoice view / print ----------
function rupeesInWords(n) {
  const o = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? o[x] : t[Math.floor(x / 10)] + (x % 10 ? ' ' + o[x % 10] : '');
  const three = x => (x >= 100 ? o[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
  n = Math.round(n); if (n === 0) return 'Zero Rupees Only';
  const out = [];
  for (const [v, name] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) { const q = Math.floor(n / v); if (q) { out.push(three(q) + ' ' + name); n %= v; } }
  if (n) out.push(three(n));
  return out.join(' ') + ' Rupees Only';
}

// Shrinks an invoice of up to ONE_PAGE_LINES lines so it always prints on a single A4 page.
// It lays the invoice out at the printed width, measures it, and sets a zoom that the print styles use.
function fitPaper() {
  const p = document.querySelector('.paper'); if (!p) return;
  p.style.removeProperty('--fit'); p.style.removeProperty('--pw');
  if ((+p.dataset.lines || 0) > ONE_PAGE_LINES) return; // long invoices flow onto more pages
  const mm = 96 / 25.4, pageW = 186 * mm, pageH = 265 * mm; // A4 minus 12mm margins (273mm), with a little spare height
  document.body.classList.add('measuring');
  const fitsAt = f => { p.style.width = (pageW / f) + 'px'; return p.scrollHeight * f <= pageH; };
  let fit = 1;
  if (!fitsAt(1)) {
    let lo = Math.max(0.5, pageH / p.scrollHeight), hi = 1; // lo always fits: a wider layout is never taller
    for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2; if (fitsAt(mid)) lo = mid; else hi = mid; }
    fit = lo;
  }
  p.style.width = '';
  document.body.classList.remove('measuring');
  if (fit < 1) { p.style.setProperty('--fit', fit.toFixed(4)); p.style.setProperty('--pw', (pageW / fit).toFixed(1) + 'px'); }
}
window.addEventListener('beforeprint', fitPaper);

function viewInvoice(id) {
  const inv = db.invoices.find(i => i.id === id);
  if (!inv) { location.hash = '#/invoices'; return; }
  const s = db.settings, c = calc(inv), n = inv.lines.length;
  const due = addDays(inv.date, +s.dueDays || 10);
  const roundOff = c.rounded - c.total;
  // optional columns are printed only when this invoice actually uses them
  const LD = lineDates(), H = inv.lines.some(l => l.hsn), D = inv.lines.some(l => +l.disc), G = c.mixed || inv.lines.some(hasOwnGst);
  const dens = n > 18 ? ' c2' : n > 12 ? ' c1' : ''; // tighter spacing as the invoice gets longer
  const party = (t, p) => `<div class="box"><span class="k">${t}</span><b class="nm">${esc(p.name)}</b>${esc(p.address)}${p.gst ? '\nGST: <b>' + esc(p.gst) + '</b>' : ''}</div>`;
  const lbl = 'font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#777;font-weight:600;display:block';
  const tr = (a, b, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${a}</td><td>${b}</td></tr>`;
  let tot = tr('Sub-total', '₹ ' + money(c.amount));
  if (c.invDisc) tot += tr(`Discount @ ${num(inv.discount)}%`, '− ₹ ' + money(c.invDisc), 'sm') + tr('Taxable value', '₹ ' + money(c.sub));
  c.rates.forEach(b => {
    if (c.inter) tot += tr(`IGST @ ${num(b.rate)}%`, '₹ ' + money(b.tax), 'sm');
    else tot += tr(`CGST @ ${num(b.rate / 2)}%`, '₹ ' + money(b.tax / 2), 'sm') + tr(`SGST @ ${num(b.rate / 2)}%`, '₹ ' + money(b.tax / 2), 'sm');
  });
  tot += tr(c.rates.length === 1 ? `Total GST @ ${num(c.rates[0].rate)}%` : 'Total GST', '₹ ' + money(c.gst));
  tot += tr('Total inc. GST', '₹ ' + money(c.total));
  tot += tr('Round off', `${roundOff >= 0 ? '+' : '−'} ${money(Math.abs(roundOff))}`, 'sm');
  tot += tr('INVOICE TOTAL', '₹ ' + money0(c.rounded), 'grand');
  $app.innerHTML = `
  <div class="actions no-print">
    <button class="btn primary" id="print">Print / Save as PDF</button>
    <a class="btn" href="#/edit/${inv.id}">Edit</a>
    <button class="btn" id="pay">${inv.status === 'paid' ? 'Mark unpaid' : 'Mark as paid'}</button>
    <button class="btn danger" id="del">Delete</button>
    <span class="badge ${statusOf(inv)}" style="align-self:center">${statusOf(inv)}${inv.paidDate ? ' · ' + fmtDate(inv.paidDate) : ''}</span>
    <a class="btn" href="#/invoices" style="margin-left:auto">← Back</a></div>
  <div class="paper${dens}" data-lines="${n}" style="${paperVars()}">
    <div class="hd">${s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}">` : `<div class="bigname">${esc(s.name)}</div>`}
      <div class="co">${s.logo ? `<b>${esc(s.name)}</b>` : ''}${esc(s.address).split('\n').join('<br>')}${s.phone ? '<br>Ph: ' + esc(s.phone) : ''}${(s.gst || s.pan) ? '<br>' + [s.gst && 'GSTIN: ' + esc(s.gst), s.pan && 'PAN: ' + esc(s.pan)].filter(Boolean).join(' &nbsp;|&nbsp; ') : ''}</div></div>
    <div class="ttl">TAX INVOICE</div>
    <div class="meta"><div><span>Invoice No.</span><b>${esc(inv.no)}</b></div><div><span>Invoice Date</span><b>${fmtDate(inv.date)}</b></div><div><span>Payment Due</span><b>${fmtDate(due)}</b></div></div>
    <div class="parties">${party('Bill To', inv.billTo)}${party('Ship To', inv.shipTo)}</div>
    <div class="scroll"><table class="items" style="min-width:520px"><thead><tr><th class="c c-sno" style="width:42px">S.No</th>${LD ? '<th class="c-date" style="width:76px">Date</th>' : ''}<th>Item</th>${H ? '<th style="width:74px">HSN/SAC</th>' : ''}<th class="c" style="width:72px">Qty</th><th class="r" style="width:78px">Rate (₹)</th>${D ? '<th class="r" style="width:54px">Disc %</th>' : ''}${G ? '<th class="r" style="width:54px">GST %</th>' : ''}<th class="r" style="width:96px">Amount (₹)</th></tr></thead><tbody>
    ${inv.lines.map((l, i) => { const lc = lineCalc(inv, l); return `<tr><td class="c c-sno">${i + 1}</td>${LD ? `<td class="c-date">${fmtDate(l.date)}</td>` : ''}<td>${esc(l.item)}${LD ? `<small class="dt">${fmtDate(l.date)}</small>` : ''}</td>${H ? `<td>${esc(l.hsn || '')}</td>` : ''}<td class="c">${num(l.count)}${l.unit ? ' ' + esc(l.unit) : ''}</td><td class="r">${money(l.cost)}</td>${D ? `<td class="r">${+l.disc ? num(l.disc) + '%' : ''}</td>` : ''}${G ? `<td class="r">${num(lc.rate)}%</td>` : ''}<td class="r">${money(lc.amount)}</td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="lower">
      <div>
        <div class="words"><span style="${lbl}">Amount in words</span><b>${rupeesInWords(c.rounded)}</b></div>
        <div class="bank"><span style="${lbl}">Bank details</span>
          <table><tr><td>Account name</td><td><b>${esc(s.accountName)}</b></td></tr><tr><td>Account no.</td><td><b>${esc(s.bankAccount)}</b></td></tr><tr><td>IFSC</td><td><b>${esc(s.ifsc)}</b></td></tr><tr><td>Bank</td><td>${esc(s.bankName)}</td></tr></table></div>
      </div>
      <div>
        <table class="tot">${tot}</table>
        <div class="sign"><div class="line"></div>For ${esc(s.name)}<br><span style="color:#777">Authorised Signatory</span></div>
      </div>
    </div>
    <div class="terms"><b>Terms &amp; conditions:</b> ${esc(s.terms)}</div>
    <div class="thanks">Thank you for your business!</div>
  </div>`;
  fitPaper();
  const li = document.querySelector('.paper .hd img'); if (li && !li.complete) li.addEventListener('load', fitPaper, { once: true });
  document.getElementById('print').onclick = () => { fitPaper(); window.print(); };
  document.getElementById('pay').onclick = async () => {
    if (inv.status === 'paid') { inv.status = 'unpaid'; inv.paidDate = ''; }
    else { inv.status = 'paid'; inv.paidDate = prompt('Payment date (YYYY-MM-DD)', today()) || today(); }
    await save(); viewInvoice(id);
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm('Delete invoice ' + inv.no + '? This cannot be undone.')) return;
    db.invoices = db.invoices.filter(i => i.id !== id); await save(); location.hash = '#/invoices';
  };
}

// ---------- customers ----------
function customers() {
  $app.innerHTML = `<h1>Customers</h1>
  <div class="card"><h2>Add new customer</h2>
    <div class="row" style="align-items:flex-start">
      <div class="field" style="flex:2"><label>Customer name *</label><input id="c_name" placeholder="Enter customer name"></div>
      <div class="field" style="flex:1"><label>GST No.</label><input id="c_gst" placeholder="Enter GST No. (optional)"></div></div>
    <div class="row" style="align-items:flex-start">
      <div class="field"><label>Billing address</label><textarea id="c_addr" style="min-height:76px" placeholder="Enter billing address"></textarea></div>
      <div class="field"><label>Shipping address</label><textarea id="c_ship" style="min-height:76px" placeholder="Enter shipping address (optional, if different from billing)"></textarea></div></div>
    <button class="btn primary" id="c_add">+ Add customer</button></div>
  <div class="card"><table class="stack custT2"><thead><tr><th style="width:19%">Name</th><th>Billing address</th><th>Shipping address</th><th style="width:176px">GST No.</th><th class="n" style="width:96px">Billed</th><th style="width:84px"></th></tr></thead><tbody>
  ${db.customers.map(c => `<tr><td data-k="Name"><input data-c="${c.id}.name" value="${esc(c.name)}" placeholder="Enter name"></td>
    <td data-k="Billing address"><textarea data-c="${c.id}.address" style="min-height:64px" placeholder="Enter billing address">${esc(c.address)}</textarea></td>
    <td data-k="Shipping address"><textarea data-c="${c.id}.shipAddress" style="min-height:64px" placeholder="Optional">${esc(c.shipAddress || '')}</textarea></td>
    <td data-k="GST No."><input data-c="${c.id}.gst" value="${esc(c.gst)}" placeholder="Optional"></td>
    <td data-k="Billed" class="n">₹${money0(db.invoices.filter(i => i.customerId === c.id).reduce((s, i) => s + calc(i).rounded, 0))}</td>
    <td class="c-del"><button class="btn sm danger" data-del="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No customers yet. Add your first customer above.</td></tr>'}</tbody></table>
  <p class="muted" style="margin:10px 0 0;font-size:12px">When you pick a customer on an invoice, Bill To and Ship To are filled from here. Changes do not alter old invoices.</p></div>`;
  document.querySelectorAll('[data-c]').forEach(el => el.onchange = async () => {
    const [id, f] = el.dataset.c.split('.'); const c = db.customers.find(x => x.id === id);
    if (f === 'name' && !el.value.trim()) { el.value = c.name; return; }
    c[f] = el.value.trim(); await save();
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete customer? Existing invoices keep their copy of the details.')) return;
    db.customers = db.customers.filter(c => c.id !== b.dataset.del); await save(); customers();
  });
  document.getElementById('c_add').onclick = async () => {
    const val = id => document.getElementById(id).value.trim();
    const name = val('c_name');
    if (!name) return alert('Customer name is required');
    if (db.customers.some(c => c.name.toLowerCase() === name.toLowerCase())) return alert('This customer already exists');
    const address = val('c_addr'), ship = val('c_ship');
    db.customers.push({ id: uid('c'), name, address, shipAddress: ship === address ? '' : ship, gst: val('c_gst') });
    await save(); customers();
  };
}

// ---------- items ----------
function itemStats() {
  const st = {};
  db.invoices.forEach(inv => inv.lines.forEach(l => {
    const s = st[l.item] || (st[l.item] = { qty: 0, amt: 0 });
    s.qty += +l.count || 0; s.amt += (+l.count || 0) * (+l.cost || 0);
  }));
  return st;
}
function items() {
  let q = '';
  const stats = itemStats();
  const Dt = colOn('details'), H = colOn('hsn'), U = colOn('unit'), G = colOn('itemGst');
  const cols = 5 + Dt + H + U + G;
  $app.innerHTML = `<h1>Items</h1>
  <div class="card"><h2>Add new item</h2>
    <div class="row tight" style="align-items:flex-end">
      <div class="field" style="flex:3"><label>Item / service name *</label><input id="n_name" placeholder="Enter item or service name"></div>
      ${Dt ? '<div class="field" style="flex:3"><label>Details</label><input id="n_det" placeholder="Enter details (optional)"></div>' : ''}
      ${H ? '<div class="field" style="flex:1.2"><label>HSN / SAC</label><input id="n_hsn" placeholder="Optional"></div>' : ''}
      ${U ? '<div class="field" style="flex:1.1"><label>Unit</label><button type="button" class="sel" id="n_unit" data-v=""><span class="muted">Select</span></button></div>' : ''}
      <div class="field" style="flex:1.2"><label>Rate (₹) *</label><input id="n_rate" type="number" step="0.01" placeholder="0"></div>
      ${G ? `<div class="field" style="flex:1"><label>GST %</label><input id="n_gst" type="number" step="0.01" min="0" placeholder="Optional"></div>` : ''}
      <div class="field" style="flex:0 0 auto;min-width:0"><button class="btn primary" id="n_add">+ Add item</button></div>
    </div></div>
  <div class="toolbar"><input id="q" placeholder="Search items"><span class="muted" id="cnt"></span><a class="btn" href="#/menu" id="menuBtn" style="margin-left:auto">Menu / Price list PDF</a></div>
  <div class="card"><table class="stack itemsT2"><thead><tr><th${Dt ? ' style="width:23%"' : ''}>Item</th>${Dt ? '<th>Details</th>' : ''}${H ? '<th style="width:96px">HSN / SAC</th>' : ''}${U ? '<th style="width:94px">Unit</th>' : ''}<th class="n" style="width:96px">Rate (₹)</th>${G ? '<th class="n" style="width:92px">GST %</th>' : ''}<th class="n" style="width:78px">Qty sold</th><th class="n" style="width:100px">Sales (₹)</th><th style="width:80px"></th></tr></thead><tbody id="rows"></tbody></table>
  <p class="muted" style="margin:10px 0 0;font-size:12px">Changes here only affect new invoices. Old invoices keep the rate, unit and GST they were billed with.${G ? ' If GST % is left empty, the default GST rate of the invoice is used.' : ''}</p></div>`;
  const draw = () => {
    const list = db.items.filter(i => (i.name + ' ' + (i.details || '') + ' ' + (i.hsn || '')).toLowerCase().includes(q.toLowerCase()));
    document.getElementById('cnt').textContent = `${list.length} of ${db.items.length} items`;
    document.getElementById('rows').innerHTML = list.map(it => {
      const s = stats[it.name] || { qty: 0, amt: 0 };
      return `<tr><td data-k="Item" class="c-item"><input data-i="${it.id}.name" value="${esc(it.name)}" placeholder="Enter item name"></td>
      ${Dt ? `<td data-k="Details" class="c-det"><input data-i="${it.id}.details" value="${esc(it.details || '')}" placeholder="Optional"></td>` : ''}
      ${H ? `<td data-k="HSN / SAC"><input data-i="${it.id}.hsn" value="${esc(it.hsn || '')}" placeholder="Optional"></td>` : ''}
      ${U ? `<td data-k="Unit"><button type="button" class="sel" data-iu="${it.id}"><span${it.unit ? '' : ' class="muted"'}>${esc(it.unit || 'Select')}</span></button></td>` : ''}
      <td data-k="Rate (₹)"><input type="number" step="0.01" class="n" data-i="${it.id}.rate" value="${it.rate}" placeholder="0"></td>
      ${G ? `<td data-k="GST %"><input type="number" step="0.01" min="0" class="n" data-i="${it.id}.gst" value="${hasOwnGst(it) ? it.gst : ''}" placeholder="Optional"></td>` : ''}
      <td data-k="Qty sold" class="n c-stat">${money0(s.qty)}</td><td data-k="Sales" class="n c-stat">₹${money0(s.amt)}</td>
      <td class="c-del"><button class="btn sm danger" data-del="${it.id}">Delete</button></td></tr>`;
    }).join('') || `<tr><td colspan="${cols}" class="muted">No items</td></tr>`;
    document.querySelectorAll('[data-i]').forEach(el => el.onchange = async () => {
      const [id, f] = el.dataset.i.split('.'); const it = db.items.find(c => c.id === id);
      if (f === 'name' && !el.value.trim()) { el.value = it.name; return; }
      it[f] = f === 'rate' ? +el.value : f === 'gst' ? (el.value === '' ? '' : Math.max(0, +el.value || 0)) : el.value.trim(); await save();
    });
    document.querySelectorAll('[data-iu]').forEach(b => b.onclick = () => { const it = db.items.find(c => c.id === b.dataset.iu); pickUnit(b, it.unit, async v => { it.unit = v; showUnit(b, v); await save(); }); });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const it = db.items.find(c => c.id === b.dataset.del);
      if (!confirm(`Delete "${it.name}"? Old invoices are not affected.`)) return;
      db.items = db.items.filter(c => c.id !== it.id); await save(); items();
    });
  };
  document.getElementById('q').oninput = e => { q = e.target.value; draw(); };
  const nu = document.getElementById('n_unit');
  if (nu) nu.onclick = () => pickUnit(nu, nu.dataset.v, v => { nu.dataset.v = v; showUnit(nu, v); });
  document.getElementById('n_add').onclick = async () => {
    const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
    const name = val('n_name'), rate = val('n_rate'), gst = val('n_gst');
    if (!name) return alert('Item name is required');
    if (rate === '' || isNaN(+rate)) return alert('Enter the rate for this item');
    if (db.items.some(i => i.name.toLowerCase() === name.toLowerCase())) return alert('This item already exists');
    db.items.push({ id: uid('i'), name, details: val('n_det'), hsn: val('n_hsn'), unit: nu ? nu.dataset.v : '', rate: +rate, gst: gst === '' ? '' : Math.max(0, +gst || 0) });
    await save(); items();
  };
  draw();
}

// ---------- items as a printable menu / price list ----------
function itemMenu() {
  const s = db.settings, list = db.items.filter(i => i.name);
  const two = list.length > 12;
  $app.innerHTML = `
  <div class="actions no-print">
    <button class="btn primary" id="print">Print / Save as PDF</button>
    <input id="m_title" value="${esc(s.menuTitle || 'Menu')}" placeholder="Enter title" maxlength="40" style="max-width:220px">
    <a class="btn" href="#/items" style="margin-left:auto">← Back</a></div>
  <div class="paper menu" data-lines="${list.length > 80 ? 99 : 0}" style="${paperVars()}">
    <div class="hd">${s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}">` : `<div class="bigname">${esc(s.name)}</div>`}
      <div class="co">${s.logo ? `<b>${esc(s.name)}</b>` : ''}${esc(s.address).split('\n').join('<br>')}${s.phone ? '<br>Ph: ' + esc(s.phone) : ''}</div></div>
    <div class="ttl" id="m_ttl">${esc(s.menuTitle || 'Menu')}</div>
    ${list.length ? `<div class="mlist${two ? ' two' : ''}">${list.map(it => `<div class="mi"><div class="nm">${esc(it.name)}${it.details && colOn('details') ? `<small>${esc(it.details)}</small>` : ''}</div><div class="pr">₹ ${num(it.rate)}${it.unit ? `<small> / ${esc(it.unit)}</small>` : ''}</div></div>`).join('')}</div>` : '<p style="text-align:center;color:#777">No items yet. Add items first.</p>'}
    <div class="thanks">${list.length} items · Rates in ₹, GST extra as applicable · ${fmtDate(today())}</div>
  </div>`;
  fitPaper();
  const li = document.querySelector('.paper .hd img'); if (li && !li.complete) li.addEventListener('load', fitPaper, { once: true });
  document.getElementById('print').onclick = () => { fitPaper(); window.print(); };
  document.getElementById('m_title').oninput = e => { document.getElementById('m_ttl').textContent = e.target.value.trim() || 'Menu'; };
  document.getElementById('m_title').onchange = async e => { s.menuTitle = e.target.value.trim() || 'Menu'; await save(); };
}

// ---------- settings ----------
function settings() {
  const s = db.settings;
  const ph = (label, type) => type === 'number' ? '0' : 'Enter ' + (/^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label);
  const f = (k, label, type = 'text') => `<div class="field"><label>${label}</label>${type === 'area' ? `<textarea data-s="${k}" placeholder="${ph(label, type)}">${esc(s[k])}</textarea>` : `<input type="${type}" data-s="${k}" value="${esc(s[k])}" placeholder="${ph(label, type)}">`}</div>`;
  $app.innerHTML = `<h1>Settings</h1>
  <div class="grid g2"><div class="card"><h2>Business (invoice header)</h2>${f('name', 'Business name')}${f('address', 'Address', 'area')}${f('phone', 'Phone')}${f('gst', 'GST No.')}${f('pan', 'PAN')}</div>
  <div class="card"><h2>Invoice numbering & tax</h2>${f('prefix', 'Invoice prefix')}${f('nextNo', 'Next invoice number', 'number')}${f('gstRate', 'Default GST %', 'number')}${f('dueDays', 'Payment due (days)', 'number')}${f('terms', 'Payment term (line 1)', 'area')}
  <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:4px 0 10px"><input type="checkbox" id="ld" ${lineDates() ? 'checked' : ''} style="width:auto;min-height:0;margin-top:3px"> <span>Show a date on every invoice line<br><small class="muted">Useful for daily supply bills. Switch off for normal product or service invoices.</small></span></label>
  <div style="margin:2px 0 12px"><div class="muted" style="font-weight:600;font-size:13px;margin-bottom:6px">Extra invoice columns</div>${[['hsn', 'HSN / SAC code'], ['unit', 'Unit (pcs, kg, box, hrs…)'], ['itemGst', 'GST % for each item'], ['disc', 'Discount'], ['details', 'Item details note']].map(([k, t]) => `<label style="display:inline-flex;gap:6px;align-items:center;font-weight:400;margin:0 16px 6px 0"><input type="checkbox" data-col="${k}" ${colOn(k) ? 'checked' : ''} style="width:auto;min-height:0"> ${t}</label>`).join('')}
  <br><small class="muted">A column is printed on an invoice only when that invoice uses it.</small></div>
  <h2 style="margin-top:14px">Bank details</h2>${f('bankAccount', 'Account number')}${f('ifsc', 'IFSC')}${f('bankName', 'Bank name')}${f('accountName', 'Account name')}</div></div>
  ${settingsExtras()}`;
  document.querySelectorAll('[data-s]').forEach(el => el.onchange = async () => {
    const k = el.dataset.s; db.settings[k] = ['nextNo', 'gstRate', 'dueDays'].includes(k) ? +el.value : el.value; await save();
    if (k === 'name') renderChrome();
  });
  document.querySelectorAll('[data-col]').forEach(el => el.onchange = async () => { db.settings.cols = { ...(db.settings.cols || {}), [el.dataset.col]: el.checked }; await save(); });
  document.getElementById('ld').onchange = async e => { db.settings.lineDates = e.target.checked; await save(); };
  settingsExtrasBind();
}

// =====================================================================
//  Auth, vendor management, branding
// =====================================================================
let me = null;
let brand = { appName: 'NovaBill', logo: '' };
let wsId = sessionStorage.getItem('ws') || '';
const setWs = id => { wsId = id || ''; if (wsId) sessionStorage.setItem('ws', wsId); else sessionStorage.removeItem('ws'); };

async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (wsId && url === '/api/db') headers['X-Workspace'] = wsId;
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401 && url !== '/api/login') { me = null; showLogin(); throw new Error('auth'); }
  return r;
}
async function load() {
  const r = await api('GET', '/api/db');
  if (r.status === 403 && wsId) { setWs(''); return load(); }
  db = await r.json();
}
async function save() {
  const r = await api('PUT', '/api/db', db);
  if (!r.ok) alert('Save failed: ' + await r.text());
}

// ---------- colour helpers / theme ----------
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
const lum = h => { const [r, g, b] = hex2rgb(h).map(v => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const DEFAULT_THEME = '#4a25d0'; // NovaBill indigo, same family as the login page
// '#3b82f6' was the old built-in default, so it counts as "not chosen yet"
const themeColor = () => { const t = db && db.settings && db.settings.themeColor; return /^#[0-9a-f]{6}$/i.test(t || '') && t.toLowerCase() !== '#3b82f6' ? t : DEFAULT_THEME; };
function applyTheme() {
  const c = themeColor();
  const st = document.documentElement.style;
  const light = lum(c) > 0.45;
  st.setProperty('--brand', c);
  st.setProperty('--brand-d', mix(c, '#000000', 0.12));
  st.setProperty('--bar', mix(c, '#000000', 0.1));
  st.setProperty('--bg', mix(c, '#ffffff', 0.95));
  st.setProperty('--line', mix(c, '#ffffff', 0.78));
  st.setProperty('--tint', mix(c, '#ffffff', 0.9));
  st.setProperty('--tint2', mix(c, '#ffffff', 0.94));
  st.setProperty('--on-brand', light ? '#1b1b1b' : '#ffffff');
  st.setProperty('--btn-fg', light ? c : '#ffffff');
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = c;
}
function paperVars() {
  const c = themeColor();
  return `--pa:${mix(c, '#000000', 0.3)};--pt:${mix(c, '#ffffff', 0.55)}`;
}

// ---------- logo picker (resizes in the browser, stores as data URL) ----------
function pickLogo(cb) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/png');
      if (url.length > 2e6) return alert('Image is too large, please choose a smaller one');
      cb(url);
    };
    img.onerror = () => alert('Could not read that image');
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}

// ---------- page chrome ----------
function renderChrome() {
  document.body.classList.remove('authless');
  const s = db ? db.settings : {};
  document.title = s.name ? s.name + ' · ' + brand.appName : brand.appName;
  const logo = s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.name)}">` : `<img class="deflogo" src="${esc(brand.logo || 'novabill-logo.png')}" alt="${esc(brand.appName)}">`;
  document.getElementById('top').innerHTML = `
    <a class="brand" href="#/dashboard">${logo}</a>
    <nav id="nav"><a href="#/dashboard">Dashboard</a><a href="#/invoices">Invoices</a><a href="#/customers">Customers</a><a href="#/items">Items</a><a href="#/settings">Settings</a>${me.role === 'admin' ? '<a href="#/vendors">Vendors</a>' : ''}</nav>
    <a class="btn primary" href="#/new"><span class="long">+ New invoice</span><span class="short">+ New</span></a>
    <button class="btn sm" id="logout" title="Sign out">Logout</button>`;
  document.getElementById('logout').onclick = logout;
  const b = document.getElementById('banner');
  b.innerHTML = wsId ? `<div class="banner">Viewing <b>${esc(s.name)}</b> as admin <button class="btn sm" id="exitws">Exit to my account</button></div>` : '';
  if (wsId) document.getElementById('exitws').onclick = async () => { setWs(''); await load(); applyTheme(); renderChrome(); location.hash = '#/vendors'; route(); };
}
async function logout() {
  try { await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { }
  me = null; db = null; setWs(''); applyTheme(); showLogin();
}

// ---------- login / forced password change ----------
function brandMark() {
  return brand.logo ? `<img src="${esc(brand.logo)}" alt="" style="max-height:80px;max-width:100%">` : brand.appName === 'NovaBill' ? '<img class="applogo" src="novabill-logo.png" alt="NovaBill">' : '<img class="appicon" src="icon.png" alt="">';
}
function showLogin(msg) {
  document.body.classList.add('authless');
  document.getElementById('top').innerHTML = '';
  document.getElementById('banner').innerHTML = '';
  document.title = brand.appName + ' · Sign in';
  const own = !brand.logo && brand.appName === 'NovaBill';
  $app.innerHTML = `<div class="auth">
    <aside class="auth-side" aria-hidden="true">
      <div class="auth-bars"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="auth-copy">
        <p class="auth-tag">Invoice. Analyze. Grow.</p>
        <h2>Billing made simple for every business.</h2>
        <ul>
          <li><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.500 4.500L19 7.500"/></svg>GST invoices ready in under a minute</li>
          <li><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.500 4.500L19 7.500"/></svg>See who has paid and who has not</li>
          <li><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.500 4.500L19 7.500"/></svg>Sales by month, customer and item</li>
          <li><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.500 4.500L19 7.500"/></svg>Works on your phone and your computer</li>
        </ul>
      </div>
    </aside>
    <section class="auth-main">
      <form class="login2" id="lf" autocomplete="on">
        <div class="lg">${brandMark()}</div>${own ? '' : `<h1 class="wm">${esc(brand.appName)}</h1>`}
        <h2 class="auth-h">Welcome back</h2>
        <p class="muted auth-sub">Sign in to your account to continue</p>
        <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required autofocus placeholder="Enter username"></div>
        <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required placeholder="Enter password"></div>
        <label class="auth-show"><input type="checkbox" id="show"> Show password</label>
        <div id="err" class="err">${esc(msg || '')}</div>
        <button class="btn primary" id="go">Sign in</button>
        <p class="auth-foot">Forgot your password? Ask your administrator to reset it.</p>
      </form>
    </section></div>`;
  document.getElementById('show').onchange = e => document.getElementById('p').type = e.target.checked ? 'text' : 'password';
  document.getElementById('lf').onsubmit = async e => {
    e.preventDefault();
    const go = document.getElementById('go'), err = document.getElementById('err'); go.disabled = true; err.textContent = '';
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }) });
    go.disabled = false;
    if (!r.ok) { err.textContent = await r.text(); return; }
    me = await r.json(); setWs('');
    me.mustChange ? showChangePassword(true) : startApp();
  };
}
function showChangePassword(force) {
  document.body.classList.add('authless');
  document.getElementById('top').innerHTML = '';
  $app.innerHTML = `<form class="card login" id="cf">
    <h1 style="text-align:center;margin:0 0 4px">Set your password</h1>
    <p class="muted" style="text-align:center;margin:0 0 16px">${force ? 'For security, choose your own password before you continue.' : ''}</p>
    <div class="field"><label>Current / temporary password</label><input id="o" type="password" autocomplete="current-password" required placeholder="Enter current password"></div>
    <div class="field"><label>New password (min 6 characters)</label><input id="n1" type="password" autocomplete="new-password" required minlength="6" placeholder="Enter new password"></div>
    <div class="field"><label>Confirm new password</label><input id="n2" type="password" autocomplete="new-password" required minlength="6" placeholder="Enter new password again"></div>
    <div id="err" class="err"></div>
    <button class="btn primary" style="width:100%">Save password & continue</button>
    <button type="button" class="btn" style="width:100%;margin-top:8px" id="lo">Sign out</button></form>`;
  document.getElementById('lo').onclick = logout;
  document.getElementById('cf').onsubmit = async e => {
    e.preventDefault(); const err = document.getElementById('err');
    if (document.getElementById('n1').value !== document.getElementById('n2').value) { err.textContent = 'New passwords do not match'; return; }
    const r = await api('POST', '/api/password', { oldPassword: document.getElementById('o').value, newPassword: document.getElementById('n1').value });
    if (!r.ok) { err.textContent = await r.text(); return; }
    me = await r.json(); startApp();
  };
}

// ---------- vendors (admin) ----------
const genPw = () => { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(10)), v => c[v % c.length]).join(''); };
async function vendors(notice) {
  if (me.role !== 'admin') { location.hash = '#/dashboard'; return; }
  if (wsId) { setWs(''); await load(); applyTheme(); renderChrome(); }
  const list = (await (await api('GET', '/api/admin/users')).json()).filter(u => u.role === 'vendor');
  const bl = brand.logo;
  $app.innerHTML = `<h1>Vendors</h1>
  <div class="card"><h2>Add a vendor</h2>
    <form id="nv"><div class="row" style="align-items:flex-end">
      <div class="field" style="flex:2"><label>Company name *</label><input id="v_co" required placeholder="Enter company name"></div>
      <div class="field"><label>Username *</label><input id="v_us" required autocapitalize="none" placeholder="Enter username"></div>
      <div class="field"><label>Password *</label><input id="v_pw" required minlength="6" value="${genPw()}" placeholder="Enter password"></div>
      <div class="field" style="flex:0 0 auto;min-width:0"><button class="btn primary">+ Create vendor</button></div></div></form>
    <p class="muted" style="font-size:12px;margin:0">Share the username and password with the vendor yourself. They can change it later from Settings if they want.</p>
    <div id="msg" class="${notice ? 'ok' : ''}">${notice || ''}</div></div>
  <div class="card"><h2>Vendor accounts (${list.length})</h2>
  ${list.length ? `<table class="stack vendT"><thead><tr><th>Company</th><th>Username</th><th class="n">Invoices</th><th class="n">Billed</th><th class="n">Pending</th><th>Status</th><th></th></tr></thead><tbody>
  ${list.map(u => `<tr><td><b>${esc(u.company || u.name)}</b></td><td>${esc(u.username)}</td>
    <td class="n">${u.invoices}</td><td class="n">₹${money0(u.billed)}</td><td class="n">₹${money0(u.pending)}</td>
    <td><span class="badge ${u.active ? 'paid' : 'overdue'}">${u.active ? 'active' : 'disabled'}</span></td>
    <td class="acts"><button class="btn sm" data-open="${u.id}">Open</button><button class="btn sm" data-tog="${u.id}">${u.active ? 'Disable' : 'Enable'}</button><button class="btn sm" data-pw="${u.id}">Reset password</button><button class="btn sm danger" data-del="${u.id}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No vendors yet. Add your first vendor above.</p>'}</div>
  <div class="card"><h2>Login page branding</h2>
    <div class="row" style="align-items:center">
      <div class="field"><label>App name</label><input id="b_name" value="${esc(brand.appName)}" placeholder="Enter app name"></div>
      <div style="flex:0 0 200px;min-width:0"><div class="logoprev">${bl ? `<img src="${esc(bl)}" alt="">` : '<img src="icon.png" alt="" style="height:56px"><span class="muted" style="margin-left:10px;font-size:12px">Default icon</span>'}</div></div>
      <div><button class="btn" id="b_up">Upload logo</button> <button class="btn" id="b_rm">Remove</button></div></div>
    <div style="margin-top:12px"><button class="btn primary" id="b_save">Save branding</button></div></div>`;
  const reload = n => vendors(n);
  document.getElementById('nv').onsubmit = async e => {
    e.preventDefault();
    const body = { company: v_co.value, username: v_us.value, password: v_pw.value };
    const r = await api('POST', '/api/admin/users', body);
    if (!r.ok) { const m = document.getElementById('msg'); m.className = 'err'; m.textContent = await r.text(); return; }
    reload(`✅ Vendor created. Share these login details — Username: <b>${esc(body.username)}</b> &nbsp; Password: <b>${esc(body.password)}</b>`);
  };
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => { setWs(b.dataset.open); await load(); applyTheme(); renderChrome(); location.hash = '#/dashboard'; route(); });
  document.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => {
    const u = list.find(x => x.id === b.dataset.tog);
    if (u.active && !confirm(`Disable ${u.company || u.name}? They will be signed out and cannot log in.`)) return;
    const r = await api('PATCH', '/api/admin/users/' + u.id, { active: !u.active }); if (!r.ok) alert(await r.text()); reload();
  });
  document.querySelectorAll('[data-pw]').forEach(b => b.onclick = async () => {
    const u = list.find(x => x.id === b.dataset.pw);
    const pw = prompt(`New password for ${u.username} (min 6 characters):`, genPw()); if (!pw) return;
    const r = await api('PATCH', '/api/admin/users/' + u.id, { password: pw });
    if (!r.ok) return alert(await r.text());
    reload(`✅ Password reset for <b>${esc(u.username)}</b>. New password: <b>${esc(pw)}</b>`);
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const u = list.find(x => x.id === b.dataset.del);
    if (prompt(`This removes login for "${u.company || u.name}". Their data file is kept on the server as an archive.\nType DELETE to confirm:`) !== 'DELETE') return;
    const r = await api('DELETE', '/api/admin/users/' + u.id); if (!r.ok) alert(await r.text()); reload();
  });
  let newLogo = bl;
  document.getElementById('b_up').onclick = () => pickLogo(url => { newLogo = url; document.querySelector('.logoprev').innerHTML = `<img src="${url}" alt="">`; });
  document.getElementById('b_rm').onclick = () => { newLogo = ''; document.querySelector('.logoprev').innerHTML = '<span class="muted">No logo</span>'; };
  document.getElementById('b_save').onclick = async () => {
    const r = await api('PUT', '/api/admin/brand', { appName: document.getElementById('b_name').value, logo: newLogo });
    if (!r.ok) return alert(await r.text());
    brand = await r.json(); reload('✅ Login page branding saved');
  };
}

// ---------- settings: logo/colour + account cards ----------
function settingsExtras() {
  const s = db.settings;
  return `<div class="card"><h2>Logo & colour</h2>
    <div class="row" style="align-items:center">
      <div style="flex:0 0 220px;min-width:0"><div class="logoprev" id="lp">${s.logo ? `<img src="${esc(s.logo)}" alt="">` : '<span class="muted">No logo yet. The app shows the default logo, and invoices print your company name</span>'}</div></div>
      <div><button class="btn" id="upl">Upload logo</button> ${s.logo ? '<button class="btn danger" id="rml">Remove</button>' : ''}
        <p class="muted" style="font-size:12px;margin:8px 0 0">PNG or JPG. A transparent PNG looks best on invoices.</p></div>
      <div class="field" style="max-width:200px"><label>Brand colour (menu, buttons, invoice accents)</label><input type="color" id="clr" value="${esc(themeColor())}" style="height:42px;padding:3px"></div>
    </div></div>
  <div class="card"><h2>Account</h2>
    <p style="margin:0 0 10px">Signed in as <b>${esc(me.username)}</b> (${me.role})</p>
    <form id="pwf"><div class="row" style="align-items:flex-end">
      <div class="field"><label>Current password</label><input id="pw0" type="password" autocomplete="current-password" required placeholder="Enter current password"></div>
      <div class="field"><label>New password (min 6)</label><input id="pw1" type="password" autocomplete="new-password" minlength="6" required placeholder="Enter new password"></div>
      <div class="field" style="flex:0 0 auto;min-width:0"><button class="btn">Change password</button></div></div></form>
    <div id="pwmsg"></div>
    <div style="margin-top:8px"><button class="btn" id="dl">Download my data (backup)</button> <button class="btn danger" id="lo2">Sign out</button></div></div>`;
}
function settingsExtrasBind() {
  document.getElementById('upl').onclick = () => pickLogo(async url => { db.settings.logo = url; await save(); renderChrome(); settings(); });
  const rm = document.getElementById('rml'); if (rm) rm.onclick = async () => { db.settings.logo = ''; await save(); renderChrome(); settings(); };
  document.getElementById('clr').onchange = async e => { db.settings.themeColor = e.target.value; await save(); applyTheme(); };
  document.getElementById('lo2').onclick = logout;
  document.getElementById('dl').onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
    a.download = (db.settings.name || 'billing').replace(/\W+/g, '_') + '-backup.json'; a.click();
  };
  document.getElementById('pwf').onsubmit = async e => {
    e.preventDefault(); const m = document.getElementById('pwmsg');
    const r = await api('POST', '/api/password', { oldPassword: pw0.value, newPassword: pw1.value });
    m.className = r.ok ? 'ok' : 'err'; m.textContent = r.ok ? '✅ Password changed' : await r.text(); if (r.ok) e.target.reset();
  };
}

// ---------- boot ----------
async function startApp() {
  if (wsId && me.role !== 'admin') setWs('');
  await load(); applyTheme(); renderChrome(); route();
}
async function boot() {
  try { brand = await (await fetch('/api/brand')).json(); } catch { }
  const r = await fetch('/api/me');
  if (r.status !== 200) return showLogin();
  me = await r.json();
  if (me.mustChange) return showChangePassword(true);
  startApp();
}
boot();
