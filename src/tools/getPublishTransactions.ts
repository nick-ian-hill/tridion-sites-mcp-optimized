import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

const publishTransactionStateEnum = z.enum([
    "ScheduledForPublish",
    "WaitingForPublish",
    "InProgress",
    "ScheduledForDeployment",
    "WaitingForDeployment",
    "Failed",
    "Success",
    "Warning",
    "Resolving",
    "Rendering",
    "Throttled",
    "ReadyForTransport",
    "Transporting",
    "Deploying",
    "PreparingDeployment",
    "PreCommittingDeployment",
    "CommittingDeployment",
    "WaitingForCdEnvironment",
    "UnknownByClient"
]);

const getPublishTransactionsInput = {
    userId: z.string().regex(/^tcm:0-\d+-65552$/, "Invalid User ID format. Expected 'tcm:0-X-65552'.").optional()
        .describe("The TCM URI of the user who initiated the transaction (e.g., 'tcm:0-1-65552')."),
    publicationId: z.string().regex(/^tcm:0-\d+-1$/, "Invalid Publication ID format. Expected 'tcm:0-X-1'.").optional()
        .describe("The TCM URI of a Publication (e.g., 'tcm:0-5-1')."),
    targetTypeId: z.string().regex(/^tcm:0-\d+-65538$/, "Invalid Target Type ID format. Expected 'tcm:0-X-65538'.").optional()
        .describe("The TCM URI of a publishing Target Type (e.g., 'tcm:0-1-65538')."),
    startDate: z.string().datetime({ message: "Invalid datetime format. Please use ISO 8601 format." }).optional()
        .describe("The start date and time (ISO 8601 format) to filter transactions from (e.g., '2025-10-20T10:00:00Z')."),
    endDate: z.string().datetime({ message: "Invalid datetime format. Please use ISO 8601 format." }).optional()
        .describe("The end date and time (ISO 8601 format) to filter transactions to (e.g., '2025-10-21T10:00:00Z')."),
    priority: z.enum(["Low", "Normal", "High"]).optional()
        .describe("If specified, only include Publish Transactions with this priority."),
    state: publishTransactionStateEnum.optional()
        .describe("If specified, only include Publish Transactions with this state."),
    details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional()
        .describe(`Specifies a predefined level of detail for the returned items. For custom property selection, use 'includeProperties' instead.`),
    includeProperties: z.array(z.string()).optional()
        .describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include (e.g., ["ListInfo.PublishAction", "Creator.Descripton", "Items.Title"]). If used, 'details' is ignored. 'Id', 'Title', and '$type' are always included.`),
};

const getPublishTransactionsSchema = z.object(getPublishTransactionsInput);

export const getPublishTransactions = {
    name: "getPublishTransactions",
    description: `Gets a list of publish transactions, filtering by criteria like user, state, or date range.

Strategy for tasks requiring post-processing or aggregation of results (e.g., "Find the Most...", "Count all...")
When post-processing of data from a large set of items is required, do not use this tool directly.
This approach is token-inefficient and will fail on large result sets. The correct, scalable method is to use the 'toolOrchestrator' with the 3-phase (setup-map-reduce) pattern.

Example: Find all 'Failed' transactions and create a report of their error messages.
    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            // Phase 1 (Setup): Get the IDs of all failed transactions
            context.log("Searching for failed transactions...");
            const txResult = await context.tools.getPublishTransactions({
                state: "Failed",
                details: "IdAndTitle" // Only need IDs for the map phase
            });
            const transactions = JSON.parse(txResult.content[0].text);
            
            // Return an array of item IDs for the map phase
            const txIds = transactions.map(tx => tx.Id);
            context.log(\`Found \${txIds.length} failed transactions.\`);
            return txIds;
        \`,
        mapScript: \`
            // Phase 2 (Map): Get details for EACH failed transaction
            // The 'getItem' tool can be used to read transaction details by ID
            context.log(\`Getting details for \${context.currentItemId}\`);
            const itemResult = await context.tools.getItem({
                itemId: context.currentItemId,
                // We need LoadInfo for the error and Items for context
                includeProperties: ["LoadInfo.ErrorMessage", "Items.Title", "ListInfo.PublicationTargetTitle"]
            });
            const tx = JSON.parse(itemResult.content[0].text);

            const itemTitle = (tx.Items && tx.Items.length > 0) ? tx.Items[0].Title : "N/A";
            const errorMsg = (tx.LoadInfo && tx.LoadInfo.ErrorMessage) ? tx.LoadInfo.ErrorMessage : "No error message.";
            const target = (tx.ListInfo && tx.ListInfo.PublicationTargetTitle) ? tx.ListInfo.PublicationTargetTitle : "N/A";

            // Return a custom object for the reduce phase
            return {
                id: tx.Id,
                title: tx.Title,
                item: itemTitle,
                target: target,
                error: errorMsg
            };
        \`,
        postProcessingScript: \`
            // Phase 3 (Reduce): Aggregate the results
            context.log("Aggregating results...");
            // 'results' is an array of objects from the mapScript
            const successfulResults = results
                .filter(r => r.status === 'success')
                .map(r => r.result);

            return {
                totalFailed: successfulResults.length,
                errors: successfulResults
            };
        \`
    });
`,
    input: getPublishTransactionsInput,

    execute: async (input: z.infer<typeof getPublishTransactionsSchema>, context: any) => {
        const {
            userId,
            publicationId,
            targetTypeId,
            startDate,
            endDate,
            priority,
            state,
            details = "IdAndTitle",
            includeProperties
        } = input;

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            const hasCustomProperties = includeProperties && includeProperties.length > 0;
            // Map the tool's 'details' enum to the API's 'details' enum
            // 'Contentless' is the API's most detailed option in the spec.
            const apiDetails = (hasCustomProperties || details === 'CoreDetails' || details === 'AllDetails')
                ? 'Contentless'
                : 'IdAndTitleOnly';

            const params = {
                userId,
                publicationId,
                targetTypeId,
                startDate,
                endDate,
                priority,
                state,
                details: apiDetails
            };

            // Remove any undefined parameters
            const cleanParams = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined));

            const response = await authenticatedAxios.get('/publishing/transactions', {
                params: cleanParams
            });

            if (response.status === 200) {
                // Apply 'includeProperties' or 'details' filtering *after* the request
                const finalData = filterResponseData({
                    responseData: response.data,
                    details,
                    includeProperties
                });

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(finalData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve publish transactions");
        }
    }
};