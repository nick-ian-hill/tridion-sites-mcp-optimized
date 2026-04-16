import { z } from "zod";
import { isAxiosError } from "axios";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

export const getItem = {
    name: "getItem",
    summary: "Retrieves detailed properties of a single CMS item. Use 'includeProperties' to limit the response size.",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item.
Use the 'includeProperties' parameter to request only the properties you need. This is the standard usage pattern — omitting it returns the full item, which includes hundreds of lines of permissions, HATEOAS links, and system metadata that consume context window space without adding value to most tasks.

When 'includeProperties' is appropriate (most cases): looking up a title, checking BluePrintInfo, reading metadata values, inspecting schema field names, verifying a publication's parents, confirming a lock status.
When omitting 'includeProperties' is justified (full data genuinely needed): preparing to call an update tool that requires the complete item payload (e.g., updatePage, updateContent), or inspecting the full field definitions of a Schema.

Always include all relevant properties in a single call rather than making sequential calls for the same item. 

### Contextual Retrieval
You can inspect the state of an item in a specified Publication context (e.g., to check if it is localized, shared, or accessible in a sibling/parent) by providing the 'contextPublicationId' parameter. The tool will automatically resolve the correct ID for that context.

### MASTER PROPERTY REFERENCE
You can limit the response to combinations of the following properties by providing the path in the 'includeProperties' array using dot notation (e.g., 'VersionInfo.RevisionDate', 'BinaryContent.MimeType').

**1. Standard Properties (Always Returned)**
* **Id**: The TCM URI (e.g., 'tcm:5-123').
* **Title**: The name of the item.
* **type**: The object type (e.g., 'Component', 'Page').

**2. Common Optional Properties (All Types)**
* **Description**: The description field.
* **Metadata**: The dictionary of metadata field values.
* **MetadataSchema**: Link to the schema defining the metadata ({ IdRef, Title }).
* **LocationInfo**:
    * **Path**: The logical folder path (e.g., "\\Content\\News").
    * **OrganizationalItem**: Link to the parent Folder/Structure Group.
    * **ContextRepository**: Link to the Publication containing the item.
    * **WebDavUrl**: The WebDAV access path.
* **BluePrintInfo** (Crucial for inheritance):
    * **IsLocalized**: (boolean) True if item is a local (editable) copy.
    * **IsShared**: (boolean) True if item is a shared (non-editable) copy from a parent.
    * **OwningRepository**: For shared items, a Link to the Publication from which the item is inherited (not necessarily the Primary item). For a Primary or Localized item, a link to the Publication containing the item.
    * **PrimaryBluePrintParentItem**: A Link to the Primary item. An item in a parent Publication is inherited by all child Publications. An item's Primary item is the original instance of that item, i.e., the instance of the item in an ancestor Publication from which all other instances are inherited.
* **VersionInfo**:
    * **Version**: (number) Current major version.
    * **Revision**: (number) Current minor version.
    * **CreationDate**, **RevisionDate**: ISO date strings.
    * **Creator**, **Revisor**: Links to Users.
* **LockInfo**:
    * **LockType**: ['CheckedOut' | 'InWorkflow' | 'None'].
    * **LockUser**: Link to the User holding the lock.
* **SecurityDescriptor**: 
    * **Rights**: Array of rights the current user has (e.g., ['Read', 'Write', 'Localize', 'PublishManagement']).
    * **Permissions**: Access permissions.
* **ApprovalStatus**: Link to the current approval status (e.g., "Unapproved", "Live").
* **WorkflowInfo**:
    * **ActivityInstance**, **ProcessInstance**: Links to the current activity and workflow process.
    * **Assignee**, **Performer**: Links to the assignee and performer.
    * **AssignmentDate**, **CreationDate**: ISO date strings.
    * **PreviousMessage**: The optional message provided for the previous activity.

**3. Type-Specific Properties**

* **Component**:
    * **Schema**: Link to the Component Schema.
    * **Content**: The dictionary of content field values.
    * **ComponentType**: 'Normal' or 'Multimedia'.
    * **IsBasedOnMandatorySchema**: (boolean) If true, all Components in this Folder must use the Schema defined in the Folder's LinkedSchema property.
    * **BinaryContent** (Multimedia only):
        * **Filename**, **Size**, **MimeType**, **Url**.

* **Page**:
    * **FileName**: The filename (e.g., 'index.html').
    * **PageTemplate**: Link to the associated Page Template.
    * **ComponentPresentations**: Array of top-level Component Presentations on the page.
    * **Regions**: Array of regions and their Component Presentations. This is the recommended location for content in modern layouts.
    * **LocationInfo** (Page-Specific):
        * **PublishLocationUrl**: The calculated URL of the page (e.g., "/en/news/index.html").
        * **PublishPath**: The physical path on the server.

* **Folder**:
    * **LinkedSchema**: Link to the default Schema for Components in this folder.
    * **IsLinkedSchemaMandatory**: (boolean) If true, all Components in the Folder must use the LinkedSchema.

* **Structure Group**:
    * **Directory**: The directory name in the URL path.
    * **DefaultPageTemplate**: Link to default PT.
    * **IsActive**: (boolean) If false, items inside cannot be published.
    * **LocationInfo**:
        * **PublishLocationUrl**, **PublishPath** (Structure Group-Specific).

* **Category**:
    * **XmlName**: The XML name (key) of the category.
    * **KeywordMetadataSchema**: Link to the schema defining metadata for keywords in this category.
    * **AllowedParentCategories**: Array of Links to categories allowed as parents.
    * **UseForNavigation**: (boolean) Indicates if the category is used for navigation.
    * **UseForIdentification**: (boolean).
    * **IsTaxonomyRoot**: (boolean).

* **Schema** (Component, Metadata, Region, etc.):
    * **Purpose**: 'Component', 'Multimedia', 'Metadata', 'Region', 'Protocol', etc.
    * **RootElementName**: XML root name.
    * **NamespaceUri**: The target namespace URI.
    * **Fields**: Definitions for content fields.
    * **MetadataFields**: Definitions for metadata fields.
    * **RegionDefinition**: (For Region Schemas) Constraints and NestedRegions.

* **Bundle** (Virtual Folder):
    * **Items**: List of Links to items contained in the bundle.

* **Publication**:
    * **PublicationUrl**, **PublicationPath**: Web delivery settings.
    * **MultimediaUrl**, **MultimediaPath**: Binary delivery settings.
    * **RootFolder**, **RootStructureGroup**: Links to root containers.
    * **Parents**: Array of Links to parent Publications.
    * **ShareProcessAssociations**: (boolean).

* **User**:
    * **IsEnabled**: (boolean).
    * **IsPredefined**: (boolean) e.g., for System Administrator.
    * **LanguageId**, **LocaleId**: User preferences.

* **Group**:
    * **Scope**: Array of Links to Repositories for which privileges associated with this group apply.
    * **SystemPrivileges**: Array of system-wide privileges (e.g., 'TmManagement').
    * **ClaimMappings**: SSO/Directory mappings.

* **Multimedia Type**:
    * **FileExtensions**: Array of file extensions e.g., ["doc"].
    * **MimeType**: The Mime type, e.g., "application/msword".

* **Target Type**:
    * **Purpose**: e.g., 'Staging' or 'Live'.
    * **BusinessProcessType**: Link to the BPT.
    * **MinimumApprovalStatus**: Link.
    * **Priority**: Default priority.

* **Activity Instance** (Workflow):
    * **ActivityState**: 'Assigned', 'Started', 'Finished', etc.
    * **Assignee**: Link to User or Group.
    * **ActivityDefinition**: Link to the definition (contains description/instructions).
    * **WorkItems**: Array of items in the workflow package.
    * **ProcessInstance**: Link to the parent process (workflow).

* **Publish Transaction**:
    * **State**: The transaction state (e.g., 'Success', 'Failed', 'WaitingForPublish').
    * **Priority**: 'Low', 'Normal', or 'High'.
    * **Items**: Array of items being published.
    * **TargetType**: Link to the Target Type.
    * **RenderingTime**, **TotalExecutionTime**: Timing details.
    * **PublishContexts**: Array containing details about processed items.
        * **ProcessedItems**: Array of items processed during publishing.
            * **ResolvedItem**: Link to the resolved Item and Template.
            * **RenderTime**: Time taken to render.
        * **Publication**: Link to the Publication.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?(-v\d+)?|ecl:[^:\s]+(-v\d+)?)$/).describe("The unique ID of the item. To retrieve a specific historical version, append the version number to the ID (e.g., 'tcm:5-123-v2' or 'tcm:5-123-64-v1')."),
        contextPublicationId: z.string().regex(/^tcm:0-\d+-1$/).optional().describe("The TCM URI of a Publication (e.g., 'tcm:0-10-1'). If provided, the tool will automatically resolve the item within this publication context. Use this to check inheritance, localization status, field values etc. in a specific publication."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Defaults to true. For versioned items, retrieves the latest saved state (dynamic version), including minor revisions (checked-out). Set to false to strictly retrieve the last checked-in major version."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names (supports dot notation like 'BinaryContent.MimeType'). 'Id', 'Title', and 'type' are always included.`)
    },
    execute: async ({ itemId, contextPublicationId, useDynamicVersion = true, includeProperties }: {
        itemId: string,
        contextPublicationId?: string,
        useDynamicVersion?: boolean,
        includeProperties?: string[]
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            let targetItemId = itemId;
            if (contextPublicationId) {
                targetItemId = convertItemIdToContextPublication(itemId, contextPublicationId);
            }

            const restItemId = targetItemId.replace(':', '_');
            const params: { useDynamicVersion?: boolean } = {};
            if (useDynamicVersion) {
                params.useDynamicVersion = true;
            }

            const response = await authenticatedAxios.get(`/items/${restItemId}`, { params });

            if (response.status === 200) {
                const finalData = filterResponseData({
                    responseData: response.data,
                    includeProperties,
                    details: 'CoreDetails'
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
            // --- Advanced Error Handling for BluePrint Context ---
            if (contextPublicationId && isAxiosError(error) && error.response?.status === 404) {
                try {
                    // The item does not exist in the requested context.
                    // Let's verify if the ORIGINAL item exists, and if so, where else it lives.
                    const originalRestId = itemId.replace(':', '_');
                    const hierarchyResponse = await authenticatedAxios.get(`/items/${originalRestId}/bluePrintHierarchy`, {
                        params: { details: 'IdAndTitleOnly' }
                    });

                    if (hierarchyResponse.status === 200 && hierarchyResponse.data.Items) {
                        // Filter the hierarchy to find nodes where the item DOES exist (Item property is not null)
                        const validContexts = hierarchyResponse.data.Items
                            .filter((node: any) => node.Item !== null)
                            .map((node: any) => ({
                                PublicationId: node.ContextRepositoryId,
                                PublicationTitle: node.ContextRepositoryTitle,
                                ItemId: node.Item.Id,
                                Title: node.Item.Title
                            }));

                        const helpfulError = {
                            $type: "BluePrintContextError",
                            Message: `The item '${itemId}' exists, but it is NOT visible in the requested context publication ('${contextPublicationId}').`,
                            Explanation: "This typically means the context publication is not part of the inheritance path (e.g. it is a sibling or ancestor where the item is not shared).",
                            ValidContexts: validContexts
                        };

                        const formattedError = formatForAgent(helpfulError);

                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify(formattedError, null, 2)
                            }],
                            // We return this as a successful tool result (no 'isError') so the agent can read the helpful data.
                        };
                    }
                } catch (hierarchyError) {
                    // If the original item doesn't exist either, or hierarchy fetch fails, 
                    // we fall back to the standard error handler below.
                    console.error("Failed to fetch hierarchy for diagnostic:", hierarchyError);
                }
            }

            return handleAxiosError(error, "Failed to authenticate or retrieve item");
        }
    },
    examples: [
        {
            description: "Contextual Retrieval (Success). Using includeProperties to request only the information needed.",
            payload: `const result = await tools.getItem({
  itemId: "tcm:5-123",
  contextPublicationId: "tcm:0-10-1",
  includeProperties: [
    "BluePrintInfo.IsShared",
    "BluePrintInfo.OwningRepository.Title"
  ]
});

Response:
{
  "type": "Component",
  "Id": "tcm:10-123",
  "Title": "About Us",
  "BluePrintInfo": { "IsShared": true, "OwningRepository": { "Title": "05 Master" } }
}`
        },
        {
            description: "Contextual Retrieval (Error / Not Found) - If the item does not exist in the requested context (e.g., it is in a sibling publication), the tool returns a helpful error map instead of a generic 404.",
            payload: `Response:
{
  "type": "BluePrintContextError",
  "Message": "The item 'tcm:5-123' exists, but it is NOT visible in ... 'tcm:0-12-1'.",
  "ValidContexts": [
        { 
            "PublicationId": "tcm:0-5-1", 
            "PublicationTitle": "05 Master",
            "ItemId": "tcm:5-123",
            "Title": "About Us" 
        },
        { 
            "PublicationId": "tcm:0-10-1", 
            "PublicationTitle": "10 Website EN",
            "ItemId": "tcm:10-123",
            "Title": "About Us - EN" 
        }
    ]
}`
        }
    ]
};