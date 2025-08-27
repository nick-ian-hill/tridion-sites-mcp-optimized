import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const search = {
    name: "search",
    description: `Performs a comprehensive search on the Content Manager System (CMS) for various item types based on a wide range of criteria.
  This tool is used to find items that match the specified query, such as full-text search strings, item titles, types, authors, lock status, and more.
  The return value will be an array of items that match the search criteria or an empty array if no items are found.
  This tool cannot modify, update, or delete any CMS items or files.`,
    input: {
        searchQuery: SearchQueryValidation.optional().describe("A search query model. If not provided, a default search for all items is performed."),
        resultLimit: z.number().int().default(100).optional().describe("The maximum number of results to return."),
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).default("IdAndTitleOnly").optional().describe("Specifies the level of details in the returned items."),
    },
    execute: async ({ searchQuery, resultLimit, details }: { searchQuery?: z.infer<typeof SearchQueryValidation>, resultLimit?: number, details?: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless" }) => {
        try {
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
                BasedOnSchemas: toLinkArray(searchQuery.BasedOnSchemas?.map(s => s.schemaUri)),
                UsedKeywords: toLinkArray(searchQuery.UsedKeywords),
            }] : [{
                "$type": "SearchQuery",
            }];

            const finalPayload = searchRequestPayload.map(query =>
                Object.fromEntries(
                    Object.entries(query).filter(([_, value]) => value !== undefined && value !== null)
                )
            );

            type SearchParams = {
                details: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless";
                resultLimit?: number;
            };

            const params: SearchParams = {
                details: details || "IdAndTitleOnly",
            };

            if (resultLimit !== undefined) {
                params.resultLimit = resultLimit;
            }

            const response = await authenticatedAxios.post(
                `/system/search`,
                finalPayload,
                {
                    params: params
                }
            );

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
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to perform search");
        }
    }
};