import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import {
    analyzeImageBuffer,
    getImageMimeType,
    parseExcelBuffer,
    parsePdfBuffer,
    parsePowerPointBuffer,
    parseWordBuffer,
} from "../utils/fileProcessing.js";

const readMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe(
        "The TCM URI of the multimedia component to read (e.g., 'tcm:5-124'). Use 'search' or 'getItemsInContainer' to find it."
    ),
    prompt: z.string().optional().describe(
        "Required for image files only (.jpg, .jpeg, .png, .gif, .webp): the instruction or question to send to the vision model (e.g., 'Describe this image in detail', 'Extract all visible text')."
    ),
};

const readMultimediaComponentSchema = z.object(readMultimediaComponentInputProperties);

// ─── File-type resolution ─────────────────────────────────────────────────────

type FileType = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'image';

const MIME_TYPE_MAP: Record<string, FileType> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'image/jpeg': 'image',
    'image/png': 'image',
    'image/gif': 'image',
    'image/webp': 'image',
};

const EXT_TYPE_MAP: Record<string, FileType> = {
    '.pdf': 'pdf',
    '.docx': 'docx',
    '.pptx': 'pptx',
    '.xlsx': 'xlsx',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.png': 'image',
    '.gif': 'image',
    '.webp': 'image',
};

/**
 * Resolves how to process the component. The MimeType from BinaryContent is the
 * primary source of truth; the filename extension is the fallback.
 */
function resolveFileType(mimeType: string | undefined, fileName: string): { fileType: FileType; mimeType: string } | null {
    // 1. Try the MimeType from BinaryContent
    const normalisedMime = mimeType?.toLowerCase();
    if (normalisedMime && MIME_TYPE_MAP[normalisedMime]) {
        return { fileType: MIME_TYPE_MAP[normalisedMime], mimeType: normalisedMime };
    }

    // 2. Fall back to the file extension
    const dotIndex = fileName.lastIndexOf('.');
    const ext = dotIndex !== -1 ? fileName.slice(dotIndex).toLowerCase() : '';
    const fileType = EXT_TYPE_MAP[ext];
    if (fileType) {
        const resolvedMime = fileType === 'image' ? (getImageMimeType(fileName) ?? 'image/jpeg') : 'application/octet-stream';
        return { fileType, mimeType: resolvedMime };
    }

    return null;
}

export const readMultimediaComponent = {
    name: "readMultimediaComponent",
    description: `Reads and analyses the content of a Multimedia Component. 

Supported file types and their return formats:
- **PDF (.pdf)**: Extracted plain text.
- **Word (.docx)**: Extracted body as an HTML string (images excluded).
- **PowerPoint (.pptx)**: Extracted text organised by slide number.
- **Excel (.xlsx)**: Workbook data as an object mapping sheet names to row arrays.
- **Images (.jpg, .jpeg, .png, .gif, .webp)**: AI-generated description based on a provided prompt.

NOTE: When called from 'toolOrchestrator', the returned JSON string is automatically parsed. You receive the object directly.

--- EXCEL USAGE IN TOOL ORCHESTRATOR ---
The returned Excel object is a wrapper containing all sheets from the workbook. You must access a specific sheet to get the array of rows.

Example Return Object Shape:
{
  "type": "ExcelData",
  "Id": "tcm:5-124",
  "WorkbookData": {
    "Sheet1": [
      { "header1": "valueA", "header2": "valueB" }
    ]
  }
}

Correct Usage in 'mapScript' or 'preProcessingScript':
// 1. Get the full result object
const excelResult = await context.tools.readMultimediaComponent({ itemId: "tcm:5-124" });

// 2. Get the array of rows from the first sheet
const sheetNames = Object.keys(excelResult.WorkbookData);
if (sheetNames.length === 0) throw new Error("Excel file contains no sheets.");
const excelRows = excelResult.WorkbookData[sheetNames[0]];

// 3. Now you can use the array
context.log(\`Found \${excelRows.length} rows.\`);
return excelRows; // or process rows individually
`,
    input: readMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readMultimediaComponentSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, prompt } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            console.log(`Fetching item details for ${itemId} to determine file type.`);
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);

            const itemData = getItemResponse.data;

            if (itemData.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }

            const fileName = itemData.BinaryContent?.Filename;
            if (!fileName) {
                throw new Error(`Component ${itemId} does not have a filename.`);
            }

            const resolved = resolveFileType(itemData.BinaryContent?.MimeType, fileName);
            if (!resolved) {
                throw new Error(
                    `Unsupported file type for '${fileName}'. Supported types: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), and common image formats (.jpg, .png, .gif, .webp).`
                );
            }

            const { fileType, mimeType } = resolved;

            // Pre-flight check for images: ensure a prompt is provided before downloading the buffer
            if (fileType === 'image' && !prompt) {
                throw new Error(
                    `A 'prompt' parameter is required when processing image files. Please provide a question or instruction for the vision model (e.g., 'Describe this image in detail').`
                );
            }

            console.log(`Downloading binary content for ${fileType} file: ${fileName}`);
            const downloadResponse = await authenticatedAxios.get<ArrayBuffer>(
                `/items/${restItemId}/binary/download`, 
                { responseType: 'arraybuffer' }
            );

            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            
            const buffer = Buffer.from(downloadResponse.data);
            console.log(`Successfully downloaded ${buffer.length} bytes.`);

            console.log(`Processing '${fileName}' as ${fileType}...`);

            if (fileType === 'pdf') {
                const text = await parsePdfBuffer(buffer);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "PdfText", Id: itemId, Content: text.trim() }, null, 2),
                    }],
                };
            }

            if (fileType === 'docx') {
                const html = await parseWordBuffer(buffer);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "HtmlContent", Id: itemId, Content: html }, null, 2),
                    }],
                };
            }

            if (fileType === 'pptx') {
                const slides = await parsePowerPointBuffer(buffer);
                if (slides.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({ type: "PowerPointText", Id: itemId, Content: "Presentation contains no slides." }, null, 2),
                        }],
                    };
                }
                const fullText = slides
                    .map(s => `--- Slide ${s.SlideNumber} ---\n${s.Content}`)
                    .join("\n\n");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "PowerPointText", Id: itemId, Content: fullText.trim() }, null, 2),
                    }],
                };
            }

            if (fileType === 'xlsx') {
                const workbookData = await parseExcelBuffer(buffer);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "ExcelData", Id: itemId, WorkbookData: workbookData }, null, 2),
                    }],
                };
            }

            // fileType === 'image'
            const analysis = await analyzeImageBuffer(buffer, mimeType, prompt!);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({ type: "ImageAnalysis", Id: itemId, Description: analysis }, null, 2),
                }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read multimedia component ${itemId}`);
        }
    }
};