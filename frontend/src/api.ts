// Central API helper. In production /api is rewritten to the FastAPI handler.
// In dev, Vite proxies /api to localhost:8000.

export type LocationHost = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  question: string;
  answer: string;
  fragment: string;
  hint?: string | null;
  order_idx: number;
};

export type LocationPublic = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  order_idx: number;
  position?: number | null;
  hint?: string | null;
  has_hint?: boolean;
};

export type Action = { id: number; text: string; hint?: string | null; location_id?: number | null };

export type TeamAction = {
  id: number;          // team_action id
  action_id: number;
  text: string;
  hint?: string | null;
  completed: boolean;
  completed_at?: string | null;
  location_id?: number | null;     // only revealed once visible to the team
  location_name?: string | null;
};

export type GameHost = {
  id: number;
  name: string;
  join_code: string;
  host_token: string;
  final_lat?: number | null;
  final_lng?: number | null;
  final_label?: string | null;
  started: boolean;
  has_password: boolean;
  test_mode?: boolean;
  locations: LocationHost[];
  actions: Action[];
};

export type TeamHost = {
  id: number;
  name: string;
  color: string;
  last_lat?: number | null;
  last_lng?: number | null;
  last_seen?: string | null;
  solved_count: number;
  total: number;
  actions_done: number;
  actions_total: number;
  score?: number;
  rank?: number;
  wrong_attempts?: number;
  actions: TeamAction[];
};

export type LeaderboardEntry = {
  rank: number;
  team_id: number;
  name: string;
  color: string;
  solved_count: number;
  actions_done: number;
  score: number;
};

export type HostDashboard = {
  game: GameHost;
  teams: TeamHost[];
  progress_matrix: Record<string, Record<string, boolean>>;
  leaderboard: LeaderboardEntry[];
  viewer_url_path?: string | null;
};

export type ProgressItem = {
  location_id: number;
  solved: boolean;
  attempts: number;
  fragment?: string | null;
};

export type TeamState = {
  team_id: number;
  team_name: string;
  color: string;
  game_name: string;
  locations: LocationPublic[];
  progress: ProgressItem[];
  actions: TeamAction[];
  final_lat?: number | null;
  final_lng?: number | null;
  final_label?: string | null;
  all_solved: boolean;
  rank?: number;
  score?: number;
  leaderboard?: LeaderboardEntry[];
  test_mode?: boolean;
};

export type TeamSession = {
  team_id: number;
  team_token: string;
  team_name: string;
  color: string;
  game_id: number;
  game_name: string;
};

/** Sentinel error message thrown when the server says a host password is needed. */
export const PASSWORD_REQUIRED_MARKER = "__PASSWORD_REQUIRED__";

async function req<T>(
  path: string,
  opts: { method?: string; body?: unknown; hostToken?: string; hostPassword?: string; teamToken?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.hostToken) headers["X-Host-Token"] = opts.hostToken;
  if (opts.hostPassword) headers["X-Host-Password"] = opts.hostPassword;
  if (opts.teamToken) headers["X-Team-Token"] = opts.teamToken;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail: any = `${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail !== undefined) detail = j.detail;
    } catch {}
    // FastAPI 422 returns detail as an array of validation errors. Format it
    // so we get something useful instead of the JS default "[object Object]".
    if (Array.isArray(detail)) {
      detail = detail
        .map((d: any) => {
          const where = Array.isArray(d?.loc) ? d.loc.join(".") : "";
          return where ? `${where}: ${d?.msg ?? d}` : (d?.msg ?? JSON.stringify(d));
        })
        .join("; ");
    } else if (typeof detail !== "string") {
      detail = JSON.stringify(detail);
    }
    // Special-case the password-gate so the UI can show a prompt instead of
    // a red error banner.
    if (res.status === 401 && /password required/i.test(String(detail))) {
      throw new Error(PASSWORD_REQUIRED_MARKER);
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---- host ----
export const createGame = (name: string, password?: string | null) =>
  req<GameHost>("/api/games", { body: { name, password: password || null } });

export const hostRecover = (host_token: string) =>
  req<{ game_id: number; name: string; join_code: string; has_password: boolean }>(
    "/api/host/recover",
    { body: { host_token } }
  );

export const setHostPassword = (gameId: number, hostToken: string, hostPassword: string, newPassword: string | null) =>
  req<{ has_password: boolean }>(`/api/games/${gameId}/password`, {
    body: { password: newPassword },
    hostToken, hostPassword,
  });

export const toggleTestMode = (gameId: number, hostToken: string, hostPassword: string, enabled: boolean) =>
  req<{ test_mode: boolean }>(`/api/games/${gameId}/test-mode`, {
    body: { enabled },
    hostToken, hostPassword,
  });

export const getViewerDashboard = (gameId: number, viewerToken: string) =>
  fetch(`/api/games/${gameId}/dashboard-viewer`, {
    headers: { "X-Viewer-Token": viewerToken },
  }).then(async (r) => {
    if (!r.ok) {
      let detail = `${r.status}`;
      try { const j = await r.json(); detail = j.detail || detail; } catch {}
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return r.json() as Promise<HostDashboard>;
  });

export const updateGame = (
  gameId: number,
  hostToken: string,
  hostPassword: string,
  payload: { name: string; final_lat?: number | null; final_lng?: number | null; final_label?: string | null }
) => req<GameHost>(`/api/games/${gameId}`, { method: "PATCH", body: payload, hostToken, hostPassword });

export const startGame = (gameId: number, hostToken: string, hostPassword: string) =>
  req<GameHost>(`/api/games/${gameId}/start`, { method: "POST", hostToken, hostPassword });

export const stopGame = (gameId: number, hostToken: string, hostPassword: string) =>
  req<GameHost>(`/api/games/${gameId}/stop`, { method: "POST", hostToken, hostPassword });

export const getHostDashboard = (gameId: number, hostToken: string, hostPassword: string) =>
  req<HostDashboard>(`/api/games/${gameId}/host`, { hostToken, hostPassword });

export const addLocation = (gameId: number, hostToken: string, hostPassword: string, body: Omit<LocationHost, "id">) =>
  req<LocationHost>(`/api/games/${gameId}/locations`, { body, hostToken, hostPassword });

export const updateLocation = (gameId: number, locId: number, hostToken: string, hostPassword: string, body: Omit<LocationHost, "id">) =>
  req<LocationHost>(`/api/games/${gameId}/locations/${locId}`, { method: "PUT", body, hostToken, hostPassword });

export const deleteLocation = (gameId: number, locId: number, hostToken: string, hostPassword: string) =>
  req<void>(`/api/games/${gameId}/locations/${locId}`, { method: "DELETE", hostToken, hostPassword });

export const addAction = (
  gameId: number, hostToken: string, hostPassword: string,
  text: string, hint?: string | null, location_id?: number | null
) =>
  req<Action>(`/api/games/${gameId}/actions`, {
    body: { text, hint: hint || null, location_id: location_id ?? null },
    hostToken, hostPassword,
  });

export const updateAction = (
  gameId: number, actionId: number, hostToken: string, hostPassword: string,
  text: string, hint?: string | null, location_id?: number | null
) =>
  req<Action>(`/api/games/${gameId}/actions/${actionId}`, {
    method: "PUT",
    body: { text, hint: hint || null, location_id: location_id ?? null },
    hostToken, hostPassword,
  });

export const deleteAction = (gameId: number, actionId: number, hostToken: string, hostPassword: string) =>
  req<void>(`/api/games/${gameId}/actions/${actionId}`, { method: "DELETE", hostToken, hostPassword });

export const reassignActions = (gameId: number, hostToken: string, hostPassword: string) =>
  req<{ ok: boolean; teams: number }>(`/api/games/${gameId}/actions/assign`, { method: "POST", hostToken, hostPassword });

// ---- team ----
export const joinGame = (join_code: string, name: string, color: string) =>
  req<TeamSession>("/api/teams/join", { body: { join_code, name, color } });

export const teamState = (teamId: number, teamToken: string) =>
  req<TeamState>(`/api/teams/${teamId}/state`, { teamToken });

export const teamPing = (teamId: number, teamToken: string, lat: number, lng: number) =>
  req<{ ok: boolean }>(`/api/teams/${teamId}/ping`, { body: { lat, lng }, teamToken });

export const fetchQuestion = (teamId: number, teamToken: string, locationId: number) =>
  req<{ location_id: number; name: string; question: string; hint?: string | null; has_hint?: boolean; attempts: number; distance_m: number; already_solved?: boolean; fragment?: string }>(
    `/api/teams/${teamId}/question?location_id=${locationId}`,
    { teamToken }
  );

export const submitAnswer = (teamId: number, teamToken: string, locationId: number, answer: string) =>
  req<{ correct: boolean; attempts: number; fragment?: string | null; already_solved?: boolean }>(
    `/api/teams/${teamId}/answer`,
    { body: { location_id: locationId, answer }, teamToken }
  );

export const hostToggleTeamAction = (
  gameId: number, teamId: number, teamActionId: number, hostToken: string, hostPassword: string
) =>
  req<{ id: number; completed: boolean; completed_at?: string | null }>(
    `/api/games/${gameId}/teams/${teamId}/actions/${teamActionId}/toggle`,
    { method: "POST", hostToken, hostPassword }
  );
