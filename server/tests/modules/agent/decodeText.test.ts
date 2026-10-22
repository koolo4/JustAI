import { describe, expect, it } from "vitest";

import { decodeText } from "../../../src/modules/agent/tools/AgentFileSystem.js";

describe("decodeText", () => {
    const text = "function add(a, b) { return a + b }\r\n// Привет";

    it("reads UTF-8 as before", () => {
        expect(decodeText(Buffer.from(text, "utf8"))).toBe(text);
    });

    it("reads UTF-16 LE with BOM (Windows PowerShell 5.1 `echo > file`)", () => {
        const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
        expect(decodeText(buffer)).toBe(`﻿${text}`);
    });

    it("reads UTF-16 BE with BOM", () => {
        const le = Buffer.from(`﻿${text}`, "utf16le");
        const be = Buffer.from(le);
        be.swap16();
        expect(decodeText(be)).toBe(`﻿${text}`);
    });
});
