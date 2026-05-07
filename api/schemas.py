from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field, ConfigDict


class LocationIn(BaseModel):
    name: str
    lat: float
    lng: float
    radius_m: int = Field(default=40, ge=5, le=2000)
    question: str
    answer: str
    fragment: str = ""
    hint: Optional[str] = None
    order_idx: int = 0


class LocationHostOut(LocationIn):
    id: int
    model_config = ConfigDict(from_attributes=True)


class LocationPublicOut(BaseModel):
    """What players see — no answer leaked.

    `hint` is filled only when the team has unlocked it (approved actions ≥
    this location's index in order). `has_hint` tells the UI whether a hint
    exists at all, so it can show a "locked" placeholder when appropriate.

    `position` is the team-specific index in their randomized sequence; the UI
    sorts by it. Null in the legacy "all-visible" mode (game not locked yet).
    """
    id: int
    name: str
    lat: float
    lng: float
    radius_m: int
    order_idx: int
    position: Optional[int] = None
    hint: Optional[str] = None
    has_hint: bool = False
    model_config = ConfigDict(from_attributes=True)


class GameCreate(BaseModel):
    name: str
    final_lat: Optional[float] = None
    final_lng: Optional[float] = None
    final_label: Optional[str] = None
    # Only honored at creation. Use POST /api/games/{id}/password to change later.
    password: Optional[str] = None


class HostRecoverIn(BaseModel):
    host_token: str


class HostRecoverOut(BaseModel):
    game_id: int
    name: str
    join_code: str
    has_password: bool = False


class PasswordSetIn(BaseModel):
    """null/empty clears the password; non-empty replaces it."""
    password: Optional[str] = None


class ActionIn(BaseModel):
    text: str
    hint: Optional[str] = None
    location_id: Optional[int] = None


class ActionOut(BaseModel):
    id: int
    text: str
    hint: Optional[str] = None
    location_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


class GameHostOut(BaseModel):
    id: int
    name: str
    join_code: str
    host_token: str
    final_lat: Optional[float] = None
    final_lng: Optional[float] = None
    final_label: Optional[str] = None
    started: bool
    has_password: bool = False
    locations: List[LocationHostOut] = []
    actions: List[ActionOut] = []
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def from_orm_game(cls, game) -> "GameHostOut":
        # Pydantic v2 + from_attributes can't compute has_password from a non-attribute,
        # so we build manually.
        return cls.model_validate({
            "id": game.id,
            "name": game.name,
            "join_code": game.join_code,
            "host_token": game.host_token,
            "final_lat": game.final_lat,
            "final_lng": game.final_lng,
            "final_label": game.final_label,
            "started": bool(game.started),
            "has_password": bool(game.password_hash),
            "locations": game.locations,
            "actions": game.actions,
        })


class GamePublicOut(BaseModel):
    id: int
    name: str
    join_code: str
    started: bool
    model_config = ConfigDict(from_attributes=True)


class TeamCreate(BaseModel):
    name: str
    color: str = "#D04A02"


class TeamActionOut(BaseModel):
    """A team's view of one of its assigned actions (with action text inlined)."""
    id: int  # team_action id
    action_id: int
    text: str
    hint: Optional[str] = None
    completed: bool
    completed_at: Optional[datetime] = None
    # The action's tied location, if any. The name is only revealed once the
    # location is visible in the team's sequence; otherwise location_id is None.
    location_id: Optional[int] = None
    location_name: Optional[str] = None


class TeamHostOut(BaseModel):
    id: int
    name: str
    color: str
    last_lat: Optional[float] = None
    last_lng: Optional[float] = None
    last_seen: Optional[datetime] = None
    solved_count: int = 0
    total: int = 0
    actions_done: int = 0
    actions_total: int = 0
    score: int = 0
    rank: int = 0  # 1-indexed position in the leaderboard
    wrong_attempts: int = 0
    actions: List[TeamActionOut] = []
    model_config = ConfigDict(from_attributes=True)


class LeaderboardEntry(BaseModel):
    """Public rank row players get to see — no leak of game internals."""
    rank: int
    team_id: int
    name: str
    color: str
    solved_count: int
    actions_done: int
    score: int


class TeamJoinIn(BaseModel):
    join_code: str
    name: str
    color: str = "#D04A02"


class TeamSession(BaseModel):
    team_id: int
    team_token: str
    team_name: str
    color: str
    game_id: int
    game_name: str


class PingIn(BaseModel):
    lat: float
    lng: float


class AnswerIn(BaseModel):
    location_id: int
    answer: str


class ProgressItem(BaseModel):
    location_id: int
    solved: bool
    attempts: int
    fragment: Optional[str] = None  # only if solved


class TeamStateOut(BaseModel):
    team_id: int
    team_name: str
    color: str
    game_name: str
    locations: List[LocationPublicOut]
    progress: List[ProgressItem]
    actions: List[TeamActionOut] = []
    final_lat: Optional[float] = None
    final_lng: Optional[float] = None
    final_label: Optional[str] = None
    all_solved: bool = False
    # Live ranking — fuels the competitive aspect on the player UI.
    rank: int = 0
    score: int = 0
    leaderboard: List[LeaderboardEntry] = []
    test_mode: bool = False


class HostDashboardOut(BaseModel):
    game: GameHostOut
    teams: List[TeamHostOut]
    progress_matrix: dict  # {team_id: {location_id: solved_bool}}
    leaderboard: List[LeaderboardEntry] = []
    viewer_url_path: Optional[str] = None  # frontend prepends origin


class TestModeIn(BaseModel):
    enabled: bool
