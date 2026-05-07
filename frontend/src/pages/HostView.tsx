import { Fragment, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { HostDashboard, getViewerDashboard } from "../api";
import MapView, { MapMarker } from "../components/MapView";

/**
 * Read-only "watch the host screen" view. Anyone with the URL
 * `/view/<gameId>#v=<viewer_token>` can see the live state but cannot mutate
 * anything. Useful for co-hosts watching from another laptop / phone.
 */
export default function HostView() {
  const { gameId } = useParams();
  const id = Number(gameId);
  const viewerToken = useMemo(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("v");
    if (fromHash) {
      sessionStorage.setItem(`view:${id}`, fromHash);
      return fromHash;
    }
    return sessionStorage.getItem(`view:${id}`) || "";
  }, [id]);

  const [data, setData] = useState<HostDashboard | null>(null);
  const [err, setErr] = useState("");
  const [openTeamId, setOpenTeamId] = useState<number | null>(null);

  async function reload() {
    if (!viewerToken) { setErr("Missing viewer token in URL (#v=…)."); return; }
    try {
      const d = await getViewerDashboard(id, viewerToken);
      setData(d);
      setErr("");
    } catch (e: any) { setErr(e.message || "Failed to load"); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id, viewerToken]);
  useEffect(() => {
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [id, viewerToken]);

  if (err && !data) {
    return <div className="app"><div className="card"><div className="banner banner--bad">{err}</div></div></div>;
  }
  if (!data) return <div className="app"><div className="card">Loading…</div></div>;

  const { game, teams, progress_matrix, leaderboard } = data;
  const ranked = [...teams].sort((a, b) => (a.rank || 999) - (b.rank || 999));
  const locMarkers: MapMarker[] = game.locations.map(l => ({
    id: `l-${l.id}`, lat: l.lat, lng: l.lng, label: l.name, radius_m: l.radius_m, showRadius: true,
  }));
  const teamMarkers: MapMarker[] = teams
    .filter(t => t.last_lat != null && t.last_lng != null)
    .map(t => ({ id: `t-${t.id}`, lat: t.last_lat!, lng: t.last_lng!, label: `${t.name} (${t.solved_count}/${t.total})`, color: t.color }));

  return (
    <div className="app">
      <div className="card">
        <div className="row row--wrap" style={{ gap: 12 }}>
          <h1 style={{ margin: 0 }}>{game.name}</h1>
          <span className="banner" style={{ padding: "4px 10px", background: "rgba(90,185,255,0.15)", color: "#5ab9ff" }}>
            👁 Watching (read-only)
          </span>
          {game.test_mode && <span className="banner banner--warn" style={{ padding: "4px 10px" }}>TEST MODE</span>}
          <div className="spacer" />
          <span className="muted">Join code:</span>
          <span className="code-pill">{game.join_code}</span>
        </div>
      </div>

      <div className="card">
        <MapView markers={[...locMarkers, ...teamMarkers]} big />

        {leaderboard.length > 0 && (
          <>
            <h2 style={{ marginTop: 16 }}>Leaderboard</h2>
            <ol className="loc-list" style={{ listStyle: "none", paddingLeft: 0 }}>
              {leaderboard.map(e => (
                <li key={e.team_id} className="loc-row">
                  <div className="row" style={{ gap: 10, flex: 1 }}>
                    <span style={{ fontWeight: 700, width: 28 }}>
                      {e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : `${e.rank}.`}
                    </span>
                    <span className="dot" style={{ background: e.color }} />
                    <span style={{ fontWeight: 500 }}>{e.name}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {e.solved_count} solved · {e.actions_done} actions
                    </span>
                  </div>
                  <span className="code-pill">{e.score} pts</span>
                </li>
              ))}
            </ol>
          </>
        )}

        <h2 style={{ marginTop: 16 }}>Progress</h2>
        {teams.length === 0 ? (
          <div className="muted">No teams yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="matrix">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>#</th>
                  <th style={{ textAlign: "left" }}>Team</th>
                  {game.locations.map(l => <th key={l.id} title={l.name}>{l.name.slice(0, 4)}</th>)}
                  <th>Solved</th>
                  <th>Actions</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(t => {
                  const row = progress_matrix[String(t.id)] || {};
                  const open = openTeamId === t.id;
                  return (
                    <Fragment key={t.id}>
                      <tr style={{ cursor: "pointer" }} onClick={() => setOpenTeamId(open ? null : t.id)}>
                        <td style={{ fontWeight: 700 }}>
                          {t.rank === 1 ? "🥇" : t.rank === 2 ? "🥈" : t.rank === 3 ? "🥉" : t.rank}
                        </td>
                        <td className="team-cell">
                          <span className="dot" style={{ background: t.color, marginRight: 8 }} />
                          {t.name}
                        </td>
                        {game.locations.map(l => (
                          <td key={l.id} className={row[String(l.id)] ? "solved" : ""}>{row[String(l.id)] ? "✓" : ""}</td>
                        ))}
                        <td>{t.solved_count}/{t.total}</td>
                        <td>{t.actions_done}/{t.actions_total}</td>
                        <td><strong>{t.score ?? 0}</strong></td>
                      </tr>
                      {open && t.actions.length > 0 && (
                        <tr>
                          <td colSpan={game.locations.length + 5} style={{ textAlign: "left", background: "var(--bg2)" }}>
                            <ul className="list-bullet" style={{ margin: 0 }}>
                              {t.actions.map(a => (
                                <li key={a.id} style={{ color: a.completed ? "var(--good)" : "var(--text)" }}>
                                  {a.completed ? "✓ " : "○ "}{a.text}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
