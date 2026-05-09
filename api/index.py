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
        with engine.begin() as conn:
            if "position" not in cols:
                conn.execute(text("ALTER TABLE progress ADD COLUMN position INTEGER"))
            if "submitted_at" not in cols:
                conn.execute(text("ALTER TABLE progress ADD COLUMN submitted_at TIMESTAMP"))
    if "locations" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("locations")}
        if "kind" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE locations ADD COLUMN kind TEXT DEFAULT 'question'"))
                conn.execute(text("UPDATE locations SET kind = 'question' WHERE kind IS NULL"))
    if "teams" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("teams")}
        if "is_test" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE teams ADD COLUMN is_test BOOLEAN DEFAULT FALSE"))
                conn.execute(text("UPDATE teams SET is_test = FALSE WHERE is_test IS NULL"))
    if "games" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("games")}
        with engine.begin() as conn:
            if "password_hash" not in cols:
                conn.execute(text("ALTER TABLE games ADD COLUMN password_hash TEXT"))
            if "test_mode" not in cols:
                # Use INTEGER for SQLite + Postgres compatibility (booleans
                # round-trip fine through SQLAlchemy's type adaption).
                conn.execute(text("ALTER TABLE games ADD COLUMN test_mode BOOLEAN DEFAULT FALSE"))
                conn.execute(text("UPDATE games SET test_mode = FALSE WHERE test_mode IS NULL"))
            if "viewer_token" not in cols:
                conn.execute(text("ALTER TABLE games ADD COLUMN viewer_token TEXT"))


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


# Scoring weights. Each solved stop (question or action) is worth the same.
_SCORE_PER_SOLVED = 100
_SCORE_PER_WRONG = -2


def _team_score_breakdown(team: models.Team) -> dict:
    """Returns components used both for the score and for tiebreaking."""
    solved_count = sum(1 for p in team.progress if p.solved)
    # Wrong attempts only apply to question stops (actions never count attempts).
    locs_by_id = {l.id: l for l in team.game.locations}
    total_question_attempts = 0
    question_solves = 0
    for p in team.progress:
        loc = locs_by_id.get(p.location_id)
        if loc and loc.kind == "action":
            continue
        total_question_attempts += (p.attempts or 0)
        if p.solved:
            question_solves += 1
    wrong_attempts = max(0, total_question_attempts - question_solves)
    # Legacy: count old-style approved bonus actions too — does not affect
    # score by default but stays visible in counters.
    actions_done = sum(1 for ta in team.actions if ta.completed)
    last_solve = max(
        (p.solved_at for p in team.progress if p.solved and p.solved_at),
        default=None,
    )
    score = solved_count * _SCORE_PER_SOLVED + wrong_attempts * _SCORE_PER_WRONG
    return {
        "solved_count": solved_count,
        "wrong_attempts": wrong_attempts,
        "actions_done": actions_done,
        "last_solve": last_solve,
        "score": score,
    }


def _ranked_teams(game: models.Game) -> list[tuple[models.Team, dict, int]]:
    """Returns [(team, breakdown, rank)] sorted high → low.
    Tiebreakers: more solved, more actions, fewer wrong attempts, earlier last solve.
    """
    rows = []
    for t in game.teams:
        b = _team_score_breakdown(t)
        rows.append((t, b))
    # Sorting key: (-score, -solved, -actions, wrong, last_solve_ts, team.id)
    def key(item):
        t, b = item
        last_ts = b["last_solve"].timestamp() if b["last_solve"] else float("inf")
        return (-b["score"], -b["solved_count"], -b["actions_done"], b["wrong_attempts"], last_ts, t.id)
    rows.sort(key=key)
    return [(t, b, idx + 1) for idx, (t, b) in enumerate(rows)]


def _leaderboard_entries(game: models.Game) -> list[schemas.LeaderboardEntry]:
    return [
        schemas.LeaderboardEntry(
            rank=rank,
            team_id=t.id,
            name=t.name,
            color=t.color,
            solved_count=b["solved_count"],
            actions_done=b["actions_done"],
            score=b["score"],
        )
        for (t, b, rank) in _ranked_teams(game)
    ]


def _ensure_viewer_token(db: Session, game: models.Game) -> str:
    if not game.viewer_token:
        game.viewer_token = _token()
        db.commit()
    return game.viewer_token


def _team_summary(db: Session, team: models.Team, total_locations: int,
                   breakdown: dict | None = None, rank: int = 0) -> schemas.TeamHostOut:
    if breakdown is None:
        breakdown = _team_score_breakdown(team)
    action_views = _team_action_views(team)
    return schemas.TeamHostOut(
        id=team.id,
        name=team.name,
        color=team.color,
        last_lat=team.last_lat,
        last_lng=team.last_lng,
        last_seen=team.last_seen,
        solved_count=breakdown["solved_count"],
        total=total_locations,
        actions_done=breakdown["actions_done"],
        actions_total=len(action_views),
        score=breakdown["score"],
        rank=rank,
        wrong_attempts=breakdown["wrong_attempts"],
        is_test=bool(team.is_test),
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
    return _build_dashboard(db, game)


def _build_dashboard(db: Session, game: models.Game, *, hide_host_token: bool = False) -> schemas.HostDashboardOut:
    total = len(game.locations)
    ranked = _ranked_teams(game)
    teams = [_team_summary(db, t, total, breakdown=b, rank=r) for (t, b, r) in ranked]
    matrix: dict = {}
    for t in game.teams:
        matrix[t.id] = {}
        for p in t.progress:
            matrix[t.id][p.location_id] = bool(p.solved)

    locs_by_id = {l.id: l for l in game.locations}
    pending: list[schemas.StopSubmission] = []
    for t in game.teams:
        for p in t.progress:
            if not p.submitted_at or p.solved:
                continue
            loc = locs_by_id.get(p.location_id)
            if not loc or loc.kind != "action":
                continue
            pending.append(schemas.StopSubmission(
                team_id=t.id,
                team_name=t.name,
                team_color=t.color,
                location_id=loc.id,
                location_name=loc.name,
                instruction=loc.question or "",
                submitted_at=p.submitted_at,
            ))
    pending.sort(key=lambda x: x.submitted_at)

    viewer_token = _ensure_viewer_token(db, game)
    out_game = schemas.GameHostOut.from_orm_game(game)
    if hide_host_token:
        out_game.host_token = ""  # don't leak the host secret to viewers
    return schemas.HostDashboardOut(
        game=out_game,
        teams=teams,
        progress_matrix=matrix,
        leaderboard=_leaderboard_entries(game),
        pending_stops=pending,
        viewer_url_path=f"/view/{game.id}#v={viewer_token}",
    )


@app.get("/api/games/{game_id}/dashboard-viewer", response_model=schemas.HostDashboardOut)
def viewer_dashboard(
    game_id: int,
    x_viewer_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Read-only dashboard for spectators / co-hosts. The viewer token is a
    separate, less-powerful credential — anyone with it can watch the live
    state but cannot mutate anything.
    """
    if not x_viewer_token:
        raise HTTPException(status_code=401, detail="Missing viewer token")
    game = db.query(models.Game).filter(models.Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if not game.viewer_token or game.viewer_token != x_viewer_token:
        raise HTTPException(status_code=403, detail="Bad viewer token")
    return _build_dashboard(db, game, hide_host_token=True)


@app.post("/api/games/{game_id}/test-mode")
def toggle_test_mode(
    game_id: int,
    payload: schemas.TestModeIn,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Toggle test mode. Turning it OFF also deletes every team that joined
    while it was on (their progress + actions cascade). Real teams that
    joined before test mode was ever enabled are kept.
    """
    game = _require_host(db, game_id, x_host_token, x_host_password)
    new_value = bool(payload.enabled)
    deleted = 0
    if game.test_mode and not new_value:
        test_teams = [t for t in game.teams if t.is_test]
        deleted = len(test_teams)
        for t in test_teams:
            db.delete(t)
    game.test_mode = new_value
    db.commit()
    return {"test_mode": game.test_mode, "deleted_test_teams": deleted}


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

def _normalize_location_payload(payload: schemas.LocationIn) -> dict:
    """Force consistent shape based on kind. For action stops we ignore the
    answer field entirely so the host can't accidentally trip auto-grading."""
    data = payload.model_dump()
    kind = (data.get("kind") or "question").strip().lower()
    if kind not in ("question", "action"):
        raise HTTPException(status_code=400, detail="kind must be 'question' or 'action'")
    data["kind"] = kind
    if kind == "action":
        data["answer"] = ""  # not used; keep it empty
    elif not (data.get("answer") or "").strip():
        raise HTTPException(status_code=400, detail="Question stops need an answer.")
    if not (data.get("question") or "").strip():
        label = "instruction" if kind == "action" else "question"
        raise HTTPException(status_code=400, detail=f"The {label} text is required.")
    return data


@app.post("/api/games/{game_id}/locations", response_model=schemas.LocationHostOut)
def add_location(
    game_id: int,
    payload: schemas.LocationIn,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _require_host(db, game_id, x_host_token, x_host_password)
    loc = models.Location(game_id=game_id, **_normalize_location_payload(payload))
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
    for k, v in _normalize_location_payload(payload).items():
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
            is_test=bool(existing.is_test),
        )

    team = models.Team(
        game_id=game.id,
        name=name,
        color=payload.color or "#D04A02",
        token=_token(),
        is_test=bool(game.test_mode),
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
        is_test=bool(team.is_test),
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
                submitted=bool(p.submitted_at and not p.solved),
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
                submitted=bool(p and p.submitted_at and not p.solved),
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
            kind=loc.kind or "question",
            order_idx=loc.order_idx,
            position=position,
            has_hint=bool(loc.hint),
            hint=(loc.hint if (loc.hint and unlocked) else None),
        ))

    leaderboard = _leaderboard_entries(game)
    own = next((e for e in leaderboard if e.team_id == team.id), None)

    return schemas.TeamStateOut(
        team_id=team.id,
        team_name=team.name,
        color=team.color,
        game_name=game.name,
        is_test=bool(team.is_test),
        locations=public_locs,
        progress=items,
        actions=_team_action_views(team),
        final_lat=(game.final_lat if all_solved else None),
        final_lng=(game.final_lng if all_solved else None),
        final_label=(game.final_label if all_solved else None),
        all_solved=all_solved,
        rank=(own.rank if own else 0),
        score=(own.score if own else 0),
        leaderboard=leaderboard,
        test_mode=bool(game.test_mode),
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

    test_mode = bool(team.game.test_mode)
    if not test_mode:
        if team.last_lat is None or team.last_lng is None:
            raise HTTPException(status_code=400, detail="No location ping recorded yet")
        distance = _haversine_m(team.last_lat, team.last_lng, loc.lat, loc.lng)
        if distance > loc.radius_m:
            raise HTTPException(
                status_code=403,
                detail=f"Out of range ({int(distance)}m, need ≤{loc.radius_m}m)",
            )
    else:
        distance = 0  # test mode: distance not enforced

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

    if loc.kind == "action":
        raise HTTPException(
            status_code=400,
            detail="This is an action stop — submit it via /submit-action and wait for host approval.",
        )

    if not _location_visible_to(team, loc.id):
        raise HTTPException(
            status_code=403,
            detail="This location isn't on your team's current step.",
        )

    if not team.game.test_mode:
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


from pydantic import BaseModel as _BaseModel


class _SubmitActionIn(_BaseModel):
    location_id: int


@app.post("/api/teams/{team_id}/submit-action")
def submit_action(
    team_id: int,
    payload: _SubmitActionIn,
    x_team_token: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Player marks an action stop as 'done — please approve' once they're in
    range. Host approves via the dashboard to advance the team."""
    team = _require_team(db, team_id, x_team_token)
    loc = db.query(models.Location).filter(
        models.Location.id == payload.location_id, models.Location.game_id == team.game_id
    ).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    if loc.kind != "action":
        raise HTTPException(status_code=400, detail="Not an action stop.")
    if not _location_visible_to(team, loc.id):
        raise HTTPException(status_code=403, detail="This location isn't on your team's current step.")

    if not team.game.test_mode:
        if team.last_lat is None or team.last_lng is None:
            raise HTTPException(status_code=400, detail="No location ping recorded yet")
        distance = _haversine_m(team.last_lat, team.last_lng, loc.lat, loc.lng)
        if distance > loc.radius_m:
            raise HTTPException(status_code=403, detail=f"Out of range ({int(distance)}m, need ≤{loc.radius_m}m)")

    prog = db.query(models.Progress).filter(
        models.Progress.team_id == team.id, models.Progress.location_id == loc.id
    ).first()
    if not prog:
        prog = models.Progress(team_id=team.id, location_id=loc.id, attempts=0, solved=False)
        db.add(prog)
        db.flush()
    if prog.solved:
        return {"already_solved": True, "fragment": loc.fragment}
    prog.submitted_at = datetime.utcnow()
    db.commit()
    return {"submitted": True, "submitted_at": prog.submitted_at}


@app.post("/api/games/{game_id}/teams/{team_id}/locations/{location_id}/approve")
def approve_action_stop(
    game_id: int,
    team_id: int,
    location_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Host approves a team's action-stop submission. Marks Progress.solved
    so the team's sequence advances. Distance is not re-checked (the server
    accepted the original submission and the host has out-of-band proof)."""
    _require_host(db, game_id, x_host_token, x_host_password)
    team = db.query(models.Team).filter(
        models.Team.id == team_id, models.Team.game_id == game_id
    ).first()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    loc = db.query(models.Location).filter(
        models.Location.id == location_id, models.Location.game_id == game_id
    ).first()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    if loc.kind != "action":
        raise HTTPException(status_code=400, detail="Not an action stop.")

    prog = db.query(models.Progress).filter(
        models.Progress.team_id == team.id, models.Progress.location_id == loc.id
    ).first()
    if not prog:
        prog = models.Progress(team_id=team.id, location_id=loc.id, attempts=0, solved=False)
        db.add(prog)
        db.flush()
    prog.solved = True
    prog.solved_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "team_id": team.id, "location_id": loc.id, "solved_at": prog.solved_at}


@app.post("/api/games/{game_id}/teams/{team_id}/locations/{location_id}/unapprove")
def unapprove_action_stop(
    game_id: int,
    team_id: int,
    location_id: int,
    x_host_token: str = Header(default=""),
    x_host_password: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Reverse an approval (in case the host clicked the wrong row)."""
    _require_host(db, game_id, x_host_token, x_host_password)
    prog = db.query(models.Progress).join(models.Location).filter(
        models.Progress.team_id == team_id,
        models.Progress.location_id == location_id,
        models.Location.game_id == game_id,
        models.Location.kind == "action",
    ).first()
    if not prog:
        raise HTTPException(status_code=404, detail="No such action progress")
    prog.solved = False
    prog.solved_at = None
    db.commit()
    return {"ok": True}


# Vercel @vercel/python runtime picks up `app` (ASGI) automatically.
