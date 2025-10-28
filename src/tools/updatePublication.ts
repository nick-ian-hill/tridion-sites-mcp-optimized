import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const updatePublication = {
    name: "updatePublication",
    description: `Updates an existing Publication. Publications are the main organizational units in the Content Management System, acting as containers for content and design items.
    Updating a Publication might be necessary to change its URL settings, adjust paths for multimedia, set a different locale, or reconfigure default templates and workflow processes.
    Publications are central to BluePrinting, where they can be parents (sharing content) or children (inheriting content).
    This tool modifies the properties of a single, existing Publication.

Examples:

Example 1: Updates the title and publication URL for the Publication with ID tcm:0-1-1.
    const result = await tools.updatePublication({
        itemId: "tcm:0-1-1",
        title: "Global Website - Updated",
        publicationUrl: "/global-site"
    });

Example 2: Changes the locale to French (France) and sets a new default Page Template for the Publication with ID tcm:0-5-1.
    const result = await tools.updatePublication({
        itemId: "tcm:0-5-1",
        locale: "fr-FR",
        defaultPageTemplate: "tcm:5-123-128"
    });

Example 3: Update the default task process and enable workflow process associations for a Publication.
    const result = await tools.updatePublication({
        itemId: "tcm:0-5-1",
        defaultTaskProcessId: "tcm:5-1-131074",
        enableWorkflowProcessAssociations: true
    });`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+-1$/).describe("The unique ID of the Publication to update."),
        title: z.string().optional().describe("The new title for the Publication."),
        parentPublications: z.array(z.string().regex(/^tcm:\d+-\d+-1$/)).optional().describe("An array of URIs for parent Publications. Only applicable for Publications that already have at least 1 parent."),
        publicationPath: z.string().optional().describe("The new publication path, which forms the base of the publish path for items within this Publication."),
        publicationUrl: z.string().optional().describe("The new server-relative URL for the Publication."),
        multimediaPath: z.string().optional().describe("The new physical server path where multimedia binaries will be published."),
        multimediaUrl: z.string().optional().describe("The new URL corresponding to the Multimedia Path."),
        defaultPageTemplate: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the new default Page Template."),
        defaultComponentTemplate: z.string().regex(/^tcm:\d+-\d+-32$/).optional().describe("The TCM URI of the new default Component Template."),
        defaultTemplateBuildingBlock: z.string().regex(/^tcm:\d+-\d+-2048$/).optional().describe("The TCM URI of the new default Template Building Block."),
        defaultMultimediaSchema: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the new default Multimedia Schema. This is the Schema that will be used by default when creating a new Multimedia Component."),
        pageSnapshotTemplate: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the new Page Template for rendering Page snapshots in Workflow."),
        componentSnapshotTemplate: z.string().regex(/^tcm:\d+-\d+-32$/).optional().describe("The TCM URI of the new Component Template for rendering Component snapshots in Workflow."),
        pageTemplateProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the Process Definition to associate with Page Templates."),
        componentTemplateProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the Process Definition to associate with Component Templates."),
        defaultTaskProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the default Process Definition for tasks."),
        templateBundleProcess: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the new Process Definition to associate with Template Bundles."),
        enableWorkflowProcessAssociations: z.boolean().optional().describe("If true, enables Workflow Process Associations in Shared Schemas and Structure Groups."),
        locale: z.string().optional().describe("The new locale for the Publication (e.g., 'en-US', 'de-DE')."),
        publicationType: z.string().optional().describe("The new type of the Publication (e.g., 'Web', 'Content'). Use the getPublicationTypes tool to see the available types.")
    },
    execute: async (params: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, ...updates } = params;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            const itemToUpdate = getItemResponse.data;

            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.publicationPath) itemToUpdate.PublicationPath = updates.publicationPath;
            if (updates.publicationUrl) itemToUpdate.PublicationUrl = updates.publicationUrl;
            if (updates.multimediaPath) itemToUpdate.MultimediaPath = updates.multimediaPath;
            if (updates.multimediaUrl) itemToUpdate.MultimediaUrl = updates.multimediaUrl;
            if (updates.locale) itemToUpdate.Locale = updates.locale;
            if (updates.publicationType) itemToUpdate.PublicationType = updates.publicationType;

            if (updates.enableWorkflowProcessAssociations !== undefined) {
                itemToUpdate.EnableWorkflowProcessAssociations = updates.enableWorkflowProcessAssociations;
            }

            if (updates.defaultPageTemplate) itemToUpdate.DefaultPageTemplate = toLink(updates.defaultPageTemplate);
            if (updates.defaultComponentTemplate) itemToUpdate.DefaultComponentTemplate = toLink(updates.defaultComponentTemplate);
            if (updates.defaultTemplateBuildingBlock) itemToUpdate.DefaultTemplateBuildingBlock = toLink(updates.defaultTemplateBuildingBlock);
            if (updates.defaultMultimediaSchema) itemToUpdate.DefaultMultimediaSchema = toLink(updates.defaultMultimediaSchema);
            if (updates.pageSnapshotTemplate) itemToUpdate.PageSnapshotTemplate = toLink(updates.pageSnapshotTemplate);
            if (updates.componentSnapshotTemplate) itemToUpdate.ComponentSnapshotTemplate = toLink(updates.componentSnapshotTemplate);
            if (updates.pageTemplateProcessId) itemToUpdate.PageTemplateProcess = toLink(updates.pageTemplateProcessId);
            if (updates.componentTemplateProcessId) itemToUpdate.ComponentTemplateProcess = toLink(updates.componentTemplateProcessId);
            if (updates.defaultTaskProcessId) itemToUpdate.DefaultProcessDefinitions = toLinkArray([updates.defaultTaskProcessId]);
            if (updates.templateBundleProcess) itemToUpdate.TemplateBundleProcess = toLink(updates.templateBundleProcess);
            if (updates.parentPublications) itemToUpdate.ParentPublications = toLinkArray(updates.parentPublications);

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);

            if (updateResponse.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully updated Publication ${itemId}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(updateResponse);
            }

        } catch (error) {
            return handleAxiosError(error, `Failed to update Publication ${itemId}`);
        }
    }
};