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
  hint?: string | null;
};

export type Action = { id: number; text: string };

export type TeamAction = {
  id: number;          // team_action id
  action_id: number;
  text: string;
  completed: boolean;
  completed_at?: string | null;
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
  actions: TeamAction[];
};

export type HostDashboard = {
  game: GameHost;
  teams: TeamHost[];
  progress_matrix: Record<string, Record<string, boolean>>;
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
};

export type TeamSession = {
  team_id: number;
  team_token: string;
  team_name: string;
  color: string;
  game_id: number;
  game_name: string;
};

async function req<T>(
  path: string,
  opts: { method?: string; body?: unknown; hostToken?: string; teamToken?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.hostToken) headers["X-Host-Token"] = opts.hostToken;
  if (opts.teamToken) headers["X-Team-Token"] = opts.teamToken;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail || detail;
    } catch {}
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---- host ----
export const createGame = (name: string) =>
  req<GameHost>("/api/games", { body: { name } });

export const updateGame = (
  gameId: number,
  hostToken: string,
  payload: { name: string; final_lat?: number | null; final_lng?: number | null; final_label?: string | null }
) => req<GameHost>(`/api/games/${gameId}`, { method: "PATCH", body: payload, hostToken });

export const startGame = (gameId: number, hostToken: string) =>
  req<GameHost>(`/api/games/${gameId}/start`, { method: "POST", hostToken });

export const stopGame = (gameId: number, hostToken: string) =>
  req<GameHost>(`/api/games/${gameId}/stop`, { method: "POST", hostToken });

export const getHostDashboard = (gameId: number, hostToken: string) =>
  req<HostDashboard>(`/api/games/${gameId}/host`, { hostToken });

export const addLocation = (gameId: number, hostToken: string, body: Omit<LocationHost, "id">) =>
  req<LocationHost>(`/api/games/${gameId}/locations`, { body, hostToken });

export const updateLocation = (gameId: number, locId: number, hostToken: string, body: Omit<LocationHost, "id">) =>
  req<LocationHost>(`/api/games/${gameId}/locations/${locId}`, { method: "PUT", body, hostToken });

export const deleteLocation = (gameId: number, locId: number, hostToken: string) =>
  req<void>(`/api/games/${gameId}/locations/${locId}`, { method: "DELETE", hostToken });

export const addAction = (gameId: number, hostToken: string, text: string) =>
  req<Action>(`/api/games/${gameId}/actions`, { body: { text }, hostToken });

export const updateAction = (gameId: number, actionId: number, hostToken: string, text: string) =>
  req<Action>(`/api/games/${gameId}/actions/${actionId}`, { method: "PUT", body: { text }, hostToken });

export const deleteAction = (gameId: number, actionId: number, hostToken: string) =>
  req<void>(`/api/games/${gameId}/actions/${actionId}`, { method: "DELETE", hostToken });

export const reassignActions = (gameId: number, hostToken: string) =>
  req<{ ok: boolean; teams: number }>(`/api/games/${gameId}/actions/assign`, { method: "POST", hostToken });

// ---- team ----
export const joinGame = (join_code: string, name: string, color: string) =>
  req<TeamSession>("/api/teams/join", { body: { join_code, name, color } });

export const teamState = (teamId: number, teamToken: string) =>
  req<TeamState>(`/api/teams/${teamId}/state`, { teamToken });

export const teamPing = (teamId: number, teamToken: string, lat: number, lng: number) =>
  req<{ ok: boolean }>(`/api/teams/${teamId}/ping`, { body: { lat, lng }, teamToken });

export const fetchQuestion = (teamId: number, teamToken: string, locationId: number) =>
  req<{ location_id: number; name: string; question: string; hint?: string | null; attempts: number; distance_m: number; already_solved?: boolean; fragment?: string }>(
    `/api/teams/${teamId}/question?location_id=${locationId}`,
    { teamToken }
  );

export const submitAnswer = (teamId: number, teamToken: string, locationId: number, answer: string) =>
  req<{ correct: boolean; attempts: number; fragment?: string | null; already_solved?: boolean }>(
    `/api/teams/${teamId}/answer`,
    { body: { location_id: locationId, answer }, teamToken }
  );

export const hostToggleTeamAction = (
  gameId: number, teamId: number, teamActionId: number, hostToken: string
) =>
  req<{ id: number; completed: boolean; completed_at?: string | null }>(
    `/api/games/${gameId}/teams/${teamId}/actions/${teamActionId}/toggle`,
    { method: "POST", hostToken }
  );
