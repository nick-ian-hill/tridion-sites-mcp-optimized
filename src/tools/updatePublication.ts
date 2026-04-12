import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi, formatForAgent } from "../utils/fieldReordering.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

export const updatePublication = {
    name: "updatePublication",
    summary: "Updates properties of an existing Publication, such as its Title or web delivery settings.",
    description: `Updates an existing Publication.
    
    Publications are the main organizational units in the Content Management System, acting as containers for content and design items.
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
        });

    Example 4: Update the metadata of a Publication.
        const result = await tools.updatePublication({
            itemId: "tcm:0-5-1",
            metadataSchemaId: "tcm:5-200-8", 
            metadata: {
                "configurationKey": "value",
                "apiEndpoint": "https://api.example.com"
            }
        });

    Example 5: Remove the metadata schema from a Publication.
        const result = await tools.updatePublication({
            itemId: "tcm:0-5-1",
            metadataSchemaId: "tcm:0-0-0"
        });
    `,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+-1$/).describe("The unique ID of the Publication to update."),
        title: z.string().optional().describe("The new title for the Publication."),
        parentPublications: z.array(z.string().regex(/^tcm:\d+-\d+-1$/)).optional().describe("An array of URIs for parent Publications. Only applicable for Publications that already have at least 1 parent."),
        publicationPath: z.string().optional().describe("The new publication path, which forms the base of the publish path for items within this Publication."),
        publicationUrl: z.string().optional().describe("The new server-relative URL for the Publication."),
        multimediaPath: z.string().optional().describe("The new physical server path where multimedia binaries will be published."),
        multimediaUrl: z.string().optional().describe("The new URL corresponding to the Multimedia Path."),
        metadataSchemaId: z.string().regex(/^(tcm:\d+-\d+-8|tcm:0-0-0)$/).optional().describe("The TCM URI of a new Metadata Schema. Replaces the existing schema. Pass 'tcm:0-0-0' to remove the metadata schema."),
        metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Publication's metadata fields. Replaces existing metadata."),
        defaultPageTemplate: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the new default Page Template."),
        defaultComponentTemplate: z.string().regex(/^tcm:\d+-\d+-32$/).optional().describe("The TCM URI of the new default Component Template."),
        defaultTemplateBuildingBlock: z.string().regex(/^tcm:\d+-\d+-2048$/).optional().describe("The TCM URI of the new default Template Building Block."),
        defaultMultimediaSchema: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the new default Multimedia Schema. This is the Schema that will be used by default when creating a new Multimedia Component."),
        pageSnapshotTemplate: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the new Page Template for rendering Page snapshots in Workflow."),
        componentSnapshotTemplate: z.string().regex(/^tcm:\d+-\d+-32$/).optional().describe("The TCM URI of the new Component Template for rendering Component snapshots in Workflow."),
        pageTemplateProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the Process Definition to associate with Page Template updates. If specified, changes to a Page Template will trigger the associated workflow process."),
        componentTemplateProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the Process Definition to associate with Component Template updates. If specified, changes to a Component Template will trigger the associated workflow process."),
        defaultTaskProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the default Process Definition for tasks."),
        templateBundleProcess: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of the Process Definition. If specified, changes to a Component or Page Template will require approval by a 'bundle workflow' with the associated workflow process."),
        enableWorkflowProcessAssociations: z.boolean().optional().describe("If true, enables Workflow Process Associations in Shared Schemas and Structure Groups."),
        locale: z.string().optional().describe("The new locale for the Publication (e.g., 'en-US', 'de-DE')."),
        publicationType: z.string().optional().describe("The new type of the Publication (e.g., 'Web', 'Content'). Use the getPublicationTypes tool to see the available types.")
    },
    execute: async (params: any, context: any) => {
        formatForApi(params);
        const diagnosticsArgs = JSON.parse(JSON.stringify(params));
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, ...updates } = params;
        const restItemId = itemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
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

            if (updates.metadataSchemaId) {
                if (updates.metadataSchemaId === 'tcm:0-0-0') {
                    itemToUpdate.MetadataSchema = toLink('tcm:0-0-0');
                    delete itemToUpdate.Metadata;
                } else {
                    const contextualMetadataSchemaId = convertItemIdToContextPublication(updates.metadataSchemaId, itemId);
                    itemToUpdate.MetadataSchema = toLink(contextualMetadataSchemaId);
                }
            }

            if (updates.metadata && updates.metadataSchemaId !== 'tcm:0-0-0') {
                let schemaIdForMetadata = updates.metadataSchemaId 
                    ? convertItemIdToContextPublication(updates.metadataSchemaId, itemId) 
                    : itemToUpdate.MetadataSchema?.IdRef;

                if (!schemaIdForMetadata || schemaIdForMetadata === 'tcm:0-0-0') {
                    throw new Error(`Could not determine a valid Schema for the metadata fields of Publication ${itemId}. Please specify a 'metadataSchemaId'.`);
                }

                convertLinksRecursively(updates.metadata, itemId);

                const orderedMetadata = await reorderFieldsBySchema(updates.metadata, schemaIdForMetadata, 'metadata', authenticatedAxios);
                
                itemToUpdate.Metadata = orderedMetadata;
            }

            if (updates.defaultPageTemplate) itemToUpdate.DefaultPageTemplate = toLink(convertItemIdToContextPublication(updates.defaultPageTemplate, itemId));
            if (updates.defaultComponentTemplate) itemToUpdate.DefaultComponentTemplate = toLink(convertItemIdToContextPublication(updates.defaultComponentTemplate, itemId));
            if (updates.defaultTemplateBuildingBlock) itemToUpdate.DefaultTemplateBuildingBlock = toLink(convertItemIdToContextPublication(updates.defaultTemplateBuildingBlock, itemId));
            if (updates.defaultMultimediaSchema) itemToUpdate.DefaultMultimediaSchema = toLink(convertItemIdToContextPublication(updates.defaultMultimediaSchema, itemId));
            if (updates.pageSnapshotTemplate) itemToUpdate.PageSnapshotTemplate = toLink(convertItemIdToContextPublication(updates.pageSnapshotTemplate, itemId));
            if (updates.componentSnapshotTemplate) itemToUpdate.ComponentSnapshotTemplate = toLink(convertItemIdToContextPublication(updates.componentSnapshotTemplate, itemId));
            
            if (updates.pageTemplateProcessId) itemToUpdate.PageTemplateProcess = toLink(convertItemIdToContextPublication(updates.pageTemplateProcessId, itemId));
            if (updates.componentTemplateProcessId) itemToUpdate.ComponentTemplateProcess = toLink(convertItemIdToContextPublication(updates.componentTemplateProcessId, itemId));
            if (updates.defaultTaskProcessId) itemToUpdate.DefaultProcessDefinitions = toLinkArray([convertItemIdToContextPublication(updates.defaultTaskProcessId, itemId)]);
            if (updates.templateBundleProcess) itemToUpdate.TemplateBundleProcess = toLink(convertItemIdToContextPublication(updates.templateBundleProcess, itemId));
            
            if (updates.parentPublications) itemToUpdate.Parents = toLinkArray(updates.parentPublications);

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status === 200) {
                 const updatedItem = updateResponse.data;
                 const responseData = {
                    type: updatedItem['$type'],
                    Id: updatedItem.Id,
                    Message: `Successfully updated ${updatedItem.Id}`
                };
                const formattedResponseData = formatForAgent(responseData);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(updateResponse);
            }

        } catch (error) {
            await diagnoseBluePrintError(error, diagnosticsArgs, itemId, authenticatedAxios);
            return handleAxiosError(error, `Failed to update Publication ${itemId}`);
        }
    }
};