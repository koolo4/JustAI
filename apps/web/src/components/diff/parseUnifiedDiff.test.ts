import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "./parseUnifiedDiff";

const DIFF = [
    "diff --git a/src/math.js b/src/math.js",
    "index 1111111..2222222 100644",
    "--- a/src/math.js",
    "+++ b/src/math.js",
    "@@ -1,3 +1,6 @@",
    " function add(a, b) {",
    "   return a + b;",
    " }",
    "+function mul(a, b) {",
    "+  return a * b;",
    "+}",
    "@@ -10,2 +13,1 @@ module",
    "-module.exports = { add };",
    "-// old",
    "+module.exports = { add, mul };",
    "diff --git a/notes.md b/notes.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/notes.md",
    "@@ -0,0 +1 @@",
    "+hello",
    "\\ No newline at end of file",
    "diff --git a/logo.png b/logo.png",
    "Binary files a/logo.png and b/logo.png differ",
    "",
].join("\n");

describe("parseUnifiedDiff", () => {
    const files = parseUnifiedDiff(DIFF);

    it("splits files and counts changes", () => {
        expect(files.map(file => [file.path, file.added, file.removed, file.binary])).toEqual([
            ["src/math.js", 4, 2, false],
            ["notes.md", 1, 0, false],
            ["logo.png", 0, 0, true],
        ]);
    });

    it("numbers old and new lines across hunks", () => {
        const lines = files[0]!.lines;

        expect(lines[0]).toEqual({ kind: "hunk", text: "@@ -1,3 +1,6 @@" });
        expect(lines[1]).toEqual({ kind: "context", text: "function add(a, b) {", oldNumber: 1, newNumber: 1 });
        expect(lines[4]).toEqual({ kind: "added", text: "function mul(a, b) {", newNumber: 4 });
        expect(lines.find(line => line.kind === "removed")).toEqual({ kind: "removed", text: "module.exports = { add };", oldNumber: 10 });
        expect(lines.at(-1)).toEqual({ kind: "added", text: "module.exports = { add, mul };", newNumber: 13 });
    });

    it("handles CRLF and an empty diff", () => {
        expect(parseUnifiedDiff(DIFF.replace(/\n/g, "\r\n"))[0]!.added).toBe(4);
        expect(parseUnifiedDiff("")).toEqual([]);
    });
});
