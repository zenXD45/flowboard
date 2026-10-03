import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME =
  process.env.CHROME_PATH ||
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome`;
const BASE = process.env.BASE || 'http://localhost:5002';
const OUT = process.env.OUT || '/tmp/opencode/shots-android';
const ANDROID = process.env.ANDROID === '1';

// Pixel 7 class device. 412x915 css px is the realistic Android viewport.
const DEVICES = {
  android: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' },
  // A small, very common budget Android width (Galaxy A-series / older devices).
  androidSm: { width: 360, height: 740, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false }
};

const which = process.argv[2] || 'android';
const device = DEVICES[which];
const tag = which;

if (!existsSync(OUT)) (await import('node:fs')).mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport(device);
if (device.userAgent) await page.setUserAgent(device.userAgent);

const log = (...a) => console.log(...a);
// Trap every route change so the culprit is identifiable rather than guessed at.
await page.evaluateOnNewDocument(`(() => {
  window.__nav = [];
  const note = (how) => window.__nav.push({ how, hash: location.hash, stack: new Error().stack });
  window.addEventListener('hashchange', () => note('hashchange'));
  const origRS = history.replaceState.bind(history);
  history.replaceState = (...a) => { note('replaceState'); return origRS(...a); };
  const origPS = history.pushState.bind(history);
  history.pushState = (...a) => { note('pushState'); return origPS(...a); };
  window.addEventListener('pagehide', () => note('pagehide'));
  window.addEventListener('popstate', (e) => note('popstate state=' + JSON.stringify(e.state)));
  document.addEventListener('touchend', (e) => note('touchend on ' + (e.target.className || e.target.tagName)), true);
  document.addEventListener('click', (e) => note('click:' + (e.target.className || e.target.tagName)), true);
})()`);
page.on('console', (m) => { if (m.type() === 'error') log('  [console.error]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => log('  [pageerror]', String(e).slice(0, 400)));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) log('  [navigated]', f.url()); });
page.on('load', () => log('  [load event]'));
const user = `aud${Date.now().toString().slice(-6)}`;

// ---------------------------------------------------------------- sign up
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.auth__card', { timeout: 20000 });
await page.screenshot({ path: `${OUT}/${tag}-1-auth.png` });

// The card opens in login mode; switch to signup so a password field with
// autocomplete="new-password" exists.
await page.evaluate(() => {
  const swap = [...document.querySelectorAll('.auth__swap button')].find((b) => b.textContent.trim() === 'Create one');
  if (swap) swap.click();
});
await page.waitForSelector('input[autocomplete="new-password"]', { timeout: 10000 });
await page.type('input[autocomplete="username"]', user);
await page.type('input[autocomplete="new-password"]', 'supersecret123');
await Promise.all([
  page.waitForSelector('.dash', { timeout: 20000 }),
  page.click('button[type="submit"]')
]);
await page.screenshot({ path: `${OUT}/${tag}-2-dashboard.png` });

// ------------------------------------------------------- board + two cards
await page.type('.dash__new input', 'Sprint 14');
await page.click('.dash__new button[type="submit"]');
await page.waitForSelector('.column', { timeout: 20000 });

const SEED = ['Tap to open a card', 'Drag me across columns'];
// Pad the first column past the height of a phone viewport so the internal
// column scroll is genuinely exercised rather than skipped for want of content.
for (let i = SEED.length; i < 20; i += 1) SEED.push(`Filler card ${i + 1}`);
for (const title of SEED) {
  await page.click('.column:nth-of-type(1) .column__add');
  await page.waitForSelector('.column:nth-of-type(1) .composer', { timeout: 8000 });
  await page.type('.column:nth-of-type(1) .composer', title);
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 400));
}
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: `${OUT}/${tag}-3-board.png` });

// ------------------------------------------------------------------ audit
const report = await page.evaluate(() => {
  const doc = document.documentElement;
  const overflow = doc.scrollWidth - doc.clientWidth;

  // Anything the user can actually press.
  const interactive = [...document.querySelectorAll('button, a, input, textarea, select, [tabindex="0"]')];
  const small = [];
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.closest('[hidden]')) continue;
    if (r.height < 44 || r.width < 44) {
      small.push({
        cls: el.className?.toString().slice(0, 46) || el.tagName,
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 26),
        w: Math.round(r.width),
        h: Math.round(r.height)
      });
    }
  }

  const board = document.querySelector('.board');
  const col = document.querySelector('.column');
  const shell = document.querySelector('.board-shell');
  const card = document.querySelector('.card');

  return {
    overflowPx: overflow,
    boardScrollsHorizontally: board ? board.scrollWidth > board.clientWidth : null,
    columnWidth: col ? Math.round(col.getBoundingClientRect().width) : null,
    shellHeight: shell ? Math.round(shell.getBoundingClientRect().height) : null,
    innerHeight: window.innerHeight,
    cardTouchAction: card ? getComputedStyle(card).touchAction : null,
    bodyTouchAction: getComputedStyle(document.body).touchAction,
    columnBodyOverflowY: (() => {
      const cb = document.querySelector('.column__body');
      return cb ? getComputedStyle(cb).overflowY : null;
    })(),
    tooSmallTargets: small
  };
});

log(`\n===== ${which.toUpperCase()} (${device.width}x${device.height}) =====`);
log(JSON.stringify(report, null, 1));

// ------------------------------------ touch: flick-scroll vs long-press drag
if (device.hasTouch) {
  const cdp = await page.target().createCDPSession();
  const titlesIn = (n) => `(() => {
    const cols = [...document.querySelectorAll('.column')];
    const c = cols[${n}];
    return c ? [...c.querySelectorAll('.card__title')].map((e) => e.textContent) : null;
  })()`;
  const geoOf = `(() => {
    const cols = [...document.querySelectorAll('.column')];
    if (cols.length < 2) return null;
    const c = cols[0].querySelector('.card');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const t = cols[1].querySelector('.column__body').getBoundingClientRect();
    return { from: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
             to:   { x: t.x + t.width / 2, y: t.y + 70 } };
  })()`;
  const boardRect = `(() => {
    const b = document.querySelector('.board').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  })()`;
  const scrollState = `(() => {
    const b = document.querySelector('.board');
    return { left: b.scrollLeft, max: b.scrollWidth - b.clientWidth };
  })()`;

  // --- 1. a real horizontal swipe must scroll the board and must NOT navigate.
  // synthesizeScrollGesture drives the compositor's own gesture recognizer, so
  // touch-action and overscroll-behavior are genuinely exercised. Dispatching
  // raw touchMove events does not: Chrome never starts a scroll from them.
  // A timed touch sequence, not Input.synthesizeScrollGesture: that helper was
  // measured inert in this headless build -- it failed to scroll a container
  // that was known to be scrollable, and with both `touch` and `mouse` source
  // types. Dispatching real touchmove events over ~500ms does drive the
  // compositor, so that is what the scroll assertions below rely on.
  const swipe = async (fromX, fromY, dx, dy, steps = 20) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY }] });
    for (let k = 1; k <= steps; k += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: Math.round(fromX + (dx * k) / steps), y: Math.round(fromY + (dy * k) / steps) }]
      });
      await new Promise((r) => setTimeout(r, 24));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, 900));
  };

  const hashStart = await page.evaluate('location.hash');
  const s0 = await page.evaluate(scrollState);
  const br = await page.evaluate(boardRect);
  // Seeding clicks the add-card button, which scrolls the column body to reach
  // it. Without this reset the first card sits above the visible column and
  // every gesture below starts on the topbar instead of on a card.
  await page.evaluate(`(() => {
    document.querySelector('.board').scrollLeft = 0;
    document.querySelector('.column__body').scrollTop = 0;
    window.__nav.length = 0;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const onCard = await page.evaluate(`(() => {
    const c = document.querySelector('.column:nth-of-type(1) .card');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 20) };
  })()`);
  // Measured after the reset on purpose: before it, this point came from the
  // scrolled-out position and every swipe landed on the topbar.
  const swipeFrom = onCard || { x: Math.round(br.x), y: Math.round(br.y) };
  await swipe(swipeFrom.x, swipeFrom.y, -240, 0);
  const s1 = await page.evaluate(scrollState);
  const hashAfterFlick = await page.evaluate('location.hash');
  log(`SWIPE on a card across the board -> board panned? ${s1.left !== s0.left ? `YES (${Math.round(s0.left)} -> ${Math.round(s1.left)} of ${Math.round(s1.max)})` : 'NO  <-- cannot pan from a card'}`);
  log(`  still on the board? ${hashAfterFlick === hashStart ? 'YES' : `NO  <-- history nav (${hashStart} -> ${hashAfterFlick})`}`);
  const navByGesture = ((await page.evaluate('window.__nav')) || []).filter(
    (n) => ['hashchange', 'popstate', 'pushState', 'replaceState'].includes(n.how)
  );
  log(`  route changes caused by the gesture: ${navByGesture.length === 0 ? 'NONE (correct)' : JSON.stringify(navByGesture)}`);
  await page.screenshot({ path: `${OUT}/${tag}-5a-flick.png` });

  // --- 4. a column body with more cards than fit must scroll internally
  const inner = await page.evaluate(`(() => {
    const b = document.querySelector('.column__body');
    const card = document.querySelector('.card');
    const r = card.getBoundingClientRect();
    const br2 = b.getBoundingClientRect();
    return { top: Math.round(r.y - br2.y),
             over: b.scrollHeight > b.clientHeight + 2,
             h: b.clientHeight };
  })()`);
  log(`COLUMN scroll -> body clips its content? ${inner.over ? `YES (card ${inner.top}px down, body ${inner.h}px tall)` : 'no overflow to test'}`);
  if (inner.over) {
    await page.evaluate(`(() => {
      document.querySelector('.board').scrollLeft = 0;
      document.querySelector('.column__body').scrollTop = 0;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const y0 = await page.evaluate(`document.querySelector('.column__body').scrollTop`);
    // Start over a card in the middle of the body. 30px up from the bottom lands
    // inside the composer input, and an input scrolls its own caret rather than
    // the column behind it, so the gesture was testing nothing.
    const vp = await page.evaluate(`(() => {
      const r = document.querySelector('.column__body').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.6) };
    })()`);
    await swipe(vp.x, vp.y, 0, -170);
    const y1 = await page.evaluate(`document.querySelector('.column__body').scrollTop`);
    const hashNow = await page.evaluate('location.hash');
    log(`  vertical swipe inside a column -> body scrolled? ${y1 !== y0 ? `YES (${Math.round(y0)} -> ${Math.round(y1)})` : 'NO'}`);
    log(`  still on the board? ${hashNow === hashStart ? 'YES' : 'NO  <-- pull-to-refresh/nav'}`);
    await page.screenshot({ path: `${OUT}/${tag}-6-column-scroll.png` });
  }
  // --- 2. a long press then drag must move the card between columns
  await page.evaluate(`(() => {
    document.querySelector('.board').scrollLeft = 0;
    document.querySelector('.column__body').scrollTop = 0;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const before = await page.evaluate(titlesIn(0));
  let g = await page.evaluate(geoOf);
  if (!g) {
    log('LONG-PRESS DRAG -> could not locate two columns with a card');
  } else {
    await page.touchscreen.touchStart(g.from.x, g.from.y);
    await new Promise((r) => setTimeout(r, 320));           // hold: past the 200ms threshold
    for (let i = 1; i <= 14; i += 1) {
      await page.touchscreen.touchMove(
        g.from.x + ((g.to.x - g.from.x) * i) / 14,
        g.from.y + ((g.to.y - g.from.y) * i) / 14
      );
      await new Promise((r) => setTimeout(r, 30));
    }
    await page.screenshot({ path: `${OUT}/${tag}-5b-mid-drag.png` });
    await page.touchscreen.touchEnd();
    await new Promise((r) => setTimeout(r, 1200));
    const after = await page.evaluate(titlesIn(0));
    const stillOnBoard = (await page.evaluate('location.hash')) === hashStart;
    const moved = JSON.stringify(before) !== JSON.stringify(after);
    const sheetOpen = await page.evaluate(`Boolean(document.querySelector('.sheet'))`);
    log(`LONG-PRESS DRAG col1 -> col2 moved the card? ${moved ? 'YES' : 'NO'}`);
    log(`  stayed on the board? ${stillOnBoard ? 'YES' : 'NO  <-- ejected by the drag'}`);
    log(`  drag also opened the sheet (false click leak)? ${sheetOpen ? 'YES  <-- BUG' : 'no'}`);
    log(`  col1 before: ${JSON.stringify(before)}`);
    log(`  col1 after:  ${JSON.stringify(after)}`);
    await page.screenshot({ path: `${OUT}/${tag}-5-after-drag.png` });
    if (sheetOpen) { await page.click('.scrim'); await new Promise((r) => setTimeout(r, 450)); }
  }

  // --- 3. a single tap must open the card
  if (await page.evaluate(`document.querySelectorAll('.card').length`)) {
    await page.tap('.card');
    await new Promise((r) => setTimeout(r, 800));
    const opened = await page.evaluate(`Boolean(document.querySelector('.sheet'))`);
    log(`TAP a card -> sheet opens? ${opened ? 'YES' : 'NO  <-- cards unreachable on touch'}`);
    await page.screenshot({ path: `${OUT}/${tag}-4-card-sheet.png` });
    if (opened) { await page.click('.scrim'); await new Promise((r) => setTimeout(r, 450)); }
  }

}

// ------------------------------------------------------------- panel views
const survived = await page.evaluate(`document.querySelectorAll('[data-testid="open-people"]').length`);
if (!survived) { log('(lost the board before the panel views — skipping)'); await browser.close(); process.exit(0); }
await page.click('[data-testid="open-people"]');
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${OUT}/${tag}-6-people.png` });
await page.click('.scrim');
await new Promise((r) => setTimeout(r, 400));
await page.click('[data-testid="open-activity"]');
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${OUT}/${tag}-7-activity.png` });

await browser.close();
log(`\nscreenshots -> ${OUT}\n`);
