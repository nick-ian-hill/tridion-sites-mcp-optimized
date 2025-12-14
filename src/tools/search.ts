import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent, formatForApi } from "../utils/fieldReordering.js";

export const search = {
    name: "search",
    description: `Performs a comprehensive search on the Content Manager System (CMS) to find item IDs based on various criteria.
    
    This tool is the entry point for finding items based on full-text queries, schemas, modification dates, and lock statuses.
    
    ### CRITICAL: Search and Versioned Items
    Changes to versioned items (Components, Pages, Templates, Schemas, and Template Building Blocks) are only indexed once the item is checked in.
    This means that
    - when performing a search immediately after checking in an item, the item may not be returned (due to an indexing delay),
    - items that have been saved but do not yet have a major version will also appear in the results,
    - changes to existing versioned items (e.g., field value updates) not yet present in a major version will also not be picked up by a search.
    When trying to look up a versioned item where one of the above scenarios may apply, a more reliable strategy is to first find every item of the required type using 'getItemsInContainer', and then check the relevant property (or properties) using 'getItem' in the mapScript of a toolOrchestrator call.

    Searching in Categories
    Normally, the search API searches within Publications or Folders. This tool has been enhanced to also support searching *inside* a Category (ItemType 512).
    If you provide a Category ID in the 'SearchIn' field, the tool will automatically switch strategies to fetch all keywords in that category and filter them based on your 'Title' criteria.

    ### The "Find-Then-Fetch" Pattern
    This tool returns **ONLY** the 'Id', 'Title', and 'type' of matching items.
    
    To inspect item details:
    1.  **Find:** Use this tool ('search') to efficiently get a list of relevant item IDs.
    2.  **Fetch:** Pass the IDs to the 'bulkReadItems' tool, or iterate over the items using the 'toolOrchestrator' and call 'getItem'. To retrieve specific properties (e.g., 'Content', 'Metadata', 'VersionInfo', etc.) use the includeProperties parameter in the 'getItem' or 'bulkReadItems' tools. A comprehensive list of available properties is documented in the 'getItem' tool.
    
    ### Strategy for efficient aggregation
    When you need to count items based on deep properties (e.g., "Count components with schema X that have empty description fields"), do NOT try to do this with one search.
    Instead, use the 'toolOrchestrator':
    1.  **Pre-Processing:** Call 'search' to find all candidate items (e.g., all components using Schema X).
    2.  **Map Script:** For each item, call 'getItem' to check the specific field.
    3.  **Post-Processing:** Aggregate the results.

    When using 'FullTextQuery' to search for a substring, a leading/trailing asterisk or other wildcard may be necessary, e.g., "*ing", "?art*".`,
    input: {
        searchQuery: SearchQueryValidation.optional().describe("A search query model. If not provided, a default search for all items is performed."),
        resultLimit: z.number().int().default(100).optional().describe("The maximum number of results to return. If the number of results matches the (default) result limit, consider setting a higher resultLimit and trying again."),
    },
    execute: async ({ searchQuery, resultLimit = 100 }: { searchQuery?: z.infer<typeof SearchQueryValidation>, resultLimit: number }, context: any) => {
        formatForApi(searchQuery);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            // --- Interception Logic: Search inside Category ---
            if (searchQuery && searchQuery.SearchIn && searchQuery.SearchIn.endsWith("-512")) {
                console.log(`[Search] Intercepting search request for Category: ${searchQuery.SearchIn}`);
                
                // If ItemTypes are specified but do NOT include 'Keyword', return empty immediately
                // because Categories only contain Keywords.
                if (searchQuery.ItemTypes && searchQuery.ItemTypes.length > 0 && !searchQuery.ItemTypes.includes("Keyword")) {
                    return { content: [{ type: "text", text: "[]" }] };
                }

                const categoryId = searchQuery.SearchIn.replace(':', '_');
                const keywordsResponse = await authenticatedAxios.get(`/items/${categoryId}/keywords`);
                
                if (keywordsResponse.status === 200) {
                    let keywords = keywordsResponse.data;

                    // Client-side filtering for Title
                    if (searchQuery.Title) {
                        const searchTitle = searchQuery.Title;
                        const isCaseSensitive = searchQuery.IsTitleCaseSensitive === true;
                        
                        keywords = keywords.filter((k: any) => {
                            const kTitle = k.Title || "";
                            if (isCaseSensitive) {
                                return kTitle.includes(searchTitle);
                            }
                            return kTitle.toLowerCase().includes(searchTitle.toLowerCase());
                        });
                    }

                    // Apply Result Limit
                    if (resultLimit > 0 && keywords.length > resultLimit) {
                        keywords = keywords.slice(0, resultLimit);
                    }

                    // Format
                    const finalData = filterResponseData({ 
                        responseData: keywords, 
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
                    return handleUnexpectedResponse(keywordsResponse);
                }
            }
            // --- End Interception Logic ---

            if (searchQuery && searchQuery.SearchIn) {
                const contextId = searchQuery.SearchIn;
                if (searchQuery.BasedOnSchemas) {
                    if (!searchQuery.SearchIn) {
                        throw new Error("InvalidSearchQuery: The 'SearchIn' parameter is required when filtering by 'BasedOnSchemas'.");
                    }
                    searchQuery.BasedOnSchemas = searchQuery.BasedOnSchemas.map(schemaFilter => ({
                        ...schemaFilter,
                        schemaUri: convertItemIdToContextPublication(schemaFilter.schemaUri, contextId)
                    }));
                }

                if (searchQuery.UsedKeywords) {
                    if (!searchQuery.SearchIn) {
                        throw new Error("InvalidSearchQuery: The 'SearchIn' parameter is required when filtering by 'UsedKeywords'.");
                    }
                    searchQuery.UsedKeywords = searchQuery.UsedKeywords.map(keywordUri =>
                        convertItemIdToContextPublication(keywordUri, contextId)
                    );
                }

                if (searchQuery.ActivityDefinition) {
                    if (!searchQuery.SearchIn) {
                        throw new Error("InvalidSearchQuery: The 'SearchIn' parameter is required when filtering by 'ActivityDefinition'.");
                    }
                    searchQuery.ActivityDefinition = convertItemIdToContextPublication(searchQuery.ActivityDefinition, contextId);
                }

                if (searchQuery.ProcessDefinition) {
                    if (!searchQuery.SearchIn) {
                        throw new Error("InvalidSearchQuery: The 'SearchIn' parameter is required when filtering by 'ProcessDefinition'.");
                    }
                    searchQuery.ProcessDefinition = convertItemIdToContextPublication(searchQuery.ProcessDefinition, contextId);
                }
            }

            const searchRequestPayload = searchQuery ? [{
                "$type": "SearchQuery",
                FullTextQuery: searchQuery.FullTextQuery,
                Title: searchQuery.Title,
                Description: searchQuery.Description,
                ItemTypes: searchQuery.ItemTypes,
                SearchInSubtree: searchQuery.SearchInSubtree,
                ModifiedAfter: searchQuery.LastModifiedAfter,
                ModifiedBefore: searchQuery.LastModifiedBefore,
                ModifiedInLastDays: searchQuery.ModifiedInLastDays,
                ModifiedInLastMonths: searchQuery.ModifiedInLastMonths,
                IsPublished: searchQuery.IsPublished,
                BlueprintStatus: searchQuery.BlueprintStatus,
                IsTitleCaseSensitive: searchQuery.IsTitleCaseSensitive,
                IsDescriptionCaseSensitive: searchQuery.IsDescriptionCaseSensitive,
                LockType: searchQuery.LockType,
                SearchIn: toLink(searchQuery.SearchIn),
                Author: toLink(searchQuery.Author),
                LockUser: toLink(searchQuery.LockUser),
                FromRepository: toLink(searchQuery.FromRepository),
                ActivityDefinition: toLink(searchQuery.ActivityDefinition),
                ProcessDefinition: toLink(searchQuery.ProcessDefinition),
                BasedOnSchemas: searchQuery.BasedOnSchemas?.map(s => {
                    const schemaFilterObject: any = {
                        Schema: {
                            "$type": "Link",
                            IdRef: s.schemaUri
                        }
                    };
                    if (s.fieldFilter) {
                        schemaFilterObject.Field = s.fieldFilter.name;
                        schemaFilterObject.FieldValue = String(s.fieldFilter.value);
                    }

                    return schemaFilterObject;
                }),
                UsedKeywords: toLinkArray(searchQuery.UsedKeywords),
            }] : [{
                "$type": "SearchQuery",
            }];

            const finalPayload = searchRequestPayload.map(query =>
                Object.fromEntries(
                    Object.entries(query).filter(([_, value]) => value !== undefined && value !== null)
                )
            );

            // Force minimal details to enforce the "find-then-fetch" pattern
            const params: any = {
                details: 'IdAndTitleOnly',
            };

            if (resultLimit !== undefined) {
                params.resultLimit = resultLimit;
            }

            const response = await authenticatedAxios.post(
                `/system/search`,
                finalPayload,
                { params: params }
            );

            if (response.status === 200) {
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    details: "IdAndTitle" 
                });
                const formattedFinalData = formatForAgent(finalData);
                console.log(JSON.stringify(formattedFinalData, null, 2));
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedFinalData, null, 2)
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to perform search");
        }
    }
};