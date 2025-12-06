import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getRelatedBluePrintItemsInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)
        .describe("The TCM URI of the item or Publication to analyze."),
    
    relationship: z.enum([
        // Publication Structure Relationships
        "Child", 
        "Descendant", 
        "Parent", 
        "Ancestor", 
        "Sibling", 
        // Item Inheritance Relationships
        "LocalizedIn", 
        "SharedIn",
        "SharedFrom",
        "LocalizedFrom",
        "PrimaryItem"
    ]).describe(`The relationship filter.
    - 'Child'/'Descendant': Publications that inherit from the current location.
    - 'Parent'/'Ancestor': Publications that the current location inherits from.
    - 'Sibling': Publications that share the same parent(s).
    - 'LocalizedIn': Descendant locations where this item exists as a Localized (editable) copy.
    - 'SharedIn': Descendant locations where this item exists as a Shared (read-only) copy.
    - 'SharedFrom': The immediate parent item(s) from which this item inherits (valid for Shared items).
    - 'LocalizedFrom': The immediate parent item(s) from which this item *would* inherit if it were not localized (valid for Localized items).
    - 'PrimaryItem': The original root item (Owning Item) in the hierarchy.`)
};

const getRelatedBluePrintItemsSchema = z.object(getRelatedBluePrintItemsInputProperties);

export const getRelatedBluePrintItems = {
    name: "getRelatedBluePrintItems",
    description: `Retrieves related items within the BluePrint hierarchy based on a specific relationship.
This tool simplifies BluePrint analysis by returning a flat list of resolved items with their Publication context.

**Return Format:**
Returns an array of objects containing Item and Publication details.
For standard items, a 'State' property is included. For Publications, 'State' is omitted.
{
  "Item": { "Id": "...", "Title": "...", "type": "..." },
  "Publication": { "Id": "...", "Title": "..." },
  "State": "Localized" | "Shared" | "Primary" // Optional
}

**Logic & Priority:**
This tool relies on the CMS to resolve BluePrint priority and proximity. The results reflect the *effective* inheritance path. 
For example, if a Publication inherits from two parents, 'SharedFrom' will return the specific parent that "wins" the priority conflict.

**Use Cases:**
- **Impact Analysis:** Use 'SharedIn' and 'LocalizedIn' to see exactly where a change to the current item will propagate (Shared) or be masked (Localized).
- **Origin Tracing:** Use 'SharedFrom' or 'LocalizedFrom' to find the immediate source of the current item.
- **Root Cause:** Use 'PrimaryItem' to find the master copy of the content.
- **Publication Navigation:** Use 'Child'/'Parent' (with a Publication ID) to navigate the repository structure.

### Example 1: Impact Analysis (Downstream)
// Find all publications where the component "tcm:5-123" has been localized (edited).
const result = await tools.getRelatedBluePrintItems({
    itemId: "tcm:5-123",
    relationship: "LocalizedIn"
});

// Expected JSON Output:
[
  {
    "Item": { "Id": "tcm:12-123", "Title": "About Us (Local)", "type": "Component" },
    "Publication": { "Id": "tcm:0-12-1", "Title": "400 Website DE" },
    "State": "Localized"
  },
  {
    "Item": { "Id": "tcm:14-123", "Title": "About Us (FR)", "type": "Component" },
    "Publication": { "Id": "tcm:0-14-1", "Title": "400 Website FR" },
    "State": "Localized"
  }
]

### Example 2: Origin Tracing (Upstream)
// Find the immediate parent item that "tcm:12-123" inherits from.
const result = await tools.getRelatedBluePrintItems({
    itemId: "tcm:12-123",
    relationship: "SharedFrom"
});

// Expected JSON Output:
[
  {
    "Item": { "Id": "tcm:5-123", "Title": "About Us", "type": "Component" },
    "Publication": { "Id": "tcm:0-5-1", "Title": "100 Master Content" },
    "State": "Primary"
  }
]

### Example 3: Publication Structure
// Find the immediate child publications of "tcm:0-1-1".
const result = await tools.getRelatedBluePrintItems({
    itemId: "tcm:0-1-1",
    relationship: "Child"
});

// Expected JSON Output (State is omitted for Publications):
[
  {
    "Item": { "Id": "tcm:0-2-1", "Title": "010 Schemas", "type": "Publication" },
    "Publication": { "Id": "tcm:0-2-1", "Title": "010 Schemas" }
  },
  {
    "Item": { "Id": "tcm:0-3-1", "Title": "020 Templates", "type": "Publication" },
    "Publication": { "Id": "tcm:0-3-1", "Title": "020 Templates" }
  }
]`,
    input: getRelatedBluePrintItemsInputProperties,
    execute: async (input: z.infer<typeof getRelatedBluePrintItemsSchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, relationship } = input;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            
            // Fetch hierarchy with basic details.
            // We do NOT need full content, just Id, Title, and BluePrintInfo.
            // The bluePrintHierarchy endpoint handles the resolution of Priority/Proximity for us.
            const response = await authenticatedAxios.get(`/items/${escapedItemId}/bluePrintHierarchy`, {
                params: { details: 'IdAndTitleOnly' }
            });

            if (response.status !== 200) {
                return handleUnexpectedResponse(response);
            }

            const rawItems = response.data.Items; // Array of BluePrintNodes
            
            // --- 1. Graph Construction ---
            // We map Publication IDs to nodes to facilitate traversal.
            const nodeMap = new Map<string, any>();
            const childrenMap = new Map<string, Set<string>>(); // PubId -> Set<ChildPubId>
            const parentsMap = new Map<string, Set<string>>();  // PubId -> Set<ParentPubId>
            
            let contextPubId = "";

            // extract Publication ID from the input Item ID to identify "Self" in the graph
            const uriMatch = itemId.match(/tcm:(\d+)-/);
            const inputPubId = uriMatch ? `tcm:0-${uriMatch[1]}-1` : itemId; // Fallback to itemId if it looks like a pub

            for (const node of rawItems) {
                const pubId = node.ContextRepositoryId;
                nodeMap.set(pubId, node);
                
                // Identify Context Node
                // The hierarchy endpoint returns the graph relative to the requested item.
                // We identify the node belonging to the requested item's publication.
                if (pubId === inputPubId) {
                    contextPubId = pubId;
                }

                if (!childrenMap.has(pubId)) childrenMap.set(pubId, new Set());
                if (!parentsMap.has(pubId)) parentsMap.set(pubId, new Set());
            }

            // Build Edges based on the API response.
            // The API returns 'Parents' for each node, representing the EFFECTIVE BluePrint parents for this item.
            for (const node of rawItems) {
                const childPubId = node.ContextRepositoryId;
                if (node.Parents) {
                    for (const parent of node.Parents) {
                        const parentPubId = parent.IdRef;
                        
                        // Register Relationship
                        if (!childrenMap.has(parentPubId)) childrenMap.set(parentPubId, new Set());
                        childrenMap.get(parentPubId)!.add(childPubId);

                        parentsMap.get(childPubId)!.add(parentPubId);
                    }
                }
            }

            // --- 2. Traversal Logic ---
            const resultPubIds = new Set<string>();

            // Helper: Recursive Downstream
            const traverseDown = (startPubId: string, visited: Set<string>) => {
                const children = childrenMap.get(startPubId);
                if (children) {
                    for (const child of children) {
                        if (!visited.has(child)) {
                            visited.add(child);
                            resultPubIds.add(child);
                            traverseDown(child, visited);
                        }
                    }
                }
            };

            // Helper: Recursive Upstream
            const traverseUp = (startPubId: string, visited: Set<string>) => {
                const parents = parentsMap.get(startPubId);
                if (parents) {
                    for (const parent of parents) {
                        if (!visited.has(parent)) {
                            visited.add(parent);
                            resultPubIds.add(parent);
                            traverseUp(parent, visited);
                        }
                    }
                }
            };

            // Helper: Find Root (Primary)
            const findRoot = (startPubId: string): string => {
                const parents = parentsMap.get(startPubId);
                if (!parents || parents.size === 0) return startPubId; // No parents, this is root
                
                // If multiple parents, pick the first one (arbitrary for Primary check, as all roads lead to Rome)
                // In a valid BluePrint for a single item, there is strictly one Primary Parent chain 
                // that leads to the Owning Repository.
                const firstParent = parents.values().next().value;
                
                if (!firstParent) return startPubId; // Should not happen due to size check, but satisfies TS
                
                return findRoot(firstParent);
            };

            // --- 3. Execute Selection based on Relationship ---
            switch (relationship) {
                // --- Publication Structure ---
                case "Child":
                    childrenMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;
                case "Descendant":
                    traverseDown(contextPubId, new Set());
                    break;
                case "Parent":
                    parentsMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;
                case "Ancestor":
                    traverseUp(contextPubId, new Set());
                    break;
                case "Sibling":
                    // Siblings = Children of my Parents, excluding Me.
                    const myParents = parentsMap.get(contextPubId);
                    if (myParents) {
                        for (const parentId of myParents) {
                            const siblings = childrenMap.get(parentId);
                            if (siblings) {
                                siblings.forEach(sib => {
                                    if (sib !== contextPubId) resultPubIds.add(sib);
                                });
                            }
                        }
                    }
                    break;

                // --- Item Inheritance ---
                case "LocalizedIn":
                case "SharedIn":
                    // These look Downstream (Descendants)
                    traverseDown(contextPubId, new Set());
                    break;

                case "SharedFrom":
                case "LocalizedFrom":
                    // These look Upstream (Immediate Parents only)
                    // The API 'Parents' array represents the resolved source(s).
                    parentsMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;

                case "PrimaryItem":
                    const rootPubId = findRoot(contextPubId);
                    resultPubIds.add(rootPubId);
                    break;
            }

            // --- 4. Filter & Format Results ---
            let finalItems = [];

            for (const pubId of resultPubIds) {
                const node = nodeMap.get(pubId);
                if (!node) continue;

                const item = node.Item;
                const isLocalized = item.BluePrintInfo?.IsLocalized === true;
                const isShared = item.BluePrintInfo?.IsShared === true;

                // Apply Logic Filter
                let include = true;

                if (relationship === "LocalizedIn") {
                    // Must be downstream AND localized
                    if (!isLocalized) include = false;
                } 
                else if (relationship === "SharedIn") {
                    // Must be downstream AND shared (and not localized masking it)
                    if (!isShared || isLocalized) include = false;
                }
                // For SharedFrom / LocalizedFrom, we simply return the items found in the Parent nodes.
                // We do not filter by state, because the parent could be Shared OR Localized/Primary.
                // The relationship implies "This is the item I inherited from".

                if (include) {
                    const isPublication = item.$type === "Publication" || (item.Id && item.Id.endsWith("-1"));
                    
                    let state: string | undefined = "Primary";
                    if (isLocalized) state = "Localized";
                    else if (isShared) state = "Shared";

                    if (isPublication) {
                        state = undefined; // State doesn't apply to Pubs
                    }

                    const resultObject: any = {
                        Item: {
                            Id: item.Id,
                            Title: item.Title,
                            type: item.$type
                        },
                        Publication: {
                            Id: node.ContextRepositoryId,
                            Title: node.ContextRepositoryTitle
                        }
                    };

                    if (state) {
                        resultObject.State = state;
                    }

                    finalItems.push(resultObject);
                }
            }

            // Clean up for agent
            const formattedData = formatForAgent(finalItems);

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(formattedData, null, 2)
                }]
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve related BluePrint items for ${itemId}`);
        }
    }
};