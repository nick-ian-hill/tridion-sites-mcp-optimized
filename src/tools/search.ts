import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const search = {
    name: "search",
    description: `Performs a comprehensive search on the Content Manager System (CMS) for various item types based on a wide range of criteria.
  This tool is used to find items that match the specified query, such as full-text search strings, item titles, types, authors, lock status, and more.
  The return value will be an array of items that match the search criteria or an empty array if no items are found.
  For browsing a known folder structure, 'getItemsInContainer' is an alternative.

  ### Important: Retrieving Full Item Details
  The search service is optimized for finding items, not for retrieving their full content or deep structural data. Properties like a Component's 'Content'/'Metadata' (the values), a Schema's 'Fields'/'MetadataFields', or a Multimedia Component's 'BinaryContent' (MimeType, Size) are **NEVER** returned by this tool, regardless of the 'details' or 'includeProperties' settings.
 
  For tasks requiring inspection of these properties, always use a two-step process:
  1.  Find: Use 'search' with the default 'details: "IdAndTitle"' to efficiently get a list of relevant item IDs.
  2.  Fetch: Use 'bulkReadItems' with the resulting IDs and the 'includeProperties' parameter to retrieve only the specific fields you need (e.g., ['Fields', 'MetadataFields', 'BinaryContent']). This is the most token-efficient and reliable method.

  When using 'FullTextQuery' to search for a substring, a leading/trailing asterisk or other wildcard may be necessary, e.g., "*ing", "?art*".

  Strategy for Efficient Searching
  To avoid excessive token usage, follow this strategy when choosing how much detail to request:

  1.  Always prefer 'includeProperties' for specific details. If you need any information beyond an item's ID and Title (e.g., who created it, where it is located), use the 'includeProperties' parameter. This is the most token-efficient method. A good practice is to first run a narrow search to identify available properties, then run your full search requesting only the ones you need.
  2.  Default to 'details: "IdAndTitle"' for lists. If the goal is simply to find items or get a count, this is the safest and fastest option.
  3.  Use 'details: "CoreDetails"' with extreme caution. This option returns a predefined set of properties, but excludes key properties like 'Content', 'Metadata', 'Fields', and 'MetadataFields'. It has high token usage and may fail if the search returns many items (over 300). Only use this if you cannot determine the required properties in advance.
  4.  Avoid 'details: "AllDetails"'. This option should almost never be used as it will likely fail or exhaust the context window.
  
  'AllDetails' adds the following properties to 'CoreDetails':
  - AccessControlList
  - ApplicableActions
  - ApprovalStatus
  - ContentSecurityDescriptor
  - ExtensionProperties
  - ListLinks
  - SecurityDescriptor
  - LoadInfo

  When using search query parameters that target items in a specific publication: 'BasedOnSchema', 'UsedKeywords', 'ProcessDefinitions', and 'ActivityDefinitions', it's mandatory to also provide a value for the 'SearchIn' parameter, otherwise the request will fail. 

  Strategy for tasks requiring post-processing or aggregation of results (e.g., "Find the Most...", "Count all...")
  When post-processing of data from a large set of items is required, do not use this tool directly.
  This approach is token-inefficient and will fail on large result sets. The correct, scalable method is to use the 'toolOrchestrator', and supply a postProcessingScript to perform the aggregation on the server-side. See the 'toolOrchestrator' documentation for the recommended 3-phase (setup-map-reduce) pattern.

  Examples:
 
  Example 1: Find all Components that use the text 'logo' and include their ComponentType for filtering.
  NOTE: The 'search' tool cannot access 'BinaryContent' (for MimeType, Size, etc.) or 'Metadata' (for alt text). It also cannot filter by 'ComponentType' directly.
  The correct way to perform this task is to search for 'ItemTypes: ['Component']' and then use the 'toolOrchestrator' to fetch and filter the results. See 'toolOrchestrator' Example 10.

This query will find all Components, which you can then process further.
    const result = await tools.search({
      searchQuery: {
        ItemTypes: ['Component'],
        FullTextQuery: 'logo'
      },
      includeProperties: ['ComponentType']
    });

Example 2: Find 'Multimedia Components' based on the 'Default Multimedia Schema' (tcm:4-5-8) within the '200 Example Content' Publication (tcm:0-4-1).
    const result = await tools.search({
      searchQuery: {
        ItemTypes: ['Component'],
        SearchIn: 'tcm:0-4-1',
        BasedOnSchemas: [
          {
            schemaUri: 'tcm:4-5-8'
          }
        ]
      },
      includeProperties: ['ComponentType']
    });
  `,
    input: {
        searchQuery: SearchQueryValidation.optional().describe("A search query model. If not provided, a default search for all items is performed."),
        resultLimit: z.number().int().default(100).optional().describe("The maximum number of results to return. If the number of results matches the (default) result limit, consider setting a higher resultLimit and trying again."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail for the returned items. For custom property selection, use 'includeProperties' instead.
- "IdAndTitle": Returns only the ID and Title of each item. This is the most efficient option, and the best choice if you only need a list of items matching the query.
- "CoreDetails": Returns the main properties of each item, excluding verbose security, link-related, and content/field-related information.
- "AllDetails": Returns all available properties for each item, excluding content/field data.`),
        includeProperties: z.array(z.string()).optional().describe(`The strongly preferred method for retrieving specific details to minimize token usage. Provide an array of property names to include in the response, using dot notation for nested properties (e.g., "VersionInfo.Creator",  "ComponentType").
If this parameter is used, the 'details' parameter is ignored. 'Id', 'Title', and '$type' are always included.

Important: Search results are content-less. Properties like 'Content', 'Metadata', 'Fields', 'MetadataFields', and 'BinaryContent' are never available via search. To retrieve them, first find the item ID using this tool, then use 'bulkReadItems' or 'getItem'.

Available top-level properties in search results include, but are not limited to:
- "LocationInfo": Information about the item's location (e.g., Path, ContextRepository, OrganizationalItem).
- "VersionInfo": Details about the item's Version, CreationDate, Creator, RevisionDate, Revisor, etc.
- "LockInfo": The LockType and LockUser (the user who has the item checked out). When purely interested in finding new items or items in various lock states, the 'getLockedItems' tool is more powerful.
- "BluePrintInfo": Information related to the item's BluePrinting context (e.g., IsShared, IsLocalized, OwningRepository).
- "MetadataSchema": The Title and Id of the item's metadata schema.
Example: ["VersionInfo.Creator", "BluePrintInfo.OwningRepository", "LockInfo", "ComponentType"]`),
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