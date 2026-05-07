import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { GameHost, createGame } from "../api";

export default function HostNew() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<GameHost | null>(null);
  const [copied, setCopied] = useState<"link" | "token" | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setErr("");
    try {
      const g = await createGame(name.trim());
      // Persist host token for this browser.
      localStorage.setItem(`host:${g.id}`, g.host_token);
      setCreated(g);
    } catch (e: any) {
      setErr(e.message || "Failed to create game");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const recoveryUrl = `${window.location.origin}/host/${created.id}#t=${created.host_token}`;
    async function copy(value: string, kind: "link" | "token") {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(kind);
        setTimeout(() => setCopied(null), 2000);
      } catch {}
    }
    return (
      <div className="app">
        <div className="card">
          <h1>Game created</h1>
          <div className="banner banner--good" style={{ marginBottom: 16 }}>
            ✓ <strong>{created.name}</strong> is saved. You can come back and edit it any time.
          </div>

          <h2 style={{ marginTop: 8 }}>Save this recovery link</h2>
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Bookmark this link or paste it into your notes. It's the only way back into this game from another device, and anyone with it has full host control.
          </div>
          <div className="stack stack--tight" style={{ marginBottom: 12 }}>
            <input
              readOnly
              value={recoveryUrl}
              onFocus={e => e.currentTarget.select()}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
            <div className="row">
              <button type="button" className="btn btn--ghost btn--small" onClick={() => copy(recoveryUrl, "link")}>
                {copied === "link" ? "✓ Copied" : "Copy link"}
              </button>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => copy(created.host_token, "token")}>
                {copied === "token" ? "✓ Copied" : "Copy token only"}
              </button>
              <a className="btn btn--ghost btn--small" target="_blank" rel="noreferrer"
                 href={`mailto:?subject=${encodeURIComponent("Stadsspel host link — " + created.name)}&body=${encodeURIComponent("Save this — it's the only way back into your game:\n\n" + recoveryUrl)}`}>
                Email to myself
              </a>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            Game id: <span className="code-pill">{created.id}</span>
            &nbsp;·&nbsp; Host token: <span className="code-pill">{created.host_token.slice(0, 8)}…</span>
          </div>

          <hr style={{ borderColor: "var(--border)", margin: "20px 0" }} />
          <div className="row">
            <Link to="/" className="btn btn--ghost" style={{ textDecoration: "none" }}>Home</Link>
            <div className="spacer" />
            <button className="btn" onClick={() => nav(`/host/${created.id}`)}>
              Continue → setup
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="card">
        <h1>New game</h1>
        <form className="stack" onSubmit={submit}>
          <div>
            <label>Game name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Stadsspel Bruges 2026" autoFocus />
          </div>
          {err && <div className="banner banner--bad">{err}</div>}
          <div className="row">
            <Link to="/" className="btn btn--ghost" style={{ textDecoration: "none" }}>Cancel</Link>
            <div className="spacer" />
            <button className="btn" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</button>
          </div>
        </form>
        <hr style={{ borderColor: "var(--border)", margin: "20px 0" }} />
        <div className="muted" style={{ fontSize: 13 }}>
          Already have a game? <Link to="/host" style={{ color: "var(--primary-2)" }}>Resume hosting</Link>.
        </div>
      </div>
    </div>
  );
}
