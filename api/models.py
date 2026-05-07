import os
import sys
from datetime import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from sqlalchemy import (
    Column, Integer, String, Float, ForeignKey, DateTime, Boolean, Text, UniqueConstraint
)
from sqlalchemy.orm import relationship
from db import Base


class Game(Base):
    __tablename__ = "games"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False)
    host_token = Column(String(64), nullable=False, unique=True, index=True)
    join_code = Column(String(12), nullable=False, unique=True, index=True)
    # Optional password gate. Anyone with the host_token AND this password
    # can host. Stored as a PBKDF2 hash; null means no password set.
    password_hash = Column(String(255), nullable=True)
    final_lat = Column(Float, nullable=True)
    final_lng = Column(Float, nullable=True)
    final_label = Column(String(200), nullable=True)
    started = Column(Boolean, default=False)
    # When True, geofencing is skipped — the host can validate the flow
    # without walking around. Visibility / sequence gates still apply.
    test_mode = Column(Boolean, default=False, nullable=False)
    # Read-only "watch the host screen" token. Generated lazily; anyone
    # with the URL `/view/<gameId>#v=<viewer_token>` can watch the live
    # dashboard but cannot mutate anything.
    viewer_token = Column(String(64), nullable=True, unique=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    locations = relationship("Location", back_populates="game", cascade="all, delete-orphan", order_by="Location.order_idx")
    teams = relationship("Team", back_populates="game", cascade="all, delete-orphan")
    actions = relationship("Action", back_populates="game", cascade="all, delete-orphan", order_by="Action.id")


class Location(Base):
    __tablename__ = "locations"

    id = Column(Integer, primary_key=True)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    radius_m = Column(Integer, default=40, nullable=False)
    # "question" — auto-graded by answer match.
    # "action"   — team submits when in range, host approves manually.
    kind = Column(String(20), default="question", nullable=False)
    question = Column(Text, nullable=False)  # for action stops, this is the instruction
    answer = Column(String(200), nullable=False, default="")  # ignored for action stops
    fragment = Column(String(200), nullable=False, default="")
    hint = Column(Text, nullable=True)
    order_idx = Column(Integer, default=0, nullable=False)

    game = relationship("Game", back_populates="locations")


class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(80), nullable=False)
    color = Column(String(20), default="#D04A02")
    token = Column(String(64), nullable=False, unique=True, index=True)
    last_lat = Column(Float, nullable=True)
    last_lng = Column(Float, nullable=True)
    last_seen = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    game = relationship("Game", back_populates="teams")
    progress = relationship("Progress", back_populates="team", cascade="all, delete-orphan")
    actions = relationship("TeamAction", back_populates="team", cascade="all, delete-orphan")


class Progress(Base):
    __tablename__ = "progress"
    __table_args__ = (UniqueConstraint("team_id", "location_id", name="uq_team_location"),)

    id = Column(Integer, primary_key=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True)
    location_id = Column(Integer, ForeignKey("locations.id", ondelete="CASCADE"), nullable=False, index=True)
    # Per-team position in the randomized sequence. Null until the host locks
    # the game; legacy data also has null and falls back to "all visible".
    position = Column(Integer, nullable=True)
    solved = Column(Boolean, default=False)
    attempts = Column(Integer, default=0)
    solved_at = Column(DateTime, nullable=True)
    # For action-kind locations: when the team marked themselves as ready /
    # done. Host approval flips solved=True. Null on question-kind stops.
    submitted_at = Column(DateTime, nullable=True)

    team = relationship("Team", back_populates="progress")
    location = relationship("Location")


class Action(Base):
    __tablename__ = "actions"

    id = Column(Integer, primary_key=True)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), nullable=False, index=True)
    text = Column(Text, nullable=False)
    hint = Column(Text, nullable=True)
    # Optional: tie an action to a location. Tells the team where to do the
    # action. The location is only revealed to a team once that location is
    # in their visible sequence.
    location_id = Column(Integer, ForeignKey("locations.id", ondelete="SET NULL"), nullable=True, index=True)

    game = relationship("Game", back_populates="actions")
    location = relationship("Location")


class TeamAction(Base):
    __tablename__ = "team_actions"
    __table_args__ = (UniqueConstraint("team_id", "action_id", name="uq_team_action"),)

    id = Column(Integer, primary_key=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False, index=True)
    action_id = Column(Integer, ForeignKey("actions.id", ondelete="CASCADE"), nullable=False, index=True)
    completed = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)

    team = relationship("Team", back_populates="actions")
    action = relationship("Action")
