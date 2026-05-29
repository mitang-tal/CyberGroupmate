import type { buildMetaApiContext } from "../meta-sandbox/meta-api/index.js";
import type { GlobalState } from "../main-agent/global-state.js";

export type MetaApiContext = ReturnType<typeof buildMetaApiContext>;

export interface McpServerDeps {
    metaApi: MetaApiContext;
    globalState: GlobalState;
    workspaceRoot: string;
}
