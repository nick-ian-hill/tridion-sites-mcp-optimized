import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getDefaultModel = {
    name: "getDefaultModel",
    description: `Retrieves the default data model for a specified item type. This model can then be used as a template for creating a new item of that type.
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
        containerId: z.string().regex(/^tcm:\d+-\d+-(?:1|2|4|512)$/).optional().describe("The TCM URI of the organizational item (e.g., Folder, Publication) to use as a container. A container ID is required for most item types except Publication, TargetType, MultimediaType, User, Group, and ApprovalStatus.")
    },
    execute: async ({ modelType, containerId }: { modelType: string, containerId?: string }) => {
        try {
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
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve default model for type '${modelType}'`);
        }
    }
};
