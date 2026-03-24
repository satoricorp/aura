import { anyApi, httpActionGeneric, httpRouter } from "convex/server";

const http = httpRouter();

http.route({
  path: "/auth/exchange-google-login",
  method: "POST",
  handler: httpActionGeneric(async (ctx, request) => {
    return handleJsonRoute(request, async (body) => {
      const result = await ctx.runAction(anyApi.authActions.exchangeGoogleLogin, body);
      return jsonResponse(result);
    });
  }),
});

http.route({
  path: "/auth/refresh-session",
  method: "POST",
  handler: httpActionGeneric(async (ctx, request) => {
    return handleJsonRoute(request, async (body) => {
      const result = await ctx.runAction(anyApi.authActions.refreshSession, body);
      return jsonResponse(result);
    });
  }),
});

http.route({
  path: "/auth/logout-session",
  method: "POST",
  handler: httpActionGeneric(async (ctx, request) => {
    return handleJsonRoute(request, async (body) => {
      await ctx.runAction(anyApi.authActions.logoutSession, body);
      return new Response(null, { status: 204 });
    });
  }),
});

export default http;

async function handleJsonRoute(
  request: Request,
  handler: (body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return handler(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected auth route failure.";
    return jsonResponse({ error: message }, 400);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
