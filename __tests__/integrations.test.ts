import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  keys: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  campaigns: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  accounts: { findFirst: vi.fn(), findMany: vi.fn() },
  logs: { findMany: vi.fn(), count: vi.fn() },
  transaction: vi.fn(),
  media: vi.fn(), allMedia: vi.fn(), instagram: vi.fn(),
  context: vi.fn(), eval: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  serviceKey: state.keys, automation: state.campaigns, instagramAccount: state.accounts, dmLog: state.logs,
  $transaction: state.transaction,
} }));
vi.mock("@/lib/instagram/provider", () => ({ createInstagramContext: state.instagram, getUserMedia: state.media, getAllUserMedia: state.allMedia }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: state.context, canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role) }));
vi.mock("ioredis", () => ({ default: class { status = "ready"; eval = state.eval; listenerCount() { return 1; } } }));

import { authenticateService, hashServiceToken, newServiceToken } from "../lib/integrations/auth";
import { checkOrigin, readJson } from "../lib/integrations/http";
import { createCampaign, getCampaign, listDmLogs, listInstagramAccounts, listInstagramPosts, toggleCampaign, updateCampaign } from "../lib/integrations/campaigns";
import { callTool, listTools } from "../lib/integrations/mcp";
import { GET as listKeys, POST as createKey, DELETE as revokeKey } from "../app/api/integrations/keys/route";
import { POST as mcp } from "../app/api/mcp/route";
import { GET as rest, POST as restCreate } from "../app/api/v1/campaigns/route";
import { PATCH as restPatch, DELETE as restDelete } from "../app/api/v1/campaigns/[id]/route";
import { GET as restLogs } from "../app/api/v1/logs/route";

const token = `orp_${"a".repeat(43)}`;
const key = { id: "key", workspaceId: "workspace", scopes: ["campaigns:read"], expiresAt: new Date("2099-01-01"), revokedAt: null };
const context = { workspaceId: "workspace", keyId: "key", scopes: ["campaigns:read"] };
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
const request = (body: unknown, extra = {}) => new Request("https://example.test/api/mcp", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
  state.keys.findUnique.mockResolvedValue(key);
  state.keys.update.mockResolvedValue(key);
  state.keys.create.mockImplementation(async ({ data }) => ({ id: "new", name: data.name, scopes: data.scopes, expiresAt: data.expiresAt }));
  state.keys.findMany.mockResolvedValue([]);
  state.keys.updateMany.mockResolvedValue({ count: 1 });
  state.context.mockResolvedValue({ workspaceId: "workspace", role: "ADMIN" });
  state.eval.mockReset().mockResolvedValue(1);
  state.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run({ automation: state.campaigns, trackedLink: { findMany: vi.fn().mockResolvedValue([]) } }));
});

describe("service authentication", () => {
  it("generates random secrets and stores lookups by hash only", async () => {
    const a = newServiceToken();
    expect(a).toMatch(/^orp_[A-Za-z0-9_-]{43}$/);
    expect(newServiceToken()).not.toBe(a);
    expect(hashServiceToken(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(await authenticateService(request({}))).toEqual(context);
    expect(state.keys.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashServiceToken(token) } });
  });
  it.each(["", "Bearer bad", `Bearer ${token} extra`])("rejects invalid header %s before DB", async authorization => {
    await expect(authenticateService(request({}, { authorization }))).rejects.toMatchObject({ status: 401 });
    expect(state.keys.findUnique).not.toHaveBeenCalled();
  });
  it.each([null, { ...key, revokedAt: new Date() }, { ...key, expiresAt: new Date(0) }])("rejects missing, expired or revoked keys", async value => {
    state.keys.findUnique.mockResolvedValue(value);
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 401 });
    expect(state.eval).not.toHaveBeenCalled();
  });
  it("bounds requests and fails closed without Redis", async () => {
    state.eval.mockResolvedValueOnce(121);
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 429 });
    state.eval.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("REDIS_URL", "");
    await expect(authenticateService(request({}))).rejects.toMatchObject({ status: 503 });
  });
});

describe("key management", () => {
  it.each([30, 60, 90])("creates a %i-day key with safe one-time output", async days => {
    const before = Date.now();
    const response = await createKey(request({ name: "Reader", scopes: ["campaigns:read"], days }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const output = await response.json();
    expect(output.token).toMatch(/^orp_/);
    expect(output.key.tokenHash).toBeUndefined();
    const input = state.keys.create.mock.calls[0][0];
    expect(input.data.tokenHash).toBe(hashServiceToken(output.token));
    expect(input.data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + days * 86400000);
    expect(input.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + days * 86400000);
    expect(state.keys.update).not.toHaveBeenCalled();
  });
  it("defaults to 30 days", async () => {
    const before = Date.now();
    expect((await createKey(request({ name: "Reader", scopes: ["campaigns:read"] }))).status).toBe(201);
    expect(state.keys.create.mock.calls[0][0].data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 86400000);
  });
  it.each([0, 91, 365, 1.5])("rejects lifetime %s", async days => {
    expect((await createKey(request({ name: "Reader", scopes: ["campaigns:read"], days }))).status).toBe(400);
    expect(state.keys.create).not.toHaveBeenCalled();
  });
  it.each([null, { workspaceId: "workspace", role: "MEMBER" }])("requires admin access for all management routes", async value => {
    state.context.mockResolvedValue(value);
    expect((await listKeys()).status).toBe(403);
    expect((await createKey(request({}))).status).toBe(403);
    expect((await revokeKey(new Request("https://example.test/api/integrations/keys?id=key"))).status).toBe(403);
  });
  it("rejects write scopes and foreign Origins", async () => {
    expect((await createKey(request({ name: "Reader", scopes: ["drafts:write"] }))).status).toBe(400);
    expect((await createKey(request({}, { origin: "https://evil.test" }))).status).toBe(403);
    expect(state.keys.create).not.toHaveBeenCalled();
  });
  it("lists safe workspace metadata and revokes only workspace keys", async () => {
    expect((await listKeys()).status).toBe(200);
    const selected = state.keys.findMany.mock.calls[0][0];
    expect(selected.where).toEqual({ workspaceId: "workspace" });
    expect(selected.select.tokenHash).toBeUndefined();
    expect((await revokeKey(new Request("https://example.test/api/integrations/keys?id=key"))).status).toBe(200);
    expect(state.keys.updateMany.mock.calls[0][0].where).toEqual({ id: "key", workspaceId: "workspace", revokedAt: null });
    state.keys.updateMany.mockResolvedValue({ count: 0 });
    expect((await revokeKey(new Request("https://example.test/api/integrations/keys?id=foreign"))).status).toBe(404);
  });
});

describe("read-only MCP and REST", () => {
  it("advertises only scoped read-only tools", async () => {
    expect(listTools({ ...context, scopes: [] })).toEqual([]);
    expect(listTools(context).map(tool => tool.name)).toEqual(["list_campaigns", "get_campaign", "get_campaign_stats", "list_instagram_accounts", "list_instagram_posts", "list_dm_logs"]);
    expect(listTools(context).every(tool => tool.annotations.readOnlyHint)).toBe(true);
    await expect(callTool(context, "create_draft", {})).rejects.toMatchObject({ status: 404 });
    await expect(callTool({ ...context, scopes: [] }, "get_campaign", { id: "test" })).rejects.toMatchObject({ status: 403 });
  });
  it("negotiates MCP, handles notifications and rejects unsupported methods", async () => {
    const response = await mcp(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }));
    expect((await response.json()).result.protocolVersion).toBe("2025-11-25");
    expect((await mcp(request({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
    expect((await (await mcp(request({ jsonrpc: "2.0", id: 2, method: "unknown" }))).json()).error.code).toBe(-32601);
    expect((await mcp(request({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-protocol-version": "invalid" }))).status).toBe(400);
    expect((await mcp(request({}, { accept: "application/json" }))).status).toBe(406);
  });
  it("keeps REST and MCP details identical and non-cached", async () => {
    state.campaigns.findFirst.mockResolvedValue({ id: "campaign", trackedLinks: [{ destinationUrl: "https://example.test/primary", label: "Primary", position: 0 }] });
    const restResponse = await rest(new Request("https://example.test/api/v1/campaigns?id=campaign", { headers }));
    const expected = (await restResponse.json()).data;
    const mcpResponse = await mcp(request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_campaign", arguments: { id: "campaign" } } }));
    expect(JSON.parse((await mcpResponse.json()).result.content[0].text)).toEqual(expected);
    expect(restResponse.headers.get("cache-control")).toBe("no-store");
    expect(mcpResponse.headers.get("cache-control")).toBe("no-store");
    const selection = state.campaigns.findFirst.mock.calls[0][0];
    expect(selection.where).toEqual({ id: "campaign", workspaceId: "workspace" });
    expect(selection.select.trackedLinks.where).toEqual({ workspaceId: "workspace" });
    expect(selection.select.reportShareSlug).toBeUndefined();
    expect(selection.select.instagramAccount).toBeUndefined();
  });
  it("does not leak foreign campaigns or invent missing links", async () => {
    state.campaigns.findFirst.mockResolvedValue(null);
    await expect(getCampaign(context, "foreign")).rejects.toMatchObject({ status: 404 });
    state.campaigns.findFirst.mockResolvedValue({ id: "empty", trackedLinks: [] });
    expect(await getCampaign(context, "empty")).toMatchObject({ trackedDestinationUrl: null, secondaryDestinationUrl: null, trackedLinks: [] });
  });
});

describe("request boundaries", () => {
  it("enforces Origin while permitting non-browser clients", () => {
    expect(() => checkOrigin(request({}))).not.toThrow();
    expect(() => checkOrigin(request({}, { origin: "https://evil.test" }))).toThrow("Origin not allowed");
  });
  it("bounds chunked JSON independent of Content-Length", async () => {
    await expect(readJson(request({ padding: "x".repeat(65536) }))).rejects.toMatchObject({ status: 413 });
    await expect(readJson(request({}, { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).rejects.toMatchObject({ status: 400 });
  });
});

const writer = { ...context, scopes: ["campaigns:read", "campaigns:write"] };
const campaignInput = { name: "Launch", instagramAccountId: "account", postId: "post", keywords: ["LINK"], dmMessage: "Here you go" };
const writeHeaders = { ...headers, authorization: `Bearer ${token}` };

describe("campaigns:write keys", () => {
  it("mints read-only or read & write keys and rejects write-only or unknown scopes", async () => {
    expect((await createKey(request({ name: "Agent", scopes: ["campaigns:read", "campaigns:write"] }))).status).toBe(201);
    expect(state.keys.create.mock.calls[0][0].data.scopes).toEqual(["campaigns:read", "campaigns:write"]);
    expect((await createKey(request({ name: "Agent", scopes: ["campaigns:read", "campaigns:read"] }))).status).toBe(201);
    expect(state.keys.create.mock.calls[1][0].data.scopes).toEqual(["campaigns:read"]);
    expect((await createKey(request({ name: "Agent", scopes: ["campaigns:write"] }))).status).toBe(400);
    expect((await createKey(request({ name: "Agent", scopes: ["campaigns:read", "campaigns:write", "campaigns:write"] }))).status).toBe(400);
    expect(state.keys.create).toHaveBeenCalledTimes(2);
  });
  it("advertises write tools only to write keys and blocks read-only keys from every write path", async () => {
    expect(listTools(writer).map(tool => tool.name)).toEqual(expect.arrayContaining(["create_campaign", "update_campaign", "toggle_campaign", "delete_campaign"]));
    expect(listTools(writer).find(tool => tool.name === "delete_campaign")?.annotations.destructiveHint).toBe(true);
    expect(listTools(writer).find(tool => tool.name === "create_campaign")?.inputSchema.required).toEqual(expect.arrayContaining(["instagramAccountId", "name", "dmMessage"]));
    for (const name of ["create_campaign", "update_campaign", "toggle_campaign", "delete_campaign"]) {
      await expect(callTool(context, name, { id: "campaign" })).rejects.toMatchObject({ status: 403 });
    }
    await expect(createCampaign(context, campaignInput)).rejects.toMatchObject({ status: 403 });
    await expect(toggleCampaign(context, "campaign", true)).rejects.toMatchObject({ status: 403 });
    expect((await restCreate(new Request("https://example.test/api/v1/campaigns", { method: "POST", headers: writeHeaders, body: JSON.stringify(campaignInput) }))).status).toBe(403);
    expect(state.campaigns.create).not.toHaveBeenCalled();
    expect(state.campaigns.updateMany).not.toHaveBeenCalled();
    expect(state.campaigns.deleteMany).not.toHaveBeenCalled();
  });
  it("requires an explicit instagramAccountId owned by the workspace", async () => {
    const { instagramAccountId: _omitted, ...withoutAccount } = campaignInput;
    void _omitted;
    await expect(createCampaign(writer, withoutAccount)).rejects.toMatchObject({ status: 400 });
    state.accounts.findFirst.mockResolvedValue(null);
    await expect(createCampaign(writer, campaignInput)).rejects.toMatchObject({ status: 404 });
    expect(state.accounts.findFirst.mock.calls[0][0].where).toEqual({ id: "account", workspaceId: "workspace" });
    expect(state.campaigns.create).not.toHaveBeenCalled();
  });
  it("validates targeting like the dashboard before touching the database", async () => {
    await expect(createCampaign(writer, { ...campaignInput, postId: undefined })).rejects.toMatchObject({ status: 400 });
    await expect(createCampaign(writer, { ...campaignInput, keywords: [] })).rejects.toMatchObject({ status: 400 });
    await expect(createCampaign(writer, { ...campaignInput, openingDmEnabled: true })).rejects.toMatchObject({ status: 400 });
    await expect(createCampaign(writer, { ...campaignInput, workspaceId: "other" })).rejects.toMatchObject({ status: 400 });
    expect(state.accounts.findFirst).not.toHaveBeenCalled();
  });
  it("creates paused, workspace-scoped campaigns with a report slug and safe output", async () => {
    state.accounts.findFirst.mockResolvedValue({ id: "account" });
    state.campaigns.create.mockResolvedValue({ id: "created" });
    state.campaigns.findFirst.mockResolvedValue({ id: "created", trackedLinks: [] });
    const response = await restCreate(new Request("https://example.test/api/v1/campaigns", {
      method: "POST", headers: writeHeaders, body: JSON.stringify({ ...campaignInput, trackedDestinationUrl: "https://example.test/offer" }),
    }));
    state.keys.findUnique.mockResolvedValue(key);
    expect(response.status).toBe(403);
    state.keys.findUnique.mockResolvedValue({ ...key, scopes: writer.scopes });
    const created = await restCreate(new Request("https://example.test/api/v1/campaigns", {
      method: "POST", headers: writeHeaders, body: JSON.stringify({ ...campaignInput, trackedDestinationUrl: "https://example.test/offer" }),
    }));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const data = state.campaigns.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "workspace", instagramAccountId: "account", isActive: false, postId: "post", keywords: ["LINK"] });
    expect(data.reportShareSlug).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(data.trackedLinks.create[0]).toMatchObject({ workspaceId: "workspace", destinationUrl: "https://example.test/offer", position: 0 });
    expect(state.campaigns.findFirst.mock.calls[0][0].where).toEqual({ id: "created", workspaceId: "workspace" });
    expect(state.campaigns.findFirst.mock.calls[0][0].select.reportShareSlug).toBeUndefined();
  });
  it("updates, toggles and deletes only workspace campaigns", async () => {
    state.keys.findUnique.mockResolvedValue({ ...key, scopes: writer.scopes });
    state.campaigns.findFirst.mockResolvedValue({ id: "campaign", instagramAccountId: "account", postId: "post", keywords: ["LINK"], matchAnyWord: false, matchAnyPost: false, pendingNextReel: false, openingDmEnabled: false, trackedLinks: [] });
    state.campaigns.update.mockResolvedValue({ id: "campaign" });
    const patched = await restPatch(new Request("https://example.test/api/v1/campaigns/campaign", { method: "PATCH", headers: writeHeaders, body: JSON.stringify({ isActive: true, dmMessage: "New" }) }), { params: Promise.resolve({ id: "campaign" }) });
    expect(patched.status).toBe(200);
    expect(state.campaigns.update.mock.calls[0][0]).toEqual({ where: { id: "campaign" }, data: { isActive: true, dmMessage: "New" } });
    await expect(updateCampaign(writer, "campaign", { keywords: [], matchAnyWord: false })).rejects.toMatchObject({ status: 400 });
    state.accounts.findFirst.mockResolvedValue(null);
    await expect(updateCampaign(writer, "campaign", { instagramAccountId: "foreign" })).rejects.toMatchObject({ status: 404 });
    state.campaigns.findFirst.mockResolvedValue(null);
    await expect(updateCampaign(writer, "foreign", { isActive: true })).rejects.toMatchObject({ status: 404 });

    state.campaigns.updateMany.mockResolvedValue({ count: 1 });
    expect(await callTool(writer, "toggle_campaign", { id: "campaign", isActive: false })).toEqual({ id: "campaign", isActive: false });
    expect(state.campaigns.updateMany.mock.calls[0][0]).toEqual({ where: { id: "campaign", workspaceId: "workspace" }, data: { isActive: false } });
    state.campaigns.updateMany.mockResolvedValue({ count: 0 });
    await expect(toggleCampaign(writer, "foreign", true)).rejects.toMatchObject({ status: 404 });

    await expect(callTool(writer, "delete_campaign", { id: "campaign" })).rejects.toMatchObject({ status: 400 });
    state.campaigns.deleteMany.mockResolvedValue({ count: 1 });
    expect(await callTool(writer, "delete_campaign", { id: "campaign", confirm: true })).toEqual({ id: "campaign", deleted: true });
    expect(state.campaigns.deleteMany.mock.calls[0][0]).toEqual({ where: { id: "campaign", workspaceId: "workspace" } });
    state.campaigns.deleteMany.mockResolvedValue({ count: 0 });
    expect((await restDelete(new Request("https://example.test/api/v1/campaigns/foreign", { method: "DELETE", headers: writeHeaders }), { params: Promise.resolve({ id: "foreign" }) })).status).toBe(404);
  });
  it("explains write access in MCP initialize instructions", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    expect((await (await mcp(request(init))).json()).result.instructions).toContain("read-only");
    state.keys.findUnique.mockResolvedValue({ ...key, scopes: writer.scopes });
    expect((await (await mcp(request(init))).json()).result.instructions).toContain("create_campaign");
  });
});

describe("account, post and log reads", () => {
  it("lists accounts without tokens", async () => {
    state.accounts.findMany.mockResolvedValue([]);
    await listInstagramAccounts(context);
    const query = state.accounts.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ workspaceId: "workspace" });
    expect(query.select.accessToken).toBeUndefined();
    expect(query.select.zernioAccountId).toBeUndefined();
  });
  it("reads posts only for a workspace account and hides provider errors", async () => {
    await expect(listInstagramPosts(context, {})).rejects.toMatchObject({ status: 400 });
    state.accounts.findFirst.mockResolvedValue(null);
    await expect(listInstagramPosts(context, { instagramAccountId: "foreign" })).rejects.toMatchObject({ status: 404 });
    state.accounts.findFirst.mockResolvedValue({ id: "account", username: "celeste", provider: "META", workspaceId: "workspace", zernioAccountId: null, instagramId: "1", accessToken: "secret" });
    state.instagram.mockResolvedValue({ provider: "META", accessToken: "secret" });
    state.media.mockResolvedValue([{ id: "post" }]);
    const result = await callTool(context, "list_instagram_posts", { instagramAccountId: "account", limit: 5 });
    expect(result).toEqual({ instagramAccountId: "account", username: "celeste", provider: "META", posts: [{ id: "post" }], limitations: [] });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(state.media).toHaveBeenCalledWith({ context: { provider: "META", accessToken: "secret" }, limit: 5 });
    state.media.mockRejectedValue(new Error("token secret leaked"));
    await expect(listInstagramPosts(context, { instagramAccountId: "account" })).rejects.toMatchObject({ status: 502, message: "Failed to fetch Instagram posts" });
  });
  it("pages workspace DM logs with validated filters", async () => {
    state.logs.findMany.mockResolvedValue([]);
    state.logs.count.mockResolvedValue(41);
    const response = await restLogs(new Request("https://example.test/api/v1/logs?status=SENT&limit=20&page=2&campaignId=campaign", { headers }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.pagination).toEqual({ page: 2, limit: 20, total: 41, totalPages: 3 });
    const query = state.logs.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ workspaceId: "workspace", status: "SENT", automationId: "campaign" });
    expect(query.skip).toBe(20);
    expect(query.select.instagramAccount).toEqual({ select: { username: true } });
    await expect(listDmLogs(context, { status: "NOPE" })).rejects.toMatchObject({ status: 400 });
    await expect(listDmLogs({ ...context, scopes: [] }, {})).rejects.toMatchObject({ status: 403 });
  });
});
