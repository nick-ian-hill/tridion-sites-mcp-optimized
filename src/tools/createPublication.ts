import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const createPublication = {
    name: "createPublication",
    description: `Creates a new Publication. Publications are the main organizational units in the Content Management System. They act as containers for all other content and design items like Components, Pages, and Schemas.

Publications are central to the concept of BluePrinting, a powerful feature that allows for content reuse and inheritance across a hierarchy of Publications. A Publication can be a parent, sharing its content with child Publications, or a child, inheriting content from one or more parents. This structure is ideal for managing multi-language websites, different brand channels, or various stages of a project (like development, staging, and live).`,
    input: {
        title: z.string().describe("The title for the new Publication."),
        publicationPath: z.string().optional().describe("The publication path, which forms the base of the publish path for Structure Groups and Pages within this Publication."),
        publicationUrl: z.string().optional().describe("The server-relative URL for the Publication. This will be prefixed to the URLs of published Pages."),
        multimediaPath: z.string().optional().describe("The physical path on the server where multimedia binaries will be published."),
        multimediaUrl: z.string().optional().describe("The URL that corresponds to the Multimedia Path, used to construct links to published multimedia."),
        defaultPageTemplate: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the default Page Template for this Publication."),
        defaultComponentTemplate: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the default Component Template for this Publication."),
        defaultTemplateBuildingBlock: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the default Template Building Block for this Publication."),
        pageSnapshotTemplate: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the Page Template to use for rendering snapshots of Pages in Workflow."),
        componentSnapshotTemplate: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the Component Template to use for rendering snapshots of Components in Workflow."),
        pageTemplateProcess: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the workflow Process Definition for Page Templates."),
        componentTemplateProcess: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the workflow Process Definition for Component Templates."),
        templateBundleProcess: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of the Process Definition to associate with Template Bundles."),
        shareProcessAssociations: z.boolean().optional().describe("If true, indicates that Process Associations of Schemas and Structure Groups are shared from a parent Publication."),
        locale: z.string().optional().describe("The locale for the Publication (e.g., 'en-US', 'de-DE')."),
        publicationType: z.string().optional().describe("The type of the Publication (e.g., 'Web', 'Content').")
    },
    examples: [
        {
            input: {
                title: "My New Website Publication",
                publicationUrl: "/my-new-site",
                multimediaUrl: "/my-new-site/images",
                locale: "en-US"
            },
            description: "Creates a new Publication with a title, a publication URL for web content, a specific URL for multimedia items, and sets its locale to US English."
        },
        {
            input: {
                title: "Corporate Master Content",
                publicationType: "Content"
            },
            description: "Creates a basic 'Content' Publication intended to be a parent in a BluePrint structure, from which other Publications can inherit content."
        }
    ],
    execute: async (args: any) => {
        const {
            title, publicationPath, publicationUrl, multimediaPath, multimediaUrl,
            defaultPageTemplate, defaultComponentTemplate, defaultTemplateBuildingBlock,
            pageSnapshotTemplate, componentSnapshotTemplate, pageTemplateProcess,
            componentTemplateProcess, templateBundleProcess, shareProcessAssociations,
            locale, publicationType
        } = args;

        try {
            // 1. Get the default model for a Publication
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Publication');
            
            if (defaultModelResponse.status !== 200) {
                return { 
                    content: [], 
                    errors: [{ message: `Failed to retrieve default model for Publication. Status: ${defaultModelResponse.status}, Message: ${defaultModelResponse.statusText}` }] 
                };
            }
            
            const payload = defaultModelResponse.data;
            
            // 2. Customize the payload with the provided arguments
            payload.Title = title;
            if (publicationPath) payload.PublicationPath = publicationPath;
            if (publicationUrl) payload.PublicationUrl = publicationUrl;
            if (multimediaPath) payload.MultimediaPath = multimediaPath;
            if (multimediaUrl) payload.MultimediaUrl = multimediaUrl;
            if (locale) payload.Locale = locale;
            if (publicationType) payload.PublicationType = publicationType;

            // Handle Link properties
            if (defaultPageTemplate) payload.DefaultPageTemplate = { "$type": "Link", "IdRef": defaultPageTemplate };
            if (defaultComponentTemplate) payload.DefaultComponentTemplate = { "$type": "Link", "IdRef": defaultComponentTemplate };
            if (defaultTemplateBuildingBlock) payload.DefaultTemplateBuildingBlock = { "$type": "Link", "IdRef": defaultTemplateBuildingBlock };
            if (pageSnapshotTemplate) payload.PageSnapshotTemplate = { "$type": "Link", "IdRef": pageSnapshotTemplate };
            if (componentSnapshotTemplate) payload.ComponentSnapshotTemplate = { "$type": "Link", "IdRef": componentSnapshotTemplate };
            if (pageTemplateProcess) payload.PageTemplateProcess = { "$type": "Link", "IdRef": pageTemplateProcess };
            if (componentTemplateProcess) payload.ComponentTemplateProcess = { "$type": "Link", "IdRef": componentTemplateProcess };
            if (templateBundleProcess) payload.TemplateBundleProcess = { "$type": "Link", "IdRef": templateBundleProcess };

            // Handle boolean property
            if (typeof shareProcessAssociations === 'boolean') {
                payload.ShareProcessAssociations = shareProcessAssociations;
            }

            // 3. Post the customized payload to create the Publication
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully created Publication with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                    }],
                };
            } else {
                return {
                    content: [],
                    errors: [{ message: `Unexpected response status during Publication creation: ${createResponse.status}` }],
                };
            }

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to create Publication: ${errorMessage}` }],
            };
        }
    }
};