import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- Tool Interface ---
interface Tool {
    name: string;
    description: string;
    input: any;
    execute: Function;
}

function isTool(obj: any): obj is Tool {
    return (
        obj &&
        typeof obj === 'object' &&
        'name' in obj && typeof obj.name === 'string' &&
        'description' in obj && typeof obj.description === 'string' &&
        'input' in obj &&
        'execute' in obj && typeof obj.execute === 'function'
    );
}

/**
 * Loads all tools and executes the Relational Content Import logic.
 * Strategy:
 * 1. Setup Containers (Folder, SG, Category)
 * 2. Create Keywords (Parallel)
 * 3. Create Schemas & Templates
 * 4. Create Components (Parallel)
 * 5. Create Pages (Parallel)
 */
async function runTest() {
    console.log("--- Starting 5-Stage High-Performance Import ---");

    // --- 1. Load All Tools ---
    const tools: Tool[] = [];
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const toolsDirPath = path.join(__dirname, 'tools');

    try {
        const toolFiles = await fs.readdir(toolsDirPath);
        for (const file of toolFiles) {
            if (file.endsWith('.ts')) {
                const modulePath = path.join(toolsDirPath, file);
                const moduleUrl = pathToFileURL(modulePath).href;
                const module = await import(moduleUrl);
                const potentialTool = Object.values(module)[0];
                if (isTool(potentialTool)) {
                    tools.push(potentialTool);
                }
            }
        }
    } catch (error) {
        console.error("----- FATAL: Could not load tools -----");
        process.exit(1);
    }
    
    const toolsAsRecord: Record<string, Tool> = tools.reduce((acc, tool) => {
        acc[tool.name] = tool;
        return acc;
    }, {} as Record<string, Tool>);

    const orchestratorTool = tools.find(t => t.name === 'toolOrchestrator');
    if (!orchestratorTool) process.exit(1);
    
    const mcpContext = { tools: toolsAsRecord };

    // Global Config - Unique Name Generation
    const EXCEL_ITEM_ID = "tcm:5-4485";
    const RUN_ID = new Date().getTime();
    const IMPORT_ROOT_NAME = `Import_${RUN_ID}`; 
    
    console.log(`Target Root Name: ${IMPORT_ROOT_NAME}`);

    // --- Shared State passed between stages ---
    let containers: any = {};
    let keywordMap: Record<string, string> = {};
    let schemaIds: any = {};
    let componentMap: Record<string, string> = {};

    // Helper to unwrap debug responses
    const getResultData = (responseBody: any) => responseBody.result ? responseBody.result : responseBody;

    // =================================================================================
    // STAGE 0: CONTAINERS (Folder, SG, Category)
    // =================================================================================
    console.log("\n=== STAGE 0: Containers ===");
    
    const stage0Input = {
        debug: true,
        maxConcurrency: 1,
        parameters: { rootName: IMPORT_ROOT_NAME },
        preProcessingScript: `
            context.log('Stage 0: Creating Containers...');
            
            // 1. Find Root Context (Publication Root)
            const pubId = "tcm:0-5-1"; 
            const rootSgItems = await context.tools.getItemsInContainer({ containerId: pubId, itemTypes: ["StructureGroup"], details: "IdAndTitle" });
            const rootSg = rootSgItems.find(i => i.Title === "Root") || rootSgItems[0];
            
            const rootFolderItems = await context.tools.getItemsInContainer({ containerId: pubId, itemTypes: ["Folder"], details: "IdAndTitle" });
            const rootFolder = rootFolderItems.find(i => i.Title === "Building Blocks" || i.Title === "Content" || i.Title === "Root") || rootFolderItems[0];

            // 2. Create Containers
            context.log('Creating Folder...');
            const folderRes = await context.tools.createItem({ 
                itemType: "Folder", 
                title: context.parameters.rootName, 
                locationId: rootFolder.Id 
            });

            context.log('Creating Structure Group...');
            const sgRes = await context.tools.createItem({ 
                itemType: "StructureGroup", 
                title: context.parameters.rootName, 
                locationId: rootSg.Id, 
                directory: context.parameters.rootName.toLowerCase() 
            });

            context.log('Creating Category...');
            const catRes = await context.tools.createItem({ 
                itemType: "Category", 
                title: "Classification " + context.parameters.rootName, 
                locationId: pubId 
            });

            return {
                itemIds: [], 
                preProcessingResult: {
                    folderId: folderRes.Id,
                    structureGroupId: sgRes.Id,
                    categoryId: catRes.Id,
                    pubId: pubId
                }
            };
        `,
        postProcessingScript: `return context.preProcessingResult;`
    };

    try {
        const res = await orchestratorTool.execute(stage0Input as any, mcpContext);
        containers = getResultData(JSON.parse(res.content[0].text));
        if (!containers.folderId) throw new Error("Stage 0 failed to return container IDs");
        console.log("Containers Created:", JSON.stringify(containers, null, 2));
    } catch (e) {
        console.error("Stage 0 Failed:", e);
        process.exit(1);
    }

    // =================================================================================
    // STAGE 1: KEYWORDS (Parallel Creation)
    // =================================================================================
    console.log("\n=== STAGE 1: Keywords (Parallel) ===");

    const stage1Input = {
        debug: true,
        maxConcurrency: 5, 
        parameters: { 
            excelItemId: EXCEL_ITEM_ID,
            categoryId: containers.categoryId
        },
        preProcessingScript: `
            context.log('Stage 1: Reading Excel tags...');
            const excelData = await context.tools.readMultimediaComponent({ itemId: context.parameters.excelItemId });
            const workbook = typeof excelData === 'string' ? JSON.parse(excelData) : excelData;
            const articleRows = workbook.WorkbookData['Articles'] || [];
            
            const uniqueTags = new Set();
            articleRows.forEach(row => { 
                if (row.tags) row.tags.split(';').forEach(t => uniqueTags.add(t.trim())); 
            });
            
            const tagArray = Array.from(uniqueTags);
            context.log('Found ' + tagArray.length + ' unique tags to create.');

            return {
                itemIds: tagArray, 
                preProcessingResult: { categoryId: context.parameters.categoryId }
            };
        `,
        mapScript: `
            const tagName = context.currentItemId;
            const categoryId = context.preProcessingResult.categoryId;

            try {
                const kw = await context.tools.createItem({
                    itemType: "Keyword",
                    title: tagName,
                    locationId: categoryId
                });
                return { name: tagName, id: kw.Id };
            } catch (e) {
                context.log("Error creating keyword " + tagName + ": " + e.message);
                return { name: tagName, error: e.message };
            }
        `,
        postProcessingScript: `
            const map = {};
            context.successes.forEach(s => { 
                if (s.result && s.result.id) map[s.result.name] = s.result.id; 
            });
            return map;
        `
    };

    try {
        const res = await orchestratorTool.execute(stage1Input as any, mcpContext);
        keywordMap = getResultData(JSON.parse(res.content[0].text));
        console.log(`Created ${Object.keys(keywordMap).length} keywords.`);
    } catch (e) {
        console.error("Stage 1 Failed:", e);
        process.exit(1);
    }

    // =================================================================================
    // STAGE 2: SCHEMAS & TEMPLATES
    // =================================================================================
    console.log("\n=== STAGE 2: Schemas & Templates ===");

    const stage2Input = {
        debug: true,
        maxConcurrency: 1,
        parameters: { 
            folderId: containers.folderId,
            categoryId: containers.categoryId
        },
        preProcessingScript: `
            const folderId = context.parameters.folderId;
            const categoryId = context.parameters.categoryId;
            context.log('Stage 2: Creating Schemas in ' + folderId);

            // 1. Author Embedded Schema
            const authorRes = await context.tools.createEmbeddedSchema({
                title: "Author Embedded", locationId: folderId, rootElementName: "Author", description: "Author details",
                fields: {
                    "firstName": { "type": "SingleLineTextFieldDefinition", "Name": "firstName", "Description": "First Name" },
                    "lastName": { "type": "SingleLineTextFieldDefinition", "Name": "lastName", "Description": "Last Name" },
                    "bio": { "type": "MultiLineTextFieldDefinition", "Name": "bio", "Description": "Biography" }
                }
            });
            const authorSchemaId = authorRes.Id;

            // 2. Article Component Schema
            const artRes = await context.tools.createComponentSchema({
                title: "Article", locationId: folderId, rootElementName: "Article", description: "Article Schema",
                fields: {
                    "headline": { "type": "SingleLineTextFieldDefinition", "Name": "headline", "Description": "Headline", "MinOccurs": 1 },
                    "bodyText": { "type": "XhtmlFieldDefinition", "Name": "bodyText", "Description": "Body Content", "Height": 5 },
                    "source": { "type": "ExternalLinkFieldDefinition", "Name": "source", "Description": "Source URL", "MinOccurs": 0 },
                    "publishDate": { "type": "DateFieldDefinition", "Name": "publishDate", "Description": "Publish Date" },
                    "imageKey": { "type": "SingleLineTextFieldDefinition", "Name": "imageKey", "Description": "Image Key Reference" },
                    "authors": { 
                        "type": "EmbeddedSchemaFieldDefinition", "Name": "authors", "Description": "Authors", "MinOccurs": 0, "MaxOccurs": -1,
                        "EmbeddedSchema": { "type": "Link", "IdRef": authorSchemaId }
                    },
                    "tags": {
                        "type": "KeywordFieldDefinition", "Name": "tags", "Description": "Classification", 
                        "Category": { "type": "Link", "IdRef": categoryId }, 
                        "List": { "type": "ListDefinition", "Type": "Checkbox" }, 
                        "MinOccurs": 0, "MaxOccurs": -1
                    }
                }
            });
            const articleSchemaId = artRes.Id;

            // 3. Page Schemas
            // A. Content Region (Constraints)
            const crRes = await context.tools.createRegionSchema({
                title: "Content Region", locationId: folderId, description: "Allows any content",
                regionDefinition: { "type": "RegionDefinition", "ComponentPresentationConstraints": [] }
            });
            const contentRegionId = crRes.Id;

            // B. Master Page Definition (Structure)
            // Explicitly set IsMandatory to false, though structure is key.
            const mpRes = await context.tools.createRegionSchema({
                title: "Master Page Definition", locationId: folderId, description: "Defines Main and Sidebar",
                regionDefinition: {
                    "type": "RegionDefinition",
                    "NestedRegions": [
                        { "type": "NestedRegion", "RegionName": "Main", "IsMandatory": false, "RegionSchema": { "type": "ExpandableLink", "IdRef": contentRegionId } },
                        { "type": "NestedRegion", "RegionName": "Sidebar", "IsMandatory": false, "RegionSchema": { "type": "ExpandableLink", "IdRef": contentRegionId } }
                    ]
                }
            });
            const masterPageSchemaId = mpRes.Id;

            // 4. Templates
            const tbbs = await context.tools.search({ searchQuery: { ItemTypes: ["TemplateBuildingBlock"] }, resultLimit: 1 });
            const tbbId = tbbs.length > 0 ? tbbs[0].Id : null;
            if (!tbbId) throw new Error("No TBB found");

            // Component Template
            const ctRes = await context.tools.createItem({
                itemType: "ComponentTemplate", title: "Article Detail", locationId: folderId,
                templateBuildingBlocks: [tbbId], relatedSchemaIds: [articleSchemaId]
            });

            // Page Template
            const ptRes = await context.tools.createItem({
                itemType: "PageTemplate", title: "Standard Page", locationId: folderId,
                fileExtension: "html", 
                pageSchemaId: masterPageSchemaId, 
                templateBuildingBlocks: [tbbId]
            });

            return {
                itemIds: [],
                preProcessingResult: {
                    authorSchemaId, articleSchemaId, masterPageSchemaId,
                    componentTemplateId: ctRes.Id,
                    pageTemplateId: ptRes.Id
                }
            };
        `,
        postProcessingScript: `return context.preProcessingResult;`
    };

    try {
        const res = await orchestratorTool.execute(stage2Input as any, mcpContext);
        schemaIds = getResultData(JSON.parse(res.content[0].text));
        console.log("Schemas Created:", JSON.stringify(schemaIds, null, 2));
    } catch (e) {
        console.error("Stage 2 Failed:", e);
        process.exit(1);
    }

    // =================================================================================
    // STAGE 3: COMPONENTS (Parallel)
    // =================================================================================
    console.log("\n=== STAGE 3: Components ===");

    const stage3Input = {
        debug: true,
        maxConcurrency: 5,
        parameters: { 
            excelItemId: EXCEL_ITEM_ID, 
            infra: { ...containers, ...schemaIds, keywordMap } 
        },
        preProcessingScript: `
            context.log('Stage 3: Preparing Component Data...');
            const excelData = await context.tools.readMultimediaComponent({ itemId: context.parameters.excelItemId });
            const workbook = typeof excelData === 'string' ? JSON.parse(excelData) : excelData;
            
            const articles = workbook.WorkbookData['Articles'] || [];
            const authors = workbook.WorkbookData['Authors'] || [];

            const authorsMap = {};
            authors.forEach(a => {
                if (!authorsMap[a.articleKey]) authorsMap[a.articleKey] = [];
                authorsMap[a.articleKey].push({ firstName: a.firstName, lastName: a.lastName, bio: a.bio });
            });

            const validArticles = articles.filter(a => a.uniqueKey);
            return {
                itemIds: validArticles.map(a => a.uniqueKey),
                preProcessingResult: { articles, authorsMap, infra: context.parameters.infra }
            };
        `,
        mapScript: `
            const key = context.currentItemId;
            const { articles, authorsMap, infra } = context.preProcessingResult;
            const article = articles.find(a => a.uniqueKey === key);
            if (!article) return null;

            context.log('Creating: ' + article.headline);

            const associatedAuthors = authorsMap[key] || [];
            const tagIds = [];
            if (article.tags) {
                article.tags.split(';').forEach(t => {
                    const tagClean = t.trim();
                    if (infra.keywordMap[tagClean]) tagIds.push(infra.keywordMap[tagClean]);
                });
            }
            const keywordFieldData = tagIds.length > 0 ? tagIds.map(id => ({ "type": "Link", "IdRef": id })) : undefined;

            const content = {
                "headline": article.headline,
                "bodyText": "<p>" + article.bodyText + "</p>",
                "source": article.source, 
                "publishDate": article.publishDate,
                "imageKey": article.imageKey,
                "authors": associatedAuthors, 
                "tags": keywordFieldData
            };

            try {
                const result = await context.tools.createComponent({
                    title: article.headline,
                    locationId: infra.folderId,
                    schemaId: infra.articleSchemaId,
                    content: content
                });
                return { key: key, id: result.Id };
            } catch(e) {
                context.log("Error creating " + key + ": " + e.message);
                return { key: key, error: e.message };
            }
        `,
        postProcessingScript: `
            const map = {};
            context.successes.forEach(s => { if (s.result && s.result.id) map[s.result.key] = s.result.id; });
            return map;
        `
    };

    try {
        const res = await orchestratorTool.execute(stage3Input as any, mcpContext);
        componentMap = getResultData(JSON.parse(res.content[0].text));
        console.log(`Created ${Object.keys(componentMap).length} components.`);
    } catch (e) {
        console.error("Stage 3 Failed:", e);
        process.exit(1);
    }

    // =================================================================================
    // STAGE 4: PAGES (Parallel)
    // =================================================================================
    console.log("\n=== STAGE 4: Pages ===");

    const stage4Input = {
        debug: true,
        maxConcurrency: 5,
        parameters: { 
            excelItemId: EXCEL_ITEM_ID, 
            infra: { ...containers, ...schemaIds },
            compMap: componentMap 
        },
        preProcessingScript: `
            context.log('Stage 4: Preparing Page Data...');
            const excelData = await context.tools.readMultimediaComponent({ itemId: context.parameters.excelItemId });
            const workbook = typeof excelData === 'string' ? JSON.parse(excelData) : excelData;
            const pageRows = workbook.WorkbookData['Page Map'] || [];

            const pages = {};
            pageRows.forEach(row => {
                if (!pages[row.pageTitle]) {
                    pages[row.pageTitle] = { fileName: row.fileName, regions: {} };
                }
                if (!pages[row.pageTitle].regions[row.regionName]) {
                    pages[row.pageTitle].regions[row.regionName] = [];
                }
                pages[row.pageTitle].regions[row.regionName].push(row.articleKey);
            });

            return {
                itemIds: Object.keys(pages),
                preProcessingResult: { pages, infra: context.parameters.infra, compMap: context.parameters.compMap }
            };
        `,
        mapScript: `
            const pageTitle = context.currentItemId;
            const { pages, infra, compMap } = context.preProcessingResult;
            const pageData = pages[pageTitle];

            context.log('Creating Page: ' + pageTitle);

            // Must adhere to the strict Schema structure ("Main" and "Sidebar")
            const definedRegions = ["Main", "Sidebar"];
            const regionsPayload = [];
            
            for (const regionName of definedRegions) {
                const articleKeys = pageData.regions[regionName] || [];
                const cps = [];
                
                articleKeys.forEach(key => {
                    if (compMap[key]) {
                        cps.push({
                            "type": "ComponentPresentation",
                            "Component": { "type": "Link", "IdRef": compMap[key] },
                            "ComponentTemplate": { "type": "Link", "IdRef": infra.componentTemplateId }
                        });
                    } else {
                        context.log("Warning: Article Key " + key + " missing.");
                    }
                });

                // Always add the region object, even if empty.
                regionsPayload.push({
                    "type": "EmbeddedRegion",
                    "RegionName": regionName,
                    "ComponentPresentations": cps
                });
            }

            try {
                const res = await context.tools.createPage({
                    title: pageTitle,
                    locationId: infra.structureGroupId,
                    fileName: pageData.fileName,
                    pageTemplateId: infra.pageTemplateId,
                    regions: regionsPayload
                });
                return { id: res.Id, status: "Created" };
            } catch (e) {
                context.log("Error creating page " + pageTitle + ": " + e.message);
                return { error: e.message };
            }
        `,
        postProcessingScript: `
            context.log("Stage 4 Complete.");
            const successes = context.successes.filter(s => s.result && s.result.id).map(s => ({ title: s.itemId, ...s.result }));
            const failures = context.successes.filter(s => s.result && s.result.error).map(s => ({ title: s.itemId, error: s.result.error }));
            const hardFailures = context.failures.map(f => ({ title: f.itemId, error: f.error }));
            
            return { 
                pagesCreated: successes.length,
                failures: failures.length + hardFailures.length,
                details: [...successes, ...failures, ...hardFailures]
            };
        `
    };

    try {
        const res = await orchestratorTool.execute(stage4Input as any, mcpContext);
        const output = getResultData(JSON.parse(res.content[0].text));
        console.log("\nFinal Output:");
        console.log(JSON.stringify(output, null, 2));
    } catch (e) {
        console.error("Stage 4 Failed:", e);
    }

    console.log("\n--- Import Process Finished ---");
}

runTest();
