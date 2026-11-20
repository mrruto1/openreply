import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { DmStatus } from "@/app/generated/prisma/client";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { buildInitialCampaignLinks, syncCampaignLinks } from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";
import { createInstagramContext, getAllUserMedia, getUserMedia } from "@/lib/instagram/provider";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";

const summarySelect = {
  id: true, name: true, goal: true, instagramAccountId: true, isActive: true,
  postId: true, postUrl: true, pendingNextReel: true, matchAnyPost: true,
  keywords: true, matchAnyWord: true, dmMessage: true, createdAt: true, updatedAt: true,
} as const;

export async function listCampaigns(context: ServiceContext) {
  requireScope(context, "campaigns:read");
  return prisma.automation.findMany({
    where: { workspaceId: context.workspaceId }, select: summarySelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100,
  });
}

/** Safe detail projection shared by reads and write responses. Never selects tokens or report slugs. */
async function readCampaign(workspaceId: string, id: string) {
  const campaign = await prisma.automation.findFirst({
    where: { id, workspaceId },
    select: {
      ...summarySelect, wholeWordMatch: true, dmTriggerEnabled: true,
      openingDmEnabled: true, openingDmMessage: true, openingDmButtonLabel: true,
      linkButtonLabel: true, requireFollow: true, followPromptMessage: true,
      followPromptButtonLabel: true, followUpEnabled: true, followUpMessage: true,
      followUpDelayMinutes: true, publicReplyEnabled: true, publicReplyMessage: true,
      publicReplyMessages: true,
      trackedLinks: {
        where: { workspaceId }, orderBy: TRACKED_LINK_ORDER,
        select: { destinationUrl: true, label: true, position: true },
      },
    },
  });
  if (!campaign) throw new ApiError("Campaign not found", 404);
  const [primary, secondary] = campaign.trackedLinks;
  return {
    ...campaign, trackedDestinationUrl: primary?.destinationUrl ?? null,
    secondaryDestinationUrl: secondary?.destinationUrl ?? null,
    secondaryButtonLabel: secondary?.label ?? null,
  };
}

export async function getCampaign(context: ServiceContext, id: string) {
  requireScope(context, "campaigns:read");
  return readCampaign(context.workspaceId, id);
}

export async function getCampaignStats(context: ServiceContext, id: string) {
  await getCampaign(context, id);
  const [statuses, rawClicks] = await Promise.all([
    prisma.dmLog.groupBy({ by: ["status"], where: { workspaceId: context.workspaceId, automationId: id }, _count: { _all: true } }),
    prisma.linkClick.count({ where: { workspaceId: context.workspaceId, automationId: id } }),
  ]);
  return { campaignId: id, statuses, rawClicks, note: "Raw link requests include previews and repeated clicks; not unique recipients." };
}

// ---------------------------------------------------------------------------
// Write access (campaigns:write). Mirrors app/api/automations/route.ts, with two
// deliberate differences for unattended agents: the Instagram account must be
// named explicitly (never "the most recently connected one"), and new campaigns
// start paused unless isActive is set, so an approval step can switch them on.
// ---------------------------------------------------------------------------

const entityId = z.string().min(1).max(100);
const linkUrl = z.union([z.string().url(), z.literal("")]).optional().nullable();

const campaignShape = {
  name: z.string().min(1).max(100),
  goal: z.string().min(1).max(120).optional().nullable(),
  postId: z.string().min(1).max(200).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  trackedDestinationUrl: linkUrl,
  secondaryDestinationUrl: linkUrl,
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
};

export const createCampaignSchema = z.object({ ...campaignShape, instagramAccountId: entityId }).strict();

export const updateCampaignSchema = z.object({
  ...campaignShape,
  name: campaignShape.name.optional(),
  dmMessage: campaignShape.dmMessage.optional(),
  instagramAccountId: entityId.optional(),
  reportShareEnabled: z.boolean().optional(),
}).strict();

export type CreateCampaignInput = z.input<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.input<typeof updateCampaignSchema>;

function invalid(error: z.ZodError, prefix: string): never {
  const details = error.issues.slice(0, 5).map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  throw new ApiError(`${prefix}: ${details}`);
}

type TargetState = {
  postId?: string | null; pendingNextReel?: boolean; matchAnyPost?: boolean;
  keywords?: string[]; matchAnyWord?: boolean; openingDmEnabled?: boolean;
  openingDmMessage?: string | null; openingDmButtonLabel?: string | null;
};

/** The same rules the dashboard enforces, applied to the final saved state. */
function assertCampaignRules(state: TargetState) {
  if (!state.matchAnyPost && !state.pendingNextReel && !state.postId) {
    throw new ApiError("Choose which post(s) trigger the campaign: postId, matchAnyPost or pendingNextReel");
  }
  if (!state.matchAnyWord && !(state.keywords?.length)) throw new ApiError("Add at least one keyword, or set matchAnyWord");
  if (state.openingDmEnabled && (!state.openingDmMessage?.trim() || !state.openingDmButtonLabel?.trim())) {
    throw new ApiError("Opening DM needs openingDmMessage and openingDmButtonLabel");
  }
}

async function requireWorkspaceAccount(workspaceId: string, instagramAccountId: string) {
  const account = await prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId }, select: { id: true },
  });
  if (!account) throw new ApiError("Instagram account not found", 404);
  return account;
}

export async function createCampaign(context: ServiceContext, input: unknown) {
  requireScope(context, "campaigns:write");
  const parsed = createCampaignSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error, "Invalid campaign");
  const data = parsed.data;
  const pendingNextReel = data.pendingNextReel ?? false;
  const matchAnyPost = data.matchAnyPost ?? false;
  const matchAnyWord = data.matchAnyWord ?? false;
  const openingDmEnabled = data.openingDmEnabled ?? false;
  const requireFollow = data.requireFollow ?? false;
  const followUpEnabled = data.followUpEnabled ?? false;
  const publicReplyEnabled = data.publicReplyEnabled ?? false;
  const keywords = matchAnyWord ? [] : (data.keywords ?? []).map(k => k.trim()).filter(Boolean);
  assertCampaignRules({ ...data, pendingNextReel, matchAnyPost, matchAnyWord, keywords, openingDmEnabled });

  const account = await requireWorkspaceAccount(context.workspaceId, data.instagramAccountId);
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = ((data.publicReplyMessages?.length ?? 0) > 0
    ? data.publicReplyMessages ?? []
    : data.publicReplyMessage ? [data.publicReplyMessage] : [])
    .map(m => m.trim()).filter(Boolean);
  const linkCreates = buildInitialCampaignLinks({
    workspaceId: context.workspaceId, primaryUrl: data.trackedDestinationUrl,
    secondaryUrl: data.secondaryDestinationUrl, secondaryLabel: data.secondaryButtonLabel,
  });

  const created = await prisma.automation.create({
    data: {
      name: data.name,
      goal: data.goal,
      postId: isSpecificPost ? data.postId : null,
      postUrl: isSpecificPost ? data.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      keywords,
      matchAnyWord,
      dmTriggerEnabled: data.dmTriggerEnabled ?? false,
      dmMessage: data.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled ? data.openingDmMessage || null : null,
      openingDmButtonLabel: openingDmEnabled ? data.openingDmButtonLabel || null : null,
      linkButtonLabel: data.linkButtonLabel || null,
      requireFollow,
      followPromptMessage: requireFollow ? data.followPromptMessage || null : null,
      followPromptButtonLabel: requireFollow ? data.followPromptButtonLabel || null : null,
      followUpEnabled,
      followUpMessage: followUpEnabled ? data.followUpMessage || null : null,
      followUpDelayMinutes: followUpEnabled ? data.followUpDelayMinutes ?? 0 : 0,
      publicReplyEnabled,
      publicReplyMessages: publicReplyEnabled ? publicReplyList : [],
      publicReplyMessage: publicReplyEnabled ? publicReplyList[0] ?? null : null,
      // Paused by default: an agent creates the campaign, an approval turns it on.
      isActive: data.isActive ?? false,
      wholeWordMatch: data.wholeWordMatch ?? true,
      workspaceId: context.workspaceId,
      instagramAccountId: account.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0 ? { trackedLinks: { create: linkCreates } } : {}),
    },
    select: { id: true },
  });
  return readCampaign(context.workspaceId, created.id);
}

export async function updateCampaign(context: ServiceContext, id: string, input: unknown) {
  requireScope(context, "campaigns:write");
  const parsed = updateCampaignSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error, "Invalid campaign update");
  const existing = await prisma.automation.findFirst({ where: { id, workspaceId: context.workspaceId } });
  if (!existing) throw new ApiError("Campaign not found", 404);

  const { trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel, ...changes } = parsed.data;
  if (changes.instagramAccountId !== undefined && changes.instagramAccountId !== existing.instagramAccountId) {
    await requireWorkspaceAccount(context.workspaceId, changes.instagramAccountId);
  }
  // Keep dependent fields consistent, exactly like the dashboard PATCH.
  if (changes.keywords !== undefined) changes.keywords = changes.keywords.map(k => k.trim()).filter(Boolean);
  if (changes.matchAnyWord === true) changes.keywords = [];
  if (changes.openingDmEnabled === false) { changes.openingDmMessage = null; changes.openingDmButtonLabel = null; }
  if (changes.requireFollow === false) { changes.followPromptMessage = null; changes.followPromptButtonLabel = null; }
  if (changes.followUpEnabled === false) { changes.followUpMessage = null; changes.followUpDelayMinutes = 0; }
  if (changes.matchAnyPost === true || changes.pendingNextReel === true) { changes.postId = null; changes.postUrl = null; }
  if (changes.publicReplyMessages !== undefined) {
    const list = changes.publicReplyMessages.map(m => m.trim()).filter(Boolean);
    changes.publicReplyMessages = list;
    changes.publicReplyMessage = list[0] ?? null;
  }
  if (changes.publicReplyEnabled === false) { changes.publicReplyMessages = []; changes.publicReplyMessage = null; }
  assertCampaignRules({ ...existing, ...changes });

  await prisma.$transaction(async (tx) => {
    // Updating the campaign first locks its row, so concurrent saves serialize.
    await tx.automation.update({ where: { id: existing.id }, data: changes });
    await syncCampaignLinks(tx, {
      workspaceId: context.workspaceId, automationId: existing.id,
      primaryUrl: trackedDestinationUrl, secondaryUrl: secondaryDestinationUrl, secondaryLabel: secondaryButtonLabel,
    });
  });
  return readCampaign(context.workspaceId, existing.id);
}

export async function toggleCampaign(context: ServiceContext, id: string, isActive: boolean) {
  requireScope(context, "campaigns:write");
  const result = await prisma.automation.updateMany({ where: { id, workspaceId: context.workspaceId }, data: { isActive } });
  if (!result.count) throw new ApiError("Campaign not found", 404);
  return { id, isActive };
}

export async function deleteCampaign(context: ServiceContext, id: string) {
  requireScope(context, "campaigns:write");
  const result = await prisma.automation.deleteMany({ where: { id, workspaceId: context.workspaceId } });
  if (!result.count) throw new ApiError("Campaign not found", 404);
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Read helpers for agents choosing an account, a post, and reviewing delivery.
// ---------------------------------------------------------------------------

export async function listInstagramAccounts(context: ServiceContext) {
  requireScope(context, "campaigns:read");
  return prisma.instagramAccount.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: [{ connectedAt: "desc" }, { id: "asc" }],
    // Explicit whitelist: access tokens and provider ids never leave the server.
    select: { id: true, username: true, name: true, instagramId: true, provider: true, connectedAt: true },
  });
}

export const listInstagramPostsSchema = z.object({
  instagramAccountId: entityId,
  limit: z.coerce.number().int().min(1).max(50).optional(),
  all: z.boolean().optional(),
}).strict();

export async function listInstagramPosts(context: ServiceContext, input: unknown) {
  requireScope(context, "campaigns:read");
  const parsed = listInstagramPostsSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error, "Invalid post query");
  const account = await prisma.instagramAccount.findFirst({
    where: { id: parsed.data.instagramAccountId, workspaceId: context.workspaceId },
    select: { id: true, username: true, provider: true, workspaceId: true, zernioAccountId: true, instagramId: true, accessToken: true },
  });
  if (!account) throw new ApiError("Instagram account not found", 404);
  let posts;
  try {
    const instagram = await createInstagramContext(account);
    posts = parsed.data.all
      ? await getAllUserMedia({ context: instagram, max: 300 })
      : await getUserMedia({ context: instagram, limit: parsed.data.limit ?? 25 });
  } catch {
    // Provider errors can echo request details; never forward them.
    throw new ApiError("Failed to fetch Instagram posts", 502);
  }
  return {
    instagramAccountId: account.id, username: account.username, provider: account.provider, posts,
    limitations: account.provider === "ZERNIO" ? ["Zernio returns the 25 most recent Instagram posts."] : [],
  };
}

export const listDmLogsSchema = z.object({
  instagramAccountId: entityId.optional(),
  campaignId: entityId.optional(),
  status: z.enum(DmStatus).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

export async function listDmLogs(context: ServiceContext, input: unknown) {
  requireScope(context, "campaigns:read");
  const parsed = listDmLogsSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error, "Invalid log query");
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 20;
  const where = {
    workspaceId: context.workspaceId,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.instagramAccountId ? { instagramAccountId: parsed.data.instagramAccountId } : {}),
    ...(parsed.data.campaignId ? { automationId: parsed.data.campaignId } : {}),
  };
  const [logs, total] = await Promise.all([
    prisma.dmLog.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit,
      select: {
        id: true, automationId: true, instagramAccountId: true, commenterId: true, commenterName: true,
        commentText: true, commentId: true, matchedKeyword: true, status: true, attempts: true,
        dmSentAt: true, errorMessage: true, publicReplySentAt: true, publicReplyError: true, createdAt: true,
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    prisma.dmLog.count({ where }),
  ]);
  return { logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
