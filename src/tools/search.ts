import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";
import { SearchQueryValidation } from "../schemas/searchSchema.js";

export const search = {
    name: "search",
    description: `Performs a comprehensive search on the Content Manager System (CMS) for various item types based on a wide range of criteria.
  This tool is used to find items that match the specified query, such as full-text search strings, item titles, types, authors, lock status, and more.
  The return value will be an array of items that match the search criteria or an empty array if no items are found.
  This tool cannot modify, update, or delete any CMS items or files.`,
    input: {
        // This search tool supports a single query object, not an array.
        searchQuery: SearchQueryValidation.optional().describe("A search query model. If not provided, a default search for all items is performed."),

        // --- Global Settings ---
        resultLimit: z.number().int().default(100).optional().describe("The maximum number of results to return."),
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).default("IdAndTitleOnly").optional().describe("Specifies the level of details in the returned items."),
    },
    // The function now takes a single `searchQuery` object instead of an array.
    execute: async ({ searchQuery, resultLimit, details }: { searchQuery?: z.infer<typeof SearchQueryValidation>, resultLimit?: number, details?: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless" }) => {
        try {
            // Helper functions remain the same
            const toLink = (id: string | undefined) => (id ? { "$type": "Link", "IdRef": id } : undefined);
            const toLinkArray = (ids: string[] | undefined) => (ids && ids.length > 0 ? ids.map(id => ({ "$type": "Link", "IdRef": id })) : undefined);

            // Build the search request payload.
            // If searchQuery is provided, wrap it in an array for the API.
            // If not, create the default search payload.
            const searchRequestPayload = searchQuery ? [{
                "$type": "SearchQuery",
                // Simple properties
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
                // Properties that need to be converted to Link objects
                SearchIn: toLink(searchQuery.SearchIn),
                Author: toLink(searchQuery.Author),
                LockUser: toLink(searchQuery.LockUser),
                FromRepository: toLink(searchQuery.FromRepository),
                ActivityDefinition: toLink(searchQuery.ActivityDefinition),
                ProcessDefinition: toLink(searchQuery.ProcessDefinition),
                // Properties that need to be converted to arrays of Link objects
                BasedOnSchemas: toLinkArray(searchQuery.BasedOnSchemas),
                UsedKeywords: toLinkArray(searchQuery.UsedKeywords),
            }] : [{
                "$type": "SearchQuery",
            }];

            // Filter out undefined or null values from the payload to create the final, clean payload
            const finalPayload = searchRequestPayload.map(query =>
                Object.fromEntries(
                    Object.entries(query).filter(([_, value]) => value !== undefined && value !== null)
                )
            );

            console.log('payload', finalPayload);
            console.log('details', details);
            console.log('limit', resultLimit);

            type SearchParams = {
                details: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless";
                resultLimit?: number;
            };

            // Create a params object using the new type.
            // Start with a base object.
            const params: SearchParams = {
                details: details || "IdAndTitleOnly",
            };

            // Conditionally add resultLimit to the params object.
            if (resultLimit !== undefined) {
                params.resultLimit = resultLimit;
            }

            const response = await authenticatedAxios.post(
                `/system/search`, // Endpoint path
                finalPayload,
                {
                    params: params
                }
            );

            if (response.status === 200) {
                console.log(response);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }
                    ],
                };
            } else {
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status: ${response.status}` },
                    ],
                };
            }
        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to perform search: ${errorMessage}` }],
            };
        }
    }
};