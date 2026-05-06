import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  TeamState, fetchQuestion, submitAnswer, teamPing, teamState,
} from "../api";
import MapView, { MapMarker } from "../components/MapView";
import { haversineMeters } from "../geo";

type Pos = { lat: number; lng: number; accuracy: number };

export default function PlayerGame() {
  const { teamId } = useParams();
  const nav = useNavigate();
  const id = Number(teamId);
  const token = useMemo(() => localStorage.getItem(`team:${id}`) || "", [id]);

  const [state, setState] = useState<TeamState | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [geoErr, setGeoErr] = useState("");
  const [err, setErr] = useState("");
  const [q, setQ] = useState<{
    location_id: number; name: string; question: string; hint?: string | null; has_hint?: boolean; attempts: number; distance_m: number;
  } | null>(null);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const lastPingRef = useRef<number>(0);

  useEffect(() => {
    if (!token) { nav("/play"); return; }
    (async () => {
      try { setState(await teamState(id, token)); }
      catch (e: any) { setErr(e.message); }
    })();
  }, [id, token]);

  // poll team state
  useEffect(() => {
    if (!token) return;
    const t = setInterval(async () => {
      try { setState(await teamState(id, token)); } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, [id, token]);

  // geolocation watcher
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoErr("Geolocation not supported on this browser.");
      return;
    }
    const wid = navigator.geolocation.watchPosition(
      (gp) => {
        setGeoErr("");
        setPos({ lat: gp.coords.latitude, lng: gp.coords.longitude, accuracy: gp.coords.accuracy });
      },
      (e) => setGeoErr(e.message || "Location permission denied"),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(wid);
  }, []);

  // ping server (max 1/4s)
  useEffect(() => {
    if (!pos || !token) return;
    const now = Date.now();
    if (now - lastPingRef.current < 4000) return;
    lastPingRef.current = now;
    teamPing(id, token, pos.lat, pos.lng).catch(() => {});
  }, [pos, id, token]);

  if (!token) return null;
  if (!state) return <div className="app"><div className="card">{err || "Loading…"}</div></div>;

  const solvedSet = new Set(state.progress.filter(p => p.solved).map(p => p.location_id));
  const solvedFragments = state.progress.filter(p => p.solved && p.fragment).map(p => ({ loc: p.location_id, fragment: p.fragment! }));

  const markers: MapMarker[] = state.locations.map(l => ({
    id: l.id, lat: l.lat, lng: l.lng, label: l.name, radius_m: l.radius_m, showRadius: true, solved: solvedSet.has(l.id),
  }));

  async function openQuestion(locId: number) {
    setErr(""); setFeedback(null); setAnswer("");
    try {
      const r = await fetchQuestion(id, token, locId);
      if ((r as any).already_solved) {
        setFeedback({ ok: true, msg: `Already solved. Fragment: ${(r as any).fragment}` });
        return;
      }
      setQ(r as any);
    } catch (e: any) { setErr(e.message); }
  }

  async function send() {
    if (!q) return;
    try {
      const r = await submitAnswer(id, token, q.location_id, answer);
      if (r.correct) {
        setFeedback({ ok: true, msg: `Correct! Fragment unlocked: ${r.fragment ?? "(none)"}` });
        setQ(null);
        // refresh state
        setState(await teamState(id, token));
      } else {
        setFeedback({ ok: false, msg: `Not quite. Attempts: ${r.attempts}. Try again.` });
      }
    } catch (e: any) {
      setFeedback({ ok: false, msg: e.message });
    }
  }

  return (
    <div className="app">
      <div className="card">
        <div className="row row--wrap">
          <span className="dot" style={{ background: state.color, marginRight: 6 }} />
          <strong>{state.team_name}</strong>
          <span className="muted">· {state.game_name}</span>
          <div className="spacer" />
          <span className="muted">
            {state.progress.filter(p => p.solved).length} / {state.locations.length} solved
          </span>
        </div>
        {geoErr && <div className="banner banner--bad" style={{ marginTop: 8 }}>{geoErr}</div>}
        {!pos && !geoErr && <div className="banner banner--warn" style={{ marginTop: 8 }}>Waiting for GPS lock…</div>}
      </div>

      <div className="card">
        <MapView markers={markers} user={pos ? { lat: pos.lat, lng: pos.lng } : null} big />
      </div>

      <div className="card">
        <h2>Locations</h2>
        <ul className="loc-list">
          {state.locations.map(l => {
            const solved = solvedSet.has(l.id);
            const distance = pos ? haversineMeters(pos.lat, pos.lng, l.lat, l.lng) : null;
            const inRange = distance != null && distance <= l.radius_m;
            return (
              <li key={l.id} className="loc-row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div className="loc-row__title">{l.name}</div>
                  <div className="loc-row__meta">
                    {distance == null
                      ? "—"
                      : `${Math.round(distance)} m away (radius ${l.radius_m} m)`}
                  </div>
                  {l.hint ? (
                    <div className="loc-row__meta" style={{ color: "var(--warn)", marginTop: 4 }}>
                      <strong>Hint:</strong> {l.hint}
                    </div>
                  ) : l.has_hint ? (
                    <div className="loc-row__meta muted" style={{ marginTop: 4 }}>
                      🔒 Hint locked — get more actions approved to unlock.
                    </div>
                  ) : null}
                </div>
                <div className="row">
                  {solved ? (
                    <span className="distance-tag distance-tag--done">✓ Solved</span>
                  ) : inRange ? (
                    <button className="btn btn--small" onClick={() => openQuestion(l.id)}>Open question</button>
                  ) : (
                    <span className="distance-tag distance-tag--out">Out of range</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {err && <div className="banner banner--bad" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Your actions</h2>
          <div className="spacer" />
          {state.actions.length > 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              {state.actions.filter(a => a.completed).length} / {state.actions.length} approved
            </span>
          )}
        </div>
        {state.actions.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            Waiting for the host to reveal your actions. They'll appear here automatically.
          </div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 12, margin: "4px 0 12px" }}>
              Send proof to the host via WhatsApp. The host approves it here, and you'll see it update.
            </div>
            <ul className="loc-list">
              {state.actions.map(a => (
                <li key={a.id} className="loc-row" style={{ opacity: a.completed ? 0.85 : 1, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ textDecoration: a.completed ? "line-through" : "none" }}>{a.text}</div>
                    {a.hint && (
                      <div className="loc-row__meta" style={{ color: "var(--warn)", marginTop: 4 }}>
                        Hint: {a.hint}
                      </div>
                    )}
                  </div>
                  <span className={`distance-tag ${a.completed ? "distance-tag--done" : "distance-tag--out"}`}>
                    {a.completed ? "✓ Approved" : "Pending"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {solvedFragments.length > 0 && (
        <div className="card">
          <h2>Coordinate fragments</h2>
          <ul className="list-bullet">
            {solvedFragments.map((f, idx) => (
              <li key={idx}><span className="fragment-pill">{f.fragment}</span></li>
            ))}
          </ul>
        </div>
      )}

      {state.all_solved && (
        <div className="card">
          <h2>Final destination</h2>
          {state.final_lat != null && state.final_lng != null ? (
            <>
              <div className="banner banner--good" style={{ marginBottom: 12 }}>
                All fragments collected. Head to:
              </div>
              {state.final_label && <div style={{ marginBottom: 8 }}><strong>{state.final_label}</strong></div>}
              <div className="muted">
                {state.final_lat.toFixed(6)}, {state.final_lng.toFixed(6)}
              </div>
              <div style={{ marginTop: 12 }}>
                <a className="btn" href={`https://maps.google.com/?q=${state.final_lat},${state.final_lng}`} target="_blank" rel="noreferrer">Open in Maps</a>
              </div>
            </>
          ) : (
            <div className="muted">All locations solved! The host hasn't set final coordinates.</div>
          )}
        </div>
      )}

      {q && (
        <div className="modal-backdrop" onClick={() => setQ(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{q.name}</h2>
            <div className="muted" style={{ marginBottom: 8 }}>Within {q.distance_m}m · attempts: {q.attempts}</div>
            <p style={{ whiteSpace: "pre-wrap" }}>{q.question}</p>
            {q.hint
              ? <div className="banner banner--warn" style={{ marginBottom: 12 }}>Hint: {q.hint}</div>
              : q.has_hint
                ? <div className="banner banner--warn" style={{ marginBottom: 12 }}>🔒 A hint exists for this location but isn't unlocked yet — get more actions approved.</div>
                : null}
            <div>
              <label>Your answer</label>
              <input value={answer} onChange={e => setAnswer(e.target.value)} autoFocus />
            </div>
            {feedback && (
              <div className={`banner ${feedback.ok ? "banner--good" : "banner--bad"}`} style={{ marginTop: 12 }}>
                {feedback.msg}
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn--ghost" onClick={() => setQ(null)}>Close</button>
              <div className="spacer" />
              <button className="btn" onClick={send} disabled={!answer.trim()}>Submit</button>
            </div>
          </div>
        </div>
      )}

      {feedback && !q && (
        <div className="modal-backdrop" onClick={() => setFeedback(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className={`banner ${feedback.ok ? "banner--good" : "banner--bad"}`}>{feedback.msg}</div>
            <div className="row" style={{ marginTop: 12 }}>
              <div className="spacer" />
              <button className="btn" onClick={() => setFeedback(null)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
