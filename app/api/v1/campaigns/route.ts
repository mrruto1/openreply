import { z } from "zod";
import { authenticateService } from "@/lib/integrations/auth";
import { createCampaign, getCampaign, getCampaignStats, listCampaigns } from "@/lib/integrations/campaigns";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id !== null && !z.string().min(1).max(100).safeParse(id).success) throw new ApiError("Invalid campaign id");
    if (url.searchParams.has("stats") && !id) throw new ApiError("Campaign id required for stats");
    const data = id ? url.searchParams.has("stats") ? await getCampaignStats(context, id) : await getCampaign(context, id) : await listCampaigns(context);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

/** Create a campaign. Requires campaigns:write and an explicit instagramAccountId. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const data = await createCampaign(context, await readJson(request));
    return Response.json({ data }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
