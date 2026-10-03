# FlowBoard — design notes

Written to be defensible in an interview: not just what the app does, but why it
works the way it does, what broke, and what I would change.

---

## 1. The core problem

A collaborative board has one hard requirement that a CRUD app does not: **two
people can act on the same object at the same time and neither should silently
lose their work.**

That single sentence decides most of the architecture. If two people both move
the same card, one of them is going to be wrong. The design question is not
"how do I prevent this" but "when it happens, who is right, and does the loser
find out?"

The answer here: **the server is always right, and the loser is told.** There is
no merging of two conflicting moves, no last-write-wins that pretends both
succeeded.

---

## 2. Data model

```
User     username (unique), passwordHash, avatar
Board    title, description, ownerId, members[], lists[]   <- lists are embedded
Card     boardId, listId, title, description, labels[], dueDate,
         assigneeId, position (Number), version (Number)
Comment  boardId, cardId, authorId, body
Activity boardId, actorId, verb, targetType, targetId, meta
```

### Why lists are embedded but cards are not

Lists belong to exactly one board, are always read with it, are bounded (30 per
board), and are only ever reordered as a set. Embedding them means a rename or a
reorder is a single-document write, and loading a board needs one query instead
of two.

Cards are bounded too (500 per list) but they are what people actually interact
with, they are paginated in practice, and an embedded array that grows to
thousands of sub-documents is a document-size problem. They get their own
collection.

The rule I applied: **embed what is always read together and bounded; separate
what grows independently.**

### Why `position` is a float

Cards need an order. The obvious implementations are:

| Approach | Insert cost | Failure mode |
| --- | --- | --- |
| Integer index, renumber on change | O(n) writes per insert | Two clients renumbering fight, and a failure mid-way leaves gaps |
| LexoRank / fractional indexing | O(1) | Floating point eventually runs out of precision |
| Timestamps | O(1) | Ties, and clock skew between clients |

Fractional positioning sits between the first two. New cards get a gap of 1024.
Dropping between `a` and `b` computes `(a + b) / 2`. Nothing else is touched, so
a move is a single-card write no matter how many cards are in the list.

The cost is precision, so there is a floor. `gapIsCollapsed()` detects when the
interval between two neighbours has fallen below `1e-4` and the server renumbers
that list before accepting the move. The alternative — letting positions decay
into float noise — produces cards that sort in an order nobody chose.

---

## 3. Reads over REST, writes over WebSocket

This split is the decision I would defend hardest.

**Reads are HTTP** because they are cacheable, idempotent, and easy to reason
about. Loading a board, listing your boards, and paging the activity log all
happen once per view and never need to push to anyone else.

**Writes are WebSocket** because a write is precisely the operation that has to
reach every other open client. Once the socket exists — and it has to exist for
presence anyway — routing mutations through HTTP and then broadcasting would mean
maintaining two paths to the same authorization and validation code.

The board snapshot (`GET /api/boards/:id`) deliberately carries cards **and**
comments in two queries. Fetching comments per card would be N+1; the whole point
is that opening a card shows its full history immediately instead of only what
happened to arrive while the tab was open.

### Every mutation is a command with an acknowledgement

```js
socket.emit('card:move', { boardId, cardId, listId, index, version }, (ack) => {
  // ack: { status: 'ok', card } | { status: 'conflict', card } | { status: 'error', ... }
});
```

The sender gets a direct reply; everyone else gets a broadcast. The sender's ack
is authoritative, which is what makes optimistic updates safe to reconcile against.

---

## 4. Optimistic concurrency control

Every card carries an integer `version`. Writes are compare-and-set:

```js
const result = await Card.updateOne(
  { _id: cardId, boardId, version: expectedVersion },
  { $set: { ...patch, updatedAt: new Date() }, $inc: { version: 1 } }
);

if (result.matchedCount === 0) {
  // someone else got there first — send them the current state, not an error page
  return { status: 'conflict', card: await Card.findById(cardId) };
}
```

This is the same mechanism MongoDB uses internally for its own writes, so it is
not exotic. What matters is the client contract:

| Outcome | Client behaviour |
| --- | --- |
| `ok` | Replace the local card with the server's copy verbatim |
| `conflict` | Snap to the server's copy, toast "someone else changed this first" |
| `error` | Roll back to the exact pre-attempt state, keep the user's text in the field |

The sender also receives the normal broadcast. That looks redundant, and it is —
but it is what makes the sender's state converge on the same value as everyone
else's instead of drifting.

### What this does not cover

Field-level merging. If A renames a card while B edits its description, B's whole
update is rejected even though the fields do not overlap. A per-field version map
would fix that, and for this app it would be over-engineering — the conflicts are
rare and visible. I would add it if cards became documents people edited for hours
rather than task cards touched in a moment.

---

## 5. Client-side reconciliation

`BoardContext` holds cards in a plain object keyed by id, with a `_pending` flag.

```js
const before = cardsRef.current[cardId];
setCards((prev) => ({ ...prev, [cardId]: { ...prev[cardId], ...patch, _pending: true } }));

try {
  const ack = await mutate('card:update', { boardId, cardId, patch, version: before.version });
  setCards((prev) => ({ ...prev, [cardId]: { ...ack.card, _pending: false } }));
} catch (err) {
  // conflict carries the server's card; a plain rejection does not
  const authoritative = err.card ?? before;
  setCards((prev) => ({ ...prev, [cardId]: { ...authoritative, _pending: false } }));
}
```

Three details that took more thought than the happy path:

**The ref.** Socket listeners are registered once but need current data. Reading
`cardsRef.current` instead of `cards` keeps the listeners stable, so a card move
does not tear down and rebuild every subscription.

**Rollback copies the whole previous object**, not just the patched fields. A
partial rollback leaves stale fields behind, which is how you get a card whose
title is from one edit and description from another.

**The drop index excludes the dragged card.** `resolvePosition(..., excludeCardId)`
on the server and `findPlacement` on the client both compute the destination
against the list *with the dragged card removed*. Sending the same coordinate
system to both ends is what stops a card from landing one slot off when it is
dropped inside the list it came from.

---

## 6. Authorization

Three roles: `owner`, `member`, `viewer`. Owner can manage members and delete the
board; member can edit; viewer can only read.

Two decisions here came from bugs:

**Ownership lives in `Board.ownerId`, not as a role in `members`.** Promoting
anyone to `owner` would create two users with manage rights while only one is the
recorded owner — ambiguous about who may delete the board, and a way to strand
the real owner. `member:role` accepts only `member` or `viewer` and rejects
`owner` explicitly, with a message that says why rather than just "invalid role".
The People UI reflects this: ownership is displayed, never offered as an option.

**Every mutation re-reads access from MongoDB.** Not from `socket.data`, not from
a cache refreshed on join. A socket authenticated at handshake keeps that
authentication for its lifetime, so a user removed from a board mid-session would
otherwise keep writing until they reconnected. Every mutation calls
`loadAccess(boardId, userId, { need })`, which re-checks the role against the
database. It is one indexed query per write — cheap, and it makes revocation
immediate.

A test drives exactly this: remove a member, then have their still-open socket try
to write. It fails.

---

## 7. Presence

Presence is derived from Socket.io room membership rather than stored:

```js
const sockets = await io.in(room(boardId)).fetchSockets();
```

No heartbeat table, nothing to clean up when a client vanishes. It is correct by
construction because the room membership is maintained by the transport. The
trade-off is that it costs a round trip per presence computation, which is why
presence is emitted on join and disconnect rather than on a timer.

With `REDIS_URL` set, the Redis adapter makes `fetchSockets` span every instance,
so presence and broadcasts work across a horizontally scaled deployment. Without
it, a single instance works and a second instance would show two disjoint rooms —
which is the honest reason the adapter is documented as required for scaling
rather than optional.

---

## 8. Security

- bcrypt for passwords; the hash is never returned by any endpoint
- JWT verified in the Socket.io handshake, so an unauthenticated socket never
  reaches a listener
- Helmet, a strict CORS allowlist, and a 64 KB body limit
- Rate limiting on auth endpoints
- Every input goes through a shared validator that returns a field-level error
  rather than being coerced
- Boards are only reachable by members; there is no public link, so there is no
  guessable-id surface

`socket.data.userId` is set from the **verified token**, never from the
handshake payload:

```js
socket.data.userId = payload.sub;
```

That one line is the difference between "the socket knows who it is" and "the
socket knows who someone claimed it was."

---

## 9. Accounts, profiles, and theming

**Settings are HTTP, not socket.** The board rule is "reads over REST, writes over the socket", and this is the deliberate exception that proves it: that split exists because a board write has to fan out to a room. An account change concerns exactly one user and has no room to broadcast to, which is also why signup, login and the OAuth exchange were already HTTP. Routing profile writes through the socket would add an acknowledgement path and a reconnection problem to a feature that needs neither.

**The avatar is stored on the user but never travels with board data.** `avatarUpload` holds the resized image as a data URL, and `avatar` holds a short path (`/users/:id/avatar`) so the `.select('username avatar')` call sites stay small. Board projections select fields explicitly and never include `avatarUpload`; the raw bytes are read by the one route that serves them and nowhere else. That route is intentionally unauthenticated — an `<img>` cannot send a bearer token — and relies on the id being an opaque ObjectId that already appears in payloads the viewer was allowed to read. It answers `404` for a missing image, so a broken avatar is a missing image rather than an error page, and it is cached `immutable` for a day because the content behind a given id changes only when the user changes it.

Validation has two layers. The data URL must name a raster type — SVG is refused, because it can carry script and would be served from our own origin — and the decoded bytes must match the claimed type's magic number, so a payload labelled `image/png` cannot smuggle anything else back out under an image content type. The scoped body parser (`512 KB`, mounted ahead of the global `64 KB` one) admits the upload without widening the limit every other endpoint runs under.

**A typed email is never trusted; a provider's assertion is.** `emailVerified` is only ever set by a provider callback, never by `PATCH /auth/me`, and it is the sole signal `resolveUser` uses to attach a social identity to an existing account. Letting a self-declared address set that flag would let anyone claim anyone's account by typing their address. Changing the email in settings always clears the flag, even when the new value happens to match.

**Connecting a provider uses a link intent, not a sign-in.** The normal OAuth callback resolves a user by verified email and, failing that, creates a new one — correct for the sign-in screen, wrong for a "Connect" button on an account you are already inside, where it could silently switch you into a different account. `POST /api/auth/link/:provider` mints a short-lived token scoped to `purpose: oauth-link`, and the callback binds the identity to the token's subject while ignoring email entirely. It cannot be the session JWT: the OAuth start is a top-level navigation that cannot set an `Authorization` header, and a 7-day session token in a URL would leak into history and `Referer` headers. A 10-minute token that can only attach an identity — never sign in — limits what a leaked URL could do. Unlinking refuses to remove the last way in: a social-only account with one provider and no password gets a `409` and a message to set a password first.

**Theme is resolved in JS, not by a media query.** `prefers-color-scheme` can only express the system preference; it cannot represent "dark, because I said so" on a light desktop, which is exactly the choice the setting exists to offer. The resolved value is written to `data-theme` on `<html>`, so an explicit choice and the system preference land on the same CSS selector. The resolution runs in an inline script in `index.html` before the stylesheet paints, because doing it in React would flash the default palette on every reload, and the server's copy of `theme` is mirrored into `localStorage` so a cold boot on a fresh tab is correct before any request completes.

**Deleting an account is scoped by ownership.** Boards the user owns are destroyed along with their cards, comments and activity. Boards where they were only a member survive: their membership is pulled and any cards assigned to them are unassigned, because that content belongs to the board, not to the person leaving. Confirmation requires typing the username, plus the password when one exists.

---

## 10. Touch, and the two CSS bugs that hid there

The desktop build passed its browser test and was still broken on a phone, in
two ways that only a real touch emulation found.

**Cards could not be opened at all.** A card opened on `onDoubleClick`. A
touchscreen cannot produce a double tap without a 300ms delay penalty and no
visual affordance, so on Android a card was decoration — no description, no
comments, no due date. It is now a single click, which raised the opposite
risk: a drag ends with the pointer released over the card, so the browser fires
a click afterwards and every completed drag would fling the sheet open. dnd-kit
suppresses that click when it recognised the drag, and the browser test now
asserts both halves — a drag does not open the sheet, and a click does.

**A swipe that reached the end of the board navigated back to the dashboard.**
The board is a horizontal scroller, and Chrome treats an overscroll past its
edge as a history navigation. Mid-gesture, the user was thrown out of the board
and lost their place. `overscroll-behavior-x: contain` on the board keeps the
leftover scroll inside the board. This one is worth remembering as a class of
bug: nothing in the CSS was *wrong*, the browser was simply claiming a gesture
the app had not thought about.

The subtler of the two was this. `.column__body` set `overflow-y: auto` and
left the x axis alone, and the fix was not "leave the x axis alone":

```css
/* `overflow-y: auto` does not leave `overflow-x: visible` alone. CSS coerces
   a visible axis to `auto` whenever the other axis is scrollable. */
.column__body { overflow-y: auto; overflow-x: visible; }
/* computed: overflow-x: auto — every column became a horizontal scroller */
```

So every column quietly became a scroll container in both axes, and a scroll
container claims a pan even when it has nothing to scroll — `scrollWidth` equalled
`clientWidth` in all of them. The visible symptom was that the board could only
be panned by swiping the column header, the gap between columns, or the board
padding, and *never* by swiping a card, which is the only place a thumb rests.
`overflow-x: hidden` does not fix it, because `hidden` also creates a scroll
container. Only `clip` clips without scrolling.

Two more things that turned out to matter on a phone:

- `height: 100dvh`, not `100%` or `100vh`. The board is a full-height shell, and
  on Android the viewport changes height as the URL bar collapses. A shell pinned
  to the largest viewport puts its composer under the browser chrome.
- `touch-action: pan-x` on the board looked like a way to stop the browser
  guessing which scroller gets a gesture. It is the opposite of a hint — it
  *forbids* vertical panning, and because `touch-action` intersects up the whole
  ancestor chain, a touch that began on a card could no longer scroll its own
  column. The board is left at `auto` so the browser resolves the gesture
  against whatever scroller is actually under the finger.

Touch targets are sized by `@media (pointer: coarse)`, not by viewport width. A
28px icon button is wrong under a thumb and correct under a cursor, and a large
desktop window with a touchscreen should keep its density.

The gestures are split by intent rather than unified into one sensor. Mouse
drags at a 6px threshold; touch drags only after a 200ms hold, so a tap still
opens a card and a swipe still pans the board. That is also why `npm run android` (`scripts/android-audit.js`)
exists: it drives a real Pixel 7 and a 360px budget Android, and asserts the
gestures a desktop mouse cannot make. Both of the bugs above were invisible to
the desktop suite and obvious within a minute of emulation.

---

## 11. Tests

```
171 node:test suites      unit + integration, isolated database per file
30  smoke.js              live API, real sockets, real HTTP
21  browser-test.js       two Chrome contexts, synthetic pointer drags
   android audit          Pixel 7 + 360px Android, real touch gestures
```

Test databases are isolated per file — each suite generates a unique database
name. Running the files concurrently against one shared database produced
failures that looked like application bugs and were not; the isolation is what
made concurrent runs viable.

The browser test is the one that found real bugs. It signs up two users in
separate browser contexts, so they have genuinely separate `localStorage` and
separate sockets — not two tabs sharing a session, which would hide presence and
authorization problems. It then drives an actual drag with `page.mouse` through a
series of intermediate moves, because dnd-kit's `PointerSensor` has an activation
threshold and a single teleporting `mouse.move` will not claim the drag.

Three bugs came out of writing it:

1. **`emit()` raced the handshake.** The first mutation of a session almost always
   landed before `connected` flipped, so "create my first board" intermittently
   reported the user as offline. `emit()` now awaits the connection instead of
   failing immediately.
2. **Comments were write-only.** They were inserted into Mongo and broadcast, but
   nothing ever read them back, so a refresh silently emptied every thread. Fixed
   by including comments in the board snapshot — and covered by a regression check
   in `smoke.js`.
3. **The board snapshot omitted its own id.** `publicMember()` returned title,
   owner and lists but not `id`, so any mutation that sent `boardId: board.id` was
   rejected with "Invalid board id". The browser test surfaced it as a comment that
   silently refused to post; the error was being swallowed by an empty `catch`.

That third one is the argument for the browser test existing. The unit tests all
passed. The comment was being written, the broadcast fired, the activity log
recorded it — the only symptom was a textarea that silently refilled itself.

---

## 12. Trade-offs I would revisit

**No offline support.** An optimistic UI is halfway to an offline-first one, and
this app stops at halfway: it renders optimistically but has no queue, so a move
made on a dead connection is lost rather than deferred.

**No reordering of lists by drag.** Cards drag; lists are renamed and deleted but
not dragged. The embedded-list design makes it possible; it just is not built.

**Activity log grows forever.** It is paginated on read but never trimmed. A real
deployment would want a TTL or a retention window.

**Free-tier hosting is not production hosting.** See below.

---

## 13. Deployment

### API — Render

`render.yaml` at the repo root declares a free web service:

- `buildCommand: npm ci --prefix backend`
- `startCommand: npm start --prefix backend`
- `healthCheckPath: /health`
- `JWT_SECRET` uses `generateValue: true` so Render creates it

Environment variables to set:

| Variable | Source |
| --- | --- |
| `MONGODB_URL` | MongoDB Atlas M0 — free, 512 MB, shared |
| `JWT_SECRET` | Generated by Render |
| `FRONTEND_URL` | Your Vercel URL, for the CORS allowlist and OAuth redirects |
| `PUBLIC_URL` | This service's public URL, for OAuth callbacks |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud console OAuth app |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `REDIS_URL` | Optional, only for multiple instances |

The OAuth variables are declared in `render.yaml` with `sync: false`, so they are
entered in the dashboard and never committed. A provider button only appears once
its credentials are present, so an unconfigured deployment hides the social
sign-in rather than offering a button that fails.

### Database — MongoDB Atlas M0

Free forever at 512 MB. Adequate for a portfolio project, and far more than this
needs. The connection string goes in `MONGODB_URL` with the database name appended.
Atlas requires IP allowlisting or `0.0.0.0/0` for Render's dynamic egress IP —
the latter is fine for a demo, and worth calling out as the thing to fix first if
this were real.

### Frontend — Vercel

`frontend/vercel.json` sets the framework preset and build command. The client
reads `VITE_API_URL` at build time, so the API URL is baked into the bundle — set
it in Vercel's environment variables.

### The free-tier reality

- The API sleeps after 15 minutes idle and cold-starts in roughly 50 seconds. The
  client pings every 25 seconds while a board is open, which keeps the connection
  healthy and holds the instance awake — but the first load after a sleep is slow.
- One instance only on the free plan. A second would need `REDIS_URL` for the
  adapter, and it would need to be a paid instance.
- Atlas M0 has no backups. Fine for a demo; not fine for anything else.

I would rather state these plainly than let a reviewer discover them.

---

## 14. Interview questions this project answers

- **How do you handle two people editing the same thing?**
  Integer version per card, compare-and-set on write, server returns the
  authoritative copy on conflict, client reconciles instead of guessing.
  See `sockets/mutations.js` and the `conflict` branch in `BoardContext`.

- **Why WebSocket for writes and HTTP for reads?**
  Because the socket already exists for presence, and a write is the only
  operation that must reach other clients. Reads are cacheable and idempotent;
  pushing them over a socket would buy nothing.

- **How do you order cards without renumbering everything?**
  Fractional positions. A gap of 1024, midpoint insertion, and a floor that
  triggers renumbering before precision runs out.

- **How do you know who is allowed to do this, right now?**
  Every mutation re-reads the role from the database rather than trusting the
  session, so revoking access takes effect immediately.

- **What would break first at scale?**
  Presence. It is one `fetchSockets` per change; at high connection counts that
  becomes the bottleneck before anything else does.

- **What is the worst bug you shipped?**
  Comments that saved correctly and were never read back. Every layer reported
  success. It took a test that reloaded the page to find, which is now a permanent
  regression check.
