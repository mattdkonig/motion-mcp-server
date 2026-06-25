#!/usr/bin/env node
import express, { NextFunction, Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ClassPassSession } from "./session.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const CP_EMAIL = process.env.CLASSPASS_EMAIL || "";
const CP_PASSWORD = process.env.CLASSPASS_PASSWORD || "";
const STORAGE_STATE_PATH = process.env.CLASSPASS_STORAGE_STATE || "./data/state.json";
const HEADFUL = process.env.HEADFUL === "1";
const GENERATED_MCP_SECRET = randomBytes(16).toString("hex");
const MCP_SECRET = process.env.MCP_SECRET || GENERATED_MCP_SECRET;
const GENERATED_SECRET = !process.env.MCP_SECRET;

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

function requireSecretPath(req: Request, _res: Response, next: NextFunction): void {
  if (req.params.secret !== MCP_SECRET) {
    next("route");
    return;
  }
  next();
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
        session = new ClassPassSession({ storageStatePath: STORAGE_STATE_PATH, headful: HEADFUL });
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
app.get("/health", (_req, res) => res.json({ ok: true }));

const transports: Record<string, StreamableHTTPServerTransport> = {};
app.post("/:secret/mcp", requireSecretPath, async (req: Request, res: Response) => {
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
app.get("/:secret/mcp", requireSecretPath, handleSession);
app.delete("/:secret/mcp", requireSecretPath, handleSession);
app.listen(PORT, () => {
  console.log(`ClassPass remote MCP server listening on port ${PORT}`);
  if (GENERATED_SECRET) console.log(`MCP_SECRET not set; generated secret: ${MCP_SECRET}`);
  console.log(`MCP endpoint path: /${MCP_SECRET}/mcp`);
});
