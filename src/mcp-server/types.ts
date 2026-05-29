import type { buildMetaApiContext } from "../meta-sandbox/meta-api/index.js";

export type MetaApiContext = ReturnType<typeof buildMetaApiContext>;

export interface McpServerDeps {
    metaApi: MetaApiContext;
    workspaceRoot: string;
}
