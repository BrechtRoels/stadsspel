import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import Home from "./pages/Home";
import HostNew from "./pages/HostNew";
import HostGame from "./pages/HostGame";
import PlayerJoin from "./pages/PlayerJoin";
import PlayerGame from "./pages/PlayerGame";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/host/new" element={<HostNew />} />
        <Route path="/host/:gameId" element={<HostGame />} />
        <Route path="/play" element={<PlayerJoin />} />
        <Route path="/play/:teamId" element={<PlayerGame />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
