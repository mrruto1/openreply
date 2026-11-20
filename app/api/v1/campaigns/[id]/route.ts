import { z } from "zod";
import { authenticateService } from "@/lib/integrations/auth";
import { deleteCampaign, getCampaign, updateCampaign } from "@/lib/integrations/campaigns";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

type Params = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

async function campaignId({ params }: Params) {
  const { id } = await params;
  if (!z.string().min(1).max(100).safeParse(id).success) throw new ApiError("Invalid campaign id");
  return id;
}

export async function GET(request: Request, route: Params) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    return Response.json({ data: await getCampaign(context, await campaignId(route)) }, { headers: noStore });
  } catch (error) { return apiError(error); }
}

/** Update any campaign fields; `{ "isActive": false }` pauses it. Requires campaigns:write. */
export async function PATCH(request: Request, route: Params) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const id = await campaignId(route);
    return Response.json({ data: await updateCampaign(context, id, await readJson(request)) }, { headers: noStore });
  } catch (error) { return apiError(error); }
}

/** Permanently delete a campaign. Requires campaigns:write. */
export async function DELETE(request: Request, route: Params) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    return Response.json({ data: await deleteCampaign(context, await campaignId(route)) }, { headers: noStore });
  } catch (error) { return apiError(error); }
}
