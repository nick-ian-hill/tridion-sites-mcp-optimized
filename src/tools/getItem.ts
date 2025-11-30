import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getItem = {
    name: "getItem",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item.
This is the primary tool for fetching the FULL data of an item.
To avoid polluting the context window, use the 'includeProperties' parameter to request only what you need.

### MASTER PROPERTY REFERENCE
You can request these properties using dot notation (e.g., 'VersionInfo.RevisionDate', 'BinaryContent.MimeType').

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
    * **IsLocalized**: (boolean) True if item is a local copy.
    * **IsShared**: (boolean) True if item is visible from a parent.
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
    * **ComponentPresentations**: Array of CPs on the page.
    * **Regions**: Array of regions and their content.
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

* **Target Type**:
    * **Purpose**: e.g., 'Staging' or 'Live'.
    * **BusinessProcessType**: Link to the BPT.

* **Activity Instance** (Workflow):
    * **ActivityState**: 'Assigned', 'Started', 'Finished', etc.
    * **Assignee**: Link to User or Group.
    * **ActivityDefinition**: Link to the definition (contains description/instructions).
    * **WorkItems**: Array of items in the workflow package.
    * **ProcessInstance**: Link to the parent process (workflow).`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Defaults to true. For versioned items, retrieves the latest saved state (dynamic version), including minor revisions (checked-out). Set to false to strictly retrieve the last checked-in major version."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names (supports dot notation like 'BinaryContent.MimeType'). 'Id', 'Title', and 'type' are always included.`)
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