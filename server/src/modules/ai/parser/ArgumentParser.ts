export class ArgumentParser {

    public parseReadFile(

        prompt: string,

    ): string {

        const cleaned = prompt

            .replace(/прочитай/i, "")

            .replace(/открой/i, "")

            .replace(/read/i, "")

            .replace(/open/i, "")

            .trim();

        return cleaned;

    }

}