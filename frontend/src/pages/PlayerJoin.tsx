import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { joinGame } from "../api";

const COLORS = ["#D04A02", "#5ab9ff", "#2bb673", "#f5a623", "#a36cff", "#ff5fa2"];

export default function PlayerJoin() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const s = await joinGame(code.trim().toUpperCase(), name.trim() || "Team", color);
      localStorage.setItem(`team:${s.team_id}`, s.team_token);
      localStorage.setItem(`team:${s.team_id}:meta`, JSON.stringify({ name: s.team_name, color: s.color, game: s.game_name }));
      nav(`/play/${s.team_id}`);
    } catch (e: any) {
      setErr(e.message || "Could not join");
    } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <div className="card">
        <h1>Join a game</h1>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          New here? Pick a team name. <br />
          Already played and lost the page? Enter the same code and team name to continue.
        </div>
        <form className="stack" onSubmit={submit}>
          <div>
            <label>Game code</label>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="ABC23X" autoFocus style={{ letterSpacing: "0.2em", fontFamily: "ui-monospace, monospace" }} />
          </div>
          <div>
            <label>Team name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="The Wanderers" />
          </div>
          <div>
            <label>Team color</label>
            <div className="row row--wrap">
              {COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  style={{
                    width: 32, height: 32, borderRadius: 16, background: c,
                    border: c === color ? "3px solid white" : "2px solid var(--border)",
                    cursor: "pointer",
                  }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
          {err && <div className="banner banner--bad">{err}</div>}
          <div className="row">
            <Link to="/" className="btn btn--ghost" style={{ textDecoration: "none" }}>Cancel</Link>
            <div className="spacer" />
            <button className="btn" disabled={busy || !code.trim()}>{busy ? "Joining…" : "Join"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
