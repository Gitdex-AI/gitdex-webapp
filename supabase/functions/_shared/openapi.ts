// OpenAPI 3.1 document generated from the operation registry.

import { ERROR_CODES, ERROR_HTTP_STATUS } from "./errors.ts";
import { CONFIRMED_SCHEMA, IDEMPOTENCY_SCHEMA, OPERATIONS } from "./operations.ts";

export function buildOpenApi(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPERATIONS) {
    const pathParams = [...op.rest.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const inQuery = op.rest.method === "GET" || op.rest.method === "DELETE";
    const parameters: unknown[] = pathParams.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
      description: (op.properties[name]?.description as string | undefined) ?? name,
    }));
    const bodyProps: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(op.properties)) {
      if (pathParams.includes(name)) continue;
      if (inQuery) {
        const isArray = schema.type === "array";
        parameters.push({
          name: name === "query" ? "q" : name,
          in: "query",
          required: op.required.includes(name),
          description: schema.description,
          schema: isArray ? { type: "string", description: "Comma-separated list." } : { ...schema, description: undefined },
        });
      } else {
        bodyProps[name] = schema;
      }
    }
    if (op.idempotent) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 8, maxLength: 200 },
        description: IDEMPOTENCY_SCHEMA.description,
      });
    }
    if (op.confirm) bodyProps.confirmed = CONFIRMED_SCHEMA;

    const errorCodes = new Set<string>(["VALIDATION_FAILED", "RATE_LIMITED", "NOT_FOUND"]);
    if (op.access === "user") {
      errorCodes.add("AUTH_REQUIRED");
      errorCodes.add("FORBIDDEN");
    }
    if (op.confirm) errorCodes.add("CONFIRMATION_REQUIRED");
    if (op.kind === "write") {
      errorCodes.add("DUPLICATE_CANDIDATE");
      errorCodes.add("CONFLICT");
      errorCodes.add("INVALID_STATE");
    }
    const responses: Record<string, unknown> = {
      "200": { description: "Success", content: { "application/json": { schema: { type: "object" } } } },
    };
    const byStatus = new Map<number, string[]>();
    for (const code of errorCodes) {
      const status = ERROR_HTTP_STATUS[code as keyof typeof ERROR_HTTP_STATUS];
      byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
    }
    for (const [status, codes] of [...byStatus].sort((a, b) => a[0] - b[0])) {
      responses[String(status)] = {
        description: codes.join(" / "),
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      };
    }

    const hasBody = !inQuery && Object.keys(bodyProps).length > 0;
    const requiredBody = op.required.filter((name) => name in bodyProps);
    paths[op.rest.path] ??= {};
    paths[op.rest.path][op.rest.method.toLowerCase()] = {
      operationId: op.name,
      summary: op.title,
      description: op.description,
      tags: [op.rest.path.split("/")[1]],
      ...(op.access === "user" ? { security: [{ bearerAuth: [] }] } : { security: [] }),
      ...(parameters.length ? { parameters } : {}),
      ...(hasBody
        ? {
          requestBody: {
            required: requiredBody.length > 0,
            content: {
              "application/json": {
                schema: { type: "object", properties: bodyProps, ...(requiredBody.length ? { required: requiredBody } : {}) },
              },
            },
          },
        }
        : {}),
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "GitDex API",
      version: "1.0.0",
      description:
        "Software demand & solution network. Reads are public; writes need a signed-in account, an Idempotency-Key header, and (for publishing operations) `confirmed: true` after the user approved the preview returned by a call without it. GitDex runs no AI model. Agent guide: " +
        `${baseUrl}/ai/guide.md`,
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A GitDex personal API token (gdx_...) from /account, or an OAuth access token.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "recovery"],
              properties: {
                code: { type: "string", enum: ERROR_CODES },
                message: { type: "string" },
                recovery: { type: "string", description: "What a client or agent should do next." },
                details: { type: "object", description: "Code-specific data, e.g. preview, candidates, fields." },
              },
            },
          },
        },
      },
    },
  };
}
