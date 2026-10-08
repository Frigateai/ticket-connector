const BASE = (process.env.PLANE_BASE_URL ?? "https://ticket.frigate.ai").replace(/\/$/, "");
const API_KEY = process.env.PLANE_API_KEY ?? "";
export const WORKSPACE = process.env.PLANE_WORKSPACE_SLUG ?? "";

export class PlaneError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

export async function plane<T = any>(
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${BASE}/api/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  if (!res.ok) throw new PlaneError(res.status, `Plane ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Plane list endpoints return either an array or { results: [...] }. */
export function rows(data: any): any[] {
  return Array.isArray(data) ? data : (data?.results ?? []);
}

const ws = (p: string) => `/workspaces/${WORKSPACE}${p}`;
export const paths = { ws };

let projectCache: { at: number; list: any[] } | undefined;
export async function listProjects(): Promise<any[]> {
  if (projectCache && Date.now() - projectCache.at < 60_000) return projectCache.list;
  const list = rows(await plane("GET", ws("/projects/"), { query: { per_page: 100 } }));
  projectCache = { at: Date.now(), list };
  return list;
}

/** Accepts a project UUID, identifier (e.g. "FRG") or name. */
export async function resolveProject(ref: string): Promise<any> {
  const list = await listProjects();
  const r = ref.toLowerCase();
  const hit = list.find(
    (p) => p.id === ref || p.identifier?.toLowerCase() === r || p.name?.toLowerCase() === r,
  );
  if (!hit) throw new Error(`Project "${ref}" not found. Known: ${list.map((p) => p.identifier).join(", ")}`);
  return hit;
}

/** Resolve a state by name (case-insensitive) or id within a project. */
export async function resolveState(projectId: string, ref: string): Promise<string> {
  const states = rows(await plane("GET", ws(`/projects/${projectId}/states/`)));
  const r = ref.toLowerCase();
  const hit = states.find((s) => s.id === ref || s.name?.toLowerCase() === r);
  if (!hit) throw new Error(`State "${ref}" not found. Available: ${states.map((s) => s.name).join(", ")}`);
  return hit.id;
}

/** Fetch an issue by key ("FRG-123") or by UUID plus project. */
export async function getIssueByRef(ref: string, projectRef?: string): Promise<any> {
  const m = /^([A-Za-z0-9]+)-(\d+)$/.exec(ref);
  if (m) {
    const key = `${m[1].toUpperCase()}-${m[2]}`;
    try {
      return await plane("GET", ws(`/issues/${key}/`), { query: { expand: "state,assignees,labels" } });
    } catch (e) {
      if (!(e instanceof PlaneError) || e.status !== 404) throw e;
    }
    // Fallback for versions without the by-identifier endpoint: scan the project.
    const project = await resolveProject(m[1]);
    const list = rows(
      await plane("GET", ws(`/projects/${project.id}/issues/`), {
        query: { per_page: 100, expand: "state,assignees,labels" },
      }),
    );
    const hit = list.find((i) => String(i.sequence_id) === m[2]);
    if (hit) return hit;
    throw new Error(`Issue ${ref} not found`);
  }
  if (!projectRef) throw new Error("Pass an issue key like FRG-123, or an issue UUID together with project.");
  const project = await resolveProject(projectRef);
  return plane("GET", ws(`/projects/${project.id}/issues/${ref}/`), { query: { expand: "state,assignees,labels" } });
}
