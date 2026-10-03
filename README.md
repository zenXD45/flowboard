# FlowBoard

A real-time collaborative Kanban board. Two people open the same board, and a drag
in one window moves the card in the other before they let go of the mouse.

Built as a portfolio project to demonstrate the parts of full-stack work that
unit tests alone do not cover: concurrency, authorization under live mutation,
and UI state that has to survive disagreement between clients.

```
MERN · Express 5 · Mongoose 8 · Socket.io 4 · React 19 · Vite 7
```

## What it does

| Area | Detail |
| --- | --- |
| Accounts | Username + password, bcrypt hashed, JWT in `localStorage`, 7-day expiry |
| Boards | Create, rename, delete; owner / member / viewer roles |
| Lists | Add, rename, reorder, delete — deleting cascades its cards |
| Cards | Title, description, labels, due date, assignee, drag between lists |
| Comments | Threaded per card, loaded with the board snapshot |
| Presence | Live avatar row showing who currently has the board open |
| Activity | Append-only log of every mutation, paginated |
| Real time | Every write is a Socket.io command with an acknowledgement |
| Conflicts | Integer `version` per card; a stale write is rejected, not merged blindly |

## Running it locally

Requires Node 22+ and a MongoDB reachable at `MONGODB_URL`.

```bash
# API
cd backend
npm install
cp .env.example .env
npm start                 # http://localhost:5002

# Web, in a second terminal
cd frontend
npm install
npm run dev               # http://localhost:5173
```

Vite proxies nothing — the client reads `VITE_API_URL` (see `frontend/.env.example`).
Left unset it talks to `localhost:5002`, which is what you want in development.

### Verifying it

The API must be running for the last two.

```bash
cd backend
npm test        # 56 unit + integration tests, isolated per file
npm run smoke   # 30 checks against a live API over real sockets
npm run browser # 13 checks in two isolated Chrome sessions
```

`npm run browser` is the interesting one: it signs up two users in separate
browser contexts, invites one to the other's board, creates a card, drags it with
synthetic pointer events, and asserts the other window reacted — including that
the position survives a reload and that presence drops when a tab closes.

## Architecture in one paragraph

REST handles authentication and reads. Anything that mutates goes over Socket.io,
because a mutation is the operation that has to reach every other open client, and
the transport is already there. The client renders optimistically, tags the change
as pending, and reconciles against the server's authoritative response: on success
it takes the server's card verbatim, on a version conflict it snaps to the server's
version and tells the user someone else got there first, and on a rejection it
rolls back to the state it had before the attempt.

The client never computes a stored position. It sends the index the user dropped
the card at, and the server turns that into a fractional `position` between its two
neighbours. This keeps the "where did the user mean?" judgement in one place, so a
drag inside a list and a drag across lists cannot disagree about the answer.

See [DESIGN.md](./DESIGN.md) for the reasoning, including the decisions that were
reversed and the bugs worth writing about on a whiteboard.

## Project layout

```
backend/
  config/            env parsing and limits
  controllers/       auth and board read endpoints
  middleware/        JWT authentication
  models/            User, Board, Card, Comment, Activity
  sockets/           handshake, authorization, mutations
  tests/             node:test suites, one database per file
  scripts/           smoke.js, browser-test.js
frontend/
  src/context/       AuthContext, BoardContext (the real logic lives here)
  src/components/    Board, Column, CardTile, BoardPanel, Toasts
  src/lib/           api client, socket client, position helpers
  src/pages/         AuthCard, Dashboard, BoardPage
```

## Deployment

`render.yaml` describes a single free web service for the API. In production it
needs `MONGODB_URL` (MongoDB Atlas M0 is free), a generated `JWT_SECRET`, and
`FRONTEND_URL` for CORS. `REDIS_URL` is optional and only needed if you run more
than one API instance — it installs the Socket.io Redis adapter so broadcasts
cross instance boundaries.

The free instance sleeps after 15 minutes idle and cold-starts in roughly 50
seconds. The client pings every 25 seconds while a board is open, which both keeps
the connection healthy and holds the instance awake.

See [DESIGN.md](./DESIGN.md#deployment) for the step-by-step and the free-tier
caveats.

## License

MIT
