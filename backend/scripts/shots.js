/**
 * Seed a realistic board over the socket API (deterministic, fast) and capture
 * the UI across viewports and themes.
 *   node scripts/shots.js [outDir] [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[3] || process.env.BASE_URL || 'http://localhost:5173';
const API = process.env.API_URL || 'http://localhost:5002';
const CHROME =
  process.env.CHROME_PATH ||
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome`;
const OUT = process.argv[2] || '/tmp/opencode/shots';

const SEED = [
  ['To Do', 'Write the ordering spec', 'Fractional positioning plus the precision floor that triggers renumbering.', ['docs']],
  ['To Do', 'Fix the presence flicker', 'fetchSockets on every join causes a visible flash on slow networks.', ['bug', 'p2']],
  ['To Do', 'Accessibility audit', 'Focus trap works. Re-check the label chips against both themes.', []],
  ['In Progress', 'Card:move conflict path', 'Rollback must keep the whole prior object, not only patched fields.', ['bug', 'p1']],
  ['In Progress', 'Redis adapter smoke test', '', []],
  ['Done', 'Ship the deploy notes', '', []],
  ['Done', 'Archive the v1 board shape', '', []]
];

mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36).slice(-6);
const owner = `shot${stamp}`;
const mate = `mate${stamp}`;
const PW = 'supersecret123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
}

const call = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack: ${event}`)), 8000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });

/** Build a board with real content so density and hierarchy can be judged. */
async function seed() {
  const a = await post('/api/auth/signup', { username: owner, password: PW });
  await post('/api/auth/signup', { username: mate, password: PW });
  if (a.status !== 201) throw new Error(`signup failed: ${a.status}`);

  const token = a.data.token;
  const socket = await connect(token);

  const created = await call(socket, 'board:create', { title: 'Platform' });
  const boardId = created.board.id;
  await call(socket, 'board:join', { boardId });
  await call(socket, 'member:add', { boardId, username: mate, role: 'member' });
  await call(socket, 'board:update', { boardId, description: 'Real-time ordering, presence, and access control.' });

  // A second board so the dashboard grid has something to compose.
  const second = await call(socket, 'board:create', { title: 'Design system' });
  await call(socket, 'board:join', { boardId: second.board.id });
  await call(socket, 'list:create', { boardId: second.board.id, title: 'Tokens', index: 0 });
  await call(socket, 'card:create', {
    boardId: second.board.id,
    listId: second.board.lists[0].id,
    title: 'Colour and radius tokens',
    index: 0
  });

  const lists = created.board.lists;
  const counts = [0, 0, 0];
  for (const [listName, title, desc, labels] of SEED) {
    const list = lists.find((l) => l.title === listName) || lists[counts.indexOf(0)];
    const idx = lists.indexOf(list);
    const created_card = await call(socket, 'card:create', { boardId, listId: list.id, title, index: counts[idx] });
    // card:update is optimistically locked, so every patch must state the
    // version it was based on. Skipping this fails silently and leaves the
    // seeded card without its description or labels.
    let version = created_card.card.version;
    if (desc) {
      const ack = await call(socket, 'card:update', { boardId, cardId: created_card.card.id, patch: { description: desc }, expectedVersion: version });
      if (ack.status !== 'ok') throw new Error(`seed description failed: ${ack.message}`);
      version = ack.card.version;
    }
    if (labels.length) {
      const ack = await call(socket, 'card:update', { boardId, cardId: created_card.card.id, patch: { labels }, expectedVersion: version });
      if (ack.status !== 'ok') throw new Error(`seed labels failed: ${ack.message}`);
    }
    counts[idx] += 1;
  }

  // A comment and an assignee so the card panel is not an empty shell.
  const snapshot = await fetch(`${API}/api/boards/${boardId}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then((r) => r.json());
  const target = snapshot.cards.find((c) => c.title === 'Card:move conflict path');
  if (target) {
    await call(socket, 'comment:add', {
      boardId,
      cardId: target.id,
      body: 'Rollback must restore the full object, otherwise fields from a previous edit survive.'
    });
    await call(socket, 'card:update', {
      boardId,
      cardId: target.id,
      patch: { dueDate: new Date(Date.now() + 86_400_000).toISOString() }
    });
  }

  socket.close();
  return { token, boardId };
}

async function main() {
  console.log(`seeding ${owner}…`);
  const { token, boardId } = await seed();
  await post('/api/auth/login', { username: owner, password: PW });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  // Headless Chrome reports prefers-color-scheme: light by default, so the theme
  // has to be pinned before the first navigation or every "dark" shot is
  // actually a duplicate of its light counterpart.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  page.on('console', (m) => m.type() === 'error' && console.log('  [console]', m.text().slice(0, 200)));
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)));
  page.on('requestfailed', (r) => console.log('  [reqfail]', r.url(), r.failure()?.errorText));

  // Seed the browser session directly; no need to drive the signup form.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => window.localStorage.setItem('flowboard:token', t), token);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`  ${OUT}/${name}.png`);
  };

  const settle = (ms = 500) => sleep(ms);

  const openBoard = async (id) => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((boardId) => { window.location.hash = `#/board/${boardId}`; }, id);
    await page.waitForSelector('.column', { timeout: 20000 });
    await settle();
  };

  // --- auth -------------------------------------------------------------
  const anon = await browser.createBrowserContext();
  const anonPage = await anon.newPage();
  await anonPage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await anonPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await anonPage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await anonPage.waitForSelector('.auth__card', { timeout: 20000 });
  await anonPage.screenshot({ path: `${OUT}/01-signin.png` });
  console.log(`  ${OUT}/01-signin.png`);
  await anonPage.evaluate(() => document.querySelector('.auth__swap button')?.click());
  await anonPage.waitForSelector('input[autocomplete="username"]');
  await anonPage.type('input[autocomplete="username"]', 'ada');
  await anonPage.type('input[autocomplete="new-password"], input[autocomplete="current-password"]', 'supersecret123');
  await anonPage.screenshot({ path: `${OUT}/02-signup.png` });
  console.log(`  ${OUT}/02-signup.png`);
  await anon.close();

  // --- dashboard --------------------------------------------------------
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.boardcard', { timeout: 20000 });
  await settle();
  await shot('07-dashboard');

  // --- board ------------------------------------------------------------
  await openBoard(boardId);
  await shot('03-board');

  // --- card panel -------------------------------------------------------
  await page.evaluate(() => document.querySelector('.card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await page.waitForSelector('.sheet__body', { timeout: 10000 });
  await settle();
  await shot('04-card-panel');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.scrim'), { timeout: 5000 });

  // --- people -----------------------------------------------------------
  await page.click('[data-testid="open-people"]');
  await page.waitForSelector('.people', { timeout: 10000 });
  await settle();
  await shot('05-people');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.scrim'), { timeout: 5000 });

  // --- activity ---------------------------------------------------------
  await page.click('[data-testid="open-activity"]');
  await page.waitForSelector('.feed li', { timeout: 10000 });
  await settle();
  await shot('06-activity');

  // --- light mode -------------------------------------------------------
  await page.keyboard.press('Escape');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await openBoard(boardId);
  await shot('08-board-light');

  // --- light card panel -------------------------------------------------
  await page.evaluate(() => document.querySelector('.card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await page.waitForSelector('.sheet__body', { timeout: 10000 });
  await settle();
  await shot('11-card-panel-light');

  // --- mobile -----------------------------------------------------------
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  await openBoard(boardId);
  await shot('09-board-mobile');

  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dash__new', { timeout: 20000 });
  await settle();
  await shot('10-dashboard-mobile');

  // --- mobile auth ------------------------------------------------------
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.auth__card', { timeout: 20000 });
  await settle();
  await shot('12-signin-mobile');

  await ctx.close();
  await browser.close();
  console.log(`\nboard: ${API}/#/board/${boardId}\nlogin: ${owner} / ${PW}\n`);
}

main().catch((err) => {
  console.error('\nshots failed:', err.message);
  process.exit(1);
});
