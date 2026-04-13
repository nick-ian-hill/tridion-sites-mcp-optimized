import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const LockStateEnum = z.enum([
    "None", "CheckedOut", "Permanent", "NewItem", "InWorkflow", "Reserved"
]);
type LockState = z.infer<typeof LockStateEnum>;

const getLockedItemsInput = {
    forAllUsers: z.boolean().optional().default(false)
        .describe("If true, items locked by any user are returned. This parameter is ignored if 'lockUserId' is specified."),
    lockUserId: z.string().regex(/^tcm:0-\d+-65552$/).optional()
        .describe("The TCM URI of a specific user (e.g., 'tcm:0-1-65552'). If specified, only items locked by this user are returned."),   
    allOfLockStates: z.array(LockStateEnum).optional()
        .describe("Simple Filter: Returns items that have ALL of these lock states (e.g., ['InWorkflow', 'CheckedOut']). Use this as the primary way to filter."),
    noneOfLockStates: z.array(LockStateEnum).optional()
        .describe("Simple Filter: EXCLUDES any item that has AT LEAST ONE of these lock states (e.g., ['Permanent']). Use this to filter out unwanted states."),
    maxResults: z.number().int().optional().default(500)
        .describe("Specifies the maximum number of results to return."),
};

const getLockedItemsSchema = z.object(getLockedItemsInput);

export const getLockedItems = {
    name: "getLockedItems",
    summary: "Lists items that are currently locked (CheckedOut, InWorkflow, etc.) by one or more users.",
    description: `Gets a list of new and locked items (e.g., checked-out, in workflow).
    
    This tool is ideal for finding items in specific states using AND/NOT logic.
    
    ### "Find-Then-Fetch" Pattern
    This tool only returns the Id, Title, type properties.
    
    To inspect detailed properties:
    1.  **Find:** Use this tool to get the item IDs.
    2.  **Fetch:** Use the 'toolOrchestrator' to pass these IDs to a script that calls 'getItem' or 'bulkReadItems'.
    
    For example, to find all items checked out by a user and check their file size:
    1. Call 'getLockedItems' with 'allOfLockStates: ["CheckedOut"]' and the appropriate 'lockUserId'.
    2. Pass the resulting IDs to 'toolOrchestrator' to call 'getItem' for 'BinaryContent.Size'.`,
    input: getLockedItemsInput,
    
    execute: async (
        input: z.infer<typeof getLockedItemsSchema>,
        context: any
    ) => {
        const { 
            forAllUsers = false, 
            lockUserId, 
            allOfLockStates, 
            noneOfLockStates,
            maxResults = 500
        } = input;

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        let finalLockFilter: LockState[] | undefined = undefined;
        let finalLockResult: LockState[] | undefined = undefined;

        // --- TRANSLATION LOGIC ---
        if (allOfLockStates || noneOfLockStates) {
            const positiveStates = allOfLockStates || [];
            const negativeStates = noneOfLockStates || [];

            // The 'filter' is the superset of ALL states we care about.
            const allMentionedStates = [...positiveStates, ...negativeStates];
            
            // Remove duplicates
            finalLockFilter = [...new Set(allMentionedStates)];

            // The 'result' is ONLY the set of states we WANT to see.
            // If positiveStates is empty (e.g., "NOT CheckedOut"), the result is effectively "None".
            finalLockResult = positiveStates.length > 0 ? positiveStates : ["None"];

            // Special case: If *only* "None" is requested, we need to handle that.
            if (positiveStates.length === 1 && positiveStates[0] === "None" && !negativeStates.length) {
                finalLockFilter = ["CheckedOut", "Permanent", "NewItem", "InWorkflow", "Reserved"];
                finalLockResult = ["None"];
            } else if (positiveStates.length === 0 && negativeStates.length === 0) {
                finalLockFilter = undefined;
                finalLockResult = undefined;
            }
        }

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const params = {
                forAllUsers,
                lockUserId,
                lockFilter: finalLockFilter,
                lockResult: finalLockResult,
                maxResults,
            };
            const cleanParams = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined && (!Array.isArray(v) || v.length > 0)));
            
            const response = await authenticatedAxios.get('/lockedItems', {
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
            return handleAxiosError(error, "Failed to retrieve locked items");
        }
    },
    examples: [
                        {
                            description: "Find all items that HAVE the 'CheckedOut' state",
                            payload: `const result = await tools.getLockedItems({
        allOfLockStates: ["CheckedOut"],
        forAllUsers: true
    });`
                        },
                        {
                            description: "Find all items that have BOTH 'InWorkflow' AND 'CheckedOut' states",
                            payload: `const result = await tools.getLockedItems({
        allOfLockStates: ["InWorkflow", "CheckedOut"],
        forAllUsers: true
    });`
                        },
                        {
                            description: "Find all items that HAVE 'InWorkflow' but do NOT have 'CheckedOut' or 'Permanent'",
                            payload: `const result = await tools.getLockedItems({
        allOfLockStates: ["InWorkflow"],
        noneOfLockStates: ["CheckedOut", "Permanent"],
        forAllUsers: true
    });`
                        },
                        {
                            description: "Find all items that do NOT have the 'CheckedOut' state",
                            payload: `const result = await tools.getLockedItems({
        noneOfLockStates: ["CheckedOut"],
        forAllUsers: true
    });`
                        }
                    ]
};