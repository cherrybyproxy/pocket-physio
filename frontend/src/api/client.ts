// thin fetch wrapper for the nestjs backend.
// stores jwt in memory (not localstorage) to avoid xss exposure.
// uses sessionStorage for tab-scoped guest sessions that auto-sync when signing in and time out on tab close.

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

let accessToken: string | null = null;
const TAB_SESSIONS_KEY = "pocket_physio_tab_sessions";
const PENDING_SESSION_KEY = "pocket_physio_pending_session";

function authHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  return headers;
}

// generic request helper with error handling
async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { message?: string | string[] }).message
        ? Array.isArray((body as { message: unknown }).message)
          ? ((body as { message: string[] }).message).join(", ")
          : (body as { message: string }).message
        : `request failed: ${res.status}`
    );
  }
  return res.json() as Promise<T>;
}

// sync any pending guest session to the authenticated account upon login/registration
async function syncPendingSession(): Promise<void> {
  try {
    const pending = sessionStorage.getItem(PENDING_SESSION_KEY);
    if (pending) {
      const sessionData = JSON.parse(pending);
      await request<SessionRecord>("/sessions", {
        method: "POST",
        body: JSON.stringify(sessionData),
      });
      sessionStorage.removeItem(PENDING_SESSION_KEY);
    }
  } catch {
    // continue if sync fails
  }
}

// auth

interface AuthResponse {
  access_token: string;
}

export async function register(
  email: string,
  password: string
): Promise<void> {
  const data = await request<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  accessToken = data.access_token;
  await syncPendingSession();
}

export async function login(email: string, password: string): Promise<void> {
  const data = await request<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  accessToken = data.access_token;
  await syncPendingSession();
}

export function logout(): void {
  accessToken = null;
  sessionStorage.removeItem(PENDING_SESSION_KEY);
  window.location.href = "/";
}

export function isAuthenticated(): boolean {
  return accessToken !== null;
}

// sessions

export interface SessionRecord {
  id: string;
  date: string;
  time: string;
  injuredSide: string;
  minAngle: number;
  maxAngle: number;
  rom: number;
  bodyLeanMax?: number;
  maxLoad?: number;
  flexReps?: number;
  extReps?: number;
  createdAt: string;
  isGuest?: boolean;
}

export interface SaveSessionPayload {
  date: string;
  time: string;
  injuredSide: string;
  minAngle: number;
  maxAngle: number;
  rom: number;
  bodyLeanMax?: number;
  maxLoad?: number;
  flexReps?: number;
  extReps?: number;
}

function getTabSessions(): SessionRecord[] {
  try {
    const raw = sessionStorage.getItem(TAB_SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTabSession(session: SaveSessionPayload): SessionRecord {
  const record: SessionRecord = {
    ...session,
    id: `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    createdAt: new Date().toISOString(),
    isGuest: true,
  };
  const sessions = [record, ...getTabSessions()];
  try {
    sessionStorage.setItem(TAB_SESSIONS_KEY, JSON.stringify(sessions));
    sessionStorage.setItem(PENDING_SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore quota errors
  }
  return record;
}

export async function saveSession(session: SaveSessionPayload): Promise<SessionRecord> {
  const payload: SaveSessionPayload = {
    date: session.date,
    time: session.time,
    injuredSide: session.injuredSide === "right" ? "right" : "left",
    minAngle: Math.min(360, Math.max(0, Math.round(session.minAngle))),
    maxAngle: Math.min(360, Math.max(0, Math.round(session.maxAngle))),
    rom: Math.min(360, Math.max(0, Math.round(session.rom))),
    bodyLeanMax: Math.min(90, Math.max(0, Math.round(session.bodyLeanMax ?? 0))),
    maxLoad: Math.min(100, Math.max(0, Math.round(session.maxLoad ?? 0))),
    flexReps: Math.max(0, Math.round(session.flexReps ?? 0)),
    extReps: Math.max(0, Math.round(session.extReps ?? 0)),
  };

  if (!isAuthenticated()) {
    return saveTabSession(payload);
  }

  return request<SessionRecord>("/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getSessions(): Promise<SessionRecord[]> {
  if (!isAuthenticated()) {
    return getTabSessions();
  }

  try {
    const cloudSessions = await request<SessionRecord[]>("/sessions");
    return cloudSessions;
  } catch {
    return getTabSessions();
  }
}
