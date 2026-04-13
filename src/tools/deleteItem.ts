import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const deleteItem = {
    name: "deleteItem",
    summary: "Permanently removes an item or a specific version with safety checks for dependencies, locks, and publishing.",
    description: `Permanently deletes a single item or a specific historical version of an item from the Content Manager.
IMPORTANT: Tridion enforces strict deletion rules. The current version of an item cannot be deleted if it is localized, locked, published, or used by other items anywhere across the blueprint.

**Behavior for Historical Versions (IDs ending in -v#):**
- Bypasses all complex checks (localizations, locks, dependencies). 
- Simply deletes the specified historical snapshot directly (requires confirmation).

**Behavior for the current version of an item when 'forceDelete' is false (Default - Analysis Mode):**
- Finds the Primary Item and checks for all blockers across the BluePrint hierarchy.
- If NO blockers exist, it cleanly deletes the Primary Item.
- If blockers EXIST (or if the item is a non-empty Folder/Category), it aborts and returns a 'DeleteAnalysisReport' JSON object detailing the status.

**Behavior for the current version of an item when 'forceDelete' is true (Execution Mode):**
- Automatically unlocalizes child items and undoes standard check-outs before deleting.
- **CASCADE DELETES:** If targeted at a non-empty container, it will attempt a recursive cascade delete. This will succeed if all child items are clean, but fail if any child item is blocked.
- **HARD BLOCKERS:** It will STILL ABORT if there are structural dependencies (e.g., used on a Page), if the item is actively Published, or if the item is locked in a **Workflow**. The agent must use 'update', 'unpublish', or workflow tools to resolve these hard blockers manually before attempting a force delete.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?(-v\d+)?|ecl:[^:\s]+(-v\d+)?)$/).describe("The unique ID (TCM URI) of the item to delete. Append '-v[number]' to delete a specific past version."),
        forceDelete: z.boolean().optional().default(false).describe("Set to false to fall back to Analysis Mode if the item cannot be deleted safely. Set to true to automatically resolve locks/localizations and attempt deletion (will still fail on Hard Blockers)."),
        confirmed: z.boolean().optional().describe("CRITICAL SAFETY LOCK: Leave undefined unless explicitly authorized by the user."),
    },
    execute: async ({ itemId, forceDelete = false, confirmed }: { itemId: string; forceDelete?: boolean; confirmed?: boolean }, context: any) => {
        const isVersionDeletion = /-v\d+$/.test(itemId);

        // Safety lock check (required for both forceDelete and any version deletion)
        if ((forceDelete || isVersionDeletion) && !confirmed) {
            return {
                elicit: {
                    input: "confirmed",
                    content: [{
                        type: "text",
                        text: isVersionDeletion
                            ? `Are you sure you want to permanently delete the historical version ${itemId}? This cannot be undone.`
                            : `Are you sure you want to forcibly delete ${itemId}? This will automatically unlocalize child copies, discard check-outs, and permanently delete the Primary Item (and its content if it is a container). This cannot be undone.`
                    }],
                }
            };
        }

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const initialIdEscaped = itemId.replace(':', '_');

            // --- BRANCH A: VERSION DELETION ---
            if (isVersionDeletion) {
                const deleteResponse = await authenticatedAxios.delete(`/items/${initialIdEscaped}`);

                if (deleteResponse.status === 204 || deleteResponse.status === 200) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                type: 'Success',
                                Id: itemId,
                                Message: `Successfully deleted historical version ${itemId}.`,
                            }, null, 2)
                        }],
                    };
                } else {
                    return handleUnexpectedResponse(deleteResponse);
                }
            }

            // --- BRANCH B: LIVE ITEM DELETION ---
            // --- STEP 1: RESOLVE PRIMARY ITEM ---
            const itemResponse = await authenticatedAxios.get(`/items/${initialIdEscaped}`, {
                params: { includeProperties: ["BluePrintInfo"] }
            });

            let primaryId = itemId;
            let primaryIdEscaped = initialIdEscaped;

            if (itemResponse.data.BluePrintInfo?.PrimaryBluePrintParentItem?.IdRef) {
                primaryId = itemResponse.data.BluePrintInfo.PrimaryBluePrintParentItem.IdRef;
                primaryIdEscaped = primaryId.replace(':', '_');
            }

            const itemType = itemResponse.data.$type;

            // System-wide objects (e.g. ApprovalStatus) don't live in a Publication,
            // so the /bluePrintHierarchy and /dependencyGraph endpoints return 400 for them.
            // Skip all blocker-gathering steps and proceed directly to the delete call.
            // The API handles ApprovalStatus deletion as a soft-delete (sets IsDeleted = true).
            const isSystemWideObject = typeof itemType === 'string' && itemType.includes('ApprovalStatus');

            let hasBlockers = false;
            let hasHardBlockers = false;
            let blockers = {
                isLocked: false,     // Resolvable via undoCheckOut
                inWorkflow: false,   // Hard Blocker
                isNotEmptyContainer: false, // Soft Blocker (Triggers Analysis Warning, allows Cascade in Execution)
                containerItemCount: 0,
                lockUser: "",
                localizationsToUndo: [] as string[],
                publishedItems: [] as any[],
                dependenciesToResolve: [] as any[]
            };

            if (!isSystemWideObject) {
                // --- STEP 2: GATHER DELETION BLOCKERS ---

                // 2a. Check Locks and Workflows on Primary
                const primaryItemResponse = await authenticatedAxios.get(`/items/${primaryIdEscaped}`, {
                    params: { includeProperties: ["LockInfo", "WorkflowInfo"] }
                });

                const lockInfo = primaryItemResponse.data.LockInfo;
                const rawLockType = lockInfo?.LockType;
                const lockTypes = Array.isArray(rawLockType) ? rawLockType : (rawLockType ? [rawLockType] : []);

                const workflowInfo = primaryItemResponse.data.WorkflowInfo;
                const processId = workflowInfo?.ProcessInstance?.IdRef;
                const activityId = workflowInfo?.ActivityInstance?.IdRef;

                const isStrictlyInWorkflow = lockTypes.includes('InWorkflow') ||
                    (processId && processId !== 'tcm:0-0-0') ||
                    (activityId && activityId !== 'tcm:0-0-0');

                if (isStrictlyInWorkflow) {
                    blockers.inWorkflow = true;
                    blockers.lockUser = workflowInfo?.Assignee?.Title || lockInfo?.LockUser?.Title || "Unknown User";
                } else if (lockTypes.includes('CheckedOut') || lockTypes.includes('Permanent')) {
                    blockers.isLocked = true;
                    blockers.lockUser = lockInfo?.LockUser?.Title || "Unknown User";
                }

                // 2b. Check Localizations AND Publish States across the BluePrint
                const bpResponse = await authenticatedAxios.get(`/items/${primaryIdEscaped}/bluePrintHierarchy`, {
                    params: { details: 'Contentless' }
                });

                if (bpResponse.status === 200 && bpResponse.data.Items) {
                    const allBlueprintItemIds = bpResponse.data.Items
                        .filter((node: any) => node.Item && node.Item.Id)
                        .map((node: any) => node.Item.Id);

                    blockers.localizationsToUndo = bpResponse.data.Items
                        .filter((node: any) => node.Item && node.Item.BluePrintInfo?.IsLocalized)
                        .map((node: any) => node.Item.Id);

                    for (const bpItemId of allBlueprintItemIds) {
                        try {
                            const escBpItemId = bpItemId.replace(':', '_');
                            const pubInfoResponse = await authenticatedAxios.get(`/items/${escBpItemId}/publishInfo`);

                            if (pubInfoResponse.status === 200 && pubInfoResponse.data && pubInfoResponse.data.length > 0) {
                                const targets = pubInfoResponse.data.map((pi: any) => pi.PublishContext?.PublicationTarget?.Title || "Unknown Target");
                                blockers.publishedItems.push({
                                    Id: bpItemId,
                                    Targets: [...new Set(targets)]
                                });
                            }
                        } catch (pubError) {
                            // Suppress 404s
                        }
                    }
                }

                // 2c. Check Dependencies (UsedBy)
                const depResponse = await authenticatedAxios.get(`/items/${primaryIdEscaped}/dependencyGraph`, {
                    params: { direction: 'UsedBy', details: 'IdAndTitleOnly' }
                });

                if (depResponse.status === 200 && depResponse.data.Dependencies) {
                    const traverseDeps = (node: any) => {
                        if (node.Item && node.Item.Id !== primaryId) {
                            blockers.dependenciesToResolve.push({ Id: node.Item.Id, Title: node.Item.Title });
                        }
                        if (node.Dependencies) {
                            node.Dependencies.forEach(traverseDeps);
                        }
                    };
                    depResponse.data.Dependencies.forEach(traverseDeps);
                }

                // 2d. Check Container Status (Folders, Structure Groups, Categories)
                if (['Folder', 'StructureGroup', 'Category'].includes(itemType)) {
                    try {
                        const listResponse = await authenticatedAxios.get(`/items/${primaryIdEscaped}/list`);
                        if (listResponse.status === 200 && listResponse.data.Items && listResponse.data.Items.length > 0) {
                            blockers.isNotEmptyContainer = true;
                            blockers.containerItemCount = listResponse.data.Items.length;
                        }
                    } catch (listError) {
                        // Suppress error and fall back to relying on CMS validation if the list check fails
                    }
                }

                hasHardBlockers = blockers.publishedItems.length > 0 ||
                    blockers.dependenciesToResolve.length > 0 ||
                    blockers.inWorkflow;

                // Include isNotEmptyContainer in hasBlockers to ensure we trigger the Warning in Analysis Mode
                hasBlockers = blockers.isLocked || blockers.localizationsToUndo.length > 0 || hasHardBlockers || blockers.isNotEmptyContainer;

            } // end: if (!isSystemWideObject)

            // --- STEP 3: HANDLE BLOCKERS & ANALYSIS MODE ---
            // If we are in Analysis Mode (!forceDelete), we must ALWAYS return a report
            // and NEVER proceed to Step 4.
            if (!forceDelete) {
                let analysisMessage = "No standard blockers detected. Safe to delete.";

                if (isSystemWideObject) {
                    analysisMessage = "System-wide object (Approval Status). Deletion will softly flag it as IsDeleted=true. Safe to delete.";
                } else if (hasHardBlockers) {
                    analysisMessage = "Item cannot be deleted. HARD BLOCKERS DETECTED: You must manually finish workflows, unpublish items, and/or resolve dependencies.";
                } else if (blockers.isLocked || blockers.localizationsToUndo.length > 0) {
                    analysisMessage = "Item blocked by locks or localizations. You can run this tool again with forceDelete: true to auto-resolve these.";
                }

                if (blockers.isNotEmptyContainer) {
                    analysisMessage += `\nWARNING - CASCADE DELETE: This container holds ${blockers.containerItemCount} item(s). Deep dependency scanning on contents was skipped. Forcing deletion will attempt to permanently delete all contents. The CMS will block this if any child item is in use or published.`;
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            type: "DeleteAnalysisReport",
                            TargetItem: itemId,
                            PrimaryItemToTarget: primaryId,
                            CanDelete: !hasHardBlockers,
                            HasHardBlockers: hasHardBlockers,
                            IsSystemWideObject: isSystemWideObject,
                            Blockers: blockers,
                            Message: analysisMessage
                        }, null, 2)
                    }],
                };
            }

            // If we reach here, forceDelete IS true.
            // We only need to resolve standard blockers if they exist and it's not a system-wide object.
            if (hasBlockers && !isSystemWideObject) {
                if (hasHardBlockers) {
                    let errorMsg = `Cannot force delete. Hard blockers detected:\n`;
                    if (blockers.inWorkflow) {
                        errorMsg += `- Workflow: Item is currently in workflow (locked by ${blockers.lockUser}). You must finish the workflow first.\n`;
                    }
                    if (blockers.publishedItems.length > 0) {
                        errorMsg += `- Published Items: ${blockers.publishedItems.length} instances are published. You must unpublish them first.\n`;
                    }
                    if (blockers.dependenciesToResolve.length > 0) {
                        errorMsg += `- Dependencies: Actively used by ${blockers.dependenciesToResolve.length} other item(s).\n`;
                    }
                    throw new Error(errorMsg + `\nBlocker Details: ${JSON.stringify({
                        InWorkflow: blockers.inWorkflow,
                        Published: blockers.publishedItems,
                        Dependencies: blockers.dependenciesToResolve
                    })}`);
                }

                for (const locId of blockers.localizationsToUndo) {
                    const escLocId = locId.replace(':', '_');
                    await authenticatedAxios.post(`/items/${escLocId}/unlocalize`, null, { params: { useDynamicVersion: true } });
                }

                if (blockers.isLocked) {
                    try {
                        await authenticatedAxios.post(`/items/${primaryIdEscaped}/undoCheckOut`, {
                            "$type": "UndoCheckOutRequest",
                            RemovePermanentLock: true
                        });
                    } catch (undoError: any) {
                        if (undoError.response?.status === 404) {
                            // Item was deleted by undoCheckOut (v0.1 edge case), skip.
                        } else {
                            throw undoError;
                        }
                    }
                }
            }

            // --- STEP 4: FINAL DELETION (Live Item) ---
            try {
                const deleteResponse = await authenticatedAxios.delete(`/items/${primaryIdEscaped}`);

                if (deleteResponse.status === 204 || deleteResponse.status === 200) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                type: 'Success',
                                Id: primaryId,
                                OriginalTarget: itemId,
                                Message: forceDelete && hasBlockers
                                    ? `Successfully force-deleted Primary Item ${primaryId}. Auto-resolved locks/localizations.`
                                    : `Successfully deleted Primary Item ${primaryId}.`,
                            }, null, 2)
                        }],
                    };
                } else {
                    return handleUnexpectedResponse(deleteResponse);
                }
            } catch (deleteError: any) {
                // Check if it's the v0.1 undoCheckOut edge case
                if (deleteError.response?.status === 404 && blockers.isLocked && forceDelete) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                type: 'Success',
                                Id: primaryId,
                                OriginalTarget: itemId,
                                Message: `Successfully force-deleted Primary Item ${primaryId} (Item was removed during lock cancellation).`,
                            }, null, 2)
                        }],
                    };
                }

                // Catch and format Tridion's native Cascade Delete rejection
                if (blockers.isNotEmptyContainer && deleteError.response && (deleteError.response.status === 409 || deleteError.response.status === 400)) {
                    throw new Error(`Cascade delete failed. The CMS blocked the deletion of this container because one or more of its ${blockers.containerItemCount} child items are currently in use, published, locked, or in workflow.\nOriginal CMS Error: ${deleteError.response.data?.Message || deleteError.message}`);
                }

                throw deleteError;
            }

        } catch (error) {
            return handleAxiosError(error, `Failed to execute delete workflow for item ${itemId}`);
        }
    },
    examples: [
    ]
};