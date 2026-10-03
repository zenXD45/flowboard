# FlowBoard — product

## Problem

Small teams plan on shared boards. Most of the good ones are either expensive or
collaborative only in the sense that they reload every thirty seconds. The gap
is a board that is genuinely live on a free tier, so a team does not need a
budget to work together in real time.

## Audience

- A two-to-five person team that plans sprints without a paid tool
- Someone evaluating me as a candidate, who wants to click things rather than
  read code
- Future me, in a year, trying to remember why the ordering works this way

## What it does

Sign up with a username and password, or with Google or GitHub. Create a board,
invite a collaborator by username, and work on it together. Cards have a title, description, labels, a due
date, an assignee, comments, and a place on the board. The board shows who else is
looking at it right now and what changed while you were away.

An account page manages the profile — display name, username, email, avatar,
password, connected sign-in providers, and light/dark/system theme — and can
delete the account and everything it owns.

## Deliberate non-goals

| Not doing | Why |
| --- | --- |
| Accounts with email verification of their own | Nothing in the app needs to prove identity; it would add a whole signup-abandonment problem for no gain. Note this is about *verifying* an address we hold — a Google or GitHub sign-in still only links to an existing account when that provider asserts the address is verified |
| File attachments | Storage, virus scanning, and CDN cost, none of which demonstrate anything the rest of the app does not. Profile avatars are the single exception and are not "attachments": the browser resizes the image to 128px, the bytes live on the user document, and they are served from the user's own id — no bucket, no scanning, no CDN |
| Recurring cards / subtasks | Depth in one feature beats breadth across five |
| Drag to reorder lists | The data model supports it; the UI does not yet. Shipping a half-built interaction would be worse than not offering it |
| Offline editing | The optimistic UI is halfway there, but a real offline queue is a substantial subsystem and pretending otherwise would be dishonest |

## Success criteria

- A drag by one person is visible to another person before the mouse is released
- A move survives a page reload, because the server decided it — not the client
- Two people editing one card produces exactly one winner and one clear message
- Removing someone from a board takes effect immediately, not at their next login
- It runs free, and the free tier's limitations are written down rather than
  discovered by a reviewer

## Stack rationale

- **Express 5 + Mongoose 8** — current major versions, and Express 5's native
  async error handling removes a whole category of unhandled rejection
- **Socket.io** over raw WebSockets — rooms, acknowledgements, and reconnection
  are the actual requirement, and all three are solved here
- **React 19 + Vite 7** — fast enough iteration that the drag interactions were
  worth building with a real feedback loop
- **dnd-kit** — keyboard dragging via `KeyboardSensor`, which the previous
  popular choice did not have. The sensors are split by intent rather than
  unified: mouse drags at a 6px threshold, touch only after a 200ms hold, so a
  tap still opens a card and a swipe still pans the board
- **Node's built-in test runner** — no test framework dependency, and per-file
  process isolation maps directly onto the per-file database isolation the suite
  needs

## Data model

```
User     username (unique), displayName, passwordHash (absent for social-only
         accounts), email, emailVerified, avatar, avatarColor, avatarUpload, theme
OAuthAccount  provider + providerUserId (unique together), userId, email
Board    title, description, ownerId, members[], lists[]
Card     boardId, listId, title, description, labels[], dueDate,
         assigneeId, position, version
Comment  boardId, cardId, authorId, body
Activity boardId, actorId, verb, targetType, targetId, meta
```

Lists are embedded in the board; cards, comments, and activity are separate
collections. Rationale in [DESIGN.md](./DESIGN.md#2-data-model).

## Permissions

| | Owner | Member | Viewer |
| --- | --- | --- | --- |
| Read the board | yes | yes | yes |
| Edit cards, lists, comments | yes | yes | no |
| Invite, remove, change roles | yes | no | no |
| Delete the board | yes | no | no |

Ownership is `Board.ownerId`, never a role in `members`. A member can be promoted
to `viewer` or demoted, but ownership cannot be reassigned — the UI does not offer
it and the API rejects it, because two users with manage rights and one recorded
owner is an ambiguous state nobody wants to debug.

## Real-time behaviour

- Reads: HTTP. Board snapshot, board list, activity pages.
- Writes: Socket.io commands with acknowledgements.
- Every mutation re-reads the caller's role from the database.
- Cards use integer versions; a stale write returns the current server copy with
  `status: 'conflict'`, and the client snaps to it and says so.
- Card ordering uses fractional positions computed server-side from the index the
  user dropped at.

## Quality bar

```
171 node:test            unit + integration, one database per file
30  smoke.js             live API over real sockets and HTTP
21  browser-test.js      two Chrome contexts, real drags, real reloads
```

All passing, plus ESLint clean on the frontend (0 errors; the 2 warnings are
pre-existing Fast Refresh ones in the two context files).

Touch is covered by a separate audit, `npm run android` (`scripts/android-audit.js`), which drives a real
Pixel 7 and a 360px budget Android viewport and asserts the gestures that a
desktop mouse cannot: that a swipe on a card pans the board, that a long press
then drag moves a card between columns, that the drag does not also open the
card, that a plain tap does, and that a column scrolls under a vertical swipe
without navigating away.

## Where this goes next

1. Reorder lists by drag — the data model already supports it
2. Offline queue on top of the optimistic UI
3. Card search and filters
4. Replace `localStorage` JWT with an httpOnly cookie, which removes the XSS token
   exposure entirely
5. Per-field versioning, if card edits turn out to overlap often in practice
