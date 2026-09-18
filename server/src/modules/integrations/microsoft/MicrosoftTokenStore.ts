import { promises as fs } from "node:fs";
import path from "node:path";
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from "node:crypto";

interface StoredToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    account?: string;
}

export class MicrosoftTokenStore {

    private readonly filePath: string;
    private readonly key: Buffer;

    constructor(
        workspaceRoot: string,
    ) {
        this.filePath = path.join(
            workspaceRoot,
            ".justai",
            "microsoft-token.json",
        );

        const secret =
            process.env.JUSTAI_ENCRYPTION_KEY ||
            "development-only-change-this-secret";

        this.key =
            createHash("sha256")
                .update(secret)
                .digest();
    }

    public async save(token: StoredToken): Promise<void> {
        await fs.mkdir(
            path.dirname(this.filePath),
            { recursive: true },
        );

        const iv = randomBytes(12);
        const cipher = createCipheriv(
            "aes-256-gcm",
            this.key,
            iv,
        );

        const plaintext = Buffer.from(
            JSON.stringify(token),
            "utf8",
        );

        const encrypted = Buffer.concat([
            cipher.update(plaintext),
            cipher.final(),
        ]);

        const tag = cipher.getAuthTag();

        await fs.writeFile(
            this.filePath,
            JSON.stringify({
                iv: iv.toString("base64"),
                tag: tag.toString("base64"),
                data: encrypted.toString("base64"),
            }),
            "utf8",
        );
    }

    public async load(): Promise<StoredToken | null> {
        try {
            const raw = await fs.readFile(
                this.filePath,
                "utf8",
            );

            const record = JSON.parse(raw) as {
                iv: string;
                tag: string;
                data: string;
            };

            const decipher = createDecipheriv(
                "aes-256-gcm",
                this.key,
                Buffer.from(record.iv, "base64"),
            );

            decipher.setAuthTag(
                Buffer.from(record.tag, "base64"),
            );

            const plaintext = Buffer.concat([
                decipher.update(
                    Buffer.from(record.data, "base64"),
                ),
                decipher.final(),
            ]);

            return JSON.parse(
                plaintext.toString("utf8"),
            ) as StoredToken;
        }
        catch {
            return null;
        }
    }

    public async clear(): Promise<void> {
        await fs.rm(
            this.filePath,
            { force: true },
        );
    }
}

export type { StoredToken };
