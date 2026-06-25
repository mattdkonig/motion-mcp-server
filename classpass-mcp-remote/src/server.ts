#!/usr/bin/env node
import express, { NextFunction, Request, Response } from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ClassPassSession } from "./session.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const CP_EMAIL = process.env.CLASSPASS_EMAIL || "";
const CP_PASSWORD = process.env.CLASSPASS_PASSWORD || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const STORAGE_STATE_PATH = process.env.CLASSPASS_STORAGE_STATE || "./data/state.json";
const HEADFUL = process.env.HEADFUL === "1";
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type RegisteredClient = {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
  created_at: number;
};

type AuthorizationCode = {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  scope?: string;
  expires_at: number;
};

type TokenRecord = {
  token: string;
  client_id: string;
  scope?: string;
  expires_at: number;
};

const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, TokenRecord>();
const refreshTokens = new Map<string, TokenRecord>();

const tools = [
  { name: "classpass_login", description: "Log in with email and password. Not required if CLASSPASS_EMAIL/CLASSPASS_PASSWORD env vars are set.", inputSchema: { type: "object" as const, properties: { email: { type: "string" }, password: { type: "string" } }, required: ["email", "password"] } },
  { name: "classpass_search_classes", description: "Search classes by location, date, type, time.", inputSchema: { type: "object" as const, properties: { location: { type: "string" }, date: { type: "string" }, class_type: { type: "string" }, time_range: { type: "string" } }, required: ["location", "date"] } },
  { name: "classpass_get_class_details", description: "Full details for a class.", inputSchema: { type: "object" as const, properties: { class_id: { type: "string" } }, required: ["class_id"] } },
  { name: "classpass_book_class", description: "Book a class using credits.", inputSchema: { type: "object" as const, properties: { class_id: { type: "string" } }, required: ["class_id"] } },
  { name: "classpass_cancel_booking", description: "Cancel a booking.", inputSchema: { type: "object" as const, properties: { booking_id: { type: "string" } }, required: ["booking_id"] } },
  { name: "classpass_get_schedule", description: "Upcoming and past bookings.", inputSchema: { type: "object" as const, properties: { start_date: { type: "string" }, end_date: { type: "string" } } } },
  { name: "classpass_get_credits_balance", description: "Credits balance and plan.", inputSchema: { type: "object" as const, properties: {} } },
  { name: "classpass_get_favorites", description: "List favorited studios.", inputSchema: { type: "object" as const, properties: {} } },
  { name: "classpass_add_favorite", description: "Add a studio to favorites.", inputSchema: { type: "object" as const, properties: { studio_id: { type: "string" } }, required: ["studio_id"] } },
  { name: "classpass_get_nearby_studios", description: "Find studios near a location.", inputSchema: { type: "object" as const, properties: { location: { type: "string" }, radius: { type: "number" } }, required: ["location"] } },
];

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function getOrigin(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host");
  return `${proto}://${host}`;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isRedirectUriAllowed(client: RegisteredClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

function issueTokens(clientId: string, scope?: string) {
  const access_token = randomToken();
  const refresh_token = randomToken();
  const now = Date.now();
  accessTokens.set(access_token, {
    token: access_token,
    client_id: clientId,
    scope,
    expires_at: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  refreshTokens.set(refresh_token, {
    token: refresh_token,
    client_id: clientId,
    scope,
    expires_at: now + REFRESH_TOKEN_TTL_MS,
  });
  return {
    access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token,
    scope,
  };
}

function renderAuthorizeForm(req: Request, res: Response, status = 200, message?: string): void {
  const params = { ...req.query, ...req.body };
  const hiddenFields = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method"]
    .map((name) => `<input type="hidden" name="${name}" value="${htmlEscape(params[name])}" />`)
    .join("\n");
  res.status(status).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize ClassPass MCP</title>
  </head>
  <body>
    <main>
      <h1>Authorize ClassPass MCP</h1>
      <p>Enter the server authorization password to allow this OAuth client to access the MCP endpoint.</p>
      ${message ? `<p role="alert">${htmlEscape(message)}</p>` : ""}
      <form method="post" action="/authorize">
        ${hiddenFields}
        <label>
          Authorization password
          <input type="password" name="password" autocomplete="current-password" required autofocus />
        </label>
        <button type="submit">Authorize</button>
      </form>
    </main>
  </body>
</html>`);
}

function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const tokenRecord = token ? accessTokens.get(token) : undefined;
  const isOAuthTokenValid = tokenRecord !== undefined && tokenRecord.expires_at > Date.now();
  const isLegacyTokenValid = Boolean(AUTH_TOKEN && token === AUTH_TOKEN);

  if (tokenRecord && !isOAuthTokenValid) accessTokens.delete(token);
  if (isOAuthTokenValid || isLegacyTokenValid) {
    next();
    return;
  }

  res.set("WWW-Authenticate", `Bearer realm="classpass-mcp-remote", resource_metadata="${getOrigin(req)}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: "Unauthorized" });
}

let session: ClassPassSession | null = null;
async function ensureSession(): Promise<ClassPassSession> {
  if (session && session.isLoggedIn) return session;
  session = new ClassPassSession({ storageStatePath: STORAGE_STATE_PATH, headful: HEADFUL });
  await session.initialize();
  if (existsSync(STORAGE_STATE_PATH)) {
    const restoreResult = await session.restoreSavedSession();
    if (restoreResult.success) return session;
  }
  if (CP_EMAIL && CP_PASSWORD) {
    const loginResult = await session.login(CP_EMAIL, CP_PASSWORD);
    if (!loginResult.success) throw new Error(`Auto-login failed: ${loginResult.message}`);
  }
  return session;
}
function text(obj: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] }; }

function buildMcpServer(): Server {
  const mcp = new Server({ name: "classpass-mcp-remote", version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "classpass_login") {
        session = new ClassPassSession();
        await session.initialize();
        const result = await session.login(args?.email as string, args?.password as string);
        return text(result);
      }
      const s = await ensureSession();
      if (!s.isLoggedIn) return { content: [{ type: "text", text: "Error: not logged in. Call classpass_login or set CLASSPASS_EMAIL/CLASSPASS_PASSWORD." }], isError: true };
      switch (name) {
        case "classpass_search_classes": return text(await s.searchClasses({ location: args?.location as string, date: args?.date as string, class_type: args?.class_type as string | undefined, time_range: args?.time_range as string | undefined }));
        case "classpass_get_class_details": return text(await s.getClassDetails(args?.class_id as string));
        case "classpass_book_class": return text(await s.bookClass(args?.class_id as string));
        case "classpass_cancel_booking": return text(await s.cancelBooking(args?.booking_id as string));
        case "classpass_get_schedule": return text(await s.getSchedule({ start_date: args?.start_date as string | undefined, end_date: args?.end_date as string | undefined }));
        case "classpass_get_credits_balance": return text(await s.getCreditsBalance());
        case "classpass_get_favorites": return text(await s.getFavorites());
        case "classpass_add_favorite": return text(await s.addFavorite(args?.studio_id as string));
        case "classpass_get_nearby_studios": return text(await s.getNearbyStudios(args?.location as string, args?.radius as number | undefined));
        default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
  return mcp;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const origin = getOrigin(req);
  res.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: "ClassPass MCP Remote",
  });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const origin = getOrigin(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    service_documentation: `${origin}/health`,
  });
});

app.post("/register", (req, res) => {
  const redirectUris = Array.isArray(req.body?.redirect_uris)
    ? req.body.redirect_uris.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (redirectUris.length === 0) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
    return;
  }

  const client: RegisteredClient = {
    client_id: randomUUID(),
    client_name: getString(req.body?.client_name),
    redirect_uris: redirectUris,
    scope: getString(req.body?.scope) || "mcp",
    created_at: Math.floor(Date.now() / 1000),
  };
  clients.set(client.client_id, client);
  res.status(201).json({
    client_id: client.client_id,
    client_id_issued_at: client.created_at,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: client.scope,
  });
});

function handleAuthorize(req: Request, res: Response): void {
  if (!AUTH_PASSWORD) {
    res.status(503).send("AUTH_PASSWORD is not configured.");
    return;
  }

  const params = { ...req.query, ...req.body };
  const password = getString(params.password);
  if (!password) {
    renderAuthorizeForm(req, res);
    return;
  }
  if (!safeCompare(password, AUTH_PASSWORD)) {
    renderAuthorizeForm(req, res, 401, "Incorrect authorization password.");
    return;
  }

  const clientId = getString(params.client_id);
  const redirectUri = getString(params.redirect_uri);
  const responseType = getString(params.response_type);
  const codeChallenge = getString(params.code_challenge);
  const codeChallengeMethod = getString(params.code_challenge_method);
  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge || codeChallengeMethod !== "S256") {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const client = clients.get(clientId);
  if (!client || !isRedirectUriAllowed(client, redirectUri)) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  const code = randomToken();
  authCodes.set(code, {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: getString(params.scope) || client.scope,
    expires_at: Date.now() + AUTH_CODE_TTL_MS,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  const state = getString(params.state);
  if (state) redirect.searchParams.set("state", state);
  res.redirect(302, redirect.toString());
}

app.get("/authorize", handleAuthorize);
app.post("/authorize", handleAuthorize);

app.post("/token", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");

  const grantType = getString(req.body?.grant_type);
  const clientId = getString(req.body?.client_id);

  if (grantType === "authorization_code") {
    const code = getString(req.body?.code);
    const redirectUri = getString(req.body?.redirect_uri);
    const codeVerifier = getString(req.body?.code_verifier);
    if (!code || !clientId || !redirectUri || !codeVerifier) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const authCode = authCodes.get(code);
    authCodes.delete(code);
    if (!authCode || authCode.expires_at <= Date.now() || authCode.client_id !== clientId || authCode.redirect_uri !== redirectUri) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (pkceChallenge(codeVerifier) !== authCode.code_challenge) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    res.json(issueTokens(clientId, authCode.scope));
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = getString(req.body?.refresh_token);
    if (!refreshToken || !clientId) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const tokenRecord = refreshTokens.get(refreshToken);
    if (!tokenRecord || tokenRecord.expires_at <= Date.now() || tokenRecord.client_id !== clientId) {
      if (tokenRecord) refreshTokens.delete(refreshToken);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    res.json(issueTokens(clientId, tokenRecord.scope));
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

const transports: Record<string, StreamableHTTPServerTransport> = {};
app.post("/mcp", requireMcpAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;
  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => { transports[sid] = transport; } });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    const mcp = buildMcpServer();
    await mcp.connect(transport);
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session ID provided" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});
const handleSession = async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) { res.status(400).send("Invalid or missing session ID"); return; }
  await transports[sessionId].handleRequest(req, res);
};
app.get("/mcp", requireMcpAuth, handleSession);
app.delete("/mcp", requireMcpAuth, handleSession);
app.listen(PORT, () => { console.log(`ClassPass remote MCP server listening on port ${PORT}`); if (!AUTH_TOKEN) console.log("WARNING: MCP_AUTH_TOKEN not set."); if (!AUTH_PASSWORD) console.log("WARNING: AUTH_PASSWORD not set."); });
