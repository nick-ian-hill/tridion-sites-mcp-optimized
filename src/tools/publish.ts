import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

const resolveInstructionSchema = z.object({
    includeChildPublications: z.boolean().optional().default(false)
        .describe("DEPRECATED. Use 'publishInChildPublications' instead."),
    includeComponentLinks: z.boolean().optional().default(true)
        .describe("If true, linked Components are resolved and published."),
    includeCurrentPublication: z.boolean().optional().default(true)
        .describe("If true, the item is published in its own Publication."),
    includeDynamicVersion: z.boolean().optional().default(true)
        .describe("If true, the dynamic (latest) version of items is published."),
    includeWorkflow: z.boolean().optional().default(true)
        .describe("If true, items in workflow are published (if the user has rights)."),
    publishInChildPublications: z.array(z.string().regex(/^tcm:0-\d+-1$/)).optional().default([])
        .describe("A list of Publication TCM URIs to publish to. Overrides 'includeChildPublications'."),
    publishNewContent: z.boolean().optional().default(true)
        .describe("If true, new (unpublished) items are published. If false, only items already published are updated."),
    structureResolveOption: z.enum(["OnlyItems", "ItemsAndStructure"]).optional().default("OnlyItems")
        .describe("Defines how Structure Groups are resolved. 'OnlyItems' publishes items in the SG; 'ItemsAndStructure' publishes the SG itself and its items.")
}).optional();

const publishInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).min(1)
        .describe("An array of one or more unique item IDs (TCM URIs) to publish."),
    targetIdsOrPurposes: z.array(z.string()).min(1)
        .describe("An array of one or more Target Type IDs (e.g., 'tcm:0-1-65538') or Target Purposes (e.g., 'Live', 'Staging')."),
    priority: z.enum(["Low", "Normal", "High"]).optional().default("Normal")
        .describe("The priority for the publish transaction."),
    deployAt: z.string().datetime({ message: "Invalid datetime format. Please use ISO 8601 format." }).optional()
        .describe("Schedules the deployment for a specific time (ISO 8601 UTC format, e.g., '2025-10-30T10:00:00Z'). If omitted, deployment is immediate."),
    resolveInstruction: resolveInstructionSchema
        .describe("Specifies advanced rules for resolving dependencies."),
    dryRun: z.boolean().optional().default(false)
        .describe("If true, returns the list of items that *would* be published without actually creating a publish transaction. This is a preview.")
};

const publishSchema = z.object(publishInputProperties);

export const publish = {
    name: "publish",
    description: "Publishes one or more items to the specified targets. Can be used as a 'dryRun' to see what would be published.",
    input: publishInputProperties,

    execute: async (input: z.infer<typeof publishSchema>, context: any) => {
        const {
            itemIds,
            targetIdsOrPurposes,
            priority,
            deployAt,
            resolveInstruction: userInputResolveInstruction,
            dryRun = false
        } = input;

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const action = dryRun ? "preview publish for" : "publish";

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            const finalResolveInstruction = {
                includeChildPublications: userInputResolveInstruction?.includeChildPublications ?? false,
                includeComponentLinks: userInputResolveInstruction?.includeComponentLinks ?? true,
                includeCurrentPublication: userInputResolveInstruction?.includeCurrentPublication ?? true,
                includeDynamicVersion: userInputResolveInstruction?.includeDynamicVersion ?? true,
                includeWorkflow: userInputResolveInstruction?.includeWorkflow ?? true,
                publishInChildPublications: userInputResolveInstruction?.publishInChildPublications ?? [],
                publishNewContent: userInputResolveInstruction?.publishNewContent ?? true,
                structureResolveOption: userInputResolveInstruction?.structureResolveOption ?? "OnlyItems"
            };

            const requestBody = {
                "$type": "PublishRequest",
                "Ids": itemIds,
                "Priority": priority,
                "TargetIdsOrPurposes": targetIdsOrPurposes,
                "PublishInstruction": {
                    "$type": "PublishInstruction",
                    "DeployAt": deployAt, // Will be undefined if not provided, which is fine
                    "ResolveInstruction": finalResolveInstruction
                }
            };

            const endpoint = dryRun ? '/items/itemsToPublish' : '/items/publish';
            const successStatus = dryRun ? 200 : 202; // 200 for 'itemsToPublish', 202 for 'publish'

            const response = await authenticatedAxios.post(endpoint, requestBody);

            if (response.status === successStatus) {
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
            return handleAxiosError(error, `Failed to ${action} items`);
        }
    }
};