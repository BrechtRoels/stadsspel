import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  HostDashboard, LocationHost, PASSWORD_REQUIRED_MARKER,
  addLocation, approveStop, deleteLocation, getHostDashboard,
  hostToggleTeamAction, setHostPassword, startGame, stopGame,
  toggleTestMode, updateGame, updateLocation,
} from "../api";
import MapView, { MapMarker } from "../components/MapView";

type Tab = "setup" | "live";

// Bruges, Belfry on the Markt.
const DEFAULT_CENTER: [number, number] = [51.2087, 3.2247];

const blankLoc: Omit<LocationHost, "id"> = {
  name: "",
  lat: DEFAULT_CENTER[0],
  lng: DEFAULT_CENTER[1],
  radius_m: 40,
  kind: "question",
  question: "",
  answer: "",
  fragment: "",
  hint: "",
  order_idx: 0,
};

export default function HostGame() {
  const { gameId } = useParams();
  const nav = useNavigate();
  const id = Number(gameId);
  const hostToken = useMemo(() => {
    const stored = localStorage.getItem(`host:${id}`);
    if (stored) return stored;
    // Fall back to a token in the URL fragment, e.g. #t=abc123…
    // Fragments aren't sent to the server so they're safer than query params.
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t");
    if (fromHash) {
      localStorage.setItem(`host:${id}`, fromHash);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return fromHash;
    }
    return "";
  }, [id]);
  const [hostPassword, setHostPasswordState] = useState<string>(() => localStorage.getItem(`host_pw:${id}`) || "");
  const [needPwPrompt, setNeedPwPrompt] = useState(false);

  function rememberPassword(pw: string) {
    localStorage.setItem(`host_pw:${id}`, pw);
    setHostPasswordState(pw);
  }
  function forgetPassword() {
    localStorage.removeItem(`host_pw:${id}`);
    setHostPasswordState("");
  }

  const [tab, setTab] = useState<Tab>("setup");
  const [data, setData] = useState<HostDashboard | null>(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<Omit<LocationHost, "id"> | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [meta, setMeta] = useState<{ name: string; final_lat: string; final_lng: string; final_label: string }>({
    name: "", final_lat: "", final_lng: "", final_label: "",
  });

  async function reload() {
    if (!hostToken) { nav("/host"); return; }
    try {
      const d = await getHostDashboard(id, hostToken, hostPassword);
      setData(d);
      setMeta({
        name: d.game.name,
        final_lat: d.game.final_lat?.toString() ?? "",
        final_lng: d.game.final_lng?.toString() ?? "",
        final_label: d.game.final_label ?? "",
      });
      setErr("");
    } catch (e: any) {
      if (e?.message === PASSWORD_REQUIRED_MARKER) {
        forgetPassword();
        setNeedPwPrompt(true);
        return;
      }
      setErr(e.message || "Failed to load game");
    }
  }

  useEffect(() => { reload(); }, [id]);

  // Live polling on dashboard tab
  useEffect(() => {
    if (tab !== "live") return;
    const t = setInterval(() => { reload(); }, 3000);
    return () => clearInterval(t);
  }, [tab]);

  if (!hostToken) return null;
  if (needPwPrompt) {
    return <PasswordPrompt
      onSubmit={pw => { rememberPassword(pw); setNeedPwPrompt(false); reload(); }}
      onCancel={() => nav("/host")}
    />;
  }
  if (!data) return <div className="app"><div className="card">{err || "Loading…"}</div></div>;

  const game = data.game;

  async function saveMeta() {
    try {
      await updateGame(id, hostToken, hostPassword, {
        name: meta.name.trim() || game.name,
        final_lat: meta.final_lat ? Number(meta.final_lat) : null,
        final_lng: meta.final_lng ? Number(meta.final_lng) : null,
        final_label: meta.final_label || null,
      });
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  async function startNow() {
    try { await startGame(id, hostToken, hostPassword); reload(); } catch (e: any) { setErr(e.message); }
  }
  async function stopNow() {
    if (!confirm("Stop the game? Teams will see it as no longer live; you can resume any time.")) return;
    try { await stopGame(id, hostToken, hostPassword); reload(); } catch (e: any) { setErr(e.message); }
  }
  async function setTest(enabled: boolean) {
    if (!enabled && data) {
      const testCount = data.teams.filter(t => t.is_test).length;
      if (testCount > 0) {
        if (!confirm(
          `End test mode?\n\n${testCount} test team(s) and their progress/actions will be permanently deleted, so the real game starts from a clean roster.\n\nReal teams (joined before test mode was on) are kept.`
        )) return;
      }
    }
    try {
      const r = await toggleTestMode(id, hostToken, hostPassword, enabled);
      if (r.deleted_test_teams > 0) {
        alert(`Test mode ended. ${r.deleted_test_teams} test team(s) removed.`);
      }
      reload();
    }
    catch (e: any) { setErr(e.message); }
  }

  function openNewLoc() {
    setEditingId(null);
    const next = data!.game.locations.length;
    setDraft({ ...blankLoc, order_idx: next, name: `Location ${next + 1}` });
  }
  function openEdit(loc: LocationHost) {
    setEditingId(loc.id);
    const { id: _omit, ...rest } = loc;
    setDraft(rest);
  }

  async function saveLoc(payload: Omit<LocationHost, "id">) {
    try {
      if (editingId == null) {
        await addLocation(id, hostToken, hostPassword, payload);
      } else {
        await updateLocation(id, editingId, hostToken, hostPassword, payload);
      }
      setDraft(null);
      setEditingId(null);
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  async function removeLoc(locId: number) {
    if (!confirm("Delete this location?")) return;
    try { await deleteLocation(id, locId, hostToken, hostPassword); reload(); } catch (e: any) { setErr(e.message); }
  }

  const locMarkers: MapMarker[] = game.locations.map(l => ({
    id: l.id, lat: l.lat, lng: l.lng, label: l.name, radius_m: l.radius_m, showRadius: true,
  }));

  return (
    <div className="app">
      <div className="card">
        <div className="row row--wrap" style={{ gap: 12 }}>
          <h1 style={{ margin: 0 }}>{game.name}</h1>
          <div className="spacer" />
          <span className="muted">Join code:</span>
          <span className="code-pill">{game.join_code}</span>
          {game.started ? (
            <>
              <span className="banner banner--good" style={{ padding: "4px 10px" }}>Live</span>
              <button className="btn btn--ghost btn--small" onClick={startNow} title="Re-run for late joiners (existing teams keep their sequence)">Re-roll new teams</button>
              <button className="btn btn--ghost btn--small" onClick={stopNow}>Stop</button>
            </>
          ) : (
            <button className="btn btn--small" onClick={startNow}>Start (lock teams &amp; randomize)</button>
          )}
        </div>
        <div className="row" style={{ marginTop: 8, gap: 12 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Players join at <code>{location.origin}/play</code> with the code above.
          </div>
          <div className="spacer" />
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, margin: 0 }}>
            <input
              type="checkbox"
              checked={!!game.test_mode}
              onChange={e => setTest(e.target.checked)}
              style={{ width: "auto" }}
            />
            <span>Test mode <span className="muted">(skip geofence)</span></span>
          </label>
        </div>
        {game.test_mode && (() => {
          const testCount = data.teams.filter(t => t.is_test).length;
          return (
            <div className="banner banner--warn" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                ⚠ <strong>TEST MODE</strong> is on — teams can answer without being in range, and any team that joins right now is a <em>test team</em>.
                {testCount > 0 && <> Currently <strong>{testCount}</strong> test team(s).</>}
              </div>
              <button
                className="btn btn--small"
                onClick={() => setTest(false)}
                title="Turn off test mode and delete test teams"
              >
                End test {testCount > 0 ? `& delete ${testCount} team(s)` : ""}
              </button>
            </div>
          );
        })()}
      </div>

      <div className="card">
        <div className="tab-row">
          <button className={`tab ${tab === "setup" ? "active" : ""}`} onClick={() => setTab("setup")}>Setup</button>
          <button className={`tab ${tab === "live" ? "active" : ""}`} onClick={() => setTab("live")}>Live ({data.teams.length})</button>
        </div>

        {err && <div className="banner banner--bad" style={{ marginBottom: 12 }}>{err}</div>}

        {tab === "setup" ? (
          <SetupTab
            gameId={id}
            hostToken={hostToken}
            hostPassword={hostPassword}
            game={game}
            meta={meta}
            setMeta={setMeta}
            saveMeta={saveMeta}
            locMarkers={locMarkers}
            openNewLoc={openNewLoc}
            openEdit={openEdit}
            removeLoc={removeLoc}
            reload={reload}
            setErr={setErr}
            teamCount={data.teams.length}
            teamsWithActions={data.teams.filter(t => t.actions_total > 0).length}
            viewerUrlPath={data.viewer_url_path ?? ""}
          />
        ) : (
          <LiveTab
            data={data}
            gameId={id}
            hostToken={hostToken}
            hostPassword={hostPassword}
            reload={reload}
            setErr={setErr}
            onAddLocation={openNewLoc}
            goToSetup={() => setTab("setup")}
          />
        )}
      </div>

      {draft && (
        <LocationModal
          draft={draft}
          setDraft={setDraft}
          onClose={() => { setDraft(null); setEditingId(null); }}
          onSave={saveLoc}
          editing={editingId != null}
        />
      )}
    </div>
  );
}

function SetupTab(props: {
  gameId: number;
  hostToken: string;
  hostPassword: string;
  game: HostDashboard["game"];
  meta: { name: string; final_lat: string; final_lng: string; final_label: string };
  setMeta: (m: any) => void;
  saveMeta: () => void;
  locMarkers: MapMarker[];
  openNewLoc: () => void;
  openEdit: (l: LocationHost) => void;
  removeLoc: (id: number) => void;
  reload: () => void;
  setErr: (s: string) => void;
  teamCount: number;
  teamsWithActions: number;
  viewerUrlPath: string;
}) {
  const { gameId, hostToken, hostPassword, game, meta, setMeta, saveMeta, locMarkers, openNewLoc, openEdit, removeLoc, reload, setErr, teamCount, teamsWithActions, viewerUrlPath } = props;
  const finalLatNum = meta.final_lat ? Number(meta.final_lat) : NaN;
  const finalLngNum = meta.final_lng ? Number(meta.final_lng) : NaN;
  const finalSet = Number.isFinite(finalLatNum) && Number.isFinite(finalLngNum);
  const finalMarker: MapMarker[] = finalSet
    ? [{ id: "final", lat: finalLatNum, lng: finalLngNum, label: meta.final_label || "Final destination", color: "#f5a623" }]
    : [];

  return (
    <div className="stack">
      <div className="grid-2">
        <div>
          <label>Game name</label>
          <input value={meta.name} onChange={e => setMeta({ ...meta, name: e.target.value })} />
        </div>
        <div>
          <label>Final location label (optional)</label>
          <input value={meta.final_label} onChange={e => setMeta({ ...meta, final_label: e.target.value })} placeholder="e.g. Statue of …" />
        </div>
      </div>

      <div>
        <label>Final destination — click the map to drop the pin</label>
        <MapView markers={finalMarker} onMapClick={(lat, lng) => setMeta({ ...meta, final_lat: lat.toFixed(6), final_lng: lng.toFixed(6) })} />
        <div className="row" style={{ marginTop: 6, fontSize: 12, gap: 12 }}>
          <span className="muted">
            {finalSet
              ? `📍 ${finalLatNum.toFixed(5)}, ${finalLngNum.toFixed(5)}`
              : "No final destination set yet."}
          </span>
          <div className="spacer" />
          {finalSet && (
            <button
              className="btn btn--ghost btn--small"
              onClick={() => setMeta({ ...meta, final_lat: "", final_lng: "" })}
            >Clear pin</button>
          )}
        </div>
      </div>

      <div className="row">
        <div className="spacer" />
        <button className="btn btn--ghost" onClick={saveMeta}>Save game settings</button>
      </div>

      <h2 style={{ marginTop: 8 }}>Locations</h2>
      <MapView markers={locMarkers} />
      <div className="row">
        <div className="muted">{game.locations.length} location(s)</div>
        <div className="spacer" />
        <button className="btn" onClick={openNewLoc}>+ Add location</button>
      </div>
      <ul className="loc-list">
        {game.locations.map(l => (
          <li key={l.id} className="loc-row">
            <div>
              <div className="loc-row__title">
                <span style={{ marginRight: 8 }} title={l.kind === "action" ? "Action stop (host approves)" : "Question stop (auto-graded)"}>
                  {l.kind === "action" ? "🎯" : "❓"}
                </span>
                {l.name}
              </div>
              <div className="loc-row__meta">
                {l.lat.toFixed(5)}, {l.lng.toFixed(5)} · radius {l.radius_m}m · fragment <span className="fragment-pill">{l.fragment || "—"}</span>
              </div>
            </div>
            <div className="row">
              <button className="btn btn--ghost btn--small" onClick={() => openEdit(l)}>Edit</button>
              <button className="btn btn--danger btn--small" onClick={() => removeLoc(l.id)}>Del</button>
            </div>
          </li>
        ))}
        {game.locations.length === 0 && <div className="muted">No locations yet — add the first one to get started.</div>}
      </ul>

      <h2 style={{ marginTop: 16 }}>Share a view-only link</h2>
      <ViewerShare viewerUrlPath={viewerUrlPath} />

      <h2 style={{ marginTop: 16 }}>Host password</h2>
      <PasswordManager
        gameId={gameId}
        hostToken={hostToken}
        hostPassword={hostPassword}
        hasPassword={game.has_password}
        onChange={() => reload()}
        setErr={setErr}
      />

      {/* Bonus actions pool removed: each location now picks its own kind
          (question vs action). Use the "+ Add location" → 🎯 Action option
          to add an action-stop. */}
    </div>
  );
}


function LiveTab(props: {
  data: HostDashboard;
  gameId: number;
  hostToken: string;
  hostPassword: string;
  reload: () => void;
  setErr: (s: string) => void;
  onAddLocation: () => void;
  goToSetup: () => void;
}) {
  const { data, gameId, hostToken, hostPassword, reload, setErr, onAddLocation, goToSetup } = props;
  const { game, teams, progress_matrix } = data;
  const [openTeamId, setOpenTeamId] = useState<number | null>(null);
  const [showLocDetail, setShowLocDetail] = useState(false);

  async function approve(teamId: number, taId: number) {
    try {
      await hostToggleTeamAction(gameId, teamId, taId, hostToken, hostPassword);
      reload();
    } catch (e: any) { setErr(e.message); }
  }
  async function approveStopFn(teamId: number, locationId: number) {
    try {
      await approveStop(gameId, teamId, locationId, hostToken, hostPassword);
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  const teamMarkers: MapMarker[] = teams
    .filter(t => t.last_lat != null && t.last_lng != null)
    .map(t => ({ id: `t-${t.id}`, lat: t.last_lat!, lng: t.last_lng!, label: `${t.name} (${t.solved_count}/${t.total})`, color: t.color }));

  const locMarkers: MapMarker[] = game.locations.map(l => ({
    id: `l-${l.id}`, lat: l.lat, lng: l.lng, label: l.name, radius_m: l.radius_m, showRadius: true,
  }));

  const pendingStops = data.pending_stops || [];

  // Sort teams by rank (best first). Backend already computed rank/score.
  const ranked = [...teams].sort((a, b) => (a.rank || 999) - (b.rank || 999));

  return (
    <div className="stack">
      <MapView markers={[...locMarkers, ...teamMarkers]} big />

      {data.leaderboard.length > 0 && (
        <>
          <h2>Leaderboard</h2>
          <ol className="loc-list" style={{ listStyle: "none", paddingLeft: 0 }}>
            {data.leaderboard.slice(0, 5).map(e => (
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

      {pendingStops.length > 0 && (
        <>
          <h2>Pending approvals <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {pendingStops.length} waiting</span></h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Teams have submitted these action stops and are waiting for you. Click <em>Approve</em> once you've seen the proof.
          </div>
          <ul className="loc-list">
            {pendingStops.map(s => (
              <li key={`${s.team_id}-${s.location_id}`} className="loc-row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div className="loc-row__title">
                    <span className="dot" style={{ background: s.team_color, marginRight: 8 }} />
                    {s.team_name} <span className="muted" style={{ fontSize: 12 }}>@ {s.location_name}</span>
                  </div>
                  <div className="loc-row__meta">{s.instruction}</div>
                  <div className="loc-row__meta" style={{ fontSize: 11 }}>
                    submitted {new Date(s.submitted_at).toLocaleTimeString()}
                  </div>
                </div>
                <button className="btn btn--small" onClick={() => approveStopFn(s.team_id, s.location_id)}>Approve</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Progress</h2>
      {teams.length === 0 ? (
        <div className="muted">No teams have joined yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="matrix">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>#</th>
                <th style={{ textAlign: "left" }}>Team</th>
                {game.locations.map(l => <th key={l.id} title={l.name}>{shortLabel(l.name)}</th>)}
                <th>Solved</th>
                <th>Actions</th>
                <th>Score</th>
                <th>Last seen</th>
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
                        {t.rank === 1 ? "🥇" : t.rank === 2 ? "🥈" : t.rank === 3 ? "🥉" : `${t.rank}`}
                      </td>
                      <td className="team-cell">
                        <span className="dot" style={{ background: t.color, marginRight: 8 }} />
                        {t.name}
                        {t.is_test && (
                          <span className="code-pill" style={{ marginLeft: 6, background: "rgba(245,166,35,0.15)", color: "var(--warn)", fontSize: 10, padding: "2px 6px" }}>TEST</span>
                        )}
                        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{open ? "▾" : "▸"}</span>
                      </td>
                      {game.locations.map(l => (
                        <td key={l.id} className={row[String(l.id)] ? "solved" : ""}>{row[String(l.id)] ? "✓" : ""}</td>
                      ))}
                      <td>{t.solved_count}/{t.total}</td>
                      <td>{t.actions_done}/{t.actions_total}</td>
                      <td><strong>{t.score ?? 0}</strong></td>
                      <td>{t.last_seen ? new Date(t.last_seen).toLocaleTimeString() : "—"}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={game.locations.length + 6} style={{ textAlign: "left", background: "var(--bg2)" }}>
                          {t.actions.length === 0 ? (
                            <span className="muted">No actions assigned yet.</span>
                          ) : (
                            <ul className="loc-list" style={{ margin: 0 }}>
                              {t.actions.map(a => (
                                <li key={a.id} className="loc-row" onClick={e => e.stopPropagation()}>
                                  <span style={{ color: a.completed ? "var(--good)" : "var(--text)", textDecoration: a.completed ? "line-through" : "none" }}>
                                    {a.completed ? "✓ " : "○ "}{a.text}
                                    {a.completed && a.completed_at && (
                                      <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                                        {new Date(a.completed_at).toLocaleTimeString()}
                                      </span>
                                    )}
                                  </span>
                                  <button
                                    className={a.completed ? "btn btn--ghost btn--small" : "btn btn--small"}
                                    onClick={() => approve(t.id, a.id)}
                                  >
                                    {a.completed ? "Unapprove" : "Approve"}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
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

      <div className="row" style={{ marginTop: 8 }}>
        <h2 style={{ margin: 0 }}>All locations</h2>
        <div className="spacer" />
        <button className="btn btn--ghost btn--small" onClick={() => setShowLocDetail(s => !s)}>
          {showLocDetail ? "Hide answers" : "Show answers"}
        </button>
        <button className="btn btn--small" onClick={onAddLocation}>+ Add location</button>
        <button className="btn btn--ghost btn--small" onClick={goToSetup}>Edit in Setup</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: -4 }}>
        You can add or edit locations and actions any time, even while the game is live — teams will see updates on their next refresh.
      </div>
      <ul className="loc-list">
        {game.locations.map(l => (
          <li key={l.id} className="loc-row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div className="loc-row__title">{l.name}</div>
              <div className="loc-row__meta">
                {l.lat.toFixed(5)}, {l.lng.toFixed(5)} · radius {l.radius_m}m · fragment <span className="fragment-pill">{l.fragment || "—"}</span>
              </div>
              <div className="loc-row__meta" style={{ marginTop: 4, color: "var(--text)" }}>
                <strong>Q:</strong> {l.question}
              </div>
              {l.hint && (
                <div className="loc-row__meta" style={{ color: "var(--warn)" }}>
                  <strong>Hint:</strong> {l.hint}
                </div>
              )}
              {showLocDetail && (
                <div className="loc-row__meta" style={{ color: "var(--good)" }}>
                  <strong>A:</strong> {l.answer}
                </div>
              )}
            </div>
            <a
              className="btn btn--ghost btn--small"
              href={`https://maps.google.com/?q=${l.lat},${l.lng}`}
              target="_blank"
              rel="noreferrer"
            >Map</a>
          </li>
        ))}
        {game.locations.length === 0 && <div className="muted">No locations configured.</div>}
      </ul>

      {game.locations.some(l => l.hint) && (
        <>
          <h2 style={{ marginTop: 8 }}>Hints cheat-sheet</h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Quick reference for what to share if a team is stuck. Only locations with a hint are shown.
          </div>
          <ul className="loc-list">
            {game.locations.filter(l => l.hint).map(l => (
              <li key={l.id} className="loc-row" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div className="loc-row__title">{l.name}</div>
                  <div className="loc-row__meta" style={{ color: "var(--warn)", marginTop: 2 }}>{l.hint}</div>
                </div>
                <button
                  className="btn btn--ghost btn--small"
                  onClick={() => { navigator.clipboard?.writeText(l.hint || ""); }}
                  title="Copy hint to clipboard"
                >Copy</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function shortLabel(s: string) {
  if (s.length <= 4) return s;
  const parts = s.split(/\s+/);
  if (parts.length > 1) return parts.map(p => p[0]).join("").slice(0, 4).toUpperCase();
  return s.slice(0, 4);
}

function LocationModal(props: {
  draft: Omit<LocationHost, "id">;
  setDraft: (d: Omit<LocationHost, "id">) => void;
  onClose: () => void;
  onSave: (payload: Omit<LocationHost, "id">) => void;
  editing: boolean;
}) {
  const { draft, setDraft, onClose, onSave, editing } = props;
  const set = (k: keyof Omit<LocationHost, "id">, v: any) => setDraft({ ...draft, [k]: v });
  // For numeric inputs we keep a parallel string buffer so the user can clear
  // and retype without us writing 0/NaN into the draft mid-edit.
  const [latStr, setLatStr] = useState(String(draft.lat));
  const [lngStr, setLngStr] = useState(String(draft.lng));
  const [radiusStr, setRadiusStr] = useState(String(draft.radius_m));
  const [orderStr, setOrderStr] = useState(String(draft.order_idx));
  const [validationErr, setValidationErr] = useState("");

  // When the map is clicked, push fresh coords into both draft and the buffers.
  function onMapClick(lat: number, lng: number) {
    setDraft({ ...draft, lat, lng });
    setLatStr(String(lat));
    setLngStr(String(lng));
  }

  function trySave() {
    const lat = Number(latStr), lng = Number(lngStr);
    const radius = Number(radiusStr), order = Number(orderStr);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90)
      return setValidationErr("Latitude must be a number between -90 and 90.");
    if (!Number.isFinite(lng) || lng < -180 || lng > 180)
      return setValidationErr("Longitude must be a number between -180 and 180.");
    if (!Number.isFinite(radius) || radius < 5 || radius > 2000)
      return setValidationErr("Radius must be between 5 and 2000 metres.");
    if (!Number.isFinite(order) || order < 0)
      return setValidationErr("Order must be 0 or a positive integer.");
    setValidationErr("");
    onSave({ ...draft, lat, lng, radius_m: Math.round(radius), order_idx: Math.round(order) });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{editing ? "Edit location" : "Add location"}</h2>
        <div className="stack">
          <div>
            <label>Stop type</label>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className={`tab ${draft.kind === "question" ? "active" : ""}`}
                onClick={() => set("kind", "question")}
              >❓ Question</button>
              <button
                type="button"
                className={`tab ${draft.kind === "action" ? "active" : ""}`}
                onClick={() => set("kind", "action")}
              >🎯 Action</button>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {draft.kind === "action"
                ? "Players submit when they're at the spot; you approve manually after seeing their proof."
                : "Auto-graded: players answer to advance."}
            </div>
          </div>
          <div>
            <label>Name</label>
            <input value={draft.name} onChange={e => set("name", e.target.value)} />
          </div>
          <div className="grid-2">
            <div>
              <label>Latitude</label>
              <input type="number" step="any" value={latStr} onChange={e => setLatStr(e.target.value)} />
            </div>
            <div>
              <label>Longitude</label>
              <input type="number" step="any" value={lngStr} onChange={e => setLngStr(e.target.value)} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Tip: click on the map below to set coordinates.
          </div>
          <MapView
            markers={[{ id: "draft", lat: draft.lat, lng: draft.lng, radius_m: draft.radius_m, showRadius: true }]}
            onMapClick={onMapClick}
          />
          <div className="grid-2">
            <div>
              <label>Trigger radius (meters)</label>
              <input type="number" min={5} max={2000} value={radiusStr} onChange={e => setRadiusStr(e.target.value)} />
            </div>
            <div>
              <label>Order</label>
              <input type="number" min={0} value={orderStr} onChange={e => setOrderStr(e.target.value)} />
            </div>
          </div>
          <div>
            <label>{draft.kind === "action" ? "Action instruction (what should the team do?)" : "Question"}</label>
            <textarea rows={3} value={draft.question} onChange={e => set("question", e.target.value)} />
          </div>
          {draft.kind === "question" && (
            <div>
              <label>Answer (case- and punctuation-insensitive)</label>
              <input value={draft.answer} onChange={e => set("answer", e.target.value)} />
            </div>
          )}
          <div>
            <label>Hint (optional) — unlocks for teams as they get actions approved</label>
            <input value={draft.hint ?? ""} onChange={e => set("hint", e.target.value)} />
          </div>
          <div>
            <label>Coordinate fragment unlocked on solve</label>
            <input value={draft.fragment} onChange={e => set("fragment", e.target.value)} placeholder="e.g. lat=52.09 or '4th digit: 7'" />
          </div>
          {validationErr && <div className="banner banner--bad">{validationErr}</div>}
          <div className="row">
            <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <div className="spacer" />
            <button
              className="btn"
              onClick={trySave}
              disabled={!draft.name || !draft.question || (draft.kind === "question" && !draft.answer)}
            >
              {editing ? "Save changes" : "Add location"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


function PasswordPrompt({ onSubmit, onCancel }: { onSubmit: (pw: string) => void; onCancel: () => void }) {
  const [pw, setPw] = useState("");
  return (
    <div className="app">
      <div className="card">
        <h1>Password required</h1>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          This game is password-protected. Enter the host password to continue.
        </div>
        <form className="stack" onSubmit={e => { e.preventDefault(); if (pw) onSubmit(pw); }}>
          <div>
            <label>Host password</label>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus />
          </div>
          <div className="row">
            <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
            <div className="spacer" />
            <button className="btn" disabled={!pw}>Unlock</button>
          </div>
        </form>
      </div>
    </div>
  );
}


function PasswordManager(props: {
  gameId: number;
  hostToken: string;
  hostPassword: string;
  hasPassword: boolean;
  onChange: () => void;
  setErr: (s: string) => void;
}) {
  const { gameId, hostToken, hostPassword, hasPassword, onChange, setErr } = props;
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState("");

  async function save() {
    try {
      await setHostPassword(gameId, hostToken, hostPassword, pw || null);
      // Save the new password locally so subsequent calls work without a prompt.
      if (pw) localStorage.setItem(`host_pw:${gameId}`, pw);
      else localStorage.removeItem(`host_pw:${gameId}`);
      setPw("");
      setEditing(false);
      onChange();
    } catch (e: any) { setErr(e.message); }
  }
  async function clearPw() {
    if (!confirm("Remove the host password? Anyone with the recovery link will be able to host.")) return;
    try {
      await setHostPassword(gameId, hostToken, hostPassword, null);
      localStorage.removeItem(`host_pw:${gameId}`);
      onChange();
    } catch (e: any) { setErr(e.message); }
  }

  if (!editing) {
    return (
      <div className="row">
        <div className="muted" style={{ fontSize: 12 }}>
          {hasPassword
            ? "🔒 Password protected. Anyone with the recovery link still needs the password."
            : "No password set. Anyone with the recovery link can host."}
        </div>
        <div className="spacer" />
        <button className="btn btn--ghost btn--small" onClick={() => setEditing(true)}>
          {hasPassword ? "Change password" : "Set password"}
        </button>
        {hasPassword && (
          <button className="btn btn--ghost btn--small" onClick={clearPw}>Remove</button>
        )}
      </div>
    );
  }

  return (
    <div className="stack stack--tight">
      <input
        type="password"
        value={pw}
        onChange={e => setPw(e.target.value)}
        placeholder={hasPassword ? "New password" : "Pick a password"}
        autoFocus
      />
      <div className="row">
        <button className="btn btn--ghost btn--small" onClick={() => { setEditing(false); setPw(""); }}>Cancel</button>
        <div className="spacer" />
        <button className="btn btn--small" onClick={save} disabled={!pw}>Save</button>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        Tip: pick something easy to remember but not guessable. Anyone with the recovery link AND this password can host.
      </div>
    </div>
  );
}


function ViewerShare({ viewerUrlPath }: { viewerUrlPath: string }) {
  const [copied, setCopied] = useState(false);
  const fullUrl = viewerUrlPath ? `${window.location.origin}${viewerUrlPath}` : "";
  async function copy() {
    if (!fullUrl) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }
  return (
    <div className="stack stack--tight">
      <div className="muted" style={{ fontSize: 12 }}>
        Send this link to anyone who should watch the live screen with you.
        They'll see the map, leaderboard, and approvals — but cannot change anything.
      </div>
      <div className="row">
        <input readOnly value={fullUrl} onFocus={e => e.currentTarget.select()}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }} />
        <button className="btn btn--ghost btn--small" onClick={copy} disabled={!fullUrl}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
