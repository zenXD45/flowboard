/**
 * End-to-end proof that the real-time path works in a real browser: two separate
 * sessions, one dragging a card, the other watching it move. Run with the API up
 * and the frontend built (`npm run build` in ../frontend).
 *
 *   node scripts/browser-test.js
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5002';
const CHROME =
  process.env.CHROME_PATH ||
  `${process.env.HOME}/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome`;

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed });
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const stamp = Date.now().toString(36).slice(-6);

async function signUp(page, username) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.auth__card', { timeout: 15000 });
  await page.evaluate(() => {
    const swap = document.querySelector('.auth__swap button');
    if (swap && swap.textContent.trim() === 'Create one') swap.click();
  });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.type('input[autocomplete="username"]', username);
  await page.type('input[autocomplete="current-password"], input[autocomplete="new-password"]', 'supersecret123');
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForSelector('.dash', { timeout: 15000 })
  ]);
}

/** dnd-kit listens for pointer events, so drive them through the mouse API. */
async function dragCard(page, fromSelector, toSelector) {
  const from = await page.$(fromSelector);
  const to = await page.$(toSelector);
  if (!from || !to) throw new Error('drag targets not found');

  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('drag targets have no layout box');

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // Several intermediate moves: dnd-kit needs a real movement threshold crossed,
  // not a single teleport, before it will claim the drag.
  const steps = 22;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await page.mouse.move(
      a.x + a.width / 2 + (b.x + b.width / 2 - a.x - a.width / 2) * t,
      a.y + a.height / 2 + (b.y + 90 - a.y - a.height / 2) * t
    );
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 220));
  await page.mouse.up();
}

/** Which column each visible card currently sits in, e.g. ['In Progress']. */
const listTitlesOfCards = (page) =>
  page.$$eval('.card', (els) =>
    els
      .map((el) => el.closest('.column'))
      .filter(Boolean)
      .map((col) => col.querySelector('.column__title')?.textContent?.trim())
  );

const waitFor = async (fn, { timeout = 12000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`\nNo Chrome at ${CHROME}. Set CHROME_PATH to your binary.\n`);
    process.exit(1);
  }

  console.log(`\nFlowBoard browser test — ${BASE}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,900']
  });

  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.setViewport({ width: 1400, height: 900 });
    await pageB.setViewport({ width: 1400, height: 900 });

    const owner = `brwa${stamp}`;
    const mate = `brwb${stamp}`;

    await signUp(pageA, owner);
    check('session A signs up and reaches the dashboard', true);

    await signUp(pageB, mate);
    check('session B signs up in an isolated browser context', true);

    // A creates the board.
    await pageA.type('.dash__new input', 'Browser Board');
    await pageA.click('.dash__new button[type="submit"]');
    await pageA.waitForSelector('.column', { timeout: 15000 });
    const boardUrl = pageA.url();
    check('creating a board lands on the board view', /#\/board\//.test(boardUrl), boardUrl);

    // A invites B by username.
    await pageA.click('[data-testid="open-people"]');
    await pageA.waitForSelector('.invite input', { timeout: 8000 });
    await pageA.type('.invite input', mate);
    await pageA.click('.invite button');
    await waitFor(async () => (await pageA.$$('.people li')).length === 2, { label: 'B in member list' });
    check('owner adds B through the People panel', true);

    // Close the sheet — its scrim covers the board and would swallow clicks.
    await pageA.click('.scrim');
    await waitFor(async () => (await pageA.$('.scrim')) === null, { label: 'people panel closing' });

    // B opens the same board.
    await pageB.goto(boardUrl, { waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('.column', { timeout: 15000 });
    check('B can open the board they were invited to', true);

    // Both presence bars should report two people.
    await waitFor(async () => (await pageB.$eval('.presence__label', (el) => el.textContent)) === '2 here', {
      label: 'presence on B'
    });
    check('B sees "2 here" in the presence bar', true);

    // A creates a card in the first column.
    await pageA.click('.column:nth-of-type(1) .column__add');
    await pageA.waitForSelector('.column:nth-of-type(1) .composer', { timeout: 8000 });
    await pageA.type('.column:nth-of-type(1) .composer', 'Verify real time');
    await pageA.keyboard.press('Enter');

    await waitFor(async () => (await pageB.$$('.card')).length === 1, { label: 'card arriving on B' });
    check('card created by A appears on B without a refresh', true);

    // A drags the card into the second column.
    const beforeDrag = (await listTitlesOfCards(pageB))[0];
    await dragCard(pageA, '.column:nth-of-type(1) .card', '.column:nth-of-type(2) .column__body');

    await waitFor(async () => (await listTitlesOfCards(pageB)).includes('In Progress'), {
      label: 'card moving to In Progress on B'
    });
    const afterDrag = (await listTitlesOfCards(pageB))[0];
    check('a drag by A relocates the card on B', beforeDrag !== afterDrag, `${beforeDrag} -> ${afterDrag}`);

    // The move survives a reload because the server, not the client, owns the truth.
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('.column', { timeout: 15000 });
    await waitFor(async () => (await listTitlesOfCards(pageB)).length === 1, { label: 'card after reload' });
    const afterReload = (await listTitlesOfCards(pageB))[0];
    check('the new position is durable across a reload', afterReload === 'In Progress', afterReload);

    // Regression guard. The API used to emit an ETag with no Cache-Control, so
    // the browser was free to revalidate the session with If-None-Match and get
    // a bodyless 304 back — which the client reads as a dead session and clears
    // the token. The symptom was a reload that silently dropped you to the
    // sign-in screen, at random.
    const sessionProbe = await pageA.evaluate(async () => {
      const res = await fetch('http://localhost:5002/api/auth/me', {
        headers: { Authorization: 'Bearer ' + window.localStorage.getItem('flowboard:token') }
      });
      return { status: res.status, cacheControl: res.headers.get('cache-control') };
    });
    check(
      'authenticated API responses are not cacheable',
      /no-store/.test(sessionProbe.cacheControl || ''),
      `cache-control: ${sessionProbe.cacheControl}`
    );

    // Activity feed picked the writes up.
    await pageA.click('[data-testid="open-activity"]');
    await pageA.waitForSelector('.feed li', { timeout: 8000 });
    const feed = await pageA.$eval('.feed', (el) => el.textContent);
    check('activity feed records the card creation and move', /added/.test(feed) && /moved/.test(feed));

    // Comments must survive a reload — they are in Mongo, so loading them in
    // the snapshot is what makes a refresh non-destructive.
    await pageA.click('.scrim');
    await waitFor(async () => (await pageA.$('.scrim')) === null, { label: 'activity panel closing' });

    // B has the card open, so a new comment on it is visible without a refresh.
    await pageB.evaluate(() => {
      document.querySelector('.card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await pageB.waitForSelector('.comment__composer textarea', { timeout: 8000 });

    await pageA.evaluate(() => {
      document.querySelector('.card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await pageA.waitForSelector('.comment__composer textarea', { timeout: 8000 });
    await pageA.type('.comment__composer textarea', 'Shipping this today');
    await pageA.click('.comment__composer button');

    await waitFor(async () => (await pageB.$$('.comment__body')).length === 1, { label: 'comment arriving on B' });
    const onB = await pageB.$eval('.comment__body', (el) => el.textContent);
    check('a comment by A appears live on B', onB === 'Shipping this today', onB);

    await pageA.keyboard.press('Escape');
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('.column', { timeout: 15000 });
    await pageA.evaluate(() => {
      document.querySelector('.card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await pageA.waitForSelector('.comment__body', { timeout: 8000 });
    const restored = await pageA.$eval('.comment__body', (el) => el.textContent);
    check('the comment is still there after a reload', restored === 'Shipping this today', restored);

    // B's presence disappears when B leaves.
    await pageB.close();
    await waitFor(async () => (await pageA.$eval('.presence__label', (el) => el.textContent)) === 'only you', {
      label: 'presence clearing after B leaves'
    });
    check('presence drops B after their tab closes', true);

    await ctxA.close();
    await ctxB.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nbrowser test crashed:', err.message);
  process.exit(1);
});
