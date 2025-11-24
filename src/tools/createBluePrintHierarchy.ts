import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLinkArray } from "../utils/links.js";
import { handleAxiosError } from "../utils/errorUtils.js";
import { createJsonGraphSchema } from "../schemas/bluePrintGraphSchema.js";

// --- Internal Validation Schemas ---
// These are used to validate the parsed JSON inside the execute function.

// Schema for the top-level Root Publication
const rootPublicationSchema = z.object({
    title: z.string().describe("The title of the root publication. Must be unique."),
    key: z.string().optional().describe("The publication key. Defaults to title if omitted."),
    locale: z.string().optional().describe("The locale (e.g., 'en-US')."),
    publicationType: z.string().optional().describe("The publication type (e.g., 'Content' or 'Web').")
});

// Specific Write-Model for the Node Data (Child Publications)
const hierarchyNodeDataSchema = z.object({
    title: z.string().describe("The title of the child publication."),
    key: z.string().optional().describe("The publication key."),
    publicationUrl: z.string().optional().describe("Server-relative URL (e.g., '/nl')."),
    publicationPath: z.string().optional().describe("Physical path on server."),
    multimediaUrl: z.string().optional(),
    multimediaPath: z.string().optional(),
    locale: z.string().optional(),
    publicationType: z.string().optional()
});

// Generate the specific Graph Schema using the shared factory
const jsonGraphSchema = createJsonGraphSchema(hierarchyNodeDataSchema);

// --- Tool Input Properties ---
// defined as a plain object to match the project pattern
const createBluePrintHierarchyInputProperties = {
    rootPublicationJson: z.string().describe("A JSON string representing the Root Publication. Structure: { title: string, key?: string, locale?: string, publicationType?: string }"),
    rootStructureGroupTitle: z.string().default("Root").describe("The title of the Root Structure Group to create. Mandatory for the Root Publication."),
    hierarchyJson: z.string().describe("A JSON string representing the hierarchy graph. Structure: { nodes: [{ id, data: {...} }], edges: [{ source, target }] }")
};

// Internal schema for type inference
const createBluePrintHierarchySchema = z.object(createBluePrintHierarchyInputProperties);

export const createBluePrintHierarchy = {
    name: "createBluePrintHierarchy",
    description: `Creates an entire BluePrint hierarchy of Publications in a single operation.
    
    This tool abstracts away the complexity of managing dependencies and sequential API calls.
    1. It creates the **Root Publication** based on 'rootPublicationJson'.
    2. It **always** creates a **Root Structure Group** in the new Root.
    3. It parses 'hierarchyJson' and creates child publications in the correct topological order.
    4. Returns a map of temporary IDs to real TCM URIs.

    ### Example: Create a 'Diamond' BluePrint Hierarchy (5 Levels)
    This example creates a structure where content splits into 'Design' and 'Global' streams and merges back into 'Master Content'.
    
    // 1. Define the hierarchy object
    const hierarchy = {
        nodes: [
            // Level 1
            { id: "schema", data: { title: "100 Schema Master", publicationType: "Content" } },
            // Level 2 (Split)
            { id: "design", data: { title: "200 Design Master", publicationType: "Content" } },
            { id: "global", data: { title: "210 Global Content", publicationType: "Content" } },
            // Level 3 (Merge)
            { id: "master", data: { title: "300 Master Content", publicationType: "Content" } },
            // Level 4 (Web Master)
            { id: "web", data: { title: "400 Website Master", publicationType: "Web", publicationUrl: "/" } },
            // Level 5 (Localized Sites)
            { id: "nl", data: { title: "510 Dutch Website", publicationType: "Web", publicationUrl: "/nl", locale: "nl-NL" } },
            { id: "id", data: { title: "520 Indonesian Website", publicationType: "Web", publicationUrl: "/id", locale: "id-ID" } }
        ],
        edges: [
            // Root -> Schema
            { source: "ROOT", target: "schema" },
            // Schema -> Design & Global
            { source: "schema", target: "design" },
            { source: "schema", target: "global" },
            // Design & Global -> Master (Diamond Merge)
            { source: "design", target: "master" },
            { source: "global", target: "master" },
            // Master -> Web
            { source: "master", target: "web" },
            // Web -> Local Sites
            { source: "web", target: "nl" },
            { source: "web", target: "id" }
        ]
    };

    // 2. Call the tool, passing the objects as JSON strings
    const result = await tools.createBluePrintHierarchy({
        rootPublicationJson: JSON.stringify({
            title: "000 Empty",
            key: "000-Empty",
            locale: "en-US"
        }),
        rootStructureGroupTitle: "Root",
        hierarchyJson: JSON.stringify(hierarchy)
    });
    `,
    input: createBluePrintHierarchyInputProperties,
    execute: async (input: z.infer<typeof createBluePrintHierarchySchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { rootPublicationJson, hierarchyJson, rootStructureGroupTitle } = input;
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        // Maps specific temporary IDs (e.g. "design-master") to Real TCM URIs (e.g. "tcm:0-5-1")
        const idMap = new Map<string, string>(); 
        const createdPublications: Record<string, string> = {};
        const executionLog: string[] = [];

        // State management for dependency resolution
        const pendingNodes = new Map<string, z.infer<typeof hierarchyNodeDataSchema>>();
        const nodeParents = new Map<string, Set<string>>();

        try {
            // --- 0. Parse and Validate JSON Inputs ---
            let rootPublication;
            let hierarchy;

            try {
                const rawRoot = JSON.parse(rootPublicationJson);
                const rawHierarchy = JSON.parse(hierarchyJson);
                
                // Validate against internal Zod schemas
                rootPublication = rootPublicationSchema.parse(rawRoot);
                hierarchy = jsonGraphSchema.parse(rawHierarchy);
            } catch (parseError: any) {
                throw new Error(`Invalid JSON input or schema mismatch: ${parseError.message}`);
            }

            // --- 1. Initialize Graph Data ---
            hierarchy.nodes.forEach(node => {
                if (node.id === "ROOT") throw new Error("Node ID 'ROOT' is reserved.");
                if (pendingNodes.has(node.id)) throw new Error(`Duplicate node ID: ${node.id}`);
                
                pendingNodes.set(node.id, node.data);
                nodeParents.set(node.id, new Set());
            });

            hierarchy.edges.forEach(edge => {
                if (edge.target === "ROOT") throw new Error("'ROOT' cannot be a target.");
                if (!pendingNodes.has(edge.target)) throw new Error(`Edge target '${edge.target}' not found.`);
                if (edge.source !== "ROOT" && !pendingNodes.has(edge.source)) {
                    throw new Error(`Edge source '${edge.source}' not found.`);
                }
                nodeParents.get(edge.target)?.add(edge.source);
            });

            // --- 2. Create Root Publication ---
            const pubModelResponse = await authenticatedAxios.get('/item/defaultModel/Publication');
            const basePubModel = pubModelResponse.data;

            const rootPayload = JSON.parse(JSON.stringify(basePubModel));
            rootPayload.Title = rootPublication.title;
            rootPayload.Key = rootPublication.key || rootPublication.title;
            if (rootPublication.locale) rootPayload.Locale = rootPublication.locale;
            if (rootPublication.publicationType) rootPayload.PublicationType = rootPublication.publicationType;

            executionLog.push(`Creating Root Publication: "${rootPublication.title}"...`);
            const rootRes = await authenticatedAxios.post('/items', rootPayload);
            
            if (rootRes.status !== 201) throw new Error(`Failed to create Root Publication. Status: ${rootRes.status}`);
            
            const realRootId = rootRes.data.Id;
            idMap.set("ROOT", realRootId);
            createdPublications["ROOT"] = realRootId;
            executionLog.push(`-> Success: ${realRootId}`);

            // --- 3. Create Root Structure Group ---
            executionLog.push(`Creating Root SG ("${rootStructureGroupTitle}") in ${realRootId}...`);
            const sgModelRes = await authenticatedAxios.get('/item/defaultModel/StructureGroup', { params: { containerId: realRootId }});
            const sgPayload = sgModelRes.data;
            sgPayload.Title = rootStructureGroupTitle;
            
            if(!sgPayload.LocationInfo?.OrganizationalItem?.IdRef) {
                    sgPayload.LocationInfo = { 
                        ...sgPayload.LocationInfo, 
                        OrganizationalItem: { IdRef: realRootId } 
                    };
            }
            const sgRes = await authenticatedAxios.post('/items', sgPayload);
            if (sgRes.status !== 201) throw new Error(`Failed to create Root SG. Status: ${sgRes.status}`);
            
            executionLog.push(`-> Success: Root SG Created (${sgRes.data.Id}).`);

            // --- 4. Process Dependency Loop ---
            let progressMade = true;
            while (pendingNodes.size > 0 && progressMade) {
                progressMade = false;
                const nodesReadyToCreate: string[] = [];

                for (const [tempId, _] of pendingNodes) {
                    const parents = nodeParents.get(tempId)!;
                    let allParentsExist = true;
                    for (const parentTempId of parents) {
                        if (!idMap.has(parentTempId)) {
                            allParentsExist = false;
                            break;
                        }
                    }
                    if (allParentsExist) nodesReadyToCreate.push(tempId);
                }

                for (const tempId of nodesReadyToCreate) {
                    const nodeData = pendingNodes.get(tempId)!;
                    const parentsTempIds = nodeParents.get(tempId)!;
                    const parentRealIds: string[] = [];
                    parentsTempIds.forEach(pId => parentRealIds.push(idMap.get(pId)!));

                    const childPayload = JSON.parse(JSON.stringify(basePubModel));
                    childPayload.Title = nodeData.title;
                    childPayload.Key = nodeData.key || nodeData.title;
                    childPayload.Parents = toLinkArray(parentRealIds);
                    
                    if (nodeData.publicationUrl) childPayload.PublicationUrl = nodeData.publicationUrl;
                    if (nodeData.publicationPath) childPayload.PublicationPath = nodeData.publicationPath;
                    if (nodeData.multimediaUrl) childPayload.MultimediaUrl = nodeData.multimediaUrl;
                    if (nodeData.multimediaPath) childPayload.MultimediaPath = nodeData.multimediaPath;
                    if (nodeData.locale) childPayload.Locale = nodeData.locale;
                    if (nodeData.publicationType) childPayload.PublicationType = nodeData.publicationType;

                    executionLog.push(`Creating Child: "${nodeData.title}"...`);
                    const createRes = await authenticatedAxios.post('/items', childPayload);

                    if (createRes.status !== 201) throw new Error(`Failed to create '${nodeData.title}'. Status: ${createRes.status}`);

                    const newId = createRes.data.Id;
                    idMap.set(tempId, newId);
                    createdPublications[tempId] = newId;
                    pendingNodes.delete(tempId);
                    progressMade = true;
                    executionLog.push(`-> Success: ${newId}`);
                }
            }

            if (pendingNodes.size > 0) {
                const remainingIds = Array.from(pendingNodes.keys()).join(", ");
                throw new Error(`Dependency resolution failed. Circular dependency or missing parent. Remaining: ${remainingIds}`);
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        message: "BluePrint Hierarchy created successfully.",
                        rootId: realRootId,
                        idMap: createdPublications,
                        log: executionLog
                    }, null, 2)
                }]
            };

        } catch (error) {
            return handleAxiosError(error, "Failed to create BluePrint Hierarchy");
        }
    }
};