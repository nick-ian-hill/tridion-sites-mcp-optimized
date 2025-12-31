import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForApi } from "../utils/fieldReordering.js";

const resolveInstructionSchema = z.object({
    includeChildPublications: z.boolean().optional().default(false)
        .describe("If true, the item is published in all child Publications where it exists. Use 'publishInChildPublications' to select specific children."),
    includeComponentLinks: z.boolean().optional().default(true)
        .describe("If true, linked Components are resolved and published."),
    includeCurrentPublication: z.boolean().optional().default(true)
        .describe("If true, the item is published in its own Publication."),
    includeDynamicVersion: z.boolean().optional().default(true)
        .describe("If true, the dynamic (latest) version of items is published."),
    includeWorkflow: z.boolean().optional().default(true)
        .describe("If true, items in workflow are published (if the user has rights)."),
    publishInChildPublications: z.array(z.string().regex(/^tcm:0-\d+-1$/)).optional().default([])
        .describe("A list of specific Publication TCM URIs to publish to. Use this for targeted publishing. Overrides 'includeChildPublications'."),
    includeUnpublishedItems: z.boolean().optional().default(true)
        .describe("If true (default), items that have NOT yet been published to the target are included. If set to false, the action becomes 'Republish Only': only items that have been previously published are updated, and currently unpublished items are ignored."),
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
        .describe("If true, returns the list of items that would be published without actually creating a publish transaction. This is a preview. If no items are listed, the actual publish operation would fail with a warning.")
};

const publishSchema = z.object(publishInputProperties);

export const publish = {
    name: "publish",
    description: "Publishes one or more items to the specified targets. Can be used as a 'dryRun' to see what would be published.",
    input: publishInputProperties,

    execute: async (input: z.infer<typeof publishSchema>, context: any) => {
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

        const action = dryRun ? "preview publish for" : "publish";

        // Centralized list of causes to ensure consistency between dryRun and real publish warnings
        const commonPossibleCauses = [
            "The item has never been published, but 'includeUnpublishedItems' was set to false (Republish Only).",
            "The item has not reached the required Minimum Approval Status for the selected Target Type.",
            "The Page is missing a Page Template, or contains Components missing Component Templates.",
            "The Structure Group containing the Page has its 'Publishable' property set to false.",
            "You are trying to publish a Structure Group or Folder that contains no publishable items.",
            "The item is in a Workflow state that prevents publishing."
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
                publishNewContent: userInputResolveInstruction?.includeUnpublishedItems ?? true,
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
                                    type: "PublishingWarning",
                                    Message: "No items were resolved for publishing.",
                                    PossibleCauses: commonPossibleCauses,
                                    Suggestion: "Check the item's properties, workflow status, and the 'resolveInstruction' parameters."
                                }, null, 2)
                            }],
                        };
                    }

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                type: "PublishPreview",
                                Message: `Publish preview generated. ${resolvedItems.length} item(s) resolved for publishing.`,
                                ResolvedItems: resolvedItems
                            }, null, 2)
                        }]
                    };
                }

                // 2. Handle Actual Publish (Object with Transaction IDs)
                const transactionIds = response.data?.PublishTransactionIds || [];
                
                if (transactionIds.length === 0) {
                    const warningData = {
                        type: "PublishingWarning",
                        Message: "No items were resolved for publishing. 0 transactions created.",
                        PossibleCauses: commonPossibleCauses,
                        Suggestion: "Check the item's properties, workflow status, and the 'resolveInstruction' parameters."
                    };
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(warningData, null, 2)
                        }],
                    };
                }

                const responseData = {
                    type: "PublishResult",
                    Message: `Successfully started publish action. ${transactionIds.length} transaction(s) created.`,
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