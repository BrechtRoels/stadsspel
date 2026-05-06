import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Action, HostDashboard, LocationHost, addAction, addLocation, deleteAction,
  deleteLocation, getHostDashboard, hostToggleTeamAction, reassignActions,
  startGame, updateAction, updateGame, updateLocation,
} from "../api";
import MapView, { MapMarker } from "../components/MapView";

type Tab = "setup" | "live";

const blankLoc: Omit<LocationHost, "id"> = {
  name: "",
  lat: 52.0907,
  lng: 5.1214,
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

  async function saveLoc() {
    if (!draft) return;
    try {
      if (editingId == null) {
        await addLocation(id, hostToken, draft);
      } else {
        await updateLocation(id, editingId, hostToken, draft);
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
            <span className="banner banner--good" style={{ padding: "4px 10px" }}>Live</span>
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
          />
        ) : (
          <LiveTab data={data} gameId={id} hostToken={hostToken} reload={reload} setErr={setErr} />
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
}) {
  const { gameId, hostToken, game, meta, setMeta, saveMeta, locMarkers, openNewLoc, openEdit, removeLoc, reload, setErr } = props;
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
        <div>
          <label>Final latitude</label>
          <input value={meta.final_lat} onChange={e => setMeta({ ...meta, final_lat: e.target.value })} placeholder="52.0907" />
        </div>
        <div>
          <label>Final longitude</label>
          <input value={meta.final_lng} onChange={e => setMeta({ ...meta, final_lng: e.target.value })} placeholder="5.1214" />
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
        Each team gets 3 random actions from this pool when they join. Add at least 3 (more = more variety).
      </div>
      <ActionsEditor
        gameId={gameId}
        hostToken={hostToken}
        actions={game.actions}
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
  reload: () => void;
  setErr: (s: string) => void;
}) {
  const { gameId, hostToken, actions, reload, setErr } = props;
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");

  async function add() {
    const t = draft.trim();
    if (!t) return;
    try { await addAction(gameId, hostToken, t); setDraft(""); reload(); }
    catch (e: any) { setErr(e.message); }
  }
  async function save(id: number) {
    const t = editingText.trim();
    if (!t) return;
    try { await updateAction(gameId, id, hostToken, t); setEditingId(null); reload(); }
    catch (e: any) { setErr(e.message); }
  }
  async function remove(id: number) {
    if (!confirm("Delete this action?")) return;
    try { await deleteAction(gameId, id, hostToken); reload(); }
    catch (e: any) { setErr(e.message); }
  }
  async function topUp() {
    try { const r = await reassignActions(gameId, hostToken); alert(`Topped up ${r.teams} team(s).`); reload(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="stack">
      <div className="row">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="e.g. Take a selfie with a stranger"
          onKeyDown={e => { if (e.key === "Enter") add(); }}
        />
        <button className="btn" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
      <ul className="loc-list">
        {actions.map(a => (
          <li key={a.id} className="loc-row">
            {editingId === a.id ? (
              <input value={editingText} onChange={e => setEditingText(e.target.value)} autoFocus />
            ) : (
              <div className="loc-row__title" style={{ fontWeight: 500 }}>{a.text}</div>
            )}
            <div className="row">
              {editingId === a.id ? (
                <>
                  <button className="btn btn--small" onClick={() => save(a.id)}>Save</button>
                  <button className="btn btn--ghost btn--small" onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button className="btn btn--ghost btn--small" onClick={() => { setEditingId(a.id); setEditingText(a.text); }}>Edit</button>
                  <button className="btn btn--danger btn--small" onClick={() => remove(a.id)}>Del</button>
                </>
              )}
            </div>
          </li>
        ))}
        {actions.length === 0 && <div className="muted">No actions yet.</div>}
      </ul>
      {actions.length > 0 && (
        <div className="row">
          <div className="muted" style={{ fontSize: 12 }}>
            Tip: if you added actions after teams joined, click here to fill in their slots.
          </div>
          <div className="spacer" />
          <button className="btn btn--ghost btn--small" onClick={topUp}>Top up team actions</button>
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
}) {
  const { data, gameId, hostToken, reload, setErr } = props;
  const { game, teams, progress_matrix } = data;
  const [openTeamId, setOpenTeamId] = useState<number | null>(null);
  const [showLocDetail, setShowLocDetail] = useState(false);

  async function approve(teamId: number, taId: number) {
    try {
      await hostToggleTeamAction(gameId, teamId, taId, hostToken);
      reload();
    } catch (e: any) { setErr(e.message); }
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

      {pendingByTeam.length > 0 && (
        <>
          <h2>Pending approvals <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {totalActionsApproved}/{totalActionsAssigned} approved overall</span></h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Teams send proof via WhatsApp. Click <em>Approve</em> once you've seen it.
          </div>
          <ul className="loc-list">
            {pendingByTeam.flatMap(({ team, pending }) =>
              pending.map(a => (
                <li key={`${team.id}-${a.id}`} className="loc-row">
                  <div>
                    <div className="loc-row__title">
                      <span className="dot" style={{ background: team.color, marginRight: 8 }} />
                      {team.name}
                    </div>
                    <div className="loc-row__meta">{a.text}</div>
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
              {showLocDetail && (
                <>
                  <div className="loc-row__meta" style={{ color: "var(--good)" }}>
                    <strong>A:</strong> {l.answer}
                  </div>
                  {l.hint && (
                    <div className="loc-row__meta" style={{ color: "var(--warn)" }}>
                      <strong>Hint:</strong> {l.hint}
                    </div>
                  )}
                </>
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
  onSave: () => void;
  editing: boolean;
}) {
  const { draft, setDraft, onClose, onSave, editing } = props;
  const set = (k: keyof Omit<LocationHost, "id">, v: any) => setDraft({ ...draft, [k]: v });

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
              <input type="number" step="any" value={draft.lat} onChange={e => set("lat", Number(e.target.value))} />
            </div>
            <div>
              <label>Longitude</label>
              <input type="number" step="any" value={draft.lng} onChange={e => set("lng", Number(e.target.value))} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Tip: click on the map below to set coordinates.
          </div>
          <MapView
            markers={[{ id: "draft", lat: draft.lat, lng: draft.lng, radius_m: draft.radius_m, showRadius: true }]}
            onMapClick={(lat, lng) => setDraft({ ...draft, lat, lng })}
          />
          <div className="grid-2">
            <div>
              <label>Trigger radius (meters)</label>
              <input type="number" value={draft.radius_m} onChange={e => set("radius_m", Number(e.target.value))} />
            </div>
            <div>
              <label>Order</label>
              <input type="number" value={draft.order_idx} onChange={e => set("order_idx", Number(e.target.value))} />
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
            <label>Hint (optional)</label>
            <input value={draft.hint ?? ""} onChange={e => set("hint", e.target.value)} />
          </div>
          <div>
            <label>Coordinate fragment unlocked on solve</label>
            <input value={draft.fragment} onChange={e => set("fragment", e.target.value)} placeholder="e.g. lat=52.09 or '4th digit: 7'" />
          </div>
          <div className="row">
            <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <div className="spacer" />
            <button className="btn" onClick={onSave} disabled={!draft.name || !draft.question || !draft.answer}>
              {editing ? "Save changes" : "Add location"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
