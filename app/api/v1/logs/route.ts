import { authenticateService } from "@/lib/integrations/auth";
import { listDmLogs } from "@/lib/integrations/campaigns";
import { apiError, checkOrigin } from "@/lib/integrations/http";

const filters = ["instagramAccountId", "campaignId", "status", "page", "limit"] as const;

/** GET ?instagramAccountId=…&campaignId=…&status=SENT&page=1&limit=20 */
export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const params = new URL(request.url).searchParams;
    const query = Object.fromEntries(filters.flatMap(name => params.has(name) ? [[name, params.get(name)]] : []));
    return Response.json({ data: await listDmLogs(context, query) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
