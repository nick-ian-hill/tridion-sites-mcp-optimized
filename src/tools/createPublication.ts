import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const createPublication = {
    name: "createPublication",
    description: `Creates a new Publication in the Content Management System.

Introduction to Publications and BluePrints
- Publications are the main organizational units in the Content Manager. They act as containers for all other content and design items like Components, Pages, Schemas, Categories, Keywords, and Templates.
- BluePrinting is a hierarchical structure of related Publications that enables you to organize, reuse, and manage content and structure across multiple Publications within a single CMS instance.
- The system can contain multiple BluePrint hierarchies, but a Publication can only belong to at most one hierarchy, and all Publications in a hierarchy must share a common root Structure Group. It is not possible to remove a Publication from a hierarchy, but it can be deleted if none of its items are published or localized.

Core Concepts and Terminology
- Root Publication: The top-level parent in a BluePrint hierarchy. Since it has no parent, it contains only items created within that Publication (local items). To create a root Publication, do not specify any parent Publications. To be referenced as a parent, a Publication must have a root Structure Group. IMPORTANT It is only neccessary to create a root structure group for the root Publication, as it will be inherited by child Publications.
- BluePrint Hierarchy: A system of two or more Publications where every Publication is a direct child or descendent of a common root Publication.
- Inheritance: Items created in a parent Publication are shared down the BluePrint hierarchy to all child Publications.
- Parent Publication: A Publication that is refenced as a parent by one or more Publications. All items in a parent Publication are inherited by its children and their descendents. When you make changes to a Primary item in a parent Publication, those changes are automatically applied to shared items in child Publications.
- Child Publication: Inherits items from one or more parent Publications. The parent Publications must belong to the same BluePrint hierarchy, i.e., share a common root Structure Group. It can also contain its own local content, which can be combined with shared content.
- Primary Item: An item that is not shared or localized from an item in an ancestor Publication. Changes to a Primary item are inherited by shared instances of the item in descended Publications.
- Owning Item: A primary item or an item that has been localized. Changes to an owning item will impact shared copies of that item in descendent Publications.
- Shared Item: A read-only item that is inherited from its owning item.
- Localized Item: An inherited item that is localized in the current Publication. Localizing an item breaks the inheritance from the owning item and makes the localized item editable. After localization, subsequent changes to the owning item no longer modify the localized item.

Business Rules for Effective BluePrints
- Hierarchy Structure: A BluePrint hierarchy has a single root Publication. Only Publications that have a root Structure Group can have child Publications.
- Content cannot be moved between different Publications. However, it is possible to move a primary item up or down the hierarchy using the Promote and Demote tools.
- Inheritance Conflict Resolution:
  1. Proximity Rule: A child Publication inherits an item from the closest parent (fewest hops) that contains a localized or original version of that item.
  2. Priority Rule (Tie-Breaker): If multiple parents are equally close, the one with the highest priority is chosen. Priority is determined by the order in the 'parentPublications' array; the Publication with the lowest index has the highest priority.
- Localization Flexibility: Most content and metadata fields can be localized. However, individual fields can be defined as non-localizable via the Schema, meaning their values will always be shared from the primary item and cannot be modified in a localized item.

Practical Application
- BluePrint hierarchies are ideal for managing multi-language websites, different brand channels, or various stages of a project (development, staging, live).
- For multi-language sites, the BluePrint structure drives translations and dictates the translation flow. Content created at a corporate level can be shared down the hierarchy to country-specific Publications, where it can be localized, translated, and supplemented with local content.

Examples:

Example 1: Creates a new child Publication with a title, a publication URL for web content, a specific URL for multimedia items, and sets its locale to US English.
    const result = await tools.createPublication({
        title: "My New Website Publication",
        parentPublications: ['tcm:0-5-1'],
        publicationUrl: "/my-new-site",
        multimediaUrl: "/my-new-site/images",
        locale: "en-US"
    });

Example 2: Creates a basic 'Content' Publication that inherits structure (templates and template building blocks) from tcm:0-2-1 and content/metadata schemas from tcm:0-3-1.
    const result = await tools.createPublication({
        title: "Corporate Master Content",
        parentPublications: ['tcm:0-2-1', 'tcm:0-3-1'],
        publicationType: "Content"
    });

Example 3: Creates a Publication and configures its default workflow processes.
    const result = await tools.createPublication({
        title: "Editorial Workflow Publication",
        parentPublications: ['tcm:0-5-1'],
        publicationUrl: "/editorial",
        defaultTaskProcessId: "tcm:5-1-131074",
        enableWorkflowProcessAssociations: true
    });`,
    input: {
        title: z.string().describe("The title for the new Publication."),
        parentPublications: z.array(z.string().regex(/^tcm:\d+-\d+-1$/)).optional().describe("An array of URIs for parent Publications. Use the 'getPublications' tool to find available publications. The parents must belong to the same BluePrint hierarchy. If no parent Publications are specified, a root Publication will be created."),
        publicationKey: z.string().optional().describe("Optional unique key. Only provide this if the key must be different from the title. If omitted, the title is used as the key."),
        publicationPath: z.string().optional().describe("The publication path, which forms the base of the publish path for Structure Groups and Pages within this Publication."),
        publicationUrl: z.string().optional().describe("The server-relative URL for the Publication. This will be prefixed to the URLs of published Pages."),
        multimediaPath: z.string().optional().describe("The physical path on the server where multimedia binaries will be published."),
        multimediaUrl: z.string().optional().describe("The URL that corresponds to the Multimedia Path, used to construct links to published multimedia."),
        locale: z.string().optional().describe("The locale for the Publication (e.g., 'en-US', 'de-DE')."),
        publicationType: z.string().optional().describe("The type of the Publication (e.g., 'Web', 'Content'). Use the 'getPublicationTypes' tool to see the available types."),
        pageTemplateProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the Process Definition to associate with Page Templates."),
        componentTemplateProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the Process Definition to associate with Component Templates."),
        defaultTaskProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the default Process Definition for tasks."),
        enableWorkflowProcessAssociations: z.boolean().optional().describe("If true, enables Workflow Process Associations in Shared Schemas and Structure Groups.")
    },
    execute: async (args: any,
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, parentPublications, publicationKey, publicationPath,
            publicationUrl, multimediaPath, multimediaUrl, locale, publicationType,
            pageTemplateProcessId, componentTemplateProcessId, defaultTaskProcessId, enableWorkflowProcessAssociations
        } = args;

        try {
            // 1. Get the default model for a Publication
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Publication');

            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;

            // 2. Customize the payload with the provided arguments
            payload.Title = title;
            payload.Key = publicationKey || title;
            if (publicationPath) payload.PublicationPath = publicationPath;
            if (publicationUrl) payload.PublicationUrl = publicationUrl;
            if (multimediaPath) payload.MultimediaPath = multimediaPath;
            if (multimediaUrl) payload.MultimediaUrl = multimediaUrl;
            if (locale) payload.Locale = locale;
            if (publicationType) payload.PublicationType = publicationType;
            if (parentPublications) payload.Parents = toLinkArray(parentPublications);

            // Add workflow settings
            if (pageTemplateProcessId) {
                payload.PageTemplateProcess = { IdRef: pageTemplateProcessId };
            }
            if (componentTemplateProcessId) {
                payload.ComponentTemplateProcess = { IdRef: componentTemplateProcessId };
            }
            if (defaultTaskProcessId) {
                payload.DefaultProcessDefinitions = toLinkArray([defaultTaskProcessId]);
            }
            if (typeof enableWorkflowProcessAssociations === 'boolean') {
                payload.EnableWorkflowProcessAssociations = enableWorkflowProcessAssociations;
            }


            // 3. Post the customized payload to create the Publication
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                const responseData = {
                    $type: createResponse.data['$type'],
                    Id: createResponse.data.Id,
                    Message: `Successfully created ${createResponse.data.Id}`
                };
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }

        } catch (error) {
            return handleAxiosError(error, "Failed to create Publication");
        }
    }
};