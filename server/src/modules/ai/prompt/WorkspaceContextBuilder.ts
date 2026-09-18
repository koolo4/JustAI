export class WorkspaceContextBuilder {

    public build(

        tree: unknown,

    ): string {

        return [

            "===== PROJECT TREE =====",

            JSON.stringify(

                tree,

                null,

                2,

            ),

        ].join("\n");

    }

}