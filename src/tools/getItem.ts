import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getItem = {
    name: "getItem",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item.
This is the primary tool for "fetching" the FULL data of an item. To avoid polluting the context window, use the 'includeProperties' parameter to request only what you need.

### Available Properties Reference
You can request these properties using dot notation (e.g., 'VersionInfo.RevisionDate', 'BinaryContent.MimeType').

**1. Standard Properties (Always Returned)**
* **Id**: The TCM URI (e.g., 'tcm:5-123'). You do not need to request this.
* **Title**: The name of the item. You do not need to request this.
* **type**: The object type (e.g., 'Component', 'Page'). You do not need to request this.

**2. Common Optional Properties**
* **Description**: The description field.
* **Metadata**: The dictionary of metadata field values.
* **MetadataSchema**: Link to the schema defining the metadata ({ IdRef, Title }).
* **LocationInfo**:
    * **Path**: The folder path (e.g., "\\Content\\News").
    * **OrganizationalItem**: Link to the parent Folder/Structure Group.
    * **ContextRepository**: Link to the Publication containing the item.
    * **WebDavUrl**: The WebDAV access path.
* **BluePrintInfo** (Crucial for inheritance):
    * **IsLocalized**: (boolean) True if item is a local copy.
    * **IsShared**: (boolean) True if item is visible from a parent.
    * **OwningRepository**: For shared items, a Link to the Publication from which the item is inherited (not necessarily the Primary item). For a Primary or Localized item, a link to the Publication containing the item.
    * **PrimaryBluePrintParentItem**: A Link to the Primary item. An item in a parent Publication is inherited by all child Publications. An item's Primary item is the original instance of that item, i.e., the instance of the item in an ancestor Publication from which all other instances are inherited.
* **VersionInfo**:
    * **Version**: (number) Current major version.
    * **Revision**: (number) Current minor version.
    * **CreationDate**: ISO date string.
    * **RevisionDate**: ISO date string (last modified).
    * **Creator**: Link to the User who created it.
    * **Revisor**: Link to the User who last modified it.
* **LockInfo**:
    * **LockType**: ['CheckedOut' | 'InWorkflow' | 'None'].
    * **LockUser**: Link to the User holding the lock.
    * **LockDate**: Date the lock was applied.

**3. Type-Specific Properties**
* **Publication**:
    * **PublicationUrl**, **PublicationPath**: Web delivery settings.
    * **MultimediaUrl**, **MultimediaPath**: Binary delivery settings.
    * **RootFolder**, **RootStructureGroup**: Links to root containers.
    * **Parents**: Array of Links to parent Publications.
* **Component**:
    * **Schema**: Link to the Component Schema.
    * **Content**: The dictionary of content field values.
    * **ComponentType**: 'Normal' or 'Multimedia'.
    * **BinaryContent** (Multimedia only):
        * **Filename**, **Size**, **MimeType**, **Url**.
        * **MultimediaType**: Link to the file type definition.
* **Page**:
    * **FileName**: The filename (e.g., 'index').
    * **PageTemplate**: Link to the associated Page Template.
    * **ComponentPresentations**: Array of CPs on the page.
    * **Regions**: Array of regions and their content.
* **Schema**:
    * **Purpose**: 'Component', 'Multimedia', 'Metadata', 'Region', etc.
    * **RootElementName**: XML root name.
    * **Fields**: Definitions for content fields.
    * **MetadataFields**: Definitions for metadata fields.
* **Structure Group**:
    * **Directory**: The directory name in the URL path.
    * **DefaultPageTemplate**: Link to default PT.
* **Keyword**:
    * **Key**: Custom key string.
    * **IsAbstract**: (boolean).
    * **ParentKeywords**: Array of links to parents.
    * **RelatedKeywords**: Array of links to relations.
* **Category**:
    * **IsTaxonomyRoot**: (boolean).
    * **KeywordMetadataSchema**: Link to schema for keywords in this category.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Defaults to true. For versioned items (Components, Pages, Templates, Schemas), this retrieves the latest saved state (dynamic version), including minor revisions and checked-out changes. Set to false to strictly retrieve the last checked-in major version. This parameter is ignored for non-versioned items."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names (supports dot notation like 'BinaryContent.MimeType'). 'Id', 'Title', and 'type' are always included. Refer to the tool description for a comprehensive list of available properties.`)
    },
    execute: async ({ itemId, useDynamicVersion = true, includeProperties }: { 
        itemId: string, 
        useDynamicVersion?: boolean,
        includeProperties?: string[] 
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const params: { useDynamicVersion?: boolean } = {};

            if (useDynamicVersion) {
                params.useDynamicVersion = true;
            }

            const response = await authenticatedAxios.get(`/items/${restItemId}`, { params });

            if (response.status === 200) {
                const finalData = filterResponseData({ responseData: response.data, includeProperties });
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
            return handleAxiosError(error, "Failed to authenticate or retrieve item");
        }
    }
};