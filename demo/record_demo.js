// Voice-over: powershell -File demo/make_voice.ps1 -Json demo/narration.json -OutDir <voice-folder>  ->  node demo/make_durations.js <voice-folder>  ->  node demo/record_demo.js <work> <out.mp4> <voice-folder>
// Records a captioned product-demo video of the billing app (no audio).
//
//  1. Start a throw-away demo server (its own empty data folder, never touches real data):
//        set DATA_DIR=<some empty folder>  &  set PORT=3077  &  node server.js
//     (put {"appName":"Billing Suite","logo":""} in <folder>/brand.json first to brand the login page)
//  2. node demo/record_demo.js <work-folder> <output.mp4>
//
// Needs Chrome/Edge + ffmpeg on PATH. Uses the Chrome DevTools Protocol (Node 22 built-in WebSocket).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const WORK = process.argv[2], OUTFILE = process.argv[3];
const BASE = process.env.DEMO_URL || 'http://localhost:3077/';
const FPS = 15;
const CH = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = JSON.stringify;
const VOICE = process.argv[4];
const VMAP = VOICE && fs.existsSync(path.join(VOICE, 'durations.json')) ? JSON.parse(fs.readFileSync(path.join(VOICE, 'durations.json'), 'utf8').replace(/^﻿/, '')) : {};

(async () => {
  const prof = path.join(WORK, 'prof'); fs.mkdirSync(prof, { recursive: true });
  const proc = spawn(CH, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9335', '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
  let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9335/json')).json(); if (targets.length) break; } catch { } await sleep(250); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {};
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(J(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails)); return r.result.result.value; };
  const until = async (cond, what, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(cond)) return; await sleep(120); } throw new Error('timeout: ' + what); };

  // ---------- frame capture ----------
  let seg = 'a', n = 0, mobile = false;
  let gf = 0, lastEnd = 0; const events = [];   // gf = global frame counter (video timeline), lastEnd = frame when current narration finishes
  const dir = s => path.join(WORK, 'frames_' + s);
  const frame = async () => {
    gf++;
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
    fs.writeFileSync(path.join(dir(seg), 'f' + String(n++).padStart(5, '0') + '.jpg'), Buffer.from(s.result.data, 'base64'));
  };
  const startSeg = s => { seg = s; n = 0; fs.mkdirSync(dir(s), { recursive: true }); };
  const hold = async sec => { for (let i = 0; i < Math.round(sec * FPS); i++) await frame(); };

  // ---------- on-page helpers: caption, cursor ----------
  const INJECT = `(()=>{
    if(document.getElementById('demo-cap'))return;
    const st=document.createElement('style');st.textContent=\`
      #demo-cap{position:fixed;left:50%;transform:translateX(-50%);bottom:28px;z-index:99999;background:rgba(20,20,20,.9);color:#fff;font:600 clamp(15px,4.2vw,26px)/1.3 system-ui,Segoe UI,Arial;padding:12px 24px;border-radius:14px;max-width:88vw;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35);display:none}
      #demo-cur{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(255,80,60,.35);border:3px solid #ff503c;z-index:100000;pointer-events:none;transition:transform .05s,background .1s}
      #demo-cur.down{background:rgba(255,80,60,.85);transform:scale(.8)}
      #demo-card{position:fixed;inset:0;z-index:100001;display:none;align-items:center;justify-content:center;flex-direction:column;text-align:center;background:linear-gradient(135deg,#1b1b1b,#2b2b2b 55%,#4a3f00);color:#fff;font-family:system-ui,Segoe UI,Arial;padding:24px}
      #demo-card h1{font-size:clamp(28px,6vw,64px);margin:0 0 14px;color:#f4e36b}#demo-card p{font-size:clamp(16px,2.6vw,28px);margin:6px 0;opacity:.92}
    \`;document.head.appendChild(st);
    for(const [i,c] of [['demo-cap','div'],['demo-cur','div'],['demo-card','div']]){const e=document.createElement(c);e.id=i;document.body.appendChild(e)}
    window.prompt=(m,d)=>d||'';window.confirm=()=>true;window.alert=()=>{};
  })()`;
  // narration: a caption/card starts its voice clip; the next caption waits until the clip has finished (video holds still)
  const waitVoice = async () => { while (gf < lastEnd) await frame(); };
  const speak = key => { const v = VMAP[key]; if (!v) return; events.push({ t: gf / FPS, file: v.file }); lastEnd = gf + Math.ceil((v.dur + 0.4) * FPS); };
  const cap = async (t, bottom) => {
    await waitVoice();
    await ev(`(()=>{const c=document.getElementById('demo-cap');c.innerHTML=${J(t)};c.style.display=${J(t ? 'block' : 'none')};c.style.bottom=${J((bottom ?? (mobile ? 84 : 28)) + 'px')}})()`);
    if (t) speak(t);
  };
  const card = async (h, lines = []) => {
    await waitVoice();
    await ev(`(()=>{const c=document.getElementById('demo-card');c.innerHTML=${J(h ? `<h1>${h}</h1>` + lines.map(l => `<p>${l}</p>`).join('') : '')};c.style.display=${J(h ? 'flex' : 'none')}})()`);
    if (h) speak('card:' + h);
  };

  let cx = 40, cy = 40;
  const setCur = (x, y, down) => ev(`(()=>{const c=document.getElementById('demo-cur');c.style.transform='translate(${x}px,${y}px)';c.classList.toggle('down',${!!down})})()`);
  const rect = sel => ev(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+Math.min(r.width/2,60+r.width*0.2),y:r.top+r.height/2}})()`);
  const moveTo = async (x, y, steps = 9) => {
    const x0 = cx, y0 = cy;
    for (let i = 1; i <= steps; i++) { const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; await setCur(x0 + (x - x0) * e, y0 + (y - y0) * e); await frame(); }
    cx = x; cy = y;
  };
  const pointAt = async sel => { const r = await rect(sel); if (!r) throw new Error('no element ' + sel); await moveTo(r.x, r.y); return r; };
  const click = async (sel, wait = 0.5) => {
    const r = await pointAt(sel);
    await setCur(r.x, r.y, true); await frame(); await frame();
    await ev(`document.querySelector(${J(sel)}).click()`);
    await setCur(r.x, r.y, false); await hold(wait);
  };
  const type = async (sel, text, { per = 2, clear = true } = {}) => {
    const r = await pointAt(sel);
    await setCur(r.x, r.y, true); await frame(); await setCur(r.x, r.y, false);
    await ev(`(()=>{const e=document.querySelector(${J(sel)});e.focus();${clear ? 'e.value="";' : ''}})()`);
    for (let i = 1; i <= text.length; i++) {
      await ev(`(()=>{const e=document.querySelector(${J(sel)});e.value=${J(text.slice(0, i))};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      if (i % per === 0 || i === text.length) await frame();
    }
    await ev(`document.querySelector(${J(sel)}).dispatchEvent(new Event('change',{bubbles:true}))`);
    await frame();
  };
  const scrollTo = async (y, frames = 14) => {
    const y0 = await ev('window.scrollY');
    for (let i = 1; i <= frames; i++) { const t = i / frames, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; await ev(`window.scrollTo(0,${y0 + (y - y0) * e})`); await frame(); }
  };
  const page = h => ev(`location.hash=${J(h)}`);

  // ================= SETUP =================
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE }); await until('!!document.querySelector("#lf")', 'login form');
  await ev(INJECT); await setCur(-50, -50);

  // ================= PART 1 : ADMIN =================
  startSeg('a');
  await card('Billing Software', ['Multi-vendor invoicing with admin control', 'GST invoices · Dashboard · Item &amp; monthly sales']); await hold(3.5);
  await card(''); await cap('The admin signs in to the portal'); await hold(1.5);
  await type('#u', 'admin'); await type('#p', 'admin123');
  await click('#go', 0.8);
  await until('!!document.querySelector("#cf")', 'forced pw');
  await cap('First login: the admin must set a private password'); await hold(1.5);
  await type('#o', 'admin123'); await type('#n1', 'Admin@2026'); await type('#n2', 'Admin@2026');
  await click('#cf .primary', 1);
  await until('!!document.querySelector("#nav")', 'admin app');
  await cap('The admin adds a billing vendor (a client of yours)'); await hold(1.2);
  await click('#nav a[href="#/vendors"]', 0.8);
  await until('!!document.querySelector("#nv")', 'vendors');
  await type('#v_co', 'Sri Murugan Caterers', { per: 2 });
  await type('#v_us', 'murugan'); await type('#v_pw', 'Welcome@123');
  await cap('A temporary password is shared with the vendor'); await hold(0.8);
  await click('#nv .primary', 0.5);
  await until('document.body.innerText.includes("Vendor created")', 'vendor created');
  await cap('Vendor account created. The vendor must change the password at first login'); await hold(3);
  // (hidden) give the new vendor some older invoices so the dashboard looks lively
  await ev(`(async()=>{
    const us=await (await fetch('/api/admin/users',{headers:{'Content-Type':'application/json'}})).json();
    const v=us.find(u=>u.username==='murugan');
    const hdr={'Content-Type':'application/json','X-Workspace':v.id};
    const w=await (await fetch('/api/db',{headers:hdr})).json();
    const A={name:'ABC Software Pvt Ltd',address:'Tidel Park, Taramani\\nChennai - 600113',gst:'33AAACA1234A1Z5'};
    const G={name:'Global Tech Park Canteen',address:'OMR, Sholinganallur\\nChennai - 600119',gst:'33AABCG5678B1Z2'};
    w.customers=[{id:'c1',...A},{id:'c2',...G}];
    const inv=(n,date,c,lines,st,paid)=>({id:'seed'+n,no:'INV-'+n,date,customerId:c.name===A.name?'c1':'c2',billTo:c,shipTo:c,gstRate:5,status:st,paidDate:paid||'',lines:lines.map(([item,count,cost])=>({date,item,count,cost}))});
    w.invoices=[
      inv(1,'2026-09-12',A,[['Veg meals',35,120],['Tea',50,12]],'paid','2026-09-20'),
      inv(2,'2026-09-26',G,[['Samosa',120,15],['Tea',80,12],['Biryani',25,180]],'paid','2026-10-03'),
      inv(3,'2026-10-08',A,[['Veg meals',40,120],['Biryani',20,180],['Tea',60,12]],'paid','2026-10-15'),
      inv(4,'2026-10-18',G,[['Samosa',150,15],['Filter coffee',90,18],['Tea',70,12]],'unpaid'),
      inv(5,'2026-10-29',A,[['Veg meals',45,120],['Biryani',30,180],['Samosa',60,15]],'unpaid')];
    w.settings.nextNo=6;
    const r=await fetch('/api/db',{method:'PUT',headers:hdr,body:JSON.stringify(w)});return r.ok})()`);
  await cap('Admin can also customise the login-page logo and name'); await hold(0.5);
  await scrollTo(600, 16); await hold(2.2); await scrollTo(0, 12);
  await cap('Now the vendor signs in with the details they received'); await click('#logout', 0.8);
  await until('!!document.querySelector("#lf")', 'login'); await hold(1.2);

  // ================= PART 2 : VENDOR =================
  await type('#u', 'murugan'); await type('#p', 'Welcome@123');
  await click('#go', 0.8);
  await until('!!document.querySelector("#cf")', 'vendor forced pw');
  await cap('The vendor sets their own password'); await hold(1.2);
  await type('#o', 'Welcome@123'); await type('#n1', 'Murugan#2026'); await type('#n2', 'Murugan#2026');
  await click('#cf .primary', 1);
  await until('!!document.querySelector("#nav")', 'vendor app');
  await cap('Each vendor gets a private workspace: own data, own branding'); await hold(2.5);
  await cap('Step 1: set up the company profile'); await click('#nav a[href="#/settings"]', 0.6);
  await until('!!document.querySelector("[data-s=address]")', 'settings');
  await type('[data-s=address]', 'No 12, Anna Salai\nChennai - 600002', { per: 3 });
  await type('[data-s=phone]', '9876500000'); await type('[data-s=gst]', '33ABCDE1234F1Z5'); await type('[data-s=pan]', 'ABCDE1234F');
  await type('[data-s=prefix]', 'INV-');
  await scrollTo(520, 12);
  await type('[data-s=bankAccount]', '123456789012'); await type('[data-s=ifsc]', 'SBIN0000001'); await type('[data-s=bankName]', 'State Bank of India');
  await cap('Upload your own logo'); await scrollTo(1010, 14); await hold(0.4);
  await pointAt('#upl'); await setCur(cx, cy, true); await frame(); await frame(); await setCur(cx, cy, false);
  await ev(`(async()=>{const c=document.createElement('canvas');c.width=360;c.height=120;const g=c.getContext('2d');
    g.fillStyle='#c2410c';g.beginPath();g.arc(60,60,50,0,7);g.fill();g.fillStyle='#fff';g.font='bold 60px Arial';g.fillText('M',36,84);
    g.fillStyle='#c2410c';g.font='bold 44px Georgia';g.fillText('Murugan',126,64);g.font='19px Arial';g.fillStyle='#444';g.fillText('CATERERS & SNACKS',128,94);
    db.settings.logo=c.toDataURL('image/png');await save();renderChrome();settings();})()`);
  await hold(1.6);
  await cap('Pick a brand colour. The whole app and every invoice follow it');
  await pointAt('#clr'); await hold(0.4);
  await ev(`(()=>{const e=document.getElementById('clr');e.value='#c2410c';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await hold(2.2);
  await scrollTo(0, 10);

  await cap('Step 2: add the items you sell, with their price'); await click('#nav a[href="#/items"]', 0.6);
  await until('!!document.querySelector("#n_name")', 'items');
  for (const [nm, det, rt] of [['Veg meals', 'Full meals with sambar, rasam, curd', '120'], ['Tea', 'Masala tea', '12'], ['Samosa', 'Veg samosa with chutney', '15']]) {
    await type('#n_name', nm); await type('#n_det', det, { per: 3 }); await type('#n_rate', rt);
    await click('#n_add', 0.5);
    await until('!!document.querySelector("#n_name")', 'items re-render');
  }
  await hold(1.5);

  await cap('Step 3: create a GST invoice'); await click('a.btn.primary[href="#/new"]', 0.6);
  await until('!!document.querySelector("#no")', 'editor');
  await type('[data-p="billTo.name"]', 'Sunrise Apartments Association', { per: 3 });
  await type('[data-p="billTo.address"]', 'Velachery Main Road\nChennai - 600042', { per: 3 });
  await type('[data-p="billTo.gst"]', '33AAFSS4321C1Z8');
  await cap('Pick an item and the price fills in automatically');
  await type('[data-l="0.item"]', 'Veg meals'); await type('[data-l="0.count"]', '60');
  await click('#add', 0.3); await until('!!document.querySelector("[data-l=\\"1.item\\"]")', 'line 2');
  await type('[data-l="1.item"]', 'Tea'); await type('[data-l="1.count"]', '80');
  await click('#add', 0.3); await until('!!document.querySelector("[data-l=\\"2.item\\"]")', 'line 3');
  await type('[data-l="2.item"]', 'Samosa'); await type('[data-l="2.count"]', '100');
  await cap('CGST / SGST and the total are calculated live');
  await scrollTo(400, 10); await hold(2.2);
  await click('#save', 0.5);
  await until('!!document.querySelector(".paper")', 'invoice view');
  await cap('The invoice is ready: logo, GST, amount in words, bank details'); await scrollTo(0, 4); await hold(2.5);
  await scrollTo(520, 22); await hold(1.2); await scrollTo(1050, 22); await hold(2.5);
  await scrollTo(0, 12);
  await cap('Print or save as PDF with one click, then mark it as paid when money arrives');
  await pointAt('button[onclick="window.print()"]'); await hold(1.5);
  await click('#pay', 0.5); await until('document.getElementById("pay").innerText=="Mark unpaid"', 'paid');
  await cap('Status updates to PAID'); await hold(2);

  await cap('The dashboard shows sales month-wise and item-wise'); await click('#nav a[href="#/dashboard"]', 0.6);
  await until('!!document.querySelector("#period")', 'dashboard');
  await ev(`(()=>{const s=document.getElementById('period');s.value='all';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await hold(2.2);
  await scrollTo(430, 14); await hold(1.2);
  await cap('Monthly sales: billed, GST, received and pending'); await scrollTo(760, 14); await hold(2.5);
  await cap('Item-wise sales with quantity and share'); await scrollTo(1250, 16); await hold(3);
  await cap('Item × Month grid: see how each item sells over time'); await scrollTo(2100, 20); await hold(3);
  await scrollTo(0, 14);

  // ================= PART 3 : PHONE =================
  startSeg('m'); mobile = true;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await sleep(500); await page('#/dashboard'); await sleep(500); await setCur(-50, -50);
  await cap('Works beautifully on mobile too'); await hold(2.5);
  await scrollTo(380, 12); await hold(1.2); await scrollTo(0, 8);
  await cap('Bottom menu for one-thumb use'); await click('nav a[href="#/invoices"]', 0.6); await hold(1.4);
  await cap('Open any invoice'); await click('#rows tr', 0.6); await until('!!document.querySelector(".paper")', 'm invoice'); await hold(1.2);
  await scrollTo(700, 16); await hold(1.2); await scrollTo(1500, 16); await hold(1.6); await scrollTo(0, 10);
  await cap('Create a bill from your phone'); await click('a.btn.primary[href="#/new"]', 0.6); await hold(2);
  await cap('');

  // ================= PART 4 : ADMIN OVERVIEW =================
  startSeg('b'); mobile = false;
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await sleep(500); await ev('(async()=>{await fetch("/api/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});me=null;db=null;setWs("");applyTheme();showLogin()})()');
  await until('!!document.querySelector("#lf")', 'login'); await setCur(-50, -50);
  await cap('Back to the admin: sees every vendor at a glance'); await hold(1.2);
  await type('#u', 'admin'); await type('#p', 'Admin@2026'); await click('#go', 0.8);
  await until('!!document.querySelector("#nav")', 'admin app');
  await click('#nav a[href="#/vendors"]', 0.6); await until('!!document.querySelector("[data-open]")', 'vendors list');
  await cap('Invoices, total billed and pending amount for each vendor'); await hold(3.2);
  await cap('Open a vendor to view or support their billing'); await click('[data-open]', 0.8);
  await until('!!document.querySelector(".banner")', 'banner'); await hold(3);
  await cap('Disable access any time: the vendor is signed out instantly');
  await click('#exitws', 0.8); await until('!!document.querySelector("[data-tog]")', 'vendors'); await hold(1.2);
  await pointAt('[data-tog]'); await hold(2.2);
  await cap(''); await card('Thank you', ['Your own branded billing portal for every vendor', 'Login · Admin control · GST invoices · Sales dashboard']); await hold(4);

  await waitVoice(); await hold(0.6);
  ws.close(); proc.kill();

  // ================= ENCODE =================
  const run = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
  const parts = [];
  for (const s of ['a', 'm', 'b']) {
    const out = path.join(WORK, 'part_' + s + '.mp4');
    const vf = s === 'm'
      ? 'scale=-2:690,pad=1280:720:(ow-iw)/2:15:color=0x1b1b1b,format=yuv420p'
      : 'scale=1280:720,format=yuv420p';
    run('-framerate', String(FPS), '-i', path.join(dir(s), 'f%05d.jpg'), '-vf', vf, '-c:v', 'libx264', '-crf', '20', '-r', String(FPS), out);
    parts.push(out);
  }
  const list = path.join(WORK, 'list.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const silent = path.join(WORK, 'silent.mp4');
  run('-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent);
  if (events.length) {
    const args = ['-i', silent]; events.forEach(e => args.push('-i', path.join(VOICE, e.file)));
    const ms = e => Math.round(e.t * 1000);
    const fc = events.map((e, i) => `[${i + 1}:a]aresample=44100,adelay=${ms(e)}|${ms(e)}[a${i}]`).join(';') + ';' +
      events.map((e, i) => `[a${i}]`).join('') + `amix=inputs=${events.length}:normalize=0:dropout_transition=0,volume=1.6,apad[aout]`;
    run(...args, '-filter_complex', fc, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', OUTFILE);
    console.log('narration clips mixed:', events.length);
  } else fs.copyFileSync(silent, OUTFILE);
  console.log('DONE', OUTFILE);
  process.exit(0);
})().catch(e => { console.error('ERROR', e.stack || e.message); process.exit(2); });
