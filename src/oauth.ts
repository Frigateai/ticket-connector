import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TTL = 60 * 60; // seconds
const REFRESH_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 5 * 60;
const PENDING_TTL = 10 * 60;

const now = () => Math.floor(Date.now() / 1000);
const rand = () => randomBytes(32).toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

interface Pending {
  clientId: string;
  params: AuthorizationParams;
  expires: number;
  failures: number;
}
interface Code {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  expires: number;
}
interface TokenRec {
  clientId: string;
  expires: number;
  resource?: string;
}
interface Persisted {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRec>; // keyed by sha256(token)
  refresh: Record<string, TokenRec>;
}

/**
 * Minimal single-tenant OAuth 2.1 authorization server. Users sign in with one
 * shared password (OAUTH_LOGIN_PASSWORD). Clients and tokens are persisted to
 * DATA_DIR so connections survive restarts; tokens are stored hashed.
 */
export class LocalOAuthProvider implements OAuthServerProvider {
  private state: Persisted = { clients: {}, access: {}, refresh: {} };
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  private file: string;

  constructor(
    dataDir: string,
    private loginPassword: string,
    private staticToken: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "oauth-state.json");
    if (existsSync(this.file)) {
      try {
        this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, "utf8")) };
      } catch (e) {
        console.error("Could not read oauth state, starting empty:", e);
      }
    }
  }

  private save() {
    const t = now();
    for (const k of Object.keys(this.state.access)) if (this.state.access[k].expires < t) delete this.state.access[k];
    for (const k of Object.keys(this.state.refresh)) if (this.state.refresh[k].expires < t) delete this.state.refresh[k];
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private sweep() {
    const t = now();
    for (const [k, v] of this.pending) if (v.expires < t) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expires < t) this.codes.delete(k);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.state.clients[id],
      registerClient: (client) => {
        const full = {
          ...client,
          client_id: `client_${randomBytes(12).toString("hex")}`,
          client_id_issued_at: now(),
        } as OAuthClientInformationFull;
        this.state.clients[full.client_id] = full;
        this.save();
        return full;
      },
    };
  }

  /** Step 1: show the login page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    const id = rand();
    this.pending.set(id, { clientId: client.client_id, params, expires: now() + PENDING_TTL, failures: 0 });
    this.renderLogin(res, id, client.client_name ?? client.client_id);
  }

  private renderLogin(res: Response, id: string, clientName: string, error?: string) {
    res
      .status(error ? 401 : 200)
      .type("html")
      .set("Cache-Control", "no-store")
      .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Plane connector</title>
<style>body{font-family:system-ui,sans-serif;max-width:360px;margin:12vh auto;padding:0 16px;color:#111}
input,button{width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin-top:10px}
button{cursor:pointer}.e{color:#b00020}</style></head><body>
<h2>Plane connector</h2>
<p><b>${esc(clientName)}</b> wants to access tickets on ticket.frigate.ai.</p>
${error ? `<p class="e">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/login">
<input type="hidden" name="request_id" value="${esc(id)}">
<input type="password" name="password" placeholder="Connector password" autofocus required>
<button type="submit">Authorize</button>
</form></body></html>`);
  }

  /** Step 2: handle the login form POST. */
  handleLogin = (req: Request, res: Response) => {
    this.sweep();
    const id = String(req.body?.request_id ?? "");
    const password = String(req.body?.password ?? "");
    const p = this.pending.get(id);
    if (!p) {
      res.status(400).type("text").send("This authorization request expired. Start again from ChatGPT.");
      return;
    }
    if (!safeEqual(password, this.loginPassword)) {
      p.failures += 1;
      if (p.failures >= 5) {
        this.pending.delete(id);
        res.status(429).type("text").send("Too many attempts. Start again from ChatGPT.");
        return;
      }
      const client = this.state.clients[p.clientId];
      this.renderLogin(res, id, client?.client_name ?? p.clientId, "Incorrect password.");
      return;
    }
    this.pending.delete(id);
    const code = rand();
    this.codes.set(code, {
      clientId: p.clientId,
      codeChallenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      resource: p.params.resource?.href,
      expires: now() + CODE_TTL,
    });
    const target = new URL(p.params.redirectUri);
    target.searchParams.set("code", code);
    if (p.params.state) target.searchParams.set("state", p.params.state);
    res.redirect(302, target.href);
  };

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.expires < now()) throw new Error("Invalid or expired authorization code");
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!c || c.expires < now()) throw new Error("Invalid or expired authorization code");
    if (c.clientId !== client.client_id) throw new Error("Code was issued to a different client");
    if (redirectUri && redirectUri !== c.redirectUri) throw new Error("redirect_uri mismatch");
    return this.issue(client.client_id, c.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const h = sha(refreshToken);
    const rec = this.state.refresh[h];
    if (!rec || rec.expires < now() || rec.clientId !== client.client_id) throw new Error("Invalid refresh token");
    delete this.state.refresh[h]; // rotate
    return this.issue(client.client_id, rec.resource);
  }

  private issue(clientId: string, resource?: string): OAuthTokens {
    const access = rand();
    const refresh = rand();
    this.state.access[sha(access)] = { clientId, resource, expires: now() + ACCESS_TTL };
    this.state.refresh[sha(refresh)] = { clientId, resource, expires: now() + REFRESH_TTL };
    this.save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.staticToken && safeEqual(token, this.staticToken)) {
      return { token, clientId: "static-token", scopes: [], expiresAt: now() + 3600 };
    }
    const rec = this.state.access[sha(token)];
    if (!rec || rec.expires < now()) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: rec.clientId,
      scopes: [],
      expiresAt: rec.expires,
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, req: { token: string }): Promise<void> {
    const h = sha(req.token);
    delete this.state.access[h];
    delete this.state.refresh[h];
    this.save();
  }
}
