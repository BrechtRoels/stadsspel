import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { hostRecover } from "../api";

/**
 * Recovery flow for hosts who lost their localStorage or are on a new device.
 *
 * Accepts either:
 *   - the bare host token, or
 *   - a full recovery URL like https://…/host/12#t=<token>
 * The latter is what /host/new asks them to save when they create a game.
 */
export default function HostSignIn() {
  const nav = useNavigate();
  const [input, setInput] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function extractToken(raw: string): string {
    const v = raw.trim();
    // If it looks like a URL, pull the token out of the fragment.
    if (v.startsWith("http") || v.startsWith("/host")) {
      const hash = v.split("#")[1] || "";
      const params = new URLSearchParams(hash);
      return params.get("t") || "";
    }
    return v;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const token = extractToken(input);
      if (!token) throw new Error("Paste your host token or recovery URL.");
      const r = await hostRecover(token);
      localStorage.setItem(`host:${r.game_id}`, token);
      // Stash the password too if the user supplied one. The dashboard will
      // re-prompt if it's wrong; we don't validate here to keep this endpoint
      // public-friendly (no online password-guessing oracle).
      if (password) localStorage.setItem(`host_pw:${r.game_id}`, password);
      else localStorage.removeItem(`host_pw:${r.game_id}`);
      nav(`/host/${r.game_id}`);
    } catch (e: any) {
      setErr(e.message || "Couldn't recover that game.");
    } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <div className="card">
        <h1>Resume hosting</h1>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Paste your host token or the recovery link you saved when you created the game.
          Anyone with this token controls the game.
        </div>
        <form className="stack" onSubmit={submit}>
          <div>
            <label>Host token or recovery URL</label>
            <textarea
              rows={3}
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="https://…/host/12#t=… &nbsp;or just the token"
              autoFocus
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 12 }}
            />
          </div>
          <div>
            <label>Password (only if you set one when creating the game)</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          {err && <div className="banner banner--bad">{err}</div>}
          <div className="row">
            <Link to="/" className="btn btn--ghost" style={{ textDecoration: "none" }}>Cancel</Link>
            <div className="spacer" />
            <button className="btn" disabled={busy || !input.trim()}>{busy ? "Checking…" : "Continue"}</button>
          </div>
        </form>
        <hr style={{ borderColor: "var(--border)", margin: "20px 0" }} />
        <div className="muted" style={{ fontSize: 12 }}>
          New here? <Link to="/host/new" style={{ color: "var(--primary-2)" }}>Create a new game</Link> instead.
        </div>
      </div>
    </div>
  );
}
