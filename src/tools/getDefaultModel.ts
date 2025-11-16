import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const getDefaultModel = {
    name: "getDefaultModel",
    description: `Retrieves the default data model for a specified item type. This model serves as a template that can be modified and then used as the payload for a creation tool, such as 'createComponent', 'createItem', 'createComponentSchema', or 'createPage'. This is the recommended first step when programmatically creating a new item.
        For the top-level (root) StructureGroup, and for a Category, the containerId should be the URI of the Publication.
    For a Keyword, the container must be a Category).
    For a Component, MultimediaComponent, Bundle, SearchFolder, or Folder, the container must be a Folder.
    For a StuctureGroup or Page, the container must be a StructureGroup. The exception is a root StructureGroup, for which the container is a Publication.
    A Publication can have multiple Categories, but only a single root StructureGroup.`,
    input: {
    modelType: z.enum([
        "Bundle",
        "SearchFolder",
        "Schema",
        "Page",
        "PageTemplate",
        "Component",
        "ComponentTemplate",
        "Folder",
        "Keyword",
        "StructureGroup",
        "TemplateBuildingBlock",
        "Publication",
        "Category",
        "Group",
        "ProcessDefinition",
        "BusinessProcessType",
        "MultimediaType",
        "TargetType",
        "User",
        "TargetGroup",
        "ApprovalStatus"
    ]).describe("The type of data model to retrieve."),
    containerId: z.string().regex(/^tcm:\d+-\d+-(?:1|2|4|512)$/).optional().describe("The TCM URI of the organizational item (e.g., Folder, Publication) to use as a container. Use tools like 'getPublications', 'getItemsInContainer', or 'getCategories' to find a suitable container ID. A container ID is required for most item types.")
},
    execute: async ({ modelType, containerId }: { modelType: string, containerId?: string },
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId); 
            const endpoint = `/item/defaultModel/${modelType}`;
            const params: { containerId?: string } = {};

            if (containerId) {
                params.containerId = containerId;
            }

            const response = await authenticatedAxios.get(endpoint, { params });

            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(response.data, null, 2)
                    }]
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve default model for type '${modelType}'`);
        }
    }
};