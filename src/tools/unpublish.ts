import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForApi } from "../utils/fieldReordering.js";

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
        .describe("Schedules the removal of published items for a specific time (ISO 8601 UTC format, e.g., '2025-10-30T10:00:00Z'). If omitted, removal is immediate."),
    resolveInstruction: resolveInstructionSchema
        .describe("Specifies advanced rules for resolving dependencies."),
    dryRun: z.boolean().optional().default(false)
        .describe("If true, returns the list of items that would be unpublished without actually creating a transaction. This is a preview. If no items are listed, the actual unpublish operation would fail with a warning.")
};

const unpublishSchema = z.object(unpublishInputProperties);

export const unpublish = {
    name: "unpublish",
    description: "Unpublishes one or more items from the specified targets. Can be used as a 'dryRun' to see what would be unpublished.",
    input: unpublishInputProperties,

    execute: async (input: z.infer<typeof unpublishSchema>, context: any) => {
        formatForApi(input);
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

        const commonPossibleCauses = [
            "The item is not currently published to the specified Target.",
            "The item does not exist in the Context Publication.",
            "You do not have permission to unpublish this item."
        ];

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
                
                // 1. Handle Dry Run (Array of Items)
                if (dryRun && Array.isArray(response.data)) {
                    const resolvedItems = response.data.map((item: any) => ({
                        Id: item.Item?.IdRef,
                        Title: item.Item?.Title,
                        Publication: item.Publication?.Title,
                        Target: item.TargetType?.Title
                    }));

                    if (resolvedItems.length === 0) {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    type: "UnpublishWarning",
                                    Message: "No items were resolved for unpublishing.",
                                    PossibleCauses: commonPossibleCauses,
                                    Suggestion: "Check if the item is actually published to the target."
                                }, null, 2)
                            }],
                        };
                    }

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                type: "UnpublishPreview",
                                Message: `Unpublish preview generated. ${resolvedItems.length} item(s) resolved for unpublishing.`,
                                ResolvedItems: resolvedItems
                            }, null, 2)
                        }]
                    };
                }

                // 2. Handle Actual Unpublish (Object with Transaction IDs)
                const transactionIds = response.data?.PublishTransactionIds || [];
                
                if (transactionIds.length === 0) {
                     return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                type: "UnpublishWarning",
                                Message: "No items were resolved for unpublishing. 0 transactions created.",
                                PossibleCauses: commonPossibleCauses,
                                Suggestion: "Check if the item is actually published to the target."
                            }, null, 2)
                        }],
                    };
                }

                const responseData = {
                    type: "UnpublishResult",
                    Message: `Successfully started unpublish action. ${transactionIds.length} transaction(s) created.`,
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