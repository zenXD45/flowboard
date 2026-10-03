/**
 * Mechanical design audit: contrast, motion values, consistency locks, and
 * touch targets — measured from the live DOM in both themes rather than guessed
 * from source. Prints findings; exits non-zero on hard failures.
 *
 *   node scripts/audit-ui.js [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:5173';
const API = process.env.API_URL || 'http://localhost:5002';
const CHROME =
  process.env.CHROME_PATH ||
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome`;

const findings = [];
const fail = (rule, what, detail) => findings.push({ level: 'FAIL', rule, what, detail });
const warn = (rule, what, detail) => findings.push({ level: 'warn', rule, what, detail });

/* ---------- colour maths (WCAG 2.1 relative luminance) ---------- */

const IN_PAGE = `
  window.__audit = (() => {
    const parse = (c) => {
      const m = c.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map((v) => parseFloat(v.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1
    });
    const ratio = (fg, bg) => {
      const L1 = lum(fg), L2 = lum(bg);
      const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
      return (hi + 0.05) / (lo + 0.05);
    };
    // Walk up for the first non-transparent background.
    const bgOf = (el) => {
      let node = el;
      while (node && node !== document.documentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0.95) return c;
        if (c && c.a > 0) return over(c, bgOf(node.parentElement || document.body));
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    return { parse, ratio, bgOf };
  })();
`;

function auditPage(page, label) {
  return page.evaluate((IN_PAGE_) => {
    // eslint-disable-next-line no-eval
    eval(IN_PAGE_);
    const { parse, ratio, bgOf } = window.__audit;
    const out = [];

    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.1) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // --- text contrast ---
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own) continue;
      const s = getComputedStyle(el);
      const fg = parse(s.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const r = ratio(fg.a < 1 ? { ...fg, ...(function (f, b) {
        return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 };
      })(fg, bg) } : fg, bg);
      const px = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (r < need) {
        out.push({
          kind: 'contrast',
          sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
          text: (el.textContent || '').trim().slice(0, 34),
          ratio: Math.round(r * 100) / 100,
          need,
          px: Math.round(px * 10) / 10
        });
      }
    }

    // --- touch targets ---
    const tap = [];
    for (const el of document.querySelectorAll('button, a[href], input, select, [role="button"]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 24 || r.width < 24) {
        tap.push({ sel: el.tagName.toLowerCase() + '.' + String(el.className || '').trim().split(/\\s+/)[0], w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    if (tap.length) out.push({ kind: 'tap', items: tap.slice(0, 14) });

    // --- radius scale ---
    const radii = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const r = getComputedStyle(el).borderRadius;
      if (r && r !== '0px' && !r.includes('50%') && !r.includes('9999px')) radii.add(r);
    }
    out.push({ kind: 'radii', values: [...radii].sort() });

    // --- font families in use ---
    const fams = new Set();
    for (const el of document.querySelectorAll('body, body *')) {
      if (!visible(el)) continue;
      fams.add(getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim());
    }
    out.push({ kind: 'fonts', values: [...fams].sort() });

    // --- motion ---
    const motion = { all: [], longDur: [], easeIn: [], scaleZero: [] };
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      const props = ['transition-duration', 'animation-duration'];
      const p = s.transitionProperty || '';
      const t = s.transitionTimingFunction || '';
      // `transition-property` computes to the initial value `all` on every
      // element, so only flag it when a duration is actually in play.
      const hasDur = parseFloat(s['transition-duration']) > 0;
      if (p.includes('all') && hasDur) motion.all.push({ sel: el.tagName.toLowerCase() + '.' + String(el.className || '').trim().split(/\\s+/)[0], p });
      for (const prop of props) {
        const v = parseFloat(s[prop]);
        if (v > 0.3) motion.longDur.push({ sel: el.tagName.toLowerCase() + '.' + String(el.className || '').trim().split(/\\s+/)[0], prop, v });
      }
      if (/\\bease-in\\b/.test(t)) motion.easeIn.push({ sel: el.tagName.toLowerCase(), t });
      const tr = s.transform;
      if (tr && tr !== 'none') { const m = tr.match(/matrix\\(([^)]+)\\)/); if (m && Math.abs(parseFloat(m[1].split(',')[0])) < 0.001) motion.scaleZero.push({ sel: el.tagName.toLowerCase(), tr }); }
    }
    out.push({ kind: 'motion', ...motion });

    // --- horizontal overflow (mobile) ---
    out.push({ kind: 'overflow', scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth });

    return out;
  }, IN_PAGE);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  // Sign in through the API, then hand the token to the page.
  const stamp = Date.now().toString(36).slice(-6);
  const user = `aud${stamp}`;
  const res = await fetch(`${API}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: 'supersecret123' })
  });
  if (res.status !== 201) {
    console.error(`signup failed (${res.status}) — restart the API to clear the auth rate limiter`);
    process.exit(1);
  }
  const { token } = await res.json();

  // Board with content, via socket.
  const { io } = await import('socket.io-client');
  const socket = io(API, { auth: { token }, transports: ['websocket'] });
  await new Promise((r, j) => { socket.on('connect', r); socket.on('connect_error', j); setTimeout(() => j(new Error('ws')), 8000); });
  const call = (event, payload) => new Promise((res2, rej) => socket.emit(event, payload, (ack) => (ack.status === 'ok' ? res2(ack) : rej(new Error(`${event}: ${ack.message}`)))));
  const made = await call('board:create', { title: 'Platform' });
  const boardId = made.board.id;
  await call('board:join', { boardId });
  const listId = made.board.lists[0].id;
  const desc = 'Fractional positioning plus the precision floor that triggers renumbering.';
  const a = await call('card:create', { boardId, listId, title: 'Write the ordering spec', index: 0 });
  await call('card:update', { boardId, cardId: a.card.id, patch: { description: desc, labels: ['docs', 'p1', 'design'] }, expectedVersion: a.card.version });
  const b = await call('card:create', { boardId, listId, title: 'Fix the presence flicker', index: 1 });
  await call('card:update', { boardId, cardId: b.card.id, patch: { labels: ['bug', 'p2', 'p3'] }, expectedVersion: b.card.version });
  const c = await call('card:create', { boardId, listId, title: 'Accessibility audit', index: 2 });
  await call('comment:add', { boardId, cardId: c.card.id, body: 'Focus trap works. Re-check the label chips.' });
  socket.close();

  const scenarios = [
    { name: 'auth', url: `${BASE}/#/`, token: null, vp: { width: 1440, height: 900 } },
    { name: 'board', url: `${BASE}/#/board/${boardId}`, token, vp: { width: 1440, height: 900 }, wait: '.column' },
    { name: 'board-card-panel', url: `${BASE}/#/board/${boardId}`, token, vp: { width: 1440, height: 900 }, wait: '.column', openCard: true },
    { name: 'dashboard', url: `${BASE}/#/`, token, vp: { width: 1440, height: 900 }, wait: '.dash' },
    { name: 'board-mobile', url: `${BASE}/#/board/${boardId}`, token, vp: { width: 414, height: 896 }, wait: '.column' }
  ];

  for (const theme of ['dark', 'light']) {
    for (const sc of scenarios) {
      if (theme === 'light' && sc.vp.width < 500) continue;
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await page.setViewport({ ...sc.vp, deviceScaleFactor: 1 });
      await page.goto(sc.url, { waitUntil: 'domcontentloaded' });
      await page.evaluate((t) => {
        if (t) window.localStorage.setItem('flowboard:token', t);
        else window.localStorage.removeItem('flowboard:token');
      }, sc.token);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(sc.wait || '.auth__card', { timeout: 20000 });

      // Guard against a vacuous pass: if the seed silently failed, the audit
      // would report "clean" while never having looked at a label chip.
      if (sc.wait === '.column') {
        const n = await page.$$eval('.label', (e) => e.length);
        if (n === 0) fail('fixture', 'label chips', 'no .label rendered — the seed did not apply, so this audit is not trustworthy');
        else console.log(`  label chips rendered: ${n}`);
      }
      await new Promise((r) => setTimeout(r, 450));
      if (sc.openCard) {
        await page.evaluate(() => {
          const el = document.querySelector('.boardcard') || document.querySelector('.card');
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        await page.waitForSelector('.sheet__body', { timeout: 8000 });
        await new Promise((r) => setTimeout(r, 350));
      }
      const res = await auditPage(page, sc.name);
      console.log(`\n=== ${theme} / ${sc.name} ===`);
      for (const item of res) {
        if (item.kind === 'contrast') {
          const line = `  ${item.ratio}:1 (needs ${item.need}) ${item.px}px  ${item.sel}  "${item.text}"`;
          (item.ratio < item.need - 0.9 ? fail : warn)('contrast', item.sel, line);
        } else if (item.kind === 'tap') {
          warn('tap-target', 'small hit areas', item.items.map((i) => `${i.sel} ${i.w}×${i.h}`).join(', '));
        } else if (item.kind === 'radii') {
          console.log('  radii:', item.values.join(' '));
        } else if (item.kind === 'fonts') {
          console.log('  fonts:', item.values.join(' | '));
        } else if (item.kind === 'motion') {
          if (item.all.length) warn('motion', 'transition:all', item.all.slice(0, 5).map((i) => i.sel).join(', '));
          if (item.longDur.length) warn('motion', 'duration>300ms', item.longDur.slice(0, 5).map((i) => `${i.sel} ${i.prop}=${i.v}s`).join(', '));
          if (item.easeIn.length) warn('motion', 'ease-in', item.easeIn.slice(0, 5).map((i) => i.sel).join(', '));
          if (item.scaleZero.length) warn('motion', 'scale(0) entry', item.scaleZero.slice(0, 5).map((i) => i.sel).join(', '));
        } else if (item.kind === 'overflow') {
          if (item.scrollW > item.clientW + 1) warn('overflow', 'horizontal scroll', `${item.scrollW} > ${item.clientW}`);
        }
      }
    }
  }

  await ctx.close();
  await browser.close();

  console.log('\n--- findings ---');
  if (!findings.length) console.log('none');
  for (const f of findings) console.log(`  ${f.level}  ${f.rule}  ${f.detail}`);
  const hard = findings.filter((f) => f.level === 'FAIL').length;
  console.log(`\n${hard} hard failures, ${findings.length - hard} warnings\n`);
}

main().catch((e) => {
  console.error('audit crashed:', e.message);
  process.exit(1);
});
