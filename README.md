# Stadsspel

A team-vs-team city game. The host pins locations on a map; each location has a question and unlocks a fragment of the final coordinates. Teams visit each location, the question becomes available when they're inside the radius, and a correct answer reveals their fragment. Solve them all → the final destination is revealed.

- **Backend**: FastAPI (Python) — single Vercel serverless function
- **Frontend**: React + Vite + Leaflet (no Maps API key required)
- **DB**: SQLAlchemy. SQLite locally; Postgres in production via `DATABASE_URL`

## Quick start (local)

```bash
./start.sh setup    # one-time: Python venv + npm install
./start.sh          # runs FastAPI on :8000 and Vite on :5173
```

Open http://127.0.0.1:5173 — the Vite dev server proxies `/api/*` to FastAPI.

You can also run the halves separately: `./start.sh backend` or `./start.sh frontend`.

## Project layout

```
api/
  index.py        FastAPI app (all routes) — Vercel serverless entry
  db.py           SQLAlchemy engine & session
  models.py       Game, Location, Team, Progress
  schemas.py      Pydantic request/response models
frontend/
  src/
    pages/        Home, HostNew, HostGame, PlayerJoin, PlayerGame
    components/   MapView (Leaflet)
    api.ts        Typed fetch helpers
    geo.ts        haversine helper
requirements.txt
vercel.json       routes /api/* to api/index.py, builds Vite to frontend/dist
start.sh          local dev launcher
```

## Game flow

1. Host opens `/host/new`, names the game → gets a 6-character join code and a host link (saved in `localStorage`).
2. Host adds locations on the map: name, lat/lng, trigger radius (m), question, answer, fragment text. Optional hint.
3. Host sets the final coordinates and a label (e.g. "Statue of …").
4. Players go to `/play`, enter the join code, pick a team name and color → land on `/play/:teamId`.
5. The player UI streams their geolocation to the server (every ~4 s).
6. When a team is within a location's radius, an **Open question** button appears. The server re-checks the distance before returning the question.
7. Correct answer → that location's fragment is unlocked.
8. All locations solved → final coordinates revealed (with an "Open in Maps" link).
9. Host's **Live** tab shows all teams on the map and a progress matrix (team × location), polled every 3 s.

## Auth model

- **Host**: at game creation, the server returns a random `host_token`. The browser stores it in `localStorage["host:<gameId>"]`. Subsequent host calls send `X-Host-Token`.
- **Team**: on join, the server returns a random `team_token` stored in `localStorage["team:<teamId>"]`. Subsequent team calls send `X-Team-Token`.

No accounts, no passwords. Anyone with the host link can host; anyone with the join code can join.

## Vercel deployment

This repo is set up to deploy as-is.

1. Push to GitHub.
2. Import into Vercel.
3. Add an environment variable `DATABASE_URL` pointing to a Postgres database (Vercel Postgres, Neon, or Supabase all work; both `postgres://` and `postgresql://` URLs are accepted).
4. Deploy.

`vercel.json` configures:
- `frontend/` is built with `npm run build` → output served as static.
- `api/index.py` is built with `@vercel/python` → served as a single serverless function.
- All `/api/*` requests are rewritten to that function.

Tables auto-create on cold start (`Base.metadata.create_all`).

## Notes & limitations

- **Realtime** uses 3 s/5 s polling — websockets aren't a great fit for Vercel serverless. Plenty fast for this kind of game.
- **Geolocation** requires HTTPS in production (Vercel handles that). On `localhost` it works without TLS.
- **Answers** are compared case- and punctuation-insensitive (`hello, World!` == `Hello world`).
- **Cheating prevention**: the server re-validates the team's last known position against the location's radius before handing out the question or accepting an answer. A team can't ping a fake position from the UI without modifying client code, but for high-stakes games consider adding rate limits and accuracy checks.
- **No team join after game start**: not enforced — teams can join at any time. Add a check in `/api/teams/join` if you want to lock it down.

## API surface (cheat sheet)

```
POST   /api/games                                   create game (host)
GET    /api/games/{id}/host        X-Host-Token     full game + teams + matrix
PATCH  /api/games/{id}             X-Host-Token     update meta + final coords
POST   /api/games/{id}/start       X-Host-Token     mark started
POST   /api/games/{id}/locations   X-Host-Token     add location
PUT    /api/games/{id}/locations/{lid}              update location
DELETE /api/games/{id}/locations/{lid}              delete location

POST   /api/games/{id}/actions            X-Host-Token   add action (pool item)
PUT    /api/games/{id}/actions/{aid}      X-Host-Token   update action text
DELETE /api/games/{id}/actions/{aid}      X-Host-Token   delete action
POST   /api/games/{id}/actions/assign     X-Host-Token   top up every team to 3 assigned
POST   /api/games/{id}/teams/{tid}/actions/{ta}/toggle   approve / unapprove

POST   /api/teams/join                              join with code → team token
GET    /api/teams/{id}/state       X-Team-Token     locations + progress + assigned actions
POST   /api/teams/{id}/ping        X-Team-Token     update last GPS
GET    /api/teams/{id}/question?location_id=        get question if in range
POST   /api/teams/{id}/answer                       submit answer; returns fragment if correct
```

## Actions flow

Each team gets 3 random actions from the host's pool when they join. The
*completion* of an action is decided by the host, not the team:

1. The team performs the action and sends proof to the host via WhatsApp
   (out of band — the app does not collect photos).
2. The host opens the **Live** tab, sees the team in **Pending approvals**,
   and clicks **Approve**.
3. The team's app shows the action flip from "Pending" to "Approved ✓"
   on the next state poll.

If the host accidentally approves the wrong one they can click **Unapprove**
on the same row. Approving an action does not gate the final coordinates;
locations are the gate. Actions are a parallel objective the host scores
however they like at the end.
