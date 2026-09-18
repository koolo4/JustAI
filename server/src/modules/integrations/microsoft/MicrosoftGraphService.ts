import { DocxDocument } from "./ZipDocument.js";
import { MicrosoftOAuthService } from "./MicrosoftOAuthService.js";

interface GraphDriveItem {
    id: string;
    name: string;
    size?: number;
    webUrl?: string;
    "@microsoft.graph.downloadUrl"?: string;
}

export class MicrosoftGraphService {

    constructor(
        private readonly oauth: MicrosoftOAuthService,
    ) {}

    private async request(
        url: string,
        init: RequestInit = {},
    ): Promise<Response> {
        const token =
            await this.oauth.getAccessToken();

        const headers = new Headers(
            init.headers,
        );

        headers.set(
            "Authorization",
            `Bearer ${token}`,
        );

        return fetch(
            url,
            {
                ...init,
                headers,
            },
        );
    }

    public async getItem(
        itemPath: string,
    ): Promise<GraphDriveItem> {
        const normalized =
            itemPath
                .replace(/^\/+/, "")
                .replace(/\/+$/, "");

        const encodedPath =
            normalized
                .split("/")
                .map(part => encodeURIComponent(part))
                .join("/");

        const response =
            await this.request(
                `https://graph.microsoft.com/v1.0/me/drive/root:/${encodedPath}`,
            );

        if (!response.ok) {
            throw new Error(
                `Microsoft Graph item lookup failed: ${response.status} ${await response.text()}`,
            );
        }

        return response.json() as Promise<GraphDriveItem>;
    }

    public async download(
        itemPath: string,
    ): Promise<Buffer> {
        const item =
            await this.getItem(
                itemPath,
            );

        if (item["@microsoft.graph.downloadUrl"]) {
            const response =
                await fetch(
                    item["@microsoft.graph.downloadUrl"],
                );

            if (!response.ok) {
                throw new Error(
                    `Microsoft file download failed: ${response.status}`,
                );
            }

            return Buffer.from(
                await response.arrayBuffer(),
            );
        }

        const response =
            await this.request(
                `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(item.id)}/content`,
            );

        if (!response.ok) {
            throw new Error(
                `Microsoft file download failed: ${response.status} ${await response.text()}`,
            );
        }

        return Buffer.from(
            await response.arrayBuffer(),
        );
    }

    public async replaceContent(
        itemId: string,
        content: Buffer,
    ): Promise<GraphDriveItem> {
        const response =
            await this.request(
                `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(itemId)}/content`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type":
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    },
                    body: content as unknown as BodyInit,
                },
            );

        if (!response.ok) {
            throw new Error(
                `Microsoft file upload failed: ${response.status} ${await response.text()}`,
            );
        }

        return response.json() as Promise<GraphDriveItem>;
    }

    public async replaceWordText(
        itemPath: string,
        find: string,
        replace: string,
    ): Promise<{
        item: GraphDriveItem;
        replacements: number;
    }> {
        if (!itemPath.toLowerCase().endsWith(".docx")) {
            throw new Error(
                "word_edit requires a .docx Word document.",
            );
        }

        const item =
            await this.getItem(itemPath);

        const archive =
            await this.download(itemPath);

        const document =
            new DocxDocument(archive);

        const result =
            document.replaceText(
                find,
                replace,
            );

        const updated =
            await this.replaceContent(
                item.id,
                result.archive,
            );

        return {
            item: updated,
            replacements:
                result.replacements,
        };
    }

    public async readWordText(
        itemPath: string,
    ): Promise<{
        item: GraphDriveItem;
        text: string;
    }> {
        if (!itemPath.toLowerCase().endsWith(".docx")) {
            throw new Error(
                "word_read requires a .docx Word document.",
            );
        }

        const item =
            await this.getItem(itemPath);

        const archive =
            await this.download(itemPath);

        const document =
            new DocxDocument(archive);

        return {
            item,
            text: document.getText(),
        };
    }

    public async createEditLink(
        itemId: string,
        scope:
            | "anonymous"
            | "organization" = "organization",
    ): Promise<string | null> {
        const response =
            await this.request(
                `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(itemId)}/createLink`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        type: "edit",
                        scope,
                    }),
                },
            );

        if (!response.ok) {
            return null;
        }

        const data =
            await response.json() as {
                link?: {
                    webUrl?: string;
                };
            };

        return data.link?.webUrl ?? null;
    }
}
