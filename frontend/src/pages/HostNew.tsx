import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createGame } from "../api";

export default function HostNew() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setErr("");
    try {
      const g = await createGame(name.trim());
      // Persist host token so the host page can re-authenticate.
      localStorage.setItem(`host:${g.id}`, g.host_token);
      nav(`/host/${g.id}`);
    } catch (e: any) {
      setErr(e.message || "Failed to create game");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="card">
        <h1>New game</h1>
        <form className="stack" onSubmit={submit}>
          <div>
            <label>Game name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Stadsspel Utrecht 2026" autoFocus />
          </div>
          {err && <div className="banner banner--bad">{err}</div>}
          <div className="row">
            <Link to="/" className="btn btn--ghost" style={{ textDecoration: "none" }}>Cancel</Link>
            <div className="spacer" />
            <button className="btn" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
