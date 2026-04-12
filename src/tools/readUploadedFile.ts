import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError } from "../utils/errorUtils.js";
import {
    analyzeImageBuffer,
    getImageMimeType,
    parseExcelBuffer,
    parsePdfBuffer,
    parsePowerPointBuffer,
    parseWordBuffer,
} from "../utils/fileProcessing.js";

const readUploadedFileInputProperties = {
    attachmentId: z.string().describe(
        "The temporary ID of the uploaded file. Use the 'tempFileId' value from the attachment context.",
    ),
    fileName: z.string().describe(
        "The original file name including its extension (e.g., 'report.pdf'). This determines how the file will be processed.",
    ),
    prompt: z.string().optional().describe(
        "Required for image files only (.jpg, .jpeg, .png, .gif, .webp): the instruction or question to send to the vision model (e.g., 'Describe this image in detail', 'Extract all visible text').",
    ),
    maxRows: z.number().int().positive().optional().describe(`Excel (.xlsx) files only. Limits returned rows per sheet. STRATEGY: 1. Always start with \`maxRows\`: 3 to triage the file. 2. If a specific sheet contains instructions or logic notes rather than a data table, and you suspect more content exists (compare \`Data.length\` to \`TotalRows\`), immediately re-read THAT SPECIFIC SHEET using the \`targetSheet\` parameter WITHOUT \`maxRows\` before proceeding. 3. For actual data processing, omit \`maxRows\` only inside a 'toolOrchestrator' script.`
    ),
    targetSheet: z.string().optional().describe(
        "Optional. The exact name of a specific sheet to read. Use this if you only want to extract data from one sheet instead of the entire workbook."
    ),
};

const readUploadedFileSchema = z.object(readUploadedFileInputProperties);

// ─── File-type resolution ─────────────────────────────────────────────────────

type FileType = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'image' | 'text' | 'json';

const MIME_TYPE_MAP: Record<string, FileType> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'image/jpeg': 'image',
    'image/png': 'image',
    'image/gif': 'image',
    'image/webp': 'image',
    'text/plain': 'text',
    'application/json': 'json',
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
    '.txt': 'text',
    '.json': 'json',
};

/**
 * Resolves how to process a downloaded file. MIME type from the response
 * headers is the primary source of truth; file extension is the fallback for
 * when the server returns a generic `application/octet-stream`.
 *
 * Returns the resolved FileType together with the best-known MIME string
 * (important for image processing, which passes it directly to the vision API).
 */
function resolveFileType(
    contentType: string | undefined,
    fileName: string,
): { fileType: FileType; mimeType: string } | null {
    // 1. Try the Content-Type header (strip e.g. "; charset=utf-8")
    const headerMime = contentType?.split(';')[0].trim().toLowerCase();
    if (headerMime && MIME_TYPE_MAP[headerMime]) {
        return { fileType: MIME_TYPE_MAP[headerMime], mimeType: headerMime };
    }

    // 2. Fall back to the file extension
    const dotIndex = fileName.lastIndexOf('.');
    const ext = dotIndex !== -1 ? fileName.slice(dotIndex).toLowerCase() : '';
    const fileType = EXT_TYPE_MAP[ext];
    if (fileType) {
        // For images we prefer the server MIME if available (even if unrecognised above),
        // otherwise derive it from the extension via the shared helper.
        const mimeType = fileType === 'image' 
            ? (getImageMimeType(fileName) ?? headerMime ?? 'application/octet-stream')
            : fileType === 'text' ? 'text/plain' 
            : fileType === 'json' ? 'application/json' 
            : (headerMime ?? 'application/octet-stream');
        return { fileType, mimeType };
    }

    return null;
}

export const readUploadedFile = {
    name: "readUploadedFile",
    summary: "Extracts and analyzes text or data from a file that was attached or uploaded by the user.",
    description: `Reads and analyses the **content** of a file that was attached by the user. Use this when the user wants to extract, summarise, or act on what is inside the file.

If the user wants to **save the file as a new multimedia component** in the CMS instead, use 'createMultimediaComponentFromAttachment'.

Supported file types and their return formats:
- **Text (.txt)**: Extracted plain text.
- **JSON (.json)**: Parsed JSON object data.
- **PDF (.pdf)**: Extracted plain text.
- **Word (.docx)**: Extracted body as an HTML string (images excluded).
- **PowerPoint (.pptx)**: Extracted text organised by slide number.
- **Excel (.xlsx)**: Workbook data as an object mapping sheet names to a structured object containing 'TotalRows' and a 'Data' array of row objects.
- **Images (.jpg, .jpeg, .png, .gif, .webp)**: AI-generated description based on a provided prompt.

The attachmentId and fileName for each attachment are provided in the user's context at the start of the conversation.

NOTE: When called from 'toolOrchestrator', the returned JSON string is automatically parsed. You receive the object directly.

--- EXCEL USAGE IN TOOL ORCHESTRATOR ---
The returned Excel object is a wrapper containing all sheets from the workbook. You must access a specific sheet to get the array of rows.

Example Return Object Shape:
{
  "type": "ExcelData",
  "fileName": "data.xlsx",
  "WorkbookData": {
    "Sheet1": {
      "TotalRows": 15,
      "Data": [
        { "header1": "valueA", "header2": "valueB" }
      ]
    }
  }
}
  
--- EXCEL TWO-PASS PATTERN (RECOMMENDED FOR IMPORTS) ---
For large Excel files, use a two-pass approach to avoid processing data you do not yet understand:

Pass 1 — Preview: call with maxRows: 3 to cheaply read the column headers and 2-3 sample
values per column. Inspect WorkbookData to confirm the column names match your target CMS Schema
fields and that the value formats are as expected.

Pass 2 — Full import: Once the structure is confirmed, omit maxRows and call inside a
toolOrchestrator preProcessingScript. Return the full row array as preProcessingResult so that
the mapScript can iterate every row and create or update CMS Components.`,
    input: readUploadedFileInputProperties,
    async execute(input: z.infer<typeof readUploadedFileSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { attachmentId, fileName, prompt, maxRows } = input;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            console.log(`Downloading attachment '${fileName}' (attachmentId: ${attachmentId})...`);
            const downloadResponse = await authenticatedAxios.get('/binary/download', {
                params: { tempFileId: attachmentId, filename: fileName },
                responseType: 'arraybuffer',
            });

            if (downloadResponse.status !== 200) {
                throw new Error(`Failed to download temporary file '${fileName}'. Status: ${downloadResponse.status}`);
            }

            const buffer = Buffer.from(downloadResponse.data);
            console.log(`Downloaded ${buffer.length} bytes for '${fileName}'.`);

            const resolved = resolveFileType(downloadResponse.headers['content-type'], fileName);
            if (!resolved) {
                throw new Error(
                    `Unsupported file type for '${fileName}'. Supported types: Text (.txt), JSON (.json), PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), and common image formats (.jpg, .png, .gif, .webp).`,
                );
            }

            const { fileType, mimeType } = resolved;
            console.log(`Processing '${fileName}' as ${fileType} (MIME: ${mimeType})...`);

            if (fileType === 'text') {
                const text = buffer.toString('utf-8');
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "PlainText", fileName, Content: text }, null, 2),
                    }],
                };
            }

            if (fileType === 'json') {
                try {
                    const jsonContent = JSON.parse(buffer.toString('utf-8'));
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({ type: "JsonData", fileName, Content: jsonContent }, null, 2),
                        }],
                    };
                } catch (e: any) {
                    throw new Error(`Failed to parse JSON content: ${e.message}`);
                }
            }

            if (fileType === 'pdf') {
                const text = await parsePdfBuffer(buffer);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "PdfText", fileName, Content: text.trim() }, null, 2),
                    }],
                };
            }

            if (fileType === 'docx') {
                const html = await parseWordBuffer(buffer);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "HtmlContent", fileName, Content: html }, null, 2),
                    }],
                };
            }

            if (fileType === 'pptx') {
                const slides = await parsePowerPointBuffer(buffer);
                const fullText = slides
                    .map(s => `--- Slide ${s.SlideNumber} ---\n${s.Content}`)
                    .join("\n\n");
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "PowerPointText", fileName, Content: fullText.trim() }, null, 2),
                    }],
                };
            }

            if (fileType === 'xlsx') {
                const workbookData = await parseExcelBuffer(buffer, input.maxRows, input.targetSheet);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ type: "ExcelData", fileName, WorkbookData: workbookData }, null, 2),
                    }],
                };
            }

            // fileType === 'image'
            if (!prompt) {
                throw new Error(
                    `A 'prompt' parameter is required when processing image files. Please provide a question or instruction for the vision model (e.g., 'Describe this image in detail').`,
                );
            }
            const analysis = await analyzeImageBuffer(buffer, mimeType, prompt);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({ type: "ImageAnalysis", fileName, Description: analysis }, null, 2),
                }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read uploaded file '${fileName}'`);
        }
    },
};
