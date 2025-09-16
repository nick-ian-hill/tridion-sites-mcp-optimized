import { z } from "zod";
import ExcelJS from "exceljs";
import { Buffer } from 'buffer';
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const readExcelFileFromMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the Excel (.xlsx) file (e.g., 'tcm:5-124')."),
};

const readExcelFileFromMultimediaComponentSchema = z.object(readExcelFileFromMultimediaComponentInputProperties);

export const readExcelFileFromMultimediaComponent = {
    name: "readExcelFileFromMultimediaComponent",
    description: `Reads the content of an Excel file (.xlsx) from a multimedia component and returns its data as a JSON string.
    This tool can be useful in cases where the user would like semi-structured content in the form of an Excel file to be mapped to new items in the CMS.`,
    input: readExcelFileFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readExcelFileFromMultimediaComponentSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            console.log(`Fetching item details for ${itemId} to verify it's an Excel file.`);
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);

            const itemData = getItemResponse.data;

            if (itemData.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }
            if (!itemData.BinaryContent?.Filename?.toLowerCase().endsWith('.xlsx')) {
                throw new Error(`The file in component ${itemId} is not a .xlsx file. Filename: ${itemData.BinaryContent?.Filename}`);
            }

            console.log(`Downloading binary content for Excel file: ${itemData.BinaryContent.Filename}`);
            const downloadResponse = await authenticatedAxios.get<ArrayBuffer>(
                `/items/${restItemId}/binary/download`, 
                {
                    responseType: 'arraybuffer'
                }
            );
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            
            const excelFileBuffer: Buffer = Buffer.from(downloadResponse.data);
            console.log(`Successfully downloaded ${excelFileBuffer.length} bytes.`);

            console.log("Parsing .xlsx content into JSON using exceljs...");
            const workbook = new ExcelJS.Workbook();

            await workbook.xlsx.load(excelFileBuffer as unknown as ExcelJS.Buffer);
            
            const workbookData: { [key: string]: any[] } = {};

            workbook.eachSheet((worksheet, _sheetId) => {
                const sheetData: any[] = [];
                const headerRow = worksheet.getRow(1);
                if (!headerRow.values || headerRow.values.length === 0) return;

                const headers: string[] = [];
                headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                   headers[colNumber] = cell.value ? cell.value.toString() : `column_${colNumber}`;
                });

                worksheet.eachRow((row, rowNumber) => {
                    if (rowNumber > 1) {
                        const rowObject: { [key: string]: any } = {};
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
            
            const jsonString = JSON.stringify(workbookData, null, 2);
            console.log("Parsing complete.");

            return {
                content: [{ type: "text", text: jsonString }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read Excel file from multimedia component ${itemId}`);
        }
    }
};