import { authenticateService } from "@/lib/integrations/auth";
import { listInstagramAccounts } from "@/lib/integrations/campaigns";
import { apiError, checkOrigin } from "@/lib/integrations/http";

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    return Response.json({ data: await listInstagramAccounts(context) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
