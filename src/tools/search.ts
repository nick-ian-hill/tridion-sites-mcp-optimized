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
  The search service is optimized for finding items, not for retrieving their full content or deep structural data. Properties like a Component's 'Content'/'Metadata' or a Schema's 'Fields'/'MetadataFields' are NEVER returned by this tool, regardless of the 'details' or 'includeProperties' settings.

  For tasks requiring inspection of these properties, always use a two-step process:
  1.  Find: Use 'search' with the default 'details: "IdAndTitle"' to efficiently get a list of relevant item IDs.
  2.  Fetch: Use 'bulkReadItems' with the resulting IDs and the 'includeProperties' parameter to retrieve only the specific fields you need (e.g., ['Fields', 'MetadataFields']). This is the most token-efficient and reliable method.

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

  Examples:
 
  Example 1: Find 'Multimedia Components' which have a field containing the text 'logo'. Since we cannot limit the results to only 'Multimedia Components', you will need to review the value of the 'ComponentType' property and select only those items for which the value is 'MultimediaComponent'.
      const result = await tools.search({
      searchQuery: {
        ItemTypes: ['Component'],
        FullTextQuery: 'logo'
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

Important: Search results are content-less. Properties like 'Content', 'Metadata', 'Fields', and 'MetadataFields' are never available via search. To retrieve them, first find the item ID using this tool, then use 'bulkReadItems' or 'getItem'.

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