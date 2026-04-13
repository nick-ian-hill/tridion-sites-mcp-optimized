import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

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
};

const getPublishTransactionsSchema = z.object(getPublishTransactionsInput);

export const getPublishTransactions = {
    name: "getPublishTransactions",
    summary: "Lists recent or filtered publish transactions to check status or troubleshoot errors.",
    description: `Gets a list of publish transactions, filtering by criteria like user, state, or date range.
    
    ### "Find-Then-Fetch" Pattern
    This tool only returns Id, Title, and type.
    
    To analyze transaction details (e.g., to create a report of error messages for failed transactions):
    1.  **Find:** Use this tool to get the list of Transaction IDs (e.g., filtering by state="Failed").
    2.  **Fetch:** Use the 'toolOrchestrator' to iterate over these IDs and call 'getItem' to retrieve properties such as 'LoadInfo.ErrorMessage' or 'Items'. The 'getItem' tool provides a comprehensive list of available properties.
    
    Example Orchestrator Script for Failed Transactions:
    \`\`\`javascript
    const result = await tools.toolOrchestrator({
        preProcessingScript: \`
            // Phase 1: Find IDs
            const txResult = await context.tools.getPublishTransactions({ state: "Failed" });
            const transactions = JSON.parse(txResult.content[0].text);
            return transactions.map(tx => tx.Id);
        \`,
        mapScript: \`
            // Phase 2: Fetch Details
            const itemResult = await context.tools.getItem({
                itemId: context.currentItemId,
                includeProperties: ["LoadInfo.ErrorMessage", "Items.Title", "TargetType"]
            });
            // ... process result ...
        \`
    });
    \`\`\``,
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
        } = input;

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            const apiDetails = 'IdAndTitleOnly';

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
                const finalData = filterResponseData({
                    responseData: response.data,
                    details: "IdAndTitle"
                });
                const formattedFinalData = formatForAgent(finalData);

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedFinalData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve publish transactions");
        }
    },
    examples: [
        {
            description: "Get a list of failed transactions",
            payload: `const result = await tools.getPublishTransactions({
    state: "Failed"
});`
        }
    ]
};