import { Type } from "typebox";
import { callSlackRaw, resolveToken } from "../client.js";
import type { ToolFactory } from "../schemas.js";

export const identityTools = (tool: ToolFactory) => [
  tool({
    name: "slack_identity",
    label: "Inspect Slack token identity",
    description:
      "Report who a Slack token authenticates as and which OAuth scopes it was granted. Use to diagnose missing_scope or not_allowed_token_type errors.",
    parameters: Type.Object({
      tokenKind: Type.Optional(
        Type.Union([Type.Literal("bot"), Type.Literal("user")], {
          description: "Which configured token to inspect. Default: bot.",
        }),
      ),
    }),
    outputSchema: Type.Object(
      {
        tokenKind: Type.Union([Type.Literal("bot"), Type.Literal("user")]),
        team: Type.Union([Type.String(), Type.Null()]),
        identity: Type.Union([Type.String(), Type.Null()]),
        userId: Type.Union([Type.String(), Type.Null()]),
        scopeCount: Type.Integer(),
        scopes: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute({ tokenKind }, config, context) {
      context.signal?.throwIfAborted();
      const kind = tokenKind ?? "bot";
      const { data, scopes } = await callSlackRaw(
        "auth.test",
        resolveToken(config, kind),
        {},
        context,
      );
      return {
        tokenKind: kind,
        team: data.team ?? null,
        identity: data.user ?? null,
        userId: data.user_id ?? null,
        scopeCount: scopes.length,
        scopes,
      };
    },
  }),
];
