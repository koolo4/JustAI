import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { configureProxy, isPrivateNetworkHost, readProxySettings } from "../../../src/infrastructure/network/proxy.js";

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

describe("isPrivateNetworkHost", () => {
    it.each([
        ["192.168.1.50", true], ["10.0.0.7", true], ["172.16.4.2", true], ["172.31.255.1", true], ["169.254.10.1", true],
        ["127.0.0.1", true], ["localhost", true], ["desktop-pc2", true], ["pc2.local", true], ["[fe80::1]", true], ["fd12::3", true],
        ["172.32.0.1", false], ["8.8.8.8", false], ["api.groq.com", false], ["openrouter.ai", false], ["2001:db8::1", false],
    ])("%s → %s", (host, expected) => {
        expect(isPrivateNetworkHost(host)).toBe(expected);
    });
});

/** IPv4-адрес этого компьютера в локальной сети (если есть). */
function lanAddress(): string | undefined {
    return Object.values(os.networkInterfaces())
        .flat()
        .find(item => item && item.family === "IPv4" && !item.internal && isPrivateNetworkHost(item.address))?.address;
}

describe("configureProxy", () => {
    let server: http.Server | undefined;

    afterEach(async () => {
        configureProxy({});
        await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
        server = undefined;
    });

    it.skipIf(!lanAddress())("sends requests to the local network directly even when a proxy is set", async () => {
        server = http.createServer((_req, res) => res.end("direct"));
        await new Promise<void>(resolve => server!.listen(0, "0.0.0.0", resolve));
        const { port } = server.address() as AddressInfo;

        // Прокси заведомо недоступен: если бы запрос пошёл через него, fetch упал бы.
        configureProxy({ JUSTAI_PROXY: "http://127.0.0.1:9" });

        const response = await fetch(`http://${lanAddress()}:${port}/`);
        expect(await response.text()).toBe("direct");
    });
});
