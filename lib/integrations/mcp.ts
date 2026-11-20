import { z } from "zod";
import {
  createCampaign, createCampaignSchema, deleteCampaign, getCampaign, getCampaignStats, listCampaigns,
  listDmLogs, listInstagramAccounts, listInstagramPosts, toggleCampaign, updateCampaign, updateCampaignSchema,
} from "./campaigns";
import { requireScope, type ServiceContext, type ServiceScope } from "./auth";
import { ApiError } from "./http";

type JsonSchema = Record<string, unknown>;
type Annotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
type Tool = { name: string; description: string; inputSchema: JsonSchema; scope: ServiceScope; annotations: Annotations; run: (context: ServiceContext, args: unknown) => Promise<unknown> };

const read: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const id = { type: "string", minLength: 1, maxLength: 100 };
const idSchema = { type: "object", properties: { id }, required: ["id"], additionalProperties: false };
const idArgs = z.object({ id: z.string().min(1).max(100) }).strict();

/** JSON Schema generated from the same Zod schema that validates the call, so they cannot drift. */
function toSchema(schema: z.ZodType, extra?: { id?: boolean }): JsonSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  void _ignored;
  if (!extra?.id) return json;
  const properties = (json.properties ?? {}) as JsonSchema;
  const required = (json.required ?? []) as string[];
  return { ...json, properties: { id, ...properties }, required: ["id", ...required] };
}

function args<T extends z.ZodType>(schema: T, value: unknown, message = "Invalid tool arguments"): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    throw new ApiError(`${message}: ${details}`);
  }
  return parsed.data;
}

const updateArgs = updateCampaignSchema.extend({ id: z.string().min(1).max(100) }).strict();
const toggleArgs = z.object({ id: z.string().min(1).max(100), isActive: z.boolean() }).strict();
const deleteArgs = z.object({ id: z.string().min(1).max(100), confirm: z.literal(true) }).strict();

const tools: Tool[] = [
  { name: "list_campaigns", scope: "campaigns:read", annotations: read,
    description: "List up to 100 campaigns in this workspace; use get_campaign for complete settings and destination links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (context, value) => { args(z.object({}).strict(), value); return listCampaigns(context); } },
  { name: "get_campaign", scope: "campaigns:read", annotations: read,
    description: "Read campaign settings and ordered destination links. Missing links are null, not invented.",
    inputSchema: idSchema,
    run: (context, value) => getCampaign(context, args(idArgs, value, "Campaign id required").id) },
  { name: "get_campaign_stats", scope: "campaigns:read", annotations: read,
    description: "Read aggregate send outcomes and raw link requests, not recipient conversions.",
    inputSchema: idSchema,
    run: (context, value) => getCampaignStats(context, args(idArgs, value, "Campaign id required").id) },
  { name: "list_instagram_accounts", scope: "campaigns:read", annotations: read,
    description: "List the workspace's connected Instagram accounts (id, username, name, provider). Use the id as instagramAccountId; never guess it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (context, value) => { args(z.object({}).strict(), value); return listInstagramAccounts(context); } },
  { name: "list_instagram_posts", scope: "campaigns:read", annotations: { ...read, openWorldHint: true },
    description: "List recent posts and reels for one connected Instagram account, to pick a postId for a campaign. limit defaults to 25 (max 50); all=true pages up to 300.",
    inputSchema: { type: "object", properties: { instagramAccountId: id, limit: { type: "integer", minimum: 1, maximum: 50 }, all: { type: "boolean" } }, required: ["instagramAccountId"], additionalProperties: false },
    run: (context, value) => listInstagramPosts(context, value) },
  { name: "list_dm_logs", scope: "campaigns:read", annotations: read,
    description: "Page through DM delivery logs (newest first), optionally filtered by instagramAccountId, campaignId or status. limit defaults to 20 (max 50).",
    inputSchema: { type: "object", properties: {
      instagramAccountId: id, campaignId: id,
      status: { type: "string", enum: ["PENDING", "SENT", "FAILED", "SKIPPED_RATE_LIMIT", "SKIPPED_PLAN_LIMIT", "SKIPPED_DEDUP"] },
      page: { type: "integer", minimum: 1, maximum: 1000 }, limit: { type: "integer", minimum: 1, maximum: 50 },
    }, additionalProperties: false },
    run: (context, value) => listDmLogs(context, value) },
  { name: "create_campaign", scope: "campaigns:write", annotations: write,
    description: "Create a keyword comment-to-DM campaign on one Instagram account. instagramAccountId is required (from list_instagram_accounts). Target a postId (from list_instagram_posts), matchAnyPost or pendingNextReel. Campaigns start paused unless isActive is true.",
    inputSchema: toSchema(createCampaignSchema),
    run: (context, value) => createCampaign(context, value) },
  { name: "update_campaign", scope: "campaigns:write", annotations: { ...write, idempotentHint: true },
    description: "Update fields of an existing campaign by id. Omitted fields are unchanged; an empty string clears a tracked link URL.",
    inputSchema: toSchema(updateCampaignSchema, { id: true }),
    run: (context, value) => { const { id: campaignId, ...changes } = args(updateArgs, value); return updateCampaign(context, campaignId, changes); } },
  { name: "toggle_campaign", scope: "campaigns:write", annotations: { ...write, idempotentHint: true },
    description: "Activate (isActive=true) or pause (isActive=false) a campaign.",
    inputSchema: { type: "object", properties: { id, isActive: { type: "boolean" } }, required: ["id", "isActive"], additionalProperties: false },
    run: (context, value) => { const input = args(toggleArgs, value); return toggleCampaign(context, input.id, input.isActive); } },
  { name: "delete_campaign", scope: "campaigns:write", annotations: { ...write, destructiveHint: true, idempotentHint: true },
    description: "Permanently delete a campaign and its delivery logs and tracked links. Prefer toggle_campaign to pause. Requires confirm=true.",
    inputSchema: { type: "object", properties: { id, confirm: { type: "boolean", const: true } }, required: ["id", "confirm"], additionalProperties: false },
    run: (context, value) => deleteCampaign(context, args(deleteArgs, value, "Campaign id and confirm=true required").id) },
];

export function listTools(context: ServiceContext) {
  return tools.filter(tool => context.scopes.includes(tool.scope))
    .map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}

export async function callTool(context: ServiceContext, name: string, value: unknown) {
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new ApiError("Unknown tool", 404);
  // Checked here and again inside every helper: a read-only key can never reach a write.
  requireScope(context, tool.scope);
  return tool.run(context, value);
}
