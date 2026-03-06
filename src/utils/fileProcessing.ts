import { PdfReader } from "pdfreader";
import mammoth from "mammoth";
import JSZip from "jszip";
import { Parser as XmlParser } from "xml2js";
import ExcelJS from "exceljs";
import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// ─── PowerPoint helpers ───────────────────────────────────────────────────────

/**
 * Recursively extracts text nodes (a:t elements) from a parsed PowerPoint XML
 * object. Shared between the text-reader and the split tools.
 */
export const extractTextFromXmlObject = (obj: any): string[] => {
    let texts: string[] = [];
    if (Array.isArray(obj)) {
        for (const item of obj) {
            texts = texts.concat(extractTextFromXmlObject(item));
        }
    } else if (typeof obj === 'object' && obj !== null) {
        for (const key in obj) {
            if (key === 'a:t') {
                const val = obj[key];
                if (typeof val === 'string' && val.trim() !== '') {
                    texts.push(val);
                } else if (Array.isArray(val)) {
                    texts.push(...val.filter((t: any) => typeof t === 'string' && t.trim() !== ''));
                }
            } else {
                texts = texts.concat(extractTextFromXmlObject(obj[key]));
            }
        }
    }
    return texts;
};

// ─── PDF ──────────────────────────────────────────────────────────────────────

/**
 * Parses a PDF buffer and returns the extracted text content.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let content = "";
        new PdfReader(null).parseBuffer(buffer, (err, item) => {
            if (err) {
                reject(err);
            } else if (!item) {
                resolve(content);
            } else if (item.text) {
                content += item.text + " ";
            }
        });
    });
}

// ─── Word ─────────────────────────────────────────────────────────────────────

/**
 * Parses a Word (.docx) buffer and returns the document body as an HTML string,
 * with images stripped.
 */
export async function parseWordBuffer(buffer: Buffer): Promise<string> {
    const mammothOptions = {
        convertImage: async function (_image: any) {
            return [];
        },
    } as any;
    const { value } = await mammoth.convertToHtml({ buffer }, mammothOptions);
    return value;
}

// ─── PowerPoint ───────────────────────────────────────────────────────────────

export interface SlideContent {
    SlideNumber: number;
    Content: string;
}

/**
 * Parses a PowerPoint (.pptx) buffer and returns the text content of each
 * slide in slide-number order.
 */
export async function parsePowerPointBuffer(buffer: Buffer): Promise<SlideContent[]> {
    const zip = await JSZip.loadAsync(buffer);
    const xmlParser = new XmlParser({ explicitArray: false });

    const slideFiles = zip.file(/ppt\/slides\/slide\d+\.xml/);
    if (slideFiles.length === 0) {
        return [];
    }

    slideFiles.sort((a, b) => {
        const aNum = parseInt(a.name.match(/\d+/)?.[0] || '0', 10);
        const bNum = parseInt(b.name.match(/\d+/)?.[0] || '0', 10);
        return aNum - bNum;
    });

    return Promise.all(
        slideFiles.map(async (slideFile, index) => {
            const slideXml = await slideFile.async("string");
            const parsedXml = await xmlParser.parseStringPromise(slideXml);
            const slideTexts = extractTextFromXmlObject(parsedXml);
            return {
                SlideNumber: index + 1,
                Content: slideTexts.join("\n"),
            };
        }),
    );
}

// ─── Excel ────────────────────────────────────────────────────────────────────

/**
 * Parses an Excel (.xlsx) buffer and returns an object that maps each sheet
 * name to an array of row objects keyed by column header.
 */
export async function parseExcelBuffer(buffer: Buffer): Promise<Record<string, any[]>> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    const workbookData: Record<string, any[]> = {};

    workbook.eachSheet((worksheet) => {
        const sheetData: any[] = [];
        const headerRow = worksheet.getRow(1);

        if (!headerRow.values || headerRow.values.length === 0) {
            return;
        }

        const headers: string[] = [];
        headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            headers[colNumber] = cell.value ? cell.value.toString() : `column_${colNumber}`;
        });

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) {
                const rowObject: Record<string, any> = {};
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    const header = headers[colNumber];
                    if (header) {
                        rowObject[header] = cell.value;
                    }
                });
                if (Object.keys(rowObject).length > 0) {
                    sheetData.push(rowObject);
                }
            }
        });

        workbookData[worksheet.name] = sheetData;
    });

    return workbookData;
}

// ─── Images ───────────────────────────────────────────────────────────────────

/**
 * Returns the MIME type string for a recognised image file extension,
 * or null if the extension is not supported.
 */
export function getImageMimeType(filename: string): string | null {
    const lc = filename.toLowerCase();
    if (lc.endsWith('.png')) return 'image/png';
    if (lc.endsWith('.jpg') || lc.endsWith('.jpeg')) return 'image/jpeg';
    if (lc.endsWith('.webp')) return 'image/webp';
    if (lc.endsWith('.gif')) return 'image/gif';
    return null;
}

/**
 * Sends an image buffer to the Gemini vision model with a text prompt and
 * returns the model's response text.
 */
export async function analyzeImageBuffer(buffer: Buffer, mimeType: string, prompt: string): Promise<string> {
    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY environment variable is not set.");
    }

    const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const imagePart = {
        inlineData: {
            data: buffer.toString('base64'),
            mimeType,
        },
    };

    const result = await genAI.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: [prompt, imagePart],
        config: {
            responseModalities: ['Text'],
        },
    });

    return (result.text ?? "").trim();
}
