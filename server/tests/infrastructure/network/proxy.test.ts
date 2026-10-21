import { describe, expect, it } from "vitest";

import { readProxySettings } from "../../../src/infrastructure/network/proxy.js";

describe("readProxySettings", () => {
    it("is off without JUSTAI_PROXY", () => {
        expect(readProxySettings({})).toBeUndefined();
        expect(readProxySettings({ JUSTAI_PROXY: "  " })).toBeUndefined();
    });

    it("adds http:// and always keeps local hosts direct", () => {
        const settings = readProxySettings({ JUSTAI_PROXY: "127.0.0.1:10809", JUSTAI_NO_PROXY: "intranet.local, " });

        expect(settings?.url).toBe("http://127.0.0.1:10809");
        expect(settings?.noProxy.split(",")).toEqual(["localhost", "127.0.0.1", "::1", "[::1]", "intranet.local"]);
    });

    it("rejects a malformed proxy address", () => {
        expect(() => readProxySettings({ JUSTAI_PROXY: "http://" })).toThrow();
    });
});
