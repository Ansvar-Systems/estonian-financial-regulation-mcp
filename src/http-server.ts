#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "estonian-financial-regulation-mcp";
const DB_PATH = process.env["EFSA_DB_PATH"] ?? "data/efsa.db";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "ee_fin_search_regulations",
    description:
      "Full-text search across Finantsinspektsioon (EFSA) regulatory provisions. Returns matching guidelines, recommendations, and circulars.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Estonian or English" },
        sourcebook: { type: "string", description: "Filter by sourcebook ID (e.g., FI_Juhendid). Optional." },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter by provision status. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ee_fin_get_regulation",
    description:
      "Get a specific Finantsinspektsioon provision by sourcebook and reference.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: { type: "string", description: "Sourcebook identifier (e.g., FI_Juhendid)" },
        reference: { type: "string", description: "Provision reference" },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "ee_fin_list_sourcebooks",
    description: "List all Finantsinspektsioon sourcebook categories.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ee_fin_search_enforcement",
    description:
      "Search Finantsinspektsioon enforcement actions — fines, bans, and warnings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (firm name, breach type, etc.)" },
        action_type: {
          type: "string",
          enum: ["fine", "ban", "restriction", "warning"],
          description: "Filter by action type. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ee_fin_check_currency",
    description: "Check whether a specific Finantsinspektsioon provision reference is currently in force.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Provision reference to check" },
      },
      required: ["reference"],
    },
  },
  {
    name: "ee_fin_about",
    description: "Return metadata about this MCP server: version, data source, tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ee_fin_list_sources",
    description:
      "List the data sources used by this MCP server, including authority names, URLs, and coverage details.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ee_fin_check_data_freshness",
    description:
      "Check when the database was last updated and whether data may be stale.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas ---

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["fine", "ban", "restriction", "warning"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// --- Shared helpers ---

function buildMeta(): Record<string, unknown> {
  return {
    disclaimer:
      "Data sourced from official Finantsinspektsioon (Estonian Financial Supervision Authority) publications. Not legal or regulatory advice. Verify all references against primary sources before making compliance decisions.",
    copyright: "© Finantsinspektsioon / Estonian Financial Supervision Authority",
    source_url: "https://www.fi.ee/",
  };
}

// --- MCP server factory ---

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "ee_fin_search_regulations": {
          const parsed = SearchRegulationsArgs.parse(args);
          const results = searchProvisions({
            query: parsed.query,
            sourcebook: parsed.sourcebook,
            status: parsed.status,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "ee_fin_get_regulation": {
          const parsed = GetRegulationArgs.parse(args);
          const provision = getProvision(parsed.sourcebook, parsed.reference);
          if (!provision) {
            return errorContent(
              `Provision not found: ${parsed.sourcebook} ${parsed.reference}`,
            );
          }
          const provisionRecord = provision as Record<string, unknown>;
          return textContent({
            ...provisionRecord,
            _citation: buildCitation(
              String(provisionRecord.reference ?? parsed.reference),
              String(provisionRecord.title ?? `${parsed.sourcebook} ${parsed.reference}`),
              "ee_fin_get_regulation",
              { sourcebook: parsed.sourcebook, reference: parsed.reference },
              provisionRecord.url as string | undefined,
            ),
            _meta: buildMeta(),
          });
        }

        case "ee_fin_list_sourcebooks": {
          const sourcebooks = listSourcebooks();
          return textContent({ sourcebooks, count: sourcebooks.length, _meta: buildMeta() });
        }

        case "ee_fin_search_enforcement": {
          const parsed = SearchEnforcementArgs.parse(args);
          const results = searchEnforcement({
            query: parsed.query,
            action_type: parsed.action_type,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "ee_fin_check_currency": {
          const parsed = CheckCurrencyArgs.parse(args);
          const currency = checkProvisionCurrency(parsed.reference);
          return textContent({ ...currency, _meta: buildMeta() });
        }

        case "ee_fin_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "Finantsinspektsioon (Estonian Financial Supervision Authority) MCP server. Provides access to EFSA guidelines, recommendations, circulars, and enforcement actions.",
            data_source: "Finantsinspektsioon (https://www.fi.ee/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: buildMeta(),
          });
        }

        case "ee_fin_list_sources": {
          return textContent({
            sources: [
              {
                id: "FI_Juhendid",
                name: "Finantsinspektsioon Guidelines (Juhendid)",
                authority: "Finantsinspektsioon",
                country: "EE",
                url: "https://www.fi.ee/et/finantsinspektsioon/finantsinspektsiooni-juhendid",
                languages: ["et", "en"],
                coverage: "Regulatory guidelines for financial institutions operating in Estonia",
                license: "Estonian Government Open Data",
              },
              {
                id: "FI_Soovituslikud_Juhendid",
                name: "Finantsinspektsioon Recommended Guidelines (Soovituslikud Juhendid)",
                authority: "Finantsinspektsioon",
                country: "EE",
                url: "https://www.fi.ee/et/finantsinspektsioon/finantsinspektsiooni-juhendid",
                languages: ["et", "en"],
                coverage: "Non-binding best practice recommendations for financial institutions",
                license: "Estonian Government Open Data",
              },
              {
                id: "FI_Ringkirjad",
                name: "Finantsinspektsioon Circulars (Ringkirjad)",
                authority: "Finantsinspektsioon",
                country: "EE",
                url: "https://www.fi.ee/et/finantsinspektsioon/ringkirjad",
                languages: ["et"],
                coverage: "Supervisory circulars and communications to regulated entities",
                license: "Estonian Government Open Data",
              },
            ],
            _meta: buildMeta(),
          });
        }

        case "ee_fin_check_data_freshness": {
          let lastModified: string | null = null;
          let isStale: boolean | null = null;
          try {
            const stat = statSync(DB_PATH);
            lastModified = stat.mtime.toISOString();
            const ageMs = Date.now() - stat.mtime.getTime();
            isStale = ageMs > 30 * 24 * 60 * 60 * 1000; // stale after 30 days
          } catch {
            // DB not accessible
          }
          return textContent({
            db_path: DB_PATH,
            last_modified: lastModified,
            is_stale: isStale,
            freshness_threshold_days: 30,
            note: lastModified
              ? "Check https://www.fi.ee/ for the most recent official publications."
              : "Database file not found or not accessible.",
            _meta: buildMeta(),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server ---

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
