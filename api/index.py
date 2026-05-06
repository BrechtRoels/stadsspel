"""FastAPI entry point — also the Vercel Python serverless handler.

Vercel's @vercel/python runtime imports this file directly (not as part of an
`api` package), so we use absolute imports and ensure the directory is on
sys.path. Locally, run with: `uvicorn --app-dir api index:app --reload`.
"""
import math
import os
import random
import secrets
import string
import sys
from datetime import datetime
from typing import List

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
        if "hint" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE actions ADD COLUMN hint TEXT"))


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


def _require_host(db: Session, game_id: int, token: str) -> models.Game:
    if not token:
        raise HTTPException(status_code=401, detail="Missing host token")
    game = db.query(models.Game).filter(models.Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.host_token != token:
        raise HTTPException(status_code=403, detail="Bad host token")
    return game


def _require_team(db: Session, team_id: int, token: str) -> models.Team:
    if not token:
        raise HTTPException(status_code=401, detail="Missing team token")
    team = db.query(models.Team).filter(models.Team.id == team_id).first()
    if not team or team.token != token:
        raise HTTPException(status_code=403, detail="Bad team token")
    return team


def _team_action_views(team: models.Team) -> List[schemas.TeamActionOut]:
    out: List[schemas.TeamActionOut] = []
    for ta in team.actions:
        out.append(schemas.TeamActionOut(
            id=ta.id,
            action_id=ta.action_id,
            text=ta.action.text if ta.action else "",
            hint=(ta.action.hint if ta.action else None),
            completed=bool(ta.completed),
            completed_at=ta.completed_at,
        ))
    return out


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
    )
    db.add(game)
    db.commit()
    db.refresh(game)
    return game


@app.get("/api/games/{game_id}/host", response_model=schemas.HostDashboardOut)
def host_dashboard(
    game_id: int,
    x_host_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    game = _require_host(db, game_id, x_host_token)
    total = len(game.locations)
    teams = [_team_summary(db, t, total) for t in game.teams]
    matrix: dict = {}
    for t in game.teams:
        matrix[t.id] = {}
        for p in t.progress:
            matrix[t.id][p.location_id] = bool(p.solved)
    return schemas.HostDashboardOut(
        game=schemas.GameHostOut.model_validate(game),
        teams=teams,
        progress_matrix=matrix,
    )


@app.patch("/api/games/{game_id}", response_model=schemas.GameHostOut)
def update_game(
    game_id: int,
    payload: schemas.GameCreate,
    x_host_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    game = _require_host(db, game_id, x_host_token)
    game.name = payload.name
    game.final_lat = payload.final_lat
    game.final_lng = payload.final_lng
    game.final_label = payload.final_label
    db.commit()
    db.refresh(game)
    return game


@app.post("/api/games/{game_id}/start", response_model=schemas.GameHostOut)
def start_game(
    game_id: int,
    x_host_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    game = _require_host(db, game_id, x_host_token)
    game.started = True
    db.commit()
    db.refresh(game)
    return game


@app.post("/api/games/{game_id}/stop", response_model=schemas.GameHostOut)
def stop_game(
    game_id: int,
    x_host_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    game = _require_host(db, game_id, x_host_token)
    game.started = False
    db.commit()
    db.refresh(game)
    return game


# ---------- host: locations ----------

@app.post("/api/games/{game_id}/locations", response_model=schemas.LocationHostOut)
def add_location(
    game_id: int,
    payload: schemas.LocationIn,
    x_host_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token)
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
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token)
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
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token)
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
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token)
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Action text is required")
    hint = (payload.hint or "").strip() or None
    action = models.Action(game_id=game_id, text=text, hint=hint)
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
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token)
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
    db.commit()
    db.refresh(a)
    return a


@app.delete("/api/games/{game_id}/actions/{action_id}", status_code=204)
def delete_action(
    game_id: int,
    action_id: int,
    x_host_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token)
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
    db: Session = Depends(get_db),
):
    """Top up every team to ACTIONS_PER_TEAM. Useful if the host added actions
    after teams already joined. Existing assignments are kept (no reshuffle)."""
    game = _require_host(db, game_id, x_host_token)
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
    locs = sorted(game.locations, key=lambda l: (l.order_idx, l.id))
    prog_by_loc = {p.location_id: p for p in team.progress}
    items: List[schemas.ProgressItem] = []
    all_solved = bool(locs)
    for loc in locs:
        p = prog_by_loc.get(loc.id)
        solved = bool(p and p.solved)
        if not solved:
            all_solved = False
        items.append(
            schemas.ProgressItem(
                location_id=loc.id,
                solved=solved,
                attempts=(p.attempts if p else 0),
                fragment=(loc.fragment if solved else None),
            )
        )

    # Each approved action unlocks one hint, in location order_idx order.
    approved_count = sum(1 for ta in team.actions if ta.completed)
    public_locs: List[schemas.LocationPublicOut] = []
    for idx, loc in enumerate(locs):
        unlocked = idx < approved_count
        public_locs.append(schemas.LocationPublicOut(
            id=loc.id,
            name=loc.name,
            lat=loc.lat,
            lng=loc.lng,
            radius_m=loc.radius_m,
            order_idx=loc.order_idx,
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
    db: Session = Depends(get_db),
):
    """Approve / unapprove a team's completion of an action.

    Teams send proof out-of-band (e.g. WhatsApp); only the host flips this.
    """
    _require_host(db, game_id, x_host_token)
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
