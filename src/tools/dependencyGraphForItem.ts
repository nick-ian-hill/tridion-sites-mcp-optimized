import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const dependencyGraphForItem = {
    name: "dependencyGraphForItem",
    description: `Returns items in the Content Management System that are either dependencies of (direction = uses) or dependent on (direction = UsedBy) the specified item.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item for which the dependency graph should be retrieved."),
        direction: z.enum(["Uses", "UsedBy"]).optional().default("Uses").describe("Specifies the direction of the dependencies. 'Uses' returns items this item depends on; 'UsedBy' returns items that depend on this item."),
        contextRepositoryId: z.string().regex(/^tcm:0-\d+-1$/).optional().describe("The TCM URI of an ancestor Publication (a Publication higher in the BluePrint). If specified, the response will indicate whether the dependent items exist in this Publication."),
        rloItemTypes: z.array(z.enum([
            "Component",
            "Page",
            "Schema",
            "ComponentTemplate",
            "PageTemplate",
            "TemplateBuildingBlock",
            "BusinessProcessType",
            "VirtualFolder",
            "ProcessDefinition",
            "Folder",
            "StructureGroup",
            "Category",
            "Keyword",
            "TargetGroup",
        ])).optional().describe("Filters the results to include only these types of repository-local objects. Note that the Bundle and SearchFolder types are both instances of VirtualFoler."),
        includeContainers: z.boolean().optional().default(false).describe("If true and direction is 'Uses', the parent Folders or Structure Groups of the items in the graph are also returned (recursively)."),
        resultLimit: z.number().int().optional().default(1000).describe("The maximum number of dependency nodes to return."),
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("IdAndTitleOnly").describe("Specifies the level of detail for the items returned in the graph."),
    },
    examples: [
        {
            input: {
                itemId: "tcm:5-256-8",
                direction: "UsedBy",
                details: "IdAndTitleOnly"
            },
            description: "Finds all items that are directly using the Schema with ID tcm:5-256-8, returning only their IDs and titles."
        },
        {
            // Example 2: More complex 'Uses' check
            input: {
                itemId: "tcm:5-310-64",
                direction: "Uses",
                rloItemTypes: ["Component", "ComponentTemplate"],
                includeContainers: true
            },
            description: "Finds all Components and Component Templates that the Page tcm:5-310-64 depends on, including the Folders that contain them. This request returns linked Components in addition to Components directly added to the page."
        }
    ],
    execute: async ({ itemId, direction, contextRepositoryId, rloItemTypes, includeContainers, resultLimit, details }: any) => {
        try {
            // The API requires the colon in the TCM URI to be replaced with an underscore.
            const restItemId = itemId.replace(':', '_');

            // Assemble the query parameters for the API request.
            const params = {
                direction,
                contextRepositoryId,
                rloItemTypes,
                includeContainers,
                resultLimit,
                details
            };

            // Remove any parameters that are undefined, so they are not sent in the request.
            const cleanParams = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined));

            // Make the GET request to the dependencyGraph endpoint.
            const response = await authenticatedAxios.get(`/items/${restItemId}/dependencyGraph`, {
                params: cleanParams
            });

            // A successful request will return a 200 OK status.
            if (response.status === 200) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }
                    ],
                };
            } else {
                // Handle any unexpected, non-error status codes.
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status: ${response.status}` },
                    ],
                };
            }
        } catch (error) {
            // Handle errors from the API call, such as 404 Not Found or 500 Internal Server Error.
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to retrieve dependency graph for item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};