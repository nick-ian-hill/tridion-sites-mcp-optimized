import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67L5iukdVrhRn9nmXKiYsJePaq2ThNM5pxy8JkkKFe22WqvyWelxVXbpbegGCZUbsgrEE7_bljQ6xZl6GOcG2SCESAfIzDj9EVJPoRSAw0yaiqG5fJpG_hyA_s4oNre5gCj2MRl2n3jn1OScc6Som5S54uzSLPtfJC12wmaJlV_rfIUPanfJQayw6Xul7TIGuop4jYsQPQPTijuetTNMKs7Gn-KpIaU0TNbLFX7hB0jdeejXM6Tu2hoJCnUDvzlcMFtgbDKI0QQ2ePCHRqlAjRXt5aiiFh1s-YnOCE2g-ydUyIluMzw7YP9vu3EvNly-ZHk";

const authenticatedAxios = axios.create({
  baseURL: CMS_BASE_API_URL,
  headers: {
    "Cookie": `UserSessionID=${USER_SESSION_ID}`,
    "Accept": "application/json"
  }
});

const server = new McpServer({
  name: "tridion-sites-mcp-server",
  version: "1.0.0",
});

const SearchQueryValidation = z.object({
  // --- Core Search Criteria ---
  FullTextQuery: z.string().optional().describe("A full-text query string to search for. Supports query syntax like +, -, &&, ||, *, etc."),
  Title: z.string().optional().describe("A string to search for in item titles. This is treated as a phrase and does not support wildcards."),
  Description: z.string().optional().describe("A string to search for in the item's description field."),
  ItemTypes: z.array(z.enum([
    "Folder", "Component", "Page", "Schema", "ComponentTemplate", "PageTemplate",
    "MultimediaType", "Category", "Keyword", "User", "Group", "Publication",
    "TargetGroup", "TemplateBuildingBlock", "SearchFolder", "StructureGroup",
  ])).optional().describe("An array of item types to limit the search results to."),

  // --- Location and Scope ---
  SearchIn: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The unique TCM URI of the publication or folder to search within. MUST be provided as a string."),
  SearchInSubtree: z.boolean().default(true).optional().describe("When true, searches recursively in the publication/folder specified in SearchIn. Defaults to true."),

  // --- Schema and Keyword Criteria ---
  BasedOnSchemas: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of Schema TCM URIs. Only items based on these schemas will be returned."),
  UsedKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of Keyword TCM URIs. Only items classified with these keywords will be returned."),

  // --- Date and Modification Criteria ---
  LastModifiedAfter: z.string().datetime().optional().describe("Filters items last modified after this date (ISO 8601 format, e.g., '2023-10-27T10:00:00Z')."),
  LastModifiedBefore: z.string().datetime().optional().describe("Filters items last modified before the specified date (ISO 8601 format, e.g., '2023-10-28T10:00:00Z'). Use this when asked to find items “not modified after” a certain date, since such items must have been modified before that date."),
  ModifiedInLastDays: z.number().int().optional().describe("Filters items modified in the last specified number of days."),
  ModifiedInLastMonths: z.number().int().optional().describe("Filters items modified in the last specified number of months."),

  // --- User and Lock Criteria ---
  Author: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of the author (User) to search for."),
  LockUser: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of the user that must hold the lock on an item."),
  LockType: z.array(z.enum(["None", "CheckedOut", "Permanent", "InWorkflow"])).optional().describe("Filters items by their lock state."),

  // --- Publishing and Blueprinting ---
  IsPublished: z.boolean().optional().describe("Filters items based on their published state. True for published, false for unpublished."),
  BlueprintStatus: z.enum(["Primary", "Shared", "Localized"]).optional().describe("Filter items by Blueprint status."),
  FromRepository: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("If 'Shared' was selected as the BlueprintStatus, this value is the TCM URI of the Repository (Publication) from which the item is shared."),

  // --- Case Sensitivity ---
  IsTitleCaseSensitive: z.boolean().optional().describe("When true, the search on the 'Title' field is case-sensitive."),
  IsDescriptionCaseSensitive: z.boolean().optional().describe("When true, the search on the 'Description' field is case-sensitive."),

  // --- Workflow ---
  ActivityDefinition: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of an Activity Definition an item must be associated with."),
  ProcessDefinition: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of a Process Definition an item must be associated with."),
});

// A corresponding TypeScript type can be inferred directly from the Zod schema for type safety.
type SearchQuery = z.infer<typeof SearchQueryValidation>;

// =====================================================================================================================
// HELPER FUNCTION TO GENERATE XML CONFIGURATION FOR SEARCH FOLDER
// =====================================================================================================================
/**
 * Generates the XML configuration string for a SearchFolder based on the provided SearchQuery.
 * @param searchQuery The search query object.
 * @param resultLimit The maximum number of results.
 * @returns A string containing the XML configuration.
 */
const generateSearchFolderXmlConfiguration = (
  searchQuery: SearchQuery,
  resultLimit: number = 100,
): string => {
  const itemTypeMap: Record<string, number> = {
    "Publication": 1,
    "Folder": 2,
    "StructureGroup": 4,
    "Schema": 8,
    "Component": 16,
    "ComponentTemplate": 32,
    "Page": 64,
    "PageTemplate": 128,
    "TargetGroup": 256,
    "Category": 512,
    "Keyword": 1024,
    "TemplateBuildingBlock": 2042,
    "BusinessProcessType": 4096,
    "VirtualFolder": 8192,
    "ProcessDefinition": 131074
  };

  const lockTypeMap: Record<string, number> = {
    "None": 0,
    "CheckedOut": 1,
    "Permanent": 2,
    "InWorkflow": 3,
  };

  const publishStateMap: Record<string, number> = {
    "true": 1,
    "false": 0,
  };

  // Helper function for creating a Link element string for a single item.
  const toItemXlink = (id?: string, name: string = ""): string => {
    if (!id) return '';
    return `<${name} xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${id}"/>`;
  };

  let xml = `<SearchFolder xmlns="http://www.tridion.com/ContentManager/5.1/SearchFolder">`;

  // --- General Parameters ---
  xml += `<GeneralParameters>`;
  if (searchQuery.FullTextQuery) {
    xml += `<SearchQuery>${searchQuery.FullTextQuery}</SearchQuery>`;
  } else {
    xml += `<SearchQuery/>`;
  }
  if (searchQuery.SearchIn) {
    xml += `<SearchIn xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.SearchIn}" Recursive="${searchQuery.SearchInSubtree || true}"/>`;
  }
  xml += `</GeneralParameters>`;

  // --- Advanced Parameters ---
  xml += `<AdvancedParameters>`;

  if (searchQuery.Title) { xml += `<Title>${searchQuery.Title}</Title>`; }
  if (searchQuery.Description) { xml += `<Description>${searchQuery.Description}</Description>`; }
  if (searchQuery.LastModifiedAfter) { xml += `<ModifiedAfter>${searchQuery.LastModifiedAfter}</ModifiedAfter>`; }
  if (searchQuery.LastModifiedBefore) { xml += `<ModifiedBefore>${searchQuery.LastModifiedBefore}</ModifiedBefore>`; }
  if (searchQuery.ModifiedInLastDays) { xml += `<ModifiedInLastDays>${searchQuery.ModifiedInLastDays}</ModifiedInLastDays>`; }
  if (searchQuery.ModifiedInLastMonths) { xml += `<ModifiedInLastMonths>${searchQuery.ModifiedInLastMonths}</ModifiedInLastMonths>`; }
  if (searchQuery.IsTitleCaseSensitive) { xml += `<IsTitleCaseSensitive>${searchQuery.IsTitleCaseSensitive}</IsTitleCaseSensitive>`; }
  if (searchQuery.IsDescriptionCaseSensitive) { xml += `<IsDescriptionCaseSensitive>${searchQuery.IsDescriptionCaseSensitive}</IsDescriptionCaseSensitive>`; }

  // --- Arrays and specific item types ---
  if (searchQuery.ItemTypes && searchQuery.ItemTypes.length > 0) {
    xml += `<ItemTypes>`;
    searchQuery.ItemTypes.forEach(type => {
      xml += `<ItemType>${itemTypeMap[type]}</ItemType>`;
    });
    xml += `</ItemTypes>`;
  }

  if (searchQuery.BasedOnSchemas && searchQuery.BasedOnSchemas.length > 0) {
    xml += `<BasedOnSchema>`;
    searchQuery.BasedOnSchemas.forEach(id => {
      xml += toItemXlink(id, 'Schema');
    });
    xml += `</BasedOnSchema>`;
  }

  if (searchQuery.UsedKeywords && searchQuery.UsedKeywords.length > 0) {
    xml += `<Keyword>`;
    searchQuery.UsedKeywords.forEach(id => {
      xml += toItemXlink(id, 'Keyword');
    });
    xml += `</Keyword>`;
  }

  // --- Blueprinting ---
  if (searchQuery.BlueprintStatus) {
    xml += `<BluePrinting`;
    if (searchQuery.BlueprintStatus) { xml += ` StatusType="${searchQuery.BlueprintStatus}"`; }
    if (searchQuery.FromRepository) { xml += `/><Publication xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.FromRepository}" />`; }
    xml += ` />`;
  }

  // --- Workflow ---
  if (searchQuery.ActivityDefinition || searchQuery.ProcessDefinition) {
    xml += `<WorkflowStatus>`;
    if (searchQuery.ActivityDefinition) { xml += toItemXlink(searchQuery.ActivityDefinition, 'ActivityDefinition'); }
    if (searchQuery.ProcessDefinition) { xml += toItemXlink(searchQuery.ProcessDefinition, 'ProcessDefinition'); }
    xml += `</WorkflowStatus>`;
  }

  // --- Link-based properties ---
  if (searchQuery.Author) { xml += toItemXlink(searchQuery.Author, 'Author'); }
  if (searchQuery.LockUser) { xml += toItemXlink(searchQuery.LockUser, 'LockUser'); }

  // --- Enum/Boolean properties ---
  if (searchQuery.LockType && searchQuery.LockType.length > 0) {
    xml += `<LockStatus>`;
    searchQuery.LockType.forEach(type => {
      xml += `<LockType>${lockTypeMap[type]}</LockType>`;
    });
    xml += `</LockStatus>`;
  }

  if (searchQuery.IsPublished !== undefined) {
    xml += `<PublishState>${publishStateMap[String(searchQuery.IsPublished)]}</PublishState>`;
  }
  if (resultLimit) { xml += `<NumberOfItems>${resultLimit}</NumberOfItems>`; }
  xml += `</AdvancedParameters>`;
  xml += `</SearchFolder>`;

  return xml;
};

// Echo tool for testing
server.tool(
  "echo",
  "Echoes the input string",
  { message: z.string() },
  async ({ message }) => {
    return {
      content: [
        { type: "text", text: `You said: ${message}` }
      ],
    };
  }
);

server.tool(
  "getItemById",
  `Retrieves read-only details for a single Content Manager System (CMS) item using its unique ID.
The returned details typically include the item type ($type), identified (Id), title (Title),
actions that can be performed on the item (ApplicableActions), the schema or metadata schema the
item uses for custom field values (Schema, MetadataSchema), content field values (Content),
metadata field values (Metadata), version information like creation and revision dates (VersionInfo) etc.
This tool cannot modify, update, or delete any CMS items or files.`,
  {
    itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID of the item."),
  },
  async ({ itemId }) => {
    try {
      const restItemId = itemId.replace(':', '_');

      // Make a GET request to test item endpoint
      const response = await authenticatedAxios.get(`/items/${restItemId}`);

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
        return {
          content: [],
          errors: [
            { message: `Unexpected response status: ${response.status}` },
          ],
        };
      }
    } catch (error) {
      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `Status ${error.response.status}: ${error.response.statusText}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to authenticate or retrieve item: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "getDynamicItemById",
  `Retrieves read-only details for a single Content Manager System (CMS) item using its unique ID.
This tool should be used for "versioned" items to get the most recent saved data, including any revisions
made since the last major version.

The following item types are versioned: Components, Component Templates, Pages, Page Templates, Schemas,
and Template Building Blocks.

ID formats for versioned items:
- Components: tcm:integer-integer, tcm:integer-integer-16, ecl:integer-integer, or ecl:integer-integer-16.
- Other versioned types (Schema, Page, Component Template, Page Template): tcm:integer-integer-type, where 'type' is the item type number (Schema = 8, Page = 64, Component Template = 32, Page Template = 128, Template Building Block = 2048).

For items that do not support versioning or for versioned items without recent changes, this tool
returns the same data as getItemById. It cannot modify, update, or delete any CMS items or files.`,
  {
    itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID of the item."),
  },
  async ({ itemId }) => {
    try {
      const restItemId = itemId.replace(':', '_');

      // Make a GET request to test item endpoint
      const response = await authenticatedAxios.get(`/items/${restItemId}`, {
        params: {
          useDynamicVersion: true
        }
      });

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
        return {
          content: [],
          errors: [
            { message: `Unexpected response status: ${response.status}` },
          ],
        };
      }
    } catch (error) {
      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `Status ${error.response.status}: ${error.response.statusText}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to authenticate or retrieve item: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "bulkReadItemsById",
  `Retrieves read-only details for an array of Content Manager System (CMS) items using their IDs.
This tool is more efficient than calling getItemById for each item individually.
The returned data is an 'IdentifiableObjectDictionary' type, which maps each item ID to its details.
The 'useDynamicVersion' parameter, when set to true, loads the latest saved data for versioned items.
The 'loadFullItems' parameter, when set to true, loads the full content and metadata for each item.

The following item types are versioned: Components, Component Templates, Pages, Page Templates, Schemas,
and Template Building Blocks.

ID formats for versioned items:
- Components: tcm:integer-integer, tcm:integer-integer-16, ecl:integer-integer, or ecl:integer-integer-16.
- Other versioned types (Schema, Page, Component Template, Page Template): tcm:integer-integer-type, where 'type' is the item type number (Schema = 8, Page = 64, Component Template = 32, Page Template = 128, Template Building Block = 2048).

This tool cannot modify, update, or delete any CMS items or files.`,
  {
    itemIds: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).describe("An array of unique IDs for the items to retrieve."),
    useDynamicVersion: z.boolean().default(false).describe("When true, loads the latest revisions for versioned items. Defaults to false."),
    loadFullItems: z.boolean().default(false).describe("When true, loads the full content and metadata for each item. Defaults to false."),
  },
  async ({ itemIds, useDynamicVersion, loadFullItems }) => {
    try {
      const response = await authenticatedAxios.get(`/items/bulkRead`, {
        params: {
          itemIds: itemIds,
          useDynamicVersion: useDynamicVersion,
          loadFullItems: loadFullItems,
        }
      });

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
        return {
          content: [],
          errors: [
            { message: `Unexpected response status: ${response.status}` },
          ],
        };
      }
    } catch (error) {
      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `Status ${error.response.status}: ${error.response.statusText}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to authenticate or retrieve items: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "updateComponentById",
  `Updates content and/or metadata field values for a single Content Manager System (CMS) item of type 'Component' with the specified ID.
The ID of the schema defining the allowed content and metadata fields can be found under the component's 'Schema' property.
Fields are defined using XML Schema Definition 1.0.
This tool cannot be used to update other item types or other component fields (e.g., Title).`,
  {
    itemId: z.string().regex(/^(tcm|ecl):\d+-\d+$/).describe("The unique ID of the component to update, without the version number."),
    content: z.string().optional().describe("The updated content for the component. Must be a string representing a valid JSON object."),
    metadata: z.string().optional().describe("The updated metadata for the component. Must be a string representing a valid JSON object."),
  },
  async ({ itemId, content, metadata }) => {
    let checkedOutItem = null;
    let agentId = null; // Declare agentId here
    const restItemId = itemId.replace(':', '_');

    try {
      // Step 0: Get the current user's (agent's) ID
      const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
      agentId = whoAmIResponse.data?.User?.Id;
      if (!agentId) {
        throw new Error("Could not retrieve agent's user ID from whoAmI endpoint.");
      }

      // Step 1: Get the item to check its lock status.
      const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
      const item = getItemResponse.data;
      const isCheckedOut = item?.LockInfo?.LockType?.includes('CheckedOut');
      const checkedOutUser = item?.VersionInfo?.CheckOutUser?.IdRef;

      // Handle lock status
      if (isCheckedOut && checkedOutUser !== agentId) {
        // Item is checked out by another user, so we should not proceed.
        return {
          content: [],
          errors: [{ message: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.` }],
        };
      } else if (!isCheckedOut) {
        // Item is not checked out, proceed with a new checkout.
        const checkOutRequestModel = {
          "$type": "CheckOutRequest",
          "SetPermanentLock": true
        };
        const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, checkOutRequestModel);
        checkedOutItem = checkOutResponse.data;
      } else {
        // Item is checked out by the agent, so we can use the existing item data.
        checkedOutItem = item;
      }

      // Steps 3 & 4: Apply the new content and metadata to the stored item model.
      if (content) {
        try {
          checkedOutItem.Content = JSON.parse(content);
        } catch (e) {
          let errorMessage = "An unknown error occurred.";
          if (e instanceof Error) {
            errorMessage = e.message;
          }
          throw new Error(`Invalid JSON format for content: ${errorMessage}`);
        }
      }
      if (metadata) {
        try {
          checkedOutItem.Metadata = JSON.parse(metadata);
        } catch (e) {
          let errorMessage = "An unknown error occurred.";
          if (e instanceof Error) {
            errorMessage = e.message;
          }
          throw new Error(`Invalid JSON format for metadata: ${errorMessage}`);
        }
      }

      // Step 5: Update the component with a PUT request.
      const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, checkedOutItem);
      if (updateResponse.status !== 200) {
        throw new Error(`Update failed with status: ${updateResponse.status}`);
      }

      // Step 6: Check in the item.
      const checkInRequestModel = {
        "$type": "CheckInRequest",
        "RemovePermanentLock": true
      };
      const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, checkInRequestModel);
      if (checkInResponse.status === 200) {
        return {
          content: [{ type: "text", text: `Successfully updated and checked in component ${itemId}.` }],
        };
      } else {
        throw new Error(`Check-in failed with status: ${checkInResponse.status}`);
      }
    } catch (error) {
      // In case of any error, attempt to undo the checkout to release the lock.
      // This undo checkout logic is only needed if the item was checked out as part of this tool run.
      // If the item was already checked out to the agent, we don't undo it.
      if (checkedOutItem && checkedOutItem?.VersionInfo?.CheckOutUser?.IdRef === agentId) {
        try {
          await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
          console.error(`Successfully undid checkout for item ${itemId} due to an error.`);
        } catch (undoError) {
          console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
        }
      }

      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to update component: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "search",
  `Performs a comprehensive search on the Content Manager System (CMS) for various item types based on a wide range of criteria.
  This tool is used to find items that match the specified query, such as full-text search strings, item titles, types, authors, lock status, and more.
  The return value will be an array of items that match the search criteria or an empty array if no items are found.
  This tool cannot modify, update, or delete any CMS items or files.`,
  {
    // This search tool supports a single query object, not an array.
    searchQuery: SearchQueryValidation.optional().describe("A search query model. If not provided, a default search for all items is performed."),

    // --- Global Settings ---
    resultLimit: z.number().int().default(100).optional().describe("The maximum number of results to return."),
    details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).default("IdAndTitleOnly").optional().describe("Specifies the level of details in the returned items."),
  },
  // The function now takes a single `searchQuery` object instead of an array.
  async ({ searchQuery, resultLimit, details }) => {
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
);

server.tool(
  "createItem",
  `Creates a new Content Manager System (CMS) item of a specified type.
This tool first retrieves a default data model for the item type and its location, then customizes it with the provided details before sending the creation request.
To use this tool, the agent must provide the 'itemType', a 'title', and the 'locationId' (the TCM URI of the parent Folder, Structure Group, etc.).

For certain item types, additional parameters are mandatory:
- Page: Requires 'fileName' and 'pageTemplateId'.
- Component: Requires 'schemaId'.

If the item uses a Schema (for content) or a Metadata Schema (for metadata) that contains mandatory fields without default values, the agent must provide these values in the 'content' or 'metadata' objects. The structure of these JSON objects must exactly match the XML field names defined in the corresponding XSD schema.`,
  {
    itemType: z.enum([
      "Component", "Folder", "StructureGroup", "Keyword",
      "Category", "Page", "Schema", "Bundle", "SearchFolder"
    ]).describe("The type of CMS item to create."),
    title: z.string().describe("The title for the new item."),
    locationId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The TCM URI of the parent container (e.g., Folder, Structure Group, Category) where the new item will be created."),
    schemaId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).optional().describe("Required for 'Component' and 'Page'. The TCM URI of the Schema to use for the item's content."),
    metadataSchemaId: z.string().regex(/^(tcm):\d+-\d+(-\d+)?$/).optional().describe("Optional. The TCM URI of the Metadata Schema for the item's metadata."),
    content: z.record(z.any()).optional().describe("A JSON object for the item's content fields, structured according to its Schema. Required if the Schema has mandatory fields without default values."),
    metadata: z.record(z.any()).optional().describe("A JSON object for the item's metadata fields, structured according to its Metadata Schema. Required if the Metadata Schema has mandatory fields without default values."),
    fileName: z.string().optional().describe("Required for 'Page' type. The file name for the page, including the extension (e.g., 'about-us.html')."),
    pageTemplateId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).optional().describe("Required for 'Page' type. The TCM URI of the Page Template to be associated with the Page."),
    isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword. Defaults to false."),
    description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, and Bundle types."),
    key: z.string().optional().describe("A custom key for the Keyword. Only applicable to Keyword type."),
    parentKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of URIs for parent Keywords. Only applicable to Keyword type."),
    relatedKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of URIs for related Keywords. Only applicable to Keyword type."),
    itemsInBundle: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of TCM URIs for items in the Bundle. Only applicable to Bundle type."),
    searchQuery: SearchQueryValidation.optional().describe("A search query model. This is only applicable (and must be provided) when creating a 'SearchFolder'. For SearchFolder creation, its value MUST include the 'SearchIn' property."),
    resultLimit: z.number().int().default(100).describe("The maximum number of results to return. Only applicable to SearchFolder type")
  },
  async ({ itemType, title, locationId, schemaId, metadataSchemaId, content, metadata, fileName, pageTemplateId, isAbstract, description, key, parentKeywords, relatedKeywords, itemsInBundle, searchQuery, resultLimit }) => {
    // Helper function to create a Link array
    const toLinkArray = (ids: string[] | undefined) => (ids && ids.length > 0 ? ids.map(id => ({ "$type": "Link", "IdRef": id })) : undefined);
    console.log('SearchQuery', searchQuery);
    console.log('Creating item of type:', itemType);
    if (!itemType) {
      console.log('No model type.');
      return { content: [], errors: [{ message: `Invalid itemType specified: ${itemType}` }] };
    }

    // Perform validation for type-specific required fields
    if (itemType === 'Page' && (!fileName || !pageTemplateId)) {
      console.log('Missing parameters for Page creation.');
      return { content: [], errors: [{ message: "To create a 'Page', both 'fileName' and 'pageTemplateId' parameters are required." }] };
    }
    if (itemType === 'Component' && !schemaId) {
      console.log('Missing parameters for Component creation.');
      return { content: [], errors: [{ message: "To create a 'Component', the 'schemaId' parameter is required." }] };
    }
    console.log('Query', searchQuery);
    if (itemType === 'SearchFolder' && !searchQuery) {
      console.log('Missing parameters for SearchFolder creation.');
      return { content: [], errors: [{ message: "To create a 'SearchFolder', the 'searchQuery' parameter is required." }] };
    }

    try {
      // 1. Get the default model for the item type and location from the API
      console.log('Fetching default model for', itemType, 'with container ID', locationId);
      const defaultModelResponse = await authenticatedAxios.get(`/item/defaultModel/${itemType}`, {
        params: {
          containerId: locationId
        }
      });
      console.log('default model', defaultModelResponse);
      if (defaultModelResponse.status !== 200) {
        console.log('Failed to retrieve default model.');
        return { content: [], errors: [{ message: `Failed to retrieve default model. Status: ${defaultModelResponse.status}, Message: ${defaultModelResponse.statusText}` }] };
      }

      const payload = defaultModelResponse.data;

      // 2. Customize the payload by merging the default model with the provided arguments
      payload.Title = title;
      if (schemaId) payload.Schema = { IdRef: schemaId };
      if (metadataSchemaId) payload.MetadataSchema = { IdRef: metadataSchemaId };
      if (content) payload.Content = content;
      if (metadata) payload.Metadata = metadata;

      // Add properties specific to certain item types
      if (itemType === 'Page') {
        payload.FileName = fileName;
        payload.PageTemplate = { IdRef: pageTemplateId };
      }
      if (itemType === 'Keyword') {
        if (typeof isAbstract === 'boolean') {
          payload.IsAbstract = isAbstract;
        }
        if (description) {
          payload.Description = description;
        }
        if (key) {
          payload.Key = key;
        }
        // Correctly format parent and related keywords using the toLinkArray helper
        payload.ParentKeywords = toLinkArray(parentKeywords);
        payload.RelatedKeywords = toLinkArray(relatedKeywords);
      }

      // Special logic for SearchFolder
      if (itemType === 'SearchFolder' && searchQuery) {
        const searchInValue = searchQuery.SearchIn as any;

        if (searchInValue && typeof searchInValue === 'object' && searchInValue.IdRef) {
          searchQuery.SearchIn = searchInValue.IdRef;
        }
        payload.Configuration = generateSearchFolderXmlConfiguration(searchQuery, resultLimit);
        console.log('SearchFolder XML', payload.Configuration);
      }

      if (itemType === 'Bundle') {
        payload.Items = toLinkArray(itemsInBundle);
        console.log('Items in bundle', payload.Items);
      }

      console.log('parent keywords', payload.ParentKeywords);
      // Add description for other applicable types
      if ((itemType === 'Category' || itemType === 'Bundle' || itemType === 'Schema' || itemType === 'SearchFolder') && description) {
        payload.Description = description;
      }

      // The default model should set the location, but this ensures it's correct.
      if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
        payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: { IdRef: locationId } };
      }
      console.log('Payload', payload);

      // 3. Post the customized payload to the /items endpoint to create the item
      const createResponse = await authenticatedAxios.post('/items', payload);

      // A successful creation returns a 201 status code
      if (createResponse.status === 201) {
        return {
          content: [
            {
              type: "text",
              text: `Successfully created ${itemType} with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
            }
          ],
        };
      } else {
        return {
          content: [],
          errors: [
            { message: `Unexpected response status during item creation: ${createResponse.status}` },
          ],
        };
      }

    } catch (error) {
      console.error('Error during item creation:', error);
      // Provide detailed error feedback for easier debugging by the agent
      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to create CMS item: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "updateItemById",
  `Updates an existing Content Manager System (CMS) item of a specified type.
This tool can update various properties like title, description, content, and metadata.
For versioned item types ('Component', 'Page', 'Schema'), it automatically handles check-out and check-in.
If only updating content or metadata for a Component, you can use the updateComponentById tool.
If the item is locked by another user, the operation will be aborted.`,
  {
    itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID of the CMS item to update."),
    itemType: z.enum([
      "Component", "Folder", "StructureGroup", "Keyword",
      "Category", "Page", "Schema", "Bundle", "SearchFolder"
    ]).describe("The type of the CMS item to update."),
    // Optional fields for update, similar to createItem
    title: z.string().optional().describe("The new title for the item."),
    schemaId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the Schema to use for the item's content. (Applicable to Component/Page)"),
    metadataSchemaId: z.string().regex(/^(tcm):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the Metadata Schema for the item's metadata."),
    content: z.record(z.any()).optional().describe("A JSON object for the item's content fields. Replaces existing content."),
    metadata: z.record(z.any()).optional().describe("A JSON object for the item's metadata fields. Replaces existing metadata."),
    fileName: z.string().optional().describe("The new file name for the page. (Applicable to Page)"),
    pageTemplateId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the Page Template. (Applicable to Page)"),
    isAbstract: z.boolean().optional().describe("Set to true to make a Keyword abstract. (Applicable to Keyword)"),
    description: z.string().optional().describe("A new description for the item."),
    key: z.string().optional().describe("A new custom key for the Keyword. (Applicable to Keyword)"),
    parentKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of parent Keyword URIs. Replaces existing parents. (Applicable to Keyword)"),
    relatedKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of related Keyword URIs. Replaces existing relations. (Applicable to Keyword)"),
    itemsInBundle: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of item URIs for the Bundle. Replaces existing items. (Applicable to Bundle)"),
    searchQuery: SearchQueryValidation.optional().describe("A new search query model for the Search Folder."),
    resultLimit: z.number().int().optional().describe("A new result limit for the Search Folder.")
  },
  async (params) => {
    const { itemId, itemType, ...updates } = params;
    const restItemId = itemId.replace(':', '_');
    const versionedItemTypes = ["Component", "Page", "Schema"];
    const isVersioned = versionedItemTypes.includes(itemType);

    let agentId = null;
    let wasCheckedOutByTool = false;

    // Helper function to create a Link array
    const toLinkArray = (ids: string[] | undefined) => (ids && ids.length > 0 ? ids.map(id => ({ "$type": "Link", "IdRef": id })) : undefined);

    try {
      let itemToUpdate;

      if (isVersioned) {
        // --- Versioned Item Handling ---
        // 1. Get agent's user ID
        const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
        agentId = whoAmIResponse.data?.User?.Id;
        if (!agentId) {
          throw new Error("Could not retrieve agent's user ID from whoAmI endpoint.");
        }

        // 2. Get item and check lock status
        const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
        const currentItem = getItemResponse.data;
        const isCheckedOut = currentItem?.LockInfo?.LockType?.includes('CheckedOut');
        const checkedOutUser = currentItem?.VersionInfo?.CheckOutUser?.IdRef;

        if (isCheckedOut && checkedOutUser !== agentId) {
          return {
            content: [],
            errors: [{ message: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.` }],
          };
        }

        // 3. Check out if necessary, or get dynamic version if already checked out by agent
        if (!isCheckedOut) {
          const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, {
            "$type": "CheckOutRequest",
            "SetPermanentLock": true
          });
          itemToUpdate = checkOutResponse.data;
          wasCheckedOutByTool = true;
        } else {
          // Already checked out by agent, get the latest dynamic version to apply updates to
          const dynamicItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
            params: { useDynamicVersion: true }
          });
          itemToUpdate = dynamicItemResponse.data;
        }
      } else {
        // --- Non-Versioned Item Handling ---
        const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
        itemToUpdate = getItemResponse.data;
      }

      // --- Apply Updates to the Item JSON ---
      if (updates.title) itemToUpdate.Title = updates.title;
      if (updates.schemaId) itemToUpdate.Schema = { IdRef: updates.schemaId };
      if (updates.metadataSchemaId) itemToUpdate.MetadataSchema = { IdRef: updates.metadataSchemaId };
      if (updates.content) itemToUpdate.Content = updates.content;
      if (updates.metadata) itemToUpdate.Metadata = updates.metadata;
      if (updates.description) itemToUpdate.Description = updates.description;

      // Type-specific updates
      if (itemType === 'Page') {
        if (updates.fileName) itemToUpdate.FileName = updates.fileName;
        if (updates.pageTemplateId) itemToUpdate.PageTemplate = { IdRef: updates.pageTemplateId };
      }
      if (itemType === 'Keyword') {
        if (updates.isAbstract !== undefined) itemToUpdate.IsAbstract = updates.isAbstract;
        if (updates.key) itemToUpdate.Key = updates.key;
        if (updates.parentKeywords) itemToUpdate.ParentKeywords = toLinkArray(updates.parentKeywords);
        if (updates.relatedKeywords) itemToUpdate.RelatedKeywords = toLinkArray(updates.relatedKeywords);
      }
      if (itemType === 'Bundle' && updates.itemsInBundle) {
        itemToUpdate.Items = toLinkArray(updates.itemsInBundle);
      }
      if (itemType === 'SearchFolder' && updates.searchQuery) {
        itemToUpdate.Configuration = generateSearchFolderXmlConfiguration(updates.searchQuery, updates.resultLimit);
      }

      // --- Send PUT request to update the item ---
      const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
      if (updateResponse.status !== 200) {
        throw new Error(`Update failed with status: ${updateResponse.status} - ${updateResponse.statusText}`);
      }
      const updatedItem = updateResponse.data;

      // --- Check-in for versioned items ---
      if (isVersioned) {
        const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, {
          "$type": "CheckInRequest",
          "RemovePermanentLock": true
        });
        if (checkInResponse.status !== 200) {
          throw new Error(`Check-in failed with status: ${checkInResponse.status}`);
        }
        return {
          content: [{ type: "text", text: `Successfully updated and checked in ${itemType} ${itemId}.\n\n${JSON.stringify(updatedItem, null, 2)}` }],
        };
      }

      // --- Success for non-versioned items ---
      return {
        content: [{ type: "text", text: `Successfully updated ${itemType} ${itemId}.\n\n${JSON.stringify(updatedItem, null, 2)}` }],
      };

    } catch (error) {
      // --- Error Handling & Undo Checkout ---
      if (isVersioned && wasCheckedOutByTool) {
        try {
          await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
          console.error(`Successfully undid checkout for item ${itemId} due to an error.`);
        } catch (undoError) {
          console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
        }
      }

      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to update ${itemType} ${itemId}: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "dependencyGraphForItem",
  `Returns items in the Content Management System that are either dependencies of (direction = uses) or dependent on (direction = UsedBy) the specified item.`,
  {
    itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID of the item for which the dependency graph should be retrieved."),
    direction: z.enum(["Uses", "UsedBy"]).optional().default("Uses").describe("Specifies the direction of the dependencies. 'Uses' returns items this item depends on; 'UsedBy' returns items that depend on this item."),
    contextRepositoryId: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of an ancestor Publication (a Publication higher in the BluePrint). If specified, the response will indicate whether the dependent items exist in this Publication."),
    rloItemTypes: z.array(z.enum([
      "Component",
      "Page",
      "Schema",
      "ComponentTemplate",
      "PageTemplate",
      "TemplateBuildingBlock",
      "BusinessProcessType",
      "VirtualFolder",
      "ProcessDefinition",
      "Folder",
      "StructureGroup",
      "Category",
      "Keyword",
      "TargetGroup",
    ])).optional().describe("Filters the results to include only these types of repository-local objects. Note that the Bundle and SearchFolder types are both instances of VirtualFoler."),
    includeContainers: z.boolean().optional().default(false).describe("If true and direction is 'Uses', the parent Folders or Structure Groups of the items in the graph are also returned (recursively)."),
    resultLimit: z.number().int().optional().default(1000).describe("The maximum number of dependency nodes to return."),
    details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("IdAndTitleOnly").describe("Specifies the level of detail for the items returned in the graph."),
  },
  async ({ itemId, direction, contextRepositoryId, rloItemTypes, includeContainers, resultLimit, details }) => {
    try {
      // The API requires the colon in the TCM URI to be replaced with an underscore.
      const restItemId = itemId.replace(':', '_');

      // Assemble the query parameters for the API request.
      const params = {
        direction,
        contextRepositoryId,
        rloItemTypes,
        includeContainers,
        resultLimit,
        details
      };

      // Remove any parameters that are undefined, so they are not sent in the request.
      const cleanParams = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined));

      // Make the GET request to the dependencyGraph endpoint.
      const response = await authenticatedAxios.get(`/items/${restItemId}/dependencyGraph`, {
        params: cleanParams
      });

      // A successful request will return a 200 OK status.
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
        // Handle any unexpected, non-error status codes.
        return {
          content: [],
          errors: [
            { message: `Unexpected response status: ${response.status}` },
          ],
        };
      }
    } catch (error) {
      // Handle errors from the API call, such as 404 Not Found or 500 Internal Server Error.
      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to retrieve dependency graph for item ${itemId}: ${errorMessage}` }],
      };
    }
  }
);

server.tool(
  "getPublications",
  `Retrieves a list of all Publications in the Content Management System.
  Since the Title property of a Publication must be unique, this tool can be used to lookup the TCM URI of a Publication when only the Title is known.
  For this use case, the tool should be used with the 'details' level set to 'IdAndTitleOnly' since additional data is not required.`,
  {
    details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("IdAndTitleOnly").describe("Specifies the level of detail for the returned publications. Contentless returns the most detail. If full details of an individual Publication are required, it should be obtained using getItemById."),
  },
  async ({ details }) => {
    try {
      // Make the GET request to the publications endpoint.
      const response = await authenticatedAxios.get('/publications', {
        params: {
          details
        }
      });

      // A successful request will return a 200 OK status.
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
        // Handle any unexpected, non-error status codes.
        return {
          content: [],
          errors: [
            { message: `Unexpected response status: ${response.status}` },
          ],
        };
      }
    } catch (error) {
      // Handle errors from the API call, such as a 500 Internal Server Error.
      const errorMessage = axios.isAxiosError(error)
        ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
        : String(error);
      return {
        content: [],
        errors: [{ message: `Failed to retrieve publications: ${errorMessage}` }],
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
