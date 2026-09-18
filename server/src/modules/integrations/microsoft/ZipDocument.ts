import { deflateRawSync, inflateRawSync } from "node:zlib";

interface ZipEntry {
    name: string;
    method: number;
    flags: number;
    crc: number;
    compressed: Buffer;
    uncompressedSize: number;
    versionMadeBy: number;
    versionNeeded: number;
    externalAttributes: number;
}

function readUInt16(buffer: Buffer, offset: number): number {
    return buffer.readUInt16LE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
    return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
        if (readUInt32(buffer, i) === 0x06054b50) {
            return i;
        }
    }
    throw new Error("Invalid ZIP: end of central directory was not found.");
}

function parseZip(buffer: Buffer): ZipEntry[] {
    const eocd = findEndOfCentralDirectory(buffer);
    const count = readUInt16(buffer, eocd + 10);
    const centralOffset = readUInt32(buffer, eocd + 16);

    const entries: ZipEntry[] = [];
    let cursor = centralOffset;

    for (let i = 0; i < count; i += 1) {
        if (readUInt32(buffer, cursor) !== 0x02014b50) {
            throw new Error("Invalid ZIP: central directory entry is malformed.");
        }

        const versionMadeBy = readUInt16(buffer, cursor + 4);
        const versionNeeded = readUInt16(buffer, cursor + 6);
        const flags = readUInt16(buffer, cursor + 8);
        const method = readUInt16(buffer, cursor + 10);
        const crc = readUInt32(buffer, cursor + 16);
        const compressedSize = readUInt32(buffer, cursor + 20);
        const uncompressedSize = readUInt32(buffer, cursor + 24);
        const nameLength = readUInt16(buffer, cursor + 28);
        const extraLength = readUInt16(buffer, cursor + 30);
        const commentLength = readUInt16(buffer, cursor + 32);
        const externalAttributes = readUInt32(buffer, cursor + 38);
        const localOffset = readUInt32(buffer, cursor + 42);

        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new Error("ZIP64 DOCX files are not supported by the built-in editor.");
        }

        const name = buffer.subarray(
            cursor + 46,
            cursor + 46 + nameLength,
        ).toString("utf8");

        if (readUInt32(buffer, localOffset) !== 0x04034b50) {
            throw new Error(`Invalid ZIP local header for ${name}.`);
        }

        const localNameLength = readUInt16(buffer, localOffset + 26);
        const localExtraLength = readUInt16(buffer, localOffset + 28);
        const dataStart =
            localOffset +
            30 +
            localNameLength +
            localExtraLength;

        const compressed = Buffer.from(
            buffer.subarray(
                dataStart,
                dataStart + compressedSize,
            ),
        );

        entries.push({
            name,
            method,
            flags,
            crc,
            compressed,
            uncompressedSize,
            versionMadeBy,
            versionNeeded,
            externalAttributes,
        });

        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

function entryContent(entry: ZipEntry): Buffer {
    if (entry.method === 0) {
        return Buffer.from(entry.compressed);
    }

    if (entry.method === 8) {
        return inflateRawSync(entry.compressed);
    }

    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`);
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function xmlDecode(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function crc32(buffer: Buffer): number {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            const mask = -(crc & 1);
            crc = (crc >>> 1) ^ (0xedb88320 & mask);
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function makeLocalHeader(entry: ZipEntry, compressedSize: number, uncompressedSize: number, crc: number): Buffer {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30 + name.length);

    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(entry.versionNeeded, 4);
    header.writeUInt16LE(entry.flags & ~0x0008, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressedSize, 18);
    header.writeUInt32LE(uncompressedSize, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    name.copy(header, 30);

    return header;
}

function makeCentralHeader(
    entry: ZipEntry,
    compressedSize: number,
    uncompressedSize: number,
    crc: number,
    localOffset: number,
): Buffer {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(46 + name.length);

    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.versionMadeBy, 4);
    header.writeUInt16LE(entry.versionNeeded, 6);
    header.writeUInt16LE(entry.flags & ~0x0008, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressedSize, 20);
    header.writeUInt32LE(uncompressedSize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(entry.externalAttributes, 38);
    header.writeUInt32LE(localOffset, 42);
    name.copy(header, 46);

    return header;
}

function buildZip(entries: Array<{ entry: ZipEntry; content: Buffer }>): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const item of entries) {
        const entry = item.entry;
        const raw = item.content;
        const compressed =
            entry.method === 8
                ? deflateRawSync(raw)
                : raw;

        const crc = crc32(raw);
        const local = makeLocalHeader(
            entry,
            compressed.length,
            raw.length,
            crc,
        );

        localParts.push(local, compressed);

        centralParts.push(
            makeCentralHeader(
                entry,
                compressed.length,
                raw.length,
                crc,
                offset,
            ),
        );

        offset += local.length + compressed.length;
    }

    const central = Buffer.concat(centralParts);
    const locals = Buffer.concat(localParts);
    const eocd = Buffer.alloc(22);

    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(locals.length, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([locals, central, eocd]);
}

export class DocxDocument {

    private readonly entries: ZipEntry[];

    constructor(
        private readonly archive: Buffer,
    ) {
        this.entries = parseZip(archive);
    }

    public getText(): string {
        const document = this.findEntry("word/document.xml");
        const xml = entryContent(document).toString("utf8");

        const parts: string[] = [];
        const token = /<w:(?:t|tab|br)\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;

        let match: RegExpExecArray | null;
        while ((match = token.exec(xml)) !== null) {
            if (match[0].startsWith("<w:tab")) {
                parts.push("\t");
            }
            else if (match[0].startsWith("<w:br")) {
                parts.push("\n");
            }
            else {
                parts.push(xmlDecode(match[1] ?? ""));
            }
        }

        return parts.join("");
    }

    public replaceText(
        find: string,
        replace: string,
    ): { archive: Buffer; replacements: number } {

        if (!find) {
            throw new Error("The find text cannot be empty.");
        }

        const document = this.findEntry("word/document.xml");
        const xml = entryContent(document).toString("utf8");

        const direct = xml.split(xmlEscape(find)).length - 1;

        if (direct === 1) {
            const updatedXml =
                xml.replace(
                    xmlEscape(find),
                    xmlEscape(replace),
                );

            return {
                archive: this.rebuild(updatedXml),
                replacements: 1,
            };
        }

        if (direct > 1) {
            throw new Error(`The requested text occurs ${direct} times. Refusing an ambiguous edit.`);
        }

        throw new Error(
            "The requested text was not found as one contiguous Word text run. Use a more specific phrase or edit the document in Word.",
        );
    }

    private findEntry(name: string): ZipEntry {
        const entry = this.entries.find(item => item.name === name);

        if (!entry) {
            throw new Error(`DOCX entry ${name} was not found.`);
        }

        return entry;
    }

    private rebuild(documentXml: string): Buffer {
        return buildZip(
            this.entries.map(entry => ({
                entry,
                content:
                    entry.name === "word/document.xml"
                        ? Buffer.from(documentXml, "utf8")
                        : entryContent(entry),
            })),
        );
    }
}
