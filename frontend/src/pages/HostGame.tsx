import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Action, HostDashboard, LocationHost, addAction, addLocation, deleteAction,
  deleteLocation, getHostDashboard, hostToggleTeamAction, reassignActions,
  startGame, stopGame, updateAction, updateGame, updateLocation,
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
  const hostToken = useMemo(() => localStorage.getItem(`host:${id}`) || "", [id]);

  const [tab, setTab] = useState<Tab>("setup");
  const [data, setData] = useState<HostDashboard | null>(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<Omit<LocationHost, "id"> | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [meta, setMeta] = useState<{ name: string; final_lat: string; final_lng: string; final_label: string }>({
    name: "", final_lat: "", final_lng: "", final_label: "",
  });

  async function reload() {
    if (!hostToken) { nav("/"); return; }
    try {
      const d = await getHostDashboard(id, hostToken);
      setData(d);
      setMeta({
        name: d.game.name,
        final_lat: d.game.final_lat?.toString() ?? "",
        final_lng: d.game.final_lng?.toString() ?? "",
        final_label: d.game.final_label ?? "",
      });
    } catch (e: any) {
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
  if (!data) return <div className="app"><div className="card">{err || "Loading…"}</div></div>;

  const game = data.game;

  async function saveMeta() {
    try {
      await updateGame(id, hostToken, {
        name: meta.name.trim() || game.name,
        final_lat: meta.final_lat ? Number(meta.final_lat) : null,
        final_lng: meta.final_lng ? Number(meta.final_lng) : null,
        final_label: meta.final_label || null,
      });
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  async function startNow() {
    try { await startGame(id, hostToken); reload(); } catch (e: any) { setErr(e.message); }
  }
  async function stopNow() {
    if (!confirm("Stop the game? Teams will see it as no longer live; you can resume any time.")) return;
    try { await stopGame(id, hostToken); reload(); } catch (e: any) { setErr(e.message); }
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
        await addLocation(id, hostToken, payload);
      } else {
        await updateLocation(id, editingId, hostToken, payload);
      }
      setDraft(null);
      setEditingId(null);
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  async function removeLoc(locId: number) {
    if (!confirm("Delete this location?")) return;
    try { await deleteLocation(id, locId, hostToken); reload(); } catch (e: any) { setErr(e.message); }
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
              <button className="btn btn--ghost btn--small" onClick={stopNow}>Stop</button>
            </>
          ) : (
            <button className="btn btn--small" onClick={startNow}>Start game</button>
          )}
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          Players join at <code>{location.origin}/play</code> with the code above.
        </div>
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
          />
        ) : (
          <LiveTab
            data={data}
            gameId={id}
            hostToken={hostToken}
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
}) {
  const { gameId, hostToken, game, meta, setMeta, saveMeta, locMarkers, openNewLoc, openEdit, removeLoc, reload, setErr, teamCount, teamsWithActions } = props;
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
              <div className="loc-row__title">{l.name}</div>
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

      <h2 style={{ marginTop: 16 }}>Actions pool</h2>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Build the pool first, then click <em>Reveal actions</em> when you're ready. Each team gets 3 random actions from the pool. Players don't see anything until you reveal — and each approved action unlocks one location's hint, in order.
      </div>
      <ActionsEditor
        gameId={gameId}
        hostToken={hostToken}
        actions={game.actions}
        teamCount={teamCount}
        teamsWithActions={teamsWithActions}
        reload={reload}
        setErr={setErr}
      />
    </div>
  );
}

function ActionsEditor(props: {
  gameId: number;
  hostToken: string;
  actions: Action[];
  teamCount: number;
  teamsWithActions: number;
  reload: () => void;
  setErr: (s: string) => void;
}) {
  const { gameId, hostToken, actions, teamCount, teamsWithActions, reload, setErr } = props;
  const [draftText, setDraftText] = useState("");
  const [draftHint, setDraftHint] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [editingHint, setEditingHint] = useState("");

  const initialReveal = teamsWithActions === 0;
  const revealLabel = initialReveal
    ? `Reveal actions to teams (${teamCount})`
    : "Top up team actions";

  async function add() {
    const t = draftText.trim();
    if (!t) return;
    try {
      await addAction(gameId, hostToken, t, draftHint.trim() || null);
      setDraftText(""); setDraftHint("");
      reload();
    } catch (e: any) { setErr(e.message); }
  }
  async function save(id: number) {
    const t = editingText.trim();
    if (!t) return;
    try {
      await updateAction(gameId, id, hostToken, t, editingHint.trim() || null);
      setEditingId(null);
      reload();
    } catch (e: any) { setErr(e.message); }
  }
  async function remove(id: number) {
    if (!confirm("Delete this action?")) return;
    try { await deleteAction(gameId, id, hostToken); reload(); }
    catch (e: any) { setErr(e.message); }
  }
  async function reveal() {
    if (initialReveal && actions.length < 3) {
      if (!confirm(`Only ${actions.length} action(s) in the pool — teams will get fewer than 3. Continue?`)) return;
    }
    try { const r = await reassignActions(gameId, hostToken); alert(`Assigned to ${r.teams} team(s).`); reload(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="stack">
      <div className="stack stack--tight">
        <input
          value={draftText}
          onChange={e => setDraftText(e.target.value)}
          placeholder="Action — e.g. Take a selfie with a stranger"
          onKeyDown={e => { if (e.key === "Enter") add(); }}
        />
        <div className="row">
          <input
            value={draftHint}
            onChange={e => setDraftHint(e.target.value)}
            placeholder="Hint shown to the team (optional)"
            onKeyDown={e => { if (e.key === "Enter") add(); }}
          />
          <button className="btn" onClick={add} disabled={!draftText.trim()}>Add</button>
        </div>
      </div>
      <ul className="loc-list">
        {actions.map(a => (
          <li key={a.id} className="loc-row" style={{ alignItems: "flex-start" }}>
            {editingId === a.id ? (
              <div className="stack stack--tight" style={{ flex: 1 }}>
                <input value={editingText} onChange={e => setEditingText(e.target.value)} autoFocus placeholder="Action" />
                <input value={editingHint} onChange={e => setEditingHint(e.target.value)} placeholder="Hint (optional)" />
              </div>
            ) : (
              <div style={{ flex: 1 }}>
                <div className="loc-row__title" style={{ fontWeight: 500 }}>{a.text}</div>
                {a.hint && (
                  <div className="loc-row__meta" style={{ color: "var(--warn)", marginTop: 2 }}>
                    Hint: {a.hint}
                  </div>
                )}
              </div>
            )}
            <div className="row">
              {editingId === a.id ? (
                <>
                  <button className="btn btn--small" onClick={() => save(a.id)}>Save</button>
                  <button className="btn btn--ghost btn--small" onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button className="btn btn--ghost btn--small" onClick={() => {
                    setEditingId(a.id);
                    setEditingText(a.text);
                    setEditingHint(a.hint ?? "");
                  }}>Edit</button>
                  <button className="btn btn--danger btn--small" onClick={() => remove(a.id)}>Del</button>
                </>
              )}
            </div>
          </li>
        ))}
        {actions.length === 0 && <div className="muted">No actions yet.</div>}
      </ul>
      {actions.length > 0 && teamCount > 0 && (
        <div className="row">
          <div className="muted" style={{ fontSize: 12 }}>
            {initialReveal
              ? `${teamCount} team(s) joined and waiting. Reveal when ready.`
              : "Click again only if you added more actions to the pool — fills missing slots, never reshuffles."}
          </div>
          <div className="spacer" />
          <button
            className={initialReveal ? "btn" : "btn btn--ghost btn--small"}
            onClick={reveal}
          >{revealLabel}</button>
        </div>
      )}
      {actions.length > 0 && teamCount === 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          No teams have joined yet — share the join code with your players.
        </div>
      )}
    </div>
  );
}

function LiveTab(props: {
  data: HostDashboard;
  gameId: number;
  hostToken: string;
  reload: () => void;
  setErr: (s: string) => void;
  onAddLocation: () => void;
  goToSetup: () => void;
}) {
  const { data, gameId, hostToken, reload, setErr, onAddLocation, goToSetup } = props;
  const { game, teams, progress_matrix } = data;
  const [openTeamId, setOpenTeamId] = useState<number | null>(null);
  const [showLocDetail, setShowLocDetail] = useState(false);

  async function approve(teamId: number, taId: number) {
    try {
      await hostToggleTeamAction(gameId, teamId, taId, hostToken);
      reload();
    } catch (e: any) { setErr(e.message); }
  }

  const teamsWithActions = data.teams.filter(t => t.actions_total > 0).length;
  const teamsMissingActions = data.teams.length - teamsWithActions;
  async function reveal() {
    if (teamsWithActions === 0 && data.game.actions.length < 3) {
      if (!confirm(`Only ${data.game.actions.length} action(s) in the pool — teams will get fewer than 3. Continue?`)) return;
    }
    try { const r = await reassignActions(gameId, hostToken); alert(`Assigned to ${r.teams} team(s).`); reload(); }
    catch (e: any) { setErr(e.message); }
  }
  const teamMarkers: MapMarker[] = teams
    .filter(t => t.last_lat != null && t.last_lng != null)
    .map(t => ({ id: `t-${t.id}`, lat: t.last_lat!, lng: t.last_lng!, label: `${t.name} (${t.solved_count}/${t.total})`, color: t.color }));

  const locMarkers: MapMarker[] = game.locations.map(l => ({
    id: `l-${l.id}`, lat: l.lat, lng: l.lng, label: l.name, radius_m: l.radius_m, showRadius: true,
  }));

  const totalActionsAssigned = teams.reduce((acc, t) => acc + t.actions_total, 0);
  const totalActionsApproved = teams.reduce((acc, t) => acc + t.actions_done, 0);
  const pendingByTeam = teams
    .map(t => ({ team: t, pending: t.actions.filter(a => !a.completed) }))
    .filter(x => x.pending.length > 0);

  return (
    <div className="stack">
      <MapView markers={[...locMarkers, ...teamMarkers]} big />

      {data.game.actions.length > 0 && data.teams.length > 0 && teamsMissingActions > 0 && (
        <div className="banner banner--warn" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            {teamsWithActions === 0
              ? `Actions are not yet revealed. ${data.teams.length} team(s) waiting — they don't see actions until you click reveal.`
              : `${teamsMissingActions} team(s) joined after the reveal — top up to give them their 3 actions.`}
          </div>
          <button className="btn btn--small" onClick={reveal}>
            {teamsWithActions === 0 ? `Reveal actions (${data.teams.length})` : "Top up"}
          </button>
        </div>
      )}

      {pendingByTeam.length > 0 && (
        <>
          <h2>Pending approvals <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {totalActionsApproved}/{totalActionsAssigned} approved overall</span></h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Teams send proof via WhatsApp. Click <em>Approve</em> once you've seen it.
          </div>
          <ul className="loc-list">
            {pendingByTeam.flatMap(({ team, pending }) =>
              pending.map(a => (
                <li key={`${team.id}-${a.id}`} className="loc-row" style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div className="loc-row__title">
                      <span className="dot" style={{ background: team.color, marginRight: 8 }} />
                      {team.name}
                    </div>
                    <div className="loc-row__meta">{a.text}</div>
                    {a.hint && (
                      <div className="loc-row__meta" style={{ color: "var(--warn)", marginTop: 2 }}>
                        Hint: {a.hint}
                      </div>
                    )}
                  </div>
                  <button className="btn btn--small" onClick={() => approve(team.id, a.id)}>Approve</button>
                </li>
              ))
            )}
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
                <th style={{ textAlign: "left" }}>Team</th>
                {game.locations.map(l => <th key={l.id} title={l.name}>{shortLabel(l.name)}</th>)}
                <th>Score</th>
                <th>Actions</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {teams.map(t => {
                const row = progress_matrix[String(t.id)] || {};
                const open = openTeamId === t.id;
                return (
                  <Fragment key={t.id}>
                    <tr style={{ cursor: "pointer" }} onClick={() => setOpenTeamId(open ? null : t.id)}>
                      <td className="team-cell">
                        <span className="dot" style={{ background: t.color, marginRight: 8 }} />
                        {t.name} <span className="muted" style={{ fontSize: 11 }}>{open ? "▾" : "▸"}</span>
                      </td>
                      {game.locations.map(l => (
                        <td key={l.id} className={row[String(l.id)] ? "solved" : ""}>{row[String(l.id)] ? "✓" : ""}</td>
                      ))}
                      <td>{t.solved_count}/{t.total}</td>
                      <td>{t.actions_done}/{t.actions_total}</td>
                      <td>{t.last_seen ? new Date(t.last_seen).toLocaleTimeString() : "—"}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={game.locations.length + 4} style={{ textAlign: "left", background: "var(--bg2)" }}>
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
            <label>Question</label>
            <textarea rows={3} value={draft.question} onChange={e => set("question", e.target.value)} />
          </div>
          <div>
            <label>Answer (case- and punctuation-insensitive)</label>
            <input value={draft.answer} onChange={e => set("answer", e.target.value)} />
          </div>
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
            <button className="btn" onClick={trySave} disabled={!draft.name || !draft.question || !draft.answer}>
              {editing ? "Save changes" : "Add location"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
