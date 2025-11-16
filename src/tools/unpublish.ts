import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { sanitizeAgentJson } from "../utils/fieldReordering.js";

const resolveInstructionSchema = z.object({
    includeChildPublications: z.boolean().optional().default(false)
        .describe("DEPRECATED. Use 'publishInChildPublications' instead."),
    includeComponentLinks: z.boolean().optional().default(true)
        .describe("If true, linked Components are resolved and unpublished."),
    includeCurrentPublication: z.boolean().optional().default(true)
        .describe("If true, the item is unpublished from its own Publication."),
    includeDynamicVersion: z.boolean().optional().default(true)
        .describe("If true, the dynamic (latest) version of items is unpublished."),
    includeWorkflow: z.boolean().optional().default(true)
        .describe("If true, items in workflow are unpublished (if the user has rights)."),
    publishInChildPublications: z.array(z.string().regex(/^tcm:0-\d+-1$/)).optional().default([])
        .describe("A list of Publication TCM URIs to unpublish from. Overrides 'includeChildPublications'."),
    publishNewContent: z.boolean().optional().default(true)
        .describe("Not typically used for unpublish, but part of the shared model."),
    structureResolveOption: z.enum(["OnlyItems", "ItemsAndStructure"]).optional().default("OnlyItems")
        .describe("Defines how Structure Groups are resolved. 'OnlyItems' unpublishes items in the SG; 'ItemsAndStructure' unpublishes the SG itself and its items.")
}).optional();

const unpublishInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).min(1)
        .describe("An array of one or more unique item IDs (TCM URIs) to unpublish."),
    targetIdsOrPurposes: z.array(z.string()).min(1)
        .describe("An array of one or more Target Type IDs (e.g., 'tcm:0-1-65538') or Target Purposes (e.g., 'Live', 'Staging')."),
    priority: z.enum(["Low", "Normal", "High"]).optional().default("Normal")
        .describe("The priority for the unpublish transaction."),
    deployAt: z.string().datetime({ message: "Invalid datetime format. Please use ISO 8601 format." }).optional()
        .describe("Schedules the deployment (un-deployment) for a specific time (ISO 8601 UTC format, e.g., '2025-10-30T10:00:00Z'). If omitted, deployment is immediate."),
    resolveInstruction: resolveInstructionSchema
        .describe("Specifies advanced rules for resolving dependencies."),
    dryRun: z.boolean().optional().default(false)
        .describe("If true, returns the list of items that would be unpublished without actually creating an unpublish transaction. This is a preview. If no items are listed, the actual unpublish operation would fail with a warning.")
};

const unpublishSchema = z.object(unpublishInputProperties);

export const unpublish = {
    name: "unpublish",
    description: "Unpublishes one or more items from the specified targets. Can be used as a 'dryRun' to see what would be unpublished.",
    input: unpublishInputProperties,

    execute: async (input: z.infer<typeof unpublishSchema>, context: any) => {
        sanitizeAgentJson(input);
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

        const action = dryRun ? "preview unpublish for" : "unpublish";

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
                structureResolveOption: userInputResolveInstruction?.structureResolveOption ?? "OnlyItems",
            };

            const requestBody = {
                "$type": "UnPublishRequest",
                "Ids": itemIds,
                "Priority": priority,
                "TargetIdsOrPurposes": targetIdsOrPurposes,
                "UnPublishInstruction": {
                    "$type": "UnPublishInstruction",
                    "DeployAt": deployAt, // Will be undefined if not provided
                    "ResolveInstruction": finalResolveInstruction
                }
            };

            const endpoint = dryRun ? '/items/itemsToUnpublish' : '/items/unpublish';
            const successStatus = dryRun ? 200 : 202; // 200 for 'itemsToUnpublish', 202 for 'unpublish'

            const response = await authenticatedAxios.post(endpoint, requestBody);

            if (response.status === successStatus) {
                const transactionIds = response.data?.PublishTransactionIds || [];
                const responseData = {
                    $type: dryRun ? "UnpublishPreview" : "UnpublishResult",
                    Message: dryRun
                        ? `Unpublish preview generated. ${transactionIds.length} items would be processed.`
                        : `Successfully started unpublish action. ${transactionIds.length} transaction(s) created.`,
                    TransactionIds: transactionIds
                };

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
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