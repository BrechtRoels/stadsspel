"""FastAPI entry point — also the Vercel Python serverless handler.

Vercel's @vercel/python runtime imports this file directly (not as part of an
`api` package), so we use absolute imports and ensure the directory is on
sys.path. Locally, run with: `uvicorn --app-dir api index:app --reload`.
"""
import hashlib
import hmac
import math
import os
import random
import secrets
import string
import sys
from datetime import datetime
from typing import List, Optional

ACTIONS_PER_TEAM = 3

# Make sibling modules importable on Vercel and locally.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

import models
import schemas
from db import Base, engine, get_db

# Auto-create tables on cold start. Fine for SQLite/Postgres at this scale.
Base.metadata.create_all(bind=engine)


def _migrate_additive() -> None:
    """Add columns the ORM expects but the existing DB might be missing.

    Idempotent: only adds columns that don't exist yet. No drops, no renames.
    Works for both SQLite and Postgres.
    """
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    if "actions" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("actions")}
        with engine.begin() as conn:
            if "hint" not in cols:
                conn.execute(text("ALTER TABLE actions ADD COLUMN hint TEXT"))
            if "location_id" not in cols:
                conn.execute(text("ALTER TABLE actions ADD COLUMN location_id INTEGER"))
    if "progress" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("progress")}
        if "position" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE progress ADD COLUMN position INTEGER"))
    if "games" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("games")}
        if "password_hash" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE games ADD COLUMN password_hash TEXT"))


_migrate_additive()

app = FastAPI(title="Stadsspel API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- helpers ----------

def _token(n: int = 32) -> str:
    return secrets.token_urlsafe(n)


def _join_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    alphabet = alphabet.replace("O", "").replace("0", "").replace("I", "").replace("1", "")
    return "".join(secrets.choice(alphabet) for _ in range(6))


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _norm_answer(s: str) -> str:
    return "".join(ch.lower() for ch in (s or "").strip() if ch.isalnum())


# ---------- password hashing (stdlib only) ----------

_PBKDF2_ITERS = 120_000


def _hash_password(password: str) -> str:
    """PBKDF2-HMAC-SHA256, 120k iterations. Format: pbkdf2_sha256$iters$salt$hash."""
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${salt.hex()}${h.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters_s, salt_hex, hash_hex = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters_s))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _require_host(db: Session, game_id: int, token: str, password: str = "") -> models.Game:
    if not token:
        raise HTTPException(status_code=401, detail="Missing host token")
    game = db.query(models.Game).filter(models.Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.host_token != token:
        raise HTTPException(status_code=403, detail="Bad host token")
    if game.password_hash:
        if not password:
            raise HTTPException(status_code=401, detail="Password required")
        if not _verify_password(password, game.password_hash):
            raise HTTPException(status_code=403, detail="Wrong password")
    return game


def _require_team(db: Session, team_id: int, token: str) -> models.Team:
    if not token:
        raise HTTPException(status_code=401, detail="Missing team token")
    team = db.query(models.Team).filter(models.Team.id == team_id).first()
    if not team or team.token != token:
        raise HTTPException(status_code=403, detail="Bad team token")
    return team


def _visible_progress(team: models.Team) -> tuple[List[models.Progress], bool]:
    """Return (rows_in_view, is_locked).

    is_locked=False means the team's progress hasn't been positioned yet
    (host hasn't clicked Start to lock+randomize, or this is legacy data) —
    the caller should fall back to showing all locations.

    is_locked=True means we filter: only solved positions plus the next-up
    position are visible. Rows are sorted by position.
    """
    rows = list(team.progress)
    has_positions = any(p.position is not None for p in rows)
    if not has_positions:
        return rows, False
    pos_rows = sorted([p for p in rows if p.position is not None], key=lambda p: p.position)  # type: ignore[arg-type,return-value]
    # Note: don't use `or -1` here — position 0 is falsy but valid.
    solved_positions = [p.position for p in pos_rows if p.solved and p.position is not None]
    max_solved = max(solved_positions) if solved_positions else -1
    threshold = max_solved + 1  # next-to-solve
    visible = [p for p in pos_rows if p.position is not None and p.position <= threshold]
    return visible, True


def _resolve_action_location(db: Session, game_id: int, location_id: Optional[int]) -> Optional[int]:
    if not location_id:
        return None
    loc = db.query(models.Location).filter(
        models.Location.id == location_id, models.Location.game_id == game_id
    ).first()
    if not loc:
        raise HTTPException(status_code=400, detail="Action location must belong to this game")
    return loc.id


def _location_visible_to(team: models.Team, location_id: int) -> bool:
    """Is this specific location currently visible in the team's sequence?
    Returns True for legacy/unlocked teams (no positions set).
    """
    visible, locked = _visible_progress(team)
    if not locked:
        return True
    return any(p.location_id == location_id for p in visible)


def _team_action_views(team: models.Team) -> List[schemas.TeamActionOut]:
    out: List[schemas.TeamActionOut] = []
    for ta in team.actions:
        loc_id = ta.action.location_id if (ta.action and ta.action.location_id) else None
        loc_name: Optional[str] = None  # type: ignore[name-defined]
        loc_id_out = None
        if loc_id is not None and _location_visible_to(team, loc_id):
            # Reveal the tied location only once it's in their visible window.
            loc_id_out = loc_id
            loc = next((l for l in team.game.locations if l.id == loc_id), None)
            loc_name = loc.name if loc else None
        out.append(schemas.TeamActionOut(
            id=ta.id,
            action_id=ta.action_id,
            text=ta.action.text if ta.action else "",
            hint=(ta.action.hint if ta.action else None),
            completed=bool(ta.completed),
            completed_at=ta.completed_at,
            location_id=loc_id_out,
            location_name=loc_name,
        ))
    return out


def _lock_and_randomize(db: Session, game: models.Game) -> int:
    """For each team without a positional sequence yet, generate a random
    location ordering. Teams that already have positions are kept as-is, but
    any newly-added locations are appended to their sequence.

    Tries to give each unlocked team a *distinct* first location to spread
    teams out at the start. Returns the number of teams that were freshly
    randomized.
    """
    locations = list(game.locations)
    n = len(locations)
    teams = list(game.teams)
    if n == 0 or not teams:
        return 0

    # Track first locations already in use by locked teams so unlocked teams
    # avoid duplicating them when possible.
    used_first_loc_ids: set[int] = set()
    locked_teams: list[models.Team] = []
    unlocked_teams: list[models.Team] = []
    for t in teams:
        positions_set = [p for p in t.progress if p.position is not None]
        if positions_set:
            locked_teams.append(t)
            first = next((p for p in positions_set if p.position == 0), None)
            if first:
                used_first_loc_ids.add(first.location_id)
        else:
            unlocked_teams.append(t)

    # Build a queue of "preferred firsts" for unlocked teams: shuffle all
    # locations, prefer those not already used. If we run out, recycle.
    pool = [loc for loc in locations if loc.id not in used_first_loc_ids]
    random.shuffle(pool)
    fallback = list(locations)
    random.shuffle(fallback)
    first_queue = pool + [loc for loc in fallback if loc not in pool]

    randomized = 0
    for i, team in enumerate(unlocked_teams):
        first = first_queue[i % len(first_queue)] if first_queue else random.choice(locations)
        rest = [loc for loc in locations if loc.id != first.id]
        random.shuffle(rest)
        order = [first] + rest

        existing = {p.location_id: p for p in team.progress}
        for pos, loc in enumerate(order):
            if loc.id in existing:
                existing[loc.id].position = pos
            else:
                db.add(models.Progress(
                    team_id=team.id, location_id=loc.id,
                    position=pos, solved=False, attempts=0,
                ))
        randomized += 1

    # Late-added locations: append to each locked team's sequence.
    for team in locked_teams:
        existing_ids = {p.location_id for p in team.progress if p.position is not None}
        new_locs = [loc for loc in locations if loc.id not in existing_ids]
        if not new_locs:
            continue
        max_pos = max(p.position for p in team.progress if p.position is not None)
        random.shuffle(new_locs)
        for j, loc in enumerate(new_locs):
            db.add(models.Progress(
                team_id=team.id, location_id=loc.id,
                position=max_pos + 1 + j, solved=False, attempts=0,
            ))

    return randomized


def _team_summary(db: Session, team: models.Team, total_locations: int) -> schemas.TeamHostOut:
    solved = (
        db.query(models.Progress)
        .filter(models.Progress.team_id == team.id, models.Progress.solved == True)  # noqa: E712
        .count()
    )
    action_views = _team_action_views(team)
    actions_done = sum(1 for a in action_views if a.completed)
    return schemas.TeamHostOut(
        id=team.id,
        name=team.name,
        color=team.color,
        last_lat=team.last_lat,
        last_lng=team.last_lng,
        last_seen=team.last_seen,
        solved_count=solved,
        total=total_locations,
        actions_done=actions_done,
        actions_total=len(action_views),
        actions=action_views,
    )


def _assign_actions_to_team(db: Session, team: models.Team, n: int = ACTIONS_PER_TEAM) -> int:
    """Top up a team's assigned actions to `n` random ones from the game's pool.

    Idempotent: if the team already has `n`, does nothing. Returns how many
    new TeamAction rows were added. The caller commits.
    """
    existing_action_ids = {ta.action_id for ta in team.actions}
    needed = n - len(existing_action_ids)
    if needed <= 0:
        return 0
    pool = (
        db.query(models.Action)
        .filter(models.Action.game_id == team.game_id, ~models.Action.id.in_(existing_action_ids or [-1]))
        .all()
    )
    if not pool:
        return 0
    chosen = random.sample(pool, k=min(needed, len(pool)))
    for a in chosen:
        db.add(models.TeamAction(team_id=team.id, action_id=a.id, completed=False))
    return len(chosen)


# ---------- health ----------

@app.get("/api/health")
def health():
    return {"ok": True, "time": datetime.utcnow().isoformat()}


# ---------- host: games ----------

@app.post("/api/games", response_model=schemas.GameHostOut)
def create_game(payload: schemas.GameCreate, db: Session = Depends(get_db)):
    code = _join_code()
    for _ in range(10):
        if not db.query(models.Game).filter(models.Game.join_code == code).first():
            break
        code = _join_code()
    game = models.Game(
        name=payload.name,
        host_token=_token(),
        join_code=code,
        final_lat=payload.final_lat,
        final_lng=payload.final_lng,
        final_label=payload.final_label,
        password_hash=(_hash_password(payload.password) if payload.password else None),
    )
    db.add(game)
    db.commit()
    db.refresh(game)
    return schemas.GameHostOut.from_orm_game(game)


@app.post("/api/games/{game_id}/password")
def set_password(
    game_id: int,
    payload: schemas.PasswordSetIn,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Set, change, or clear the host password.

    Empty / null `password` clears it. To change an existing password the
    caller must already be authenticated (current password in
    X-Host-Password header) — that's enforced by _require_host.
    """
    game = _require_host(db, game_id, x_host_token, x_host_password)
    new_pw = (payload.password or "").strip()
    if new_pw:
        game.password_hash = _hash_password(new_pw)
    else:
        game.password_hash = None
    db.commit()
    return {"has_password": bool(game.password_hash)}


@app.post("/api/host/recover", response_model=schemas.HostRecoverOut)
def host_recover(payload: schemas.HostRecoverIn, db: Session = Depends(get_db)):
    """Look up a game by its host token. The token is the only secret the
    host needs to remember — it's unique-indexed and gives full host control.
    """
    token = (payload.host_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Host token is required")
    game = db.query(models.Game).filter(models.Game.host_token == token).first()
    if not game:
        raise HTTPException(status_code=404, detail="Unknown host token")
    return schemas.HostRecoverOut(
        game_id=game.id, name=game.name, join_code=game.join_code,
        has_password=bool(game.password_hash),
    )


@app.get("/api/games/{game_id}/host", response_model=schemas.HostDashboardOut)
def host_dashboard(
    game_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    game = _require_host(db, game_id, x_host_token, x_host_password)
    total = len(game.locations)
    teams = [_team_summary(db, t, total) for t in game.teams]
    matrix: dict = {}
    for t in game.teams:
        matrix[t.id] = {}
        for p in t.progress:
            matrix[t.id][p.location_id] = bool(p.solved)
    return schemas.HostDashboardOut(
        game=schemas.GameHostOut.from_orm_game(game),
        teams=teams,
        progress_matrix=matrix,
    )


@app.patch("/api/games/{game_id}", response_model=schemas.GameHostOut)
def update_game(
    game_id: int,
    payload: schemas.GameCreate,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    game = _require_host(db, game_id, x_host_token, x_host_password)
    game.name = payload.name
    game.final_lat = payload.final_lat
    game.final_lng = payload.final_lng
    game.final_label = payload.final_label
    db.commit()
    db.refresh(game)
    return schemas.GameHostOut.from_orm_game(game)


@app.post("/api/games/{game_id}/start", response_model=schemas.GameHostOut)
def start_game(
    game_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Start (or resume) the game. On the first call this also:
    - locks teams in: each team gets a random location sequence with a
      preference for distinct starting locations (anti-flocking);
    - assigns 3 random actions per team from the action pool.
    Idempotent for already-locked teams; re-clicking after late joins gives
    those teams their sequences and actions without disturbing existing ones.
    """
    game = _require_host(db, game_id, x_host_token, x_host_password)
    game.started = True
    _lock_and_randomize(db, game)
    for team in game.teams:
        _assign_actions_to_team(db, team)
    db.commit()
    db.refresh(game)
    return schemas.GameHostOut.from_orm_game(game)


@app.post("/api/games/{game_id}/stop", response_model=schemas.GameHostOut)
def stop_game(
    game_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    game = _require_host(db, game_id, x_host_token, x_host_password)
    game.started = False
    db.commit()
    db.refresh(game)
    return schemas.GameHostOut.from_orm_game(game)


# ---------- host: locations ----------

@app.post("/api/games/{game_id}/locations", response_model=schemas.LocationHostOut)
def add_location(
    game_id: int,
    payload: schemas.LocationIn,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token, x_host_password)
    loc = models.Location(game_id=game_id, **payload.model_dump())
    db.add(loc)
    db.commit()
    db.refresh(loc)
    return loc


@app.put("/api/games/{game_id}/locations/{loc_id}", response_model=schemas.LocationHostOut)
def update_location(
    game_id: int,
    loc_id: int,
    payload: schemas.LocationIn,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token, x_host_password)
    loc = db.query(models.Location).filter(
        models.Location.id == loc_id, models.Location.game_id == game_id
    ).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    for k, v in payload.model_dump().items():
        setattr(loc, k, v)
    db.commit()
    db.refresh(loc)
    return loc


@app.delete("/api/games/{game_id}/locations/{loc_id}", status_code=204)
def delete_location(
    game_id: int,
    loc_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token, x_host_password)
    loc = db.query(models.Location).filter(
        models.Location.id == loc_id, models.Location.game_id == game_id
    ).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    db.delete(loc)
    db.commit()
    return None


# ---------- host: actions ----------

@app.post("/api/games/{game_id}/actions", response_model=schemas.ActionOut)
def add_action(
    game_id: int,
    payload: schemas.ActionIn,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token, x_host_password)
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Action text is required")
    hint = (payload.hint or "").strip() or None
    location_id = _resolve_action_location(db, game_id, payload.location_id)
    action = models.Action(game_id=game_id, text=text, hint=hint, location_id=location_id)
    db.add(action)
    db.commit()
    db.refresh(action)
    return action


@app.put("/api/games/{game_id}/actions/{action_id}", response_model=schemas.ActionOut)
def update_action(
    game_id: int,
    action_id: int,
    payload: schemas.ActionIn,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token, x_host_password)
    a = db.query(models.Action).filter(
        models.Action.id == action_id, models.Action.game_id == game_id
    ).first()
    if not a:
        raise HTTPException(status_code=404, detail="Action not found")
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Action text is required")
    a.text = text
    a.hint = (payload.hint or "").strip() or None
    a.location_id = _resolve_action_location(db, game_id, payload.location_id)
    db.commit()
    db.refresh(a)
    return a


@app.delete("/api/games/{game_id}/actions/{action_id}", status_code=204)
def delete_action(
    game_id: int,
    action_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token, x_host_password)
    a = db.query(models.Action).filter(
        models.Action.id == action_id, models.Action.game_id == game_id
    ).first()
    if not a:
        raise HTTPException(status_code=404, detail="Action not found")
    db.delete(a)
    db.commit()
    return None


@app.post("/api/games/{game_id}/actions/assign")
def reassign_team_actions(
    game_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Top up every team to ACTIONS_PER_TEAM. Useful if the host added actions
    after teams already joined. Existing assignments are kept (no reshuffle)."""
    game = _require_host(db, game_id, x_host_token, x_host_password)
    for team in game.teams:
        _assign_actions_to_team(db, team)
    db.commit()
    return {"ok": True, "teams": len(game.teams)}


# ---------- team join ----------

@app.post("/api/teams/join", response_model=schemas.TeamSession)
def join_game(payload: schemas.TeamJoinIn, db: Session = Depends(get_db)):
    """Join a game by code, or rejoin an existing team by exact name match.

    Anyone with the join code + a team's name can recover that team's session
    (e.g. after clearing localStorage or switching devices). Same-name collisions
    in a game are not allowed — second poster would resume the first team.
    """
    code = (payload.join_code or "").strip().upper()
    name = payload.name.strip()[:80] or "Team"
    game = db.query(models.Game).filter(models.Game.join_code == code).first()
    if not game:
        raise HTTPException(status_code=404, detail="Unknown join code")

    existing = db.query(models.Team).filter(
        models.Team.game_id == game.id, models.Team.name == name
    ).first()
    if existing:
        # Rejoin: keep token, color, progress, and assigned actions.
        return schemas.TeamSession(
            team_id=existing.id,
            team_token=existing.token,
            team_name=existing.name,
            color=existing.color,
            game_id=game.id,
            game_name=game.name,
        )

    team = models.Team(
        game_id=game.id,
        name=name,
        color=payload.color or "#D04A02",
        token=_token(),
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    # Actions are NOT auto-assigned on join — the host triggers the reveal
    # explicitly via POST /api/games/{game_id}/actions/assign.
    return schemas.TeamSession(
        team_id=team.id,
        team_token=team.token,
        team_name=team.name,
        color=team.color,
        game_id=game.id,
        game_name=game.name,
    )


# ---------- team play ----------

def _state_for(db: Session, team: models.Team) -> schemas.TeamStateOut:
    game = team.game
    visible_progress, locked = _visible_progress(team)
    locs_by_id = {l.id: l for l in game.locations}

    if locked:
        # Locked: visible locations only, sorted by team position.
        locs = [locs_by_id[p.location_id] for p in visible_progress if p.location_id in locs_by_id]
        # Progress reflects the FULL sequence so counters like "2/5 solved"
        # are honest even though the UI only shows the visible part.
        full_rows = sorted(
            [p for p in team.progress if p.position is not None],
            key=lambda p: p.position or 0,
        )
        items: List[schemas.ProgressItem] = []
        for p in full_rows:
            loc = locs_by_id.get(p.location_id)
            items.append(schemas.ProgressItem(
                location_id=p.location_id,
                solved=bool(p.solved),
                attempts=p.attempts or 0,
                fragment=(loc.fragment if (loc and p.solved) else None),
            ))
        all_solved = bool(full_rows) and all(p.solved for p in full_rows)
    else:
        # Legacy / not-yet-locked: show all locations by global order_idx.
        locs = sorted(game.locations, key=lambda l: (l.order_idx, l.id))
        prog_by_loc = {p.location_id: p for p in team.progress}
        items = []
        for loc in locs:
            p = prog_by_loc.get(loc.id)
            items.append(schemas.ProgressItem(
                location_id=loc.id,
                solved=bool(p and p.solved),
                attempts=(p.attempts if p else 0),
                fragment=(loc.fragment if (p and p.solved) else None),
            ))
        all_solved = bool(locs) and all(prog_by_loc.get(l.id) and prog_by_loc[l.id].solved for l in locs)

    prog_by_loc = {p.location_id: p for p in team.progress}

    # Each approved action unlocks one hint, indexed against the team's
    # visible sequence (by position when locked, by global order_idx otherwise).
    approved_count = sum(1 for ta in team.actions if ta.completed)
    public_locs: List[schemas.LocationPublicOut] = []
    for idx, loc in enumerate(locs):
        unlocked = idx < approved_count
        position = None
        if locked:
            p = prog_by_loc.get(loc.id)
            position = p.position if (p and p.position is not None) else None
        public_locs.append(schemas.LocationPublicOut(
            id=loc.id,
            name=loc.name,
            lat=loc.lat,
            lng=loc.lng,
            radius_m=loc.radius_m,
            order_idx=loc.order_idx,
            position=position,
            has_hint=bool(loc.hint),
            hint=(loc.hint if (loc.hint and unlocked) else None),
        ))

    return schemas.TeamStateOut(
        team_id=team.id,
        team_name=team.name,
        color=team.color,
        game_name=game.name,
        locations=public_locs,
        progress=items,
        actions=_team_action_views(team),
        final_lat=(game.final_lat if all_solved else None),
        final_lng=(game.final_lng if all_solved else None),
        final_label=(game.final_label if all_solved else None),
        all_solved=all_solved,
    )


@app.get("/api/teams/{team_id}/state", response_model=schemas.TeamStateOut)
def team_state(
    team_id: int,
    x_team_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    team = _require_team(db, team_id, x_team_token)
    return _state_for(db, team)


@app.post("/api/games/{game_id}/teams/{team_id}/actions/{team_action_id}/toggle")
def host_toggle_team_action(
    game_id: int,
    team_id: int,
    team_action_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Approve / unapprove a team's completion of an action.

    Teams send proof out-of-band (e.g. WhatsApp); only the host flips this.
    """
    _require_host(db, game_id, x_host_token, x_host_password)
    ta = db.query(models.TeamAction).filter(
        models.TeamAction.id == team_action_id,
        models.TeamAction.team_id == team_id,
    ).first()
    if not ta:
        raise HTTPException(status_code=404, detail="Action not found for this team")
    if ta.team.game_id != game_id:
        raise HTTPException(status_code=404, detail="Action not found for this game")
    ta.completed = not ta.completed
    ta.completed_at = datetime.utcnow() if ta.completed else None
    db.commit()
    return {"id": ta.id, "completed": ta.completed, "completed_at": ta.completed_at}


@app.post("/api/teams/{team_id}/ping")
def team_ping(
    team_id: int,
    payload: schemas.PingIn,
    x_team_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    team = _require_team(db, team_id, x_team_token)
    team.last_lat = payload.lat
    team.last_lng = payload.lng
    team.last_seen = datetime.utcnow()
    db.commit()
    return {"ok": True}


@app.get("/api/teams/{team_id}/question")
def get_question(
    team_id: int,
    location_id: int,
    x_team_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    team = _require_team(db, team_id, x_team_token)
    loc = db.query(models.Location).filter(
        models.Location.id == location_id, models.Location.game_id == team.game_id
    ).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")

    if not _location_visible_to(team, loc.id):
        raise HTTPException(
            status_code=403,
            detail="This location isn't on your team's current step.",
        )

    prog = db.query(models.Progress).filter(
        models.Progress.team_id == team.id, models.Progress.location_id == loc.id
    ).first()
    if prog and prog.solved:
        return {"already_solved": True, "fragment": loc.fragment}

    if team.last_lat is None or team.last_lng is None:
        raise HTTPException(status_code=400, detail="No location ping recorded yet")

    distance = _haversine_m(team.last_lat, team.last_lng, loc.lat, loc.lng)
    if distance > loc.radius_m:
        raise HTTPException(
            status_code=403,
            detail=f"Out of range ({int(distance)}m, need ≤{loc.radius_m}m)",
        )

    # Hint is only revealed if this location's index is unlocked by approved actions.
    locs_in_order = sorted(team.game.locations, key=lambda l: (l.order_idx, l.id))
    loc_idx = next((i for i, l in enumerate(locs_in_order) if l.id == loc.id), None)
    approved_count = sum(1 for ta in team.actions if ta.completed)
    hint_unlocked = loc_idx is not None and loc_idx < approved_count

    return {
        "location_id": loc.id,
        "name": loc.name,
        "question": loc.question,
        "hint": (loc.hint if (loc.hint and hint_unlocked) else None),
        "has_hint": bool(loc.hint),
        "attempts": prog.attempts if prog else 0,
        "distance_m": int(distance),
    }


@app.post("/api/teams/{team_id}/answer")
def submit_answer(
    team_id: int,
    payload: schemas.AnswerIn,
    x_team_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    team = _require_team(db, team_id, x_team_token)
    loc = db.query(models.Location).filter(
        models.Location.id == payload.location_id, models.Location.game_id == team.game_id
    ).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")

    if not _location_visible_to(team, loc.id):
        raise HTTPException(
            status_code=403,
            detail="This location isn't on your team's current step.",
        )

    if team.last_lat is None or team.last_lng is None:
        raise HTTPException(status_code=400, detail="No location ping recorded yet")
    distance = _haversine_m(team.last_lat, team.last_lng, loc.lat, loc.lng)
    if distance > loc.radius_m:
        raise HTTPException(
            status_code=403,
            detail=f"Out of range ({int(distance)}m, need ≤{loc.radius_m}m)",
        )

    prog = db.query(models.Progress).filter(
        models.Progress.team_id == team.id, models.Progress.location_id == loc.id
    ).first()
    if not prog:
        prog = models.Progress(team_id=team.id, location_id=loc.id, attempts=0, solved=False)
        db.add(prog)
        db.flush()

    if prog.solved:
        return {"correct": True, "already_solved": True, "fragment": loc.fragment}

    prog.attempts += 1
    correct = _norm_answer(payload.answer) == _norm_answer(loc.answer)
    if correct:
        prog.solved = True
        prog.solved_at = datetime.utcnow()
    db.commit()

    return {
        "correct": correct,
        "attempts": prog.attempts,
        "fragment": loc.fragment if correct else None,
    }


# Vercel @vercel/python runtime picks up `app` (ASGI) automatically.
