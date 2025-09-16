import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const search = {
    name: "search",
    description: `Performs a comprehensive search on the Content Manager System (CMS) for various item types based on a wide range of criteria.
  This tool is used to find items that match the specified query, such as full-text search strings, item titles, types, authors, lock status, and more.
  The return value will be an array of items that match the search criteria or an empty array if no items are found.
  
  For controlling result details, you can use a predefined 'details' level or the 'includeProperties' parameter for custom requests.
  If you only need a list of items matching the query, "IdAndTitle" is the recommended and most reliable choice.
  If you require specific details from the results (e.g., which user modified an item and/or the publication it belongs to), use the 'includeProperties' parameter. This is the recommended approach when you need specific information. Consider performing a search for a small number of items first to see which properties are available and then performing a wider search requesting just the properties you need. 
  If (and only if) you do not know yet how the results will be analyzed, consider setting the 'details' level to "CoreDetails". This may fail if the search returns many items (resultLimit > 300).
  Only select "AllDetails" if you absolutely need full details about the returned items. This request will likely fail with a large number of item (resultLimit > 150). 'AllDetails' adds the following properties to 'CoreDetails':
  - AccessControlList
  - ApplicableActions
  - ApprovalStatus
  - ContentSecurityDescriptor
  - ExtensionProperties
  - ListLinks
  - SecurityDescriptor
  - LoadInfo
  
  This tool cannot modify, update, or delete any CMS items or files.`,
    input: {
        searchQuery: SearchQueryValidation.optional().describe("A search query model. If not provided, a default search for all items is performed."),
        resultLimit: z.number().int().default(100).optional().describe("The maximum number of results to return."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail for the returned items. For custom property selection, use 'includeProperties' instead.
- "IdAndTitle": Returns only the ID and Title of each item. This is the most efficient option, and the best choice if you only need a list of items matching the query.
- "CoreDetails": Returns the main properties of each item, excluding verbose security and link-related information.
- "AllDetails": Returns all available properties for each item.`),
        includeProperties: z.array(z.string()).optional().describe(`An array of property names to include in the response for fine-grained control. Supports dot notation for selecting nested properties (e.g., "VersionInfo.Creator").
Using this parameter is much preferred over 'CoreDetails' if you know which property or properties are required in advance.
If this parameter is used, the 'details' parameter is ignored. 'Id', 'Title', and '$type' are always included.
Available top-level properties include, but are not limited to:
- "LocationInfo": Information about the item's location (e.g., Path, ContextRepository, OrganizationalItem).
- "VersionInfo": Details about the item's Version, CreationDate, Creator, RevisionDate, Revisor, etc.
- "LockInfo": The LockType and LockUser (the user who has the item checked out).
- "BluePrintInfo": Information related to the item's BluePrinting context (e.g., IsShared, IsLocalized, OwningRepository).
- "MetadataSchema": The Title and Id and the item's metadata schema.
- "AccessControlList": Security information detailing user and group permissions.
Example: ["VersionInfo.Creator", "BluePrintInfo.OwningRepository", "LockInfo"]`),
    },
    execute: async ({ searchQuery, resultLimit = 100, details = "IdAndTitle", includeProperties }: { searchQuery?: z.infer<typeof SearchQueryValidation>, resultLimit: number, details?: "IdAndTitle" | "CoreDetails" | "AllDetails", includeProperties?: string[] }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            if (searchQuery && searchQuery.SearchIn) {
                const contextId = searchQuery.SearchIn;

                if (searchQuery.BasedOnSchemas) {
                    searchQuery.BasedOnSchemas = searchQuery.BasedOnSchemas.map(schemaFilter => ({
                        ...schemaFilter,
                        schemaUri: convertItemIdToContextPublication(schemaFilter.schemaUri, contextId)
                    }));
                }

                if (searchQuery.UsedKeywords) {
                    searchQuery.UsedKeywords = searchQuery.UsedKeywords.map(keywordUri =>
                        convertItemIdToContextPublication(keywordUri, contextId)
                    );
                }

                if (searchQuery.ActivityDefinition) {
                    searchQuery.ActivityDefinition = convertItemIdToContextPublication(searchQuery.ActivityDefinition, contextId);
                }

                if (searchQuery.ProcessDefinition) {
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

            const hasCustomProperties = includeProperties && includeProperties.length > 0;
            const apiDetails = hasCustomProperties || details === 'CoreDetails' || details === 'AllDetails'
                ? 'Contentless'
                : 'IdAndTitleOnly';

            type SearchParams = {
                details: "IdAndTitleOnly" | "Contentless";
                resultLimit?: number;
            };

            const params: SearchParams = {
                details: apiDetails,
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
                const finalData = filterResponseData({ responseData: response.data, details, includeProperties });
                console.log(JSON.stringify(finalData, null, 2));
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(finalData, null, 2)
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