import { describe, expect, it } from "vitest";

import { applyMention, flattenPaths, mentionAt, rankPaths } from "./mentions";

describe("mentions", () => {
    const paths = flattenPaths([
        { name: "src", path: "src", type: "folder", children: [
            { name: "app.ts", path: "src/app.ts", type: "file" },
            { name: "api", path: "src/api", type: "folder", children: [{ name: "client.ts", path: "src/api/client.ts", type: "file" }] },
        ] },
        { name: "README.md", path: "README.md", type: "file" },
        { name: "My notes.md", path: "docs\\My notes.md", type: "file" },
    ]);

    it("flattens the tree with folders marked by a slash", () => {
        expect(paths).toEqual(["src/", "src/app.ts", "src/api/", "src/api/client.ts", "README.md", "docs/My notes.md"]);
    });

    it("finds the mention being typed and ignores e-mails", () => {
        expect(mentionAt("fix @src/ap", 11)).toEqual({ start: 4, query: "src/ap" });
        expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
        expect(mentionAt("mail a@b", 8)).toBeNull();
        expect(mentionAt("@src/app.ts done", 16)).toBeNull();
    });

    it("ranks file-name matches first", () => {
        expect(rankPaths(paths, "ap")).toEqual(["src/api/", "src/app.ts", "src/api/client.ts"]);
        expect(rankPaths(paths, "readme")).toEqual(["README.md"]);
    });

    it("inserts the path and quotes paths with spaces", () => {
        expect(applyMention("fix @ap please", 7, 4, "src/app.ts")).toEqual({ text: "fix @src/app.ts please", caret: 15 });
        expect(applyMention("@my", 3, 0, "docs/My notes.md")).toEqual({ text: '@"docs/My notes.md" ', caret: 20 });
        expect(applyMention("@sr", 3, 0, "src/").text).toBe("@src ");
    });
});
