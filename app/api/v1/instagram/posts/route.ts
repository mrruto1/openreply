import { authenticateService } from "@/lib/integrations/auth";
import { listInstagramPosts } from "@/lib/integrations/campaigns";
import { apiError, checkOrigin } from "@/lib/integrations/http";

/** GET ?instagramAccountId=…&limit=25 or &all=true */
export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const params = new URL(request.url).searchParams;
    const data = await listInstagramPosts(context, {
      instagramAccountId: params.get("instagramAccountId") ?? undefined,
      ...(params.has("limit") ? { limit: params.get("limit") } : {}),
      ...(params.has("all") ? { all: params.get("all") === "true" } : {}),
    });
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
