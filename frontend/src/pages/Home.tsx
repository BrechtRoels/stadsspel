import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="app">
      <div className="card">
        <h1>Stadsspel</h1>
        <p className="muted">A team-vs-team city game. Visit locations, answer questions, unlock parts of the final coordinates.</p>
        <div className="grid-2" style={{ marginTop: 20 }}>
          <Link to="/host/new" className="btn btn--block" style={{ textDecoration: "none", textAlign: "center" }}>
            Host a game
          </Link>
          <Link to="/play" className="btn btn--ghost btn--block" style={{ textDecoration: "none", textAlign: "center" }}>
            Join as a team
          </Link>
        </div>
        <hr style={{ borderColor: "var(--border)", margin: "20px 0" }} />
        <h2>How it works</h2>
        <ol className="list-bullet muted">
          <li>The host creates a game and places locations on the map with a question, answer, and a fragment of the final coordinates.</li>
          <li>Teams join with a 6-character code and are guided to the locations.</li>
          <li>When a team is within a location's radius, the question unlocks. A correct answer reveals that location's coordinate fragment.</li>
          <li>Solve them all → the final coordinates are revealed and the team can race to the end point.</li>
        </ol>
      </div>
    </div>
  );
}
