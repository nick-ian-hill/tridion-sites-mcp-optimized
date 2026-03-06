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
};

const readUploadedFileSchema = z.object(readUploadedFileInputProperties);

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
        const mimeType = getImageMimeType(fileName) ?? headerMime ?? 'application/octet-stream';
        return { fileType, mimeType };
    }

    return null;
}

export const readUploadedFile = {
    name: "readUploadedFile",
    description: `Reads and analyses the **content** of a file that was attached by the user. Use this when the user wants to extract, summarise, or act on what is inside the file.

If the user wants to **save the file as a new multimedia component** in the CMS instead, use 'createMultimediaComponentFromAttachment'.

Supported file types and their return formats:
- **PDF (.pdf)**: Extracted plain text.
- **Word (.docx)**: Extracted body as an HTML string (images excluded).
- **PowerPoint (.pptx)**: Extracted text organised by slide number.
- **Excel (.xlsx)**: Workbook data as an object mapping sheet names to row arrays.
- **Images (.jpg, .jpeg, .png, .gif, .webp)**: AI-generated description based on a provided prompt.

The attachmentId and fileName for each attachment are provided in the user's context at the start of the conversation.`,
    input: readUploadedFileInputProperties,
    async execute(input: z.infer<typeof readUploadedFileSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { attachmentId, fileName, prompt } = input;

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
                    `Unsupported file type for '${fileName}'. Supported types: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), and common image formats (.jpg, .png, .gif, .webp).`,
                );
            }

            const { fileType, mimeType } = resolved;
            console.log(`Processing '${fileName}' as ${fileType} (MIME: ${mimeType})...`);

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
                const workbookData = await parseExcelBuffer(buffer);
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
