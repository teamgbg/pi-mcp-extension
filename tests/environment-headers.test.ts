import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveRequestHeaders } from "../src/environment-headers.js";

describe("environment-resolved HTTP headers", () => {
  it("combines static and environment-resolved headers without mutating config", () => {
    const config = {
      headers: { "X-Static": "value" },
      headersFromEnv: {
        Authorization: { env: "MCP_TOKEN", prefix: "Bearer " },
      },
    };

    assert.deepEqual(resolveRequestHeaders("scala-mcp", config, { MCP_TOKEN: "secret" }), {
      "X-Static": "value",
      Authorization: "Bearer secret",
    });
    assert.deepEqual(config.headersFromEnv.Authorization, {
      env: "MCP_TOKEN",
      prefix: "Bearer ",
    });
  });

  it("fails closed when a referenced environment variable is absent", () => {
    assert.throws(
      () =>
        resolveRequestHeaders(
          "scala-mcp",
          { headersFromEnv: { Authorization: { env: "MISSING_TOKEN" } } },
          {},
        ),
      /MISSING_TOKEN.*required.*Authorization/,
    );
  });

  it("returns undefined when no headers are configured", () => {
    assert.equal(resolveRequestHeaders("public", {}, {}), undefined);
  });
});
