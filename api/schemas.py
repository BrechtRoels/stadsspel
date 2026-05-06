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
    """
    id: int
    name: str
    lat: float
    lng: float
    radius_m: int
    order_idx: int
    hint: Optional[str] = None
    has_hint: bool = False
    model_config = ConfigDict(from_attributes=True)


class GameCreate(BaseModel):
    name: str
    final_lat: Optional[float] = None
    final_lng: Optional[float] = None
    final_label: Optional[str] = None


class ActionIn(BaseModel):
    text: str
    hint: Optional[str] = None


class ActionOut(BaseModel):
    id: int
    text: str
    hint: Optional[str] = None
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
    locations: List[LocationHostOut] = []
    actions: List[ActionOut] = []
    model_config = ConfigDict(from_attributes=True)


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
    actions: List[TeamActionOut] = []
    model_config = ConfigDict(from_attributes=True)


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


class HostDashboardOut(BaseModel):
    game: GameHostOut
    teams: List[TeamHostOut]
    progress_matrix: dict  # {team_id: {location_id: solved_bool}}
