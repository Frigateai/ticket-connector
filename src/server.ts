import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { plane, rows, paths, listProjects, resolveProject, resolveState, getIssueByRef, WORKSPACE } from "./plane.js";

const PORT = Number(process.env.PORT ?? 3000);
const MCP_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const PUBLIC_URL = (process.env.PLANE_BASE_URL ?? "https://ticket.frigate.ai").replace(/\/$/, "");
const { ws } = paths;

const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});
const wrap =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return text(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };

const slim = (i: any) => ({
  id: i.id,
  sequence_id: i.sequence_id,
  project: i.project,
  name: i.name,
  state: typeof i.state === "object" ? i.state?.name : i.state,
  priority: i.priority,
  assignees: i.assignees,
  labels: i.labels,
  target_date: i.target_date,
  updated_at: i.updated_at,
});

const issueUrl = (key: string) => `${PUBLIC_URL}/${WORKSPACE}/browse/${key}/`;
const html = (s: string) =>
  `<p>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</p>`;
const priority = z.enum(["none", "urgent", "high", "medium", "low"]);

function buildServer() {
  const s = new McpServer({ name: "plane-ticket-frigate", version: "0.1.0" });

  // ---- ChatGPT-standard tools: search + fetch ----
  s.registerTool(
    "search",
    {
      description: "Search Plane work items by text across all projects. Returns ids to pass to `fetch`.",
      inputSchema: { query: z.string().describe("Search text") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      try {
        const data = await plane("GET", ws("/work-items/search/"), { query: { search: query } }).catch(() =>
          plane("GET", ws("/issues/search/"), { query: { search: query } }),
        );
        const list = rows(data?.issues ?? data);
        const results = list.slice(0, 25).map((i: any) => {
          const key = `${i.project__identifier ?? i.project_identifier ?? ""}-${i.sequence_id}`;
          return { id: key, title: i.name, url: issueUrl(key) };
        });
        return text(JSON.stringify({ results }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  s.registerTool(
    "fetch",
    {
      description: "Fetch a Plane work item by key (e.g. FRG-123) including description and comments.",
      inputSchema: { id: z.string().describe("Issue key, e.g. FRG-123") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const i = await getIssueByRef(id);
        const comments = rows(
          await plane("GET", ws(`/projects/${i.project}/issues/${i.id}/comments/`)).catch(() => []),
        );
        const key = id.toUpperCase();
        return text(
          JSON.stringify({
            id: key,
            title: i.name,
            url: issueUrl(key),
            text:
              `${i.name}\n\n${i.description_stripped ?? i.description_html ?? ""}\n\nComments:\n` +
              comments.map((c: any) => `- ${c.comment_stripped ?? c.comment_html}`).join("\n"),
            metadata: slim(i),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- Read tools ----
  s.registerTool(
    "list_projects",
    { description: "List projects in the Plane workspace.", inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(async () => (await listProjects()).map((p) => ({ id: p.id, identifier: p.identifier, name: p.name }))),
  );

  s.registerTool(
    "list_states",
    {
      description: "List workflow states of a project.",
      inputSchema: { project: z.string().describe("Project identifier, name or UUID") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ project }) => {
      const p = await resolveProject(project);
      return rows(await plane("GET", ws(`/projects/${p.id}/states/`))).map((x) => ({
        id: x.id,
        name: x.name,
        group: x.group,
      }));
    }),
  );

  s.registerTool(
    "list_issues",
    {
      description: "List recently updated work items in a project.",
      inputSchema: {
        project: z.string().describe("Project identifier, name or UUID"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ project, limit }) => {
      const p = await resolveProject(project);
      const list = rows(
        await plane("GET", ws(`/projects/${p.id}/issues/`), {
          query: { per_page: limit, expand: "state", order_by: "-updated_at" },
        }),
      );
      return list.map((i) => ({ key: `${p.identifier}-${i.sequence_id}`, ...slim(i) }));
    }),
  );

  s.registerTool(
    "get_issue",
    {
      description: "Get one work item with description and comments. Use an issue key like FRG-123.",
      inputSchema: { issue: z.string(), project: z.string().optional().describe("Only needed if `issue` is a UUID") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ issue, project }) => {
      const i = await getIssueByRef(issue, project);
      const comments = rows(
        await plane("GET", ws(`/projects/${i.project}/issues/${i.id}/comments/`)).catch(() => []),
      );
      return {
        ...i,
        comments: comments.map((c: any) => ({
          id: c.id,
          text: c.comment_stripped ?? c.comment_html,
          created_at: c.created_at,
        })),
      };
    }),
  );

  s.registerTool(
    "list_modules",
    { description: "List modules in a project.", inputSchema: { project: z.string() }, annotations: { readOnlyHint: true } },
    wrap(async ({ project }) => {
      const p = await resolveProject(project);
      return rows(await plane("GET", ws(`/projects/${p.id}/modules/`))).map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
      }));
    }),
  );

  // ---- Write tools ----
  s.registerTool(
    "create_issue",
    {
      description: "Create a work item in a project.",
      inputSchema: {
        project: z.string().describe("Project identifier, name or UUID"),
        name: z.string(),
        description: z.string().optional(),
        priority: priority.optional(),
        state: z.string().optional().describe("State name or UUID"),
        parent: z.string().optional().describe("Parent issue UUID (makes this a sub-issue)"),
        target_date: z.string().optional().describe("YYYY-MM-DD"),
      },
    },
    wrap(async ({ project, name, description, priority, state, parent, target_date }) => {
      const p = await resolveProject(project);
      const body: any = { name, priority, parent, target_date };
      if (description) body.description_html = html(description);
      if (state) body.state = await resolveState(p.id, state);
      const i = await plane("POST", ws(`/projects/${p.id}/issues/`), { body });
      const key = `${p.identifier}-${i.sequence_id}`;
      return { key, id: i.id, url: issueUrl(key) };
    }),
  );

  s.registerTool(
    "update_issue",
    {
      description: "Update a work item (title, description, state, priority, target date).",
      inputSchema: {
        issue: z.string().describe("Issue key like FRG-123"),
        name: z.string().optional(),
        description: z.string().optional(),
        state: z.string().optional().describe("State name or UUID"),
        priority: priority.optional(),
        target_date: z.string().optional(),
      },
    },
    wrap(async ({ issue, name, description, state, priority, target_date }) => {
      const i = await getIssueByRef(issue);
      const body: any = { name, priority, target_date };
      if (description) body.description_html = html(description);
      if (state) body.state = await resolveState(i.project, state);
      await plane("PATCH", ws(`/projects/${i.project}/issues/${i.id}/`), { body });
      return { updated: issue.toUpperCase() };
    }),
  );

  s.registerTool(
    "add_comment",
    {
      description: "Add a comment to a work item.",
      inputSchema: { issue: z.string().describe("Issue key like FRG-123"), comment: z.string() },
    },
    wrap(async ({ issue, comment }) => {
      const i = await getIssueByRef(issue);
      const c = await plane("POST", ws(`/projects/${i.project}/issues/${i.id}/comments/`), {
        body: { comment_html: html(comment) },
      });
      return { comment_id: c.id };
    }),
  );

  s.registerTool(
    "add_issue_to_module",
    {
      description: "Add a work item to a module.",
      inputSchema: { issue: z.string().describe("Issue key like FRG-123"), module_id: z.string() },
    },
    wrap(async ({ issue, module_id }) => {
      const i = await getIssueByRef(issue);
      await plane("POST", ws(`/projects/${i.project}/modules/${module_id}/module-issues/`), {
        body: { issues: [i.id] },
      });
      return { added: issue.toUpperCase(), module_id };
    }),
  );

  return s;
}

if (!process.env.PLANE_API_KEY || !WORKSPACE) {
  console.error("PLANE_API_KEY and PLANE_WORKSPACE_SLUG are required");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => void res.json({ ok: true }));

app.use("/mcp", (req, res, next) => {
  if (MCP_TOKEN && req.header("authorization") !== `Bearer ${MCP_TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

// Stateless Streamable HTTP: a fresh server + transport per request.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp", (_req, res) => void res.status(405).json({ error: "Method not allowed" }));

app.listen(PORT, () => console.log(`Plane MCP connector listening on :${PORT}/mcp`));
