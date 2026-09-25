import { describe, expect, it } from "vitest";
import {
  HostToNodeMessageSchema,
  NodeToHostMessageSchema,
  SESSION_FILE_CHUNK_BYTES,
  SESSION_FILE_MAX_BYTES,
  SessionFileReadRequestSchema,
} from "./index.js";

describe("session file protocol", () => {
  const request = {
    requestId: "8c1f3a52-4bb9-4e0c-9d8f-8a2f0f3d6b11",
    sessionId: "session",
    path: "docs/report.docx",
    roots: ["C:\\work\\repo"],
    offset: 0,
    length: SESSION_FILE_CHUNK_BYTES,
  };

  it("fills the optional fields a Host may omit", () => {
    expect(SessionFileReadRequestSchema.parse(request)).toEqual({
      ...request,
      protectedRoots: [],
      agentSessionId: "",
      coordinator: false,
      version: "",
    });
  });

  it("carries reads to the Node and one answer back", () => {
    const read = HostToNodeMessageSchema.parse({ type: "session_file_read", request });
    expect(read.type).toBe("session_file_read");
    const data = {
      type: "session_file_data",
      result: {
        requestId: request.requestId,
        ok: true,
        path: "C:\\work\\repo\\docs\\report.docx",
        name: "report.docx",
        size: 3,
        modifiedAt: "2026-09-01T00:00:00.000Z",
        version: "1:2:3:4",
        offset: 0,
        data: Buffer.from("abc").toString("base64"),
      },
    };
    expect(NodeToHostMessageSchema.parse(data)).toEqual(data);
    const refusal = {
      type: "session_file_data",
      result: {
        requestId: request.requestId,
        ok: false,
        code: "forbidden",
        error: "Outside the session's folders",
      },
    };
    expect(NodeToHostMessageSchema.parse(refusal)).toEqual(refusal);
  });

  it.each([
    { path: "" },
    { path: "C:\\work\\a\0b" },
    { length: SESSION_FILE_CHUNK_BYTES + 1 },
    { offset: SESSION_FILE_MAX_BYTES + 1 },
    { offset: -1 },
    { requestId: "not-a-uuid" },
  ])("refuses a read of %j", (change) => {
    expect(
      SessionFileReadRequestSchema.safeParse({ ...request, ...change }).success,
    ).toBe(false);
  });

  it("refuses a chunk larger than one read, and an unknown refusal", () => {
    const oversized = {
      type: "session_file_data",
      result: {
        requestId: request.requestId,
        ok: true,
        path: "/tmp/a",
        name: "a",
        size: 1,
        modifiedAt: "2026-09-01T00:00:00.000Z",
        version: "v",
        offset: 0,
        data: "A".repeat(Math.ceil(SESSION_FILE_CHUNK_BYTES / 3) * 4 + 4),
      },
    };
    expect(NodeToHostMessageSchema.safeParse(oversized).success).toBe(false);
    expect(
      NodeToHostMessageSchema.safeParse({
        type: "session_file_data",
        result: { requestId: request.requestId, ok: false, code: "nope", error: "" },
      }).success,
    ).toBe(false);
  });
});
