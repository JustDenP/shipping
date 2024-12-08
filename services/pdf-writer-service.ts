import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService, Fulfillment } from '@vendure/core';
import fs from 'node:fs/promises';
import { PDFDocument, PDFEmbeddedPage, PDFFont, PDFPage, StandardFonts } from 'pdf-lib';
import { getEasyPostClient } from './easypost';
import axios from 'axios';
import { convertZplToPdf, ZplLabel } from './zplConverter';
import fontkit from '@pdf-lib/fontkit';
import path from 'path';

function makeFontPath(filename: string) {
    return path.resolve(__dirname, '..', 'static', filename);
}
const helvetica = fs.readFile(makeFontPath('Helvetica.ttf'));
const helveticaBold = fs.readFile(makeFontPath('Helvetica-Bold.ttf'));

async function getOrEmbedFonts(pdfDoc: PDFDocument): Promise<{ font: PDFFont; boldFont: PDFFont }> {
    // Load the font files
    pdfDoc.registerFontkit(fontkit);
    const [helveticaBytes, helveticaBoldBytes] = await Promise.all([helvetica, helveticaBold]);
    const font = await pdfDoc.embedFont(helveticaBytes);
    const boldFont = await pdfDoc.embedFont(helveticaBoldBytes);
    return { font, boldFont };
}

// Currency in vendure is in cents, so we need to format it in a human readable way
function formatMoney(amount: number) {
    return `$${(amount / 100).toFixed(2)}`;
}

// Scale an object to fit in a given box
function scaleToBox(width: number, height: number, boxWidth: number, boxHeight: number) {
    const scale = Math.min(boxWidth / width, boxHeight / height);
    return {
        width: width * scale,
        height: height * scale,
        x: (boxWidth - width * scale) / 2,
    };
}

interface PDFDocument2 extends PDFDocument {
    properties: Map<string, any>;
}

function zplForError(invoiceId: string, errorMsg: string) {
    return `^XA
^FX This is an error label, not a real one.
^CF0,60
^FO50,50^GB100,100,100^FS
^FO75,75^FR^GB100,100,100^FS
^FO93,93^GB40,40,40^FS
^FO220,50^FDBroken: ${invoiceId}^FS
^CF0,30
^FO220,115^FDThis label didn't print^FS
^FO220,155^FD${errorMsg}^FS
^FO220,195^FDAddress the issue and try again^FS
^FO50,250^GB700,3,3^FS
^XZ`;
}

type DrawFooterOpts = {
    text?: string;
    font: PDFFont;
    fontSize: number;
    page: PDFPage;
    pageWidth: number;
    y: number;
};

async function getLabelDataForFulfillments(fulfillments: Fulfillment[]) {
    const epCli = getEasyPostClient();

    const results = await Promise.all(
        fulfillments.map(async fulfillment => {
            const shipmentId = fulfillment.customFields.shipmentId;
            if (!shipmentId) {
                const error = `No shipment ID found for fulfillment ${fulfillment.id}`;
                return { fulfillment, labelData: null, error };
            }

            try {
                let labelUrl = fulfillment.customFields.labelUrl;
                if (!labelUrl) {
                    const shipment = await epCli.Shipment.retrieve(shipmentId);
                    labelUrl = shipment.postage_label.label_zpl_url;
                }
                if (!labelUrl) {
                    return { fulfillment, labelData: null as Buffer, error: 'No label URL found' };
                }
                const labelResult = await axios.get(labelUrl, { responseType: 'arraybuffer' });
                const labelData = labelResult.data;
                return { fulfillment, labelData, error: null };
            } catch (err) {
                // if (err instanceof AxiosError) {
                // }
                console.error('Error getting ZPL PDF: ', err, err.stack);
                const error =
                    `Error fetching ZPL label for ${fulfillment.customFields.invoiceId}:` + err.message;
                return { fulfillment, labelData: null as Buffer, error };
            }
        }),
    );

    return results;
}

export interface PdfLabelPages {
    itemId: string;
    pdfPages: PDFPage[];
}

interface TextFragment {
    text: string;
    font: PDFFont;
    size: number;
}
async function multiText(page: PDFPage, x: number, y: number, fragments: TextFragment[]): Promise<number> {
    // Draw the text in a single line, return the height of the line
    let maxHeight = 0;
    let curX = x;
    for (const fragment of fragments) {
        // Try to draw the fragment but if it fails, convert the text to ASCII and try again
        try {
            const height = fragment.font.heightAtSize(fragment.size);
            maxHeight = Math.max(maxHeight, height);
            page.drawText(fragment.text, {
                x: curX,
                y,
                font: fragment.font,
                size: fragment.size,
            });
            curX += fragment.font.widthOfTextAtSize(fragment.text, fragment.size);
        } catch (e) {
            try {
                const asciiText = await strToAscii(fragment.text);
                const height = fragment.font.heightAtSize(fragment.size);
                maxHeight = Math.max(maxHeight, height);
                page.drawText(asciiText, {
                    x: curX,
                    y,
                    font: fragment.font,
                    size: fragment.size,
                });
                curX += fragment.font.widthOfTextAtSize(asciiText, fragment.size);
            } catch (e) {
                console.error('Error drawing text fragment:', e, e.stack);
            }
        }
    }
    return maxHeight;
}

@Injectable()
export class PdfWriterService implements OnApplicationBootstrap {
    constructor(private configService: ConfigService) {}

    static pathToLogo: string;
    static pdfLogo: PDFPage | null = null;
    static pdfThanks: PDFPage | null = null;

    static async setLogoFiles(filePath1: string, filepath2?: string) {
        // Read the file
        const logoBytes = await fs.readFile(filePath1);
        const logoDoc = await PDFDocument.load(logoBytes);
        PdfWriterService.pdfLogo = logoDoc.getPage(0);

        if (filepath2) {
            const thanksBytes = await fs.readFile(filepath2);
            const thanksDoc = await PDFDocument.load(thanksBytes);
            PdfWriterService.pdfThanks = thanksDoc.getPage(0);
        }
    }

    async onApplicationBootstrap() {
        // console.log('PdfWriterService has been initialized.');
    }

    async getZplFilesFor(fulfillments: Fulfillment[]): Promise<ZplLabel[]> {
        const zplBuffers: ZplLabel[] = [];

        // First we need to resolve the label URLs
        const labelUrlResults = await getLabelDataForFulfillments(fulfillments);

        for (const { fulfillment, labelData, error } of labelUrlResults) {
            if (error) {
                zplBuffers.push({
                    itemId: fulfillment.id.toString(),
                    zpl: Buffer.from(zplForError(fulfillment.customFields.invoiceId, error)),
                });
                continue;
            } else {
                zplBuffers.push({
                    itemId: fulfillment.id.toString(),
                    zpl: labelData,
                });
            }
        }

        return zplBuffers;
    }

    async createMultipleDocuments(
        fulfillments: Fulfillment[],
        options: {
            includePackingSlip: boolean;
            includeShippingLabel: boolean;
        },
    ): Promise<Uint8Array> {
        const pdfDoc = (await PDFDocument.create()) as PDFDocument2;
        pdfDoc.properties = new Map();
        const embeddedZpl: Record<string, PdfLabelPages> = {};
        const zplPdfMap = new Map<Buffer, PDFPage[]>();

        if (options.includeShippingLabel) {
            try {
                const zplFiles = await this.getZplFilesFor(fulfillments);
                // await fs.writeFile('zplFiles.txt', zplFiles.join('\n'));
                const zplPdfResponses = await convertZplToPdf(zplFiles);

                for (const zplPdfResponse of zplPdfResponses) {
                    const { itemId, pageEnd, pageStart, pdf } = zplPdfResponse;
                    if (!zplPdfMap.has(pdf)) {
                        const zplDoc = await PDFDocument.load(pdf);
                        zplPdfMap.set(pdf, zplDoc.getPages());
                    }
                    const pages = zplPdfMap.get(pdf);
                    embeddedZpl[itemId] = {
                        itemId,
                        pdfPages: pages.slice(pageStart, pageEnd + 1),
                    };
                }
            } catch (error) {
                console.error('Error getting ZPL PDF: ', error, error.stack);
            }
        }
        zplPdfMap.clear(); // Clear the map to free up memory

        for (let i = 0; i < fulfillments.length; i++) {
            const fulfillment = fulfillments[i];

            const isGift = fulfillment.orders.some(o => o.customFields.isGift);
            const giftMessage = fulfillment.orders
                .map(o => o.customFields.giftMessage || '')
                .filter(Boolean)
                .join(' – ');

            const lblPages = embeddedZpl[fulfillment.id.toString()];
            for (const lblPageSrc of lblPages?.pdfPages || []) {
                const lblPage = await pdfDoc.embedPage(lblPageSrc);
                const targetPage = pdfDoc.addPage([4 * 72, 6 * 72]);
                const margin = 2;

                const box = scaleToBox(
                    lblPage.width,
                    lblPage.height,
                    targetPage.getWidth() - margin * 2,
                    targetPage.getHeight() - margin * 2,
                );
                targetPage.drawPage(lblPage, {
                    x: box.x + margin,
                    y: targetPage.getHeight() - box.height - margin,
                    width: box.width,
                    height: box.height,
                });
            }
            if (options.includePackingSlip) {
                await this.addPackingSlip(pdfDoc, fulfillment, isGift, giftMessage);
            }
        }

        return pdfDoc.save();
    }

    private async getOrEmbedLogo(pdfDoc: PDFDocument2): Promise<PDFEmbeddedPage | null> {
        if (!pdfDoc.properties.has('vendureLogoEmbedded') && PdfWriterService.pdfLogo) {
            const logoPage = await pdfDoc.embedPage(PdfWriterService.pdfLogo);
            pdfDoc.properties.set('vendureLogoEmbedded', 'true');
            pdfDoc.properties.set('vendureLogo', logoPage);
            return logoPage;
        } else if (pdfDoc.properties.has('vendureLogoEmbedded')) {
            return pdfDoc.properties.get('vendureLogo') as PDFEmbeddedPage;
        }
        return null;
    }

    private async getOrEmbedThanks(pdfDoc: PDFDocument2): Promise<PDFEmbeddedPage | null> {
        if (!pdfDoc.properties.has('vendureThanksEmbedded') && PdfWriterService.pdfThanks) {
            const thanksPage = await pdfDoc.embedPage(PdfWriterService.pdfThanks);
            pdfDoc.properties.set('vendureThanksEmbedded', 'true');
            pdfDoc.properties.set('vendureThanks', thanksPage);
            return thanksPage;
        } else if (pdfDoc.properties.has('vendureThanksEmbedded')) {
            return pdfDoc.properties.get('vendureThanks') as PDFEmbeddedPage;
        }
        return null;
    }

    private async getOrEmbedFonts(pdfDoc: PDFDocument2): Promise<{ font: PDFFont; boldFont: PDFFont }> {
        if (!pdfDoc.properties.has('vendureFontsEmbedded')) {
            const { font, boldFont } = await getOrEmbedFonts(pdfDoc);
            pdfDoc.properties.set('vendureFontsEmbedded', 'true');
            pdfDoc.properties.set('vendureFont', font);
            pdfDoc.properties.set('vendureBoldFont', boldFont);
            return { font, boldFont };
        } else {
            return {
                font: pdfDoc.properties.get('vendureFont') as PDFFont,
                boldFont: pdfDoc.properties.get('vendureBoldFont') as PDFFont,
            };
        }
    }

    async addPackingSlip(
        pdfDoc: PDFDocument2,
        fulfillment: Fulfillment,
        isGiftReceipt = false,
        giftMessage = '',
    ): Promise<void> {
        if (!pdfDoc.properties) {
            pdfDoc.properties = new Map();
        }
        let page = pdfDoc.addPage([4 * 72, 6 * 72]);
        const { font, boldFont } = await this.getOrEmbedFonts(pdfDoc);
        const logo = await this.getOrEmbedLogo(pdfDoc);

        const invoiceId = fulfillment.customFields.invoiceId;

        // Set some constants
        const margin = 10;
        let fontSize = 8;
        const lineHeight = () => font.heightAtSize(fontSize) * 1.2;
        const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();

        // Define column positions
        const COL_ITEM = margin;
        const COL_PRICE = pageWidth - margin;

        // Start drawing from top-left corner
        let y = pageHeight - margin;

        if (logo) {
            // Embed the PDF file in the doc
            const box = scaleToBox(logo.width, logo.height, (pageWidth - margin * 2) / 2 + 9, 1.5 * 72);

            // Draw the logo
            const xPos = pageWidth - margin - box.width;
            const yPos = pageHeight - margin - box.height;
            page.drawPage(logo, {
                x: xPos,
                y: yPos,
                width: box.width,
                height: box.height,
            });

            y -= box.height / 2;
        }

        // Calculate the height of the header
        const headerHeight =
            font.heightAtSize(fontSize + 2) + (lineHeight() * 2) / 3 + font.heightAtSize(fontSize);
        // Y is currently in the middle of the logo; we want the header vertically
        // centered at that point
        y += headerHeight / 2;

        function drawPageHeader(pageNum = 1) {
            // Draw the header
            let headerText = isGiftReceipt ? 'Gift Receipt' : 'Packing Slip';
            if (pageNum > 1) {
                headerText += ` (Page ${pageNum})`;
            }
            page.drawText(headerText, {
                x: margin,
                y: y - font.heightAtSize(fontSize),
                font: boldFont,
                size: fontSize + 2,
            });
            y -= lineHeight() * 2;

            // Draw fulfillment information
            const shipDate = fulfillment.customFields.ratePurchasedAt ?? fulfillment.updatedAt;
            page.drawText(`Shipment Date: ${new Date(shipDate).toLocaleDateString()}`, {
                x: margin,
                y,
                font,
                size: fontSize,
            });
            y -= lineHeight();
            page.drawText(`Invoice: ${invoiceId}`, { x: margin, y, font, size: fontSize });
            y -= lineHeight() * 2;
        }
        drawPageHeader();

        // Add shipping address

        const addressY = y;
        const shippingAddress = fulfillment.orders[0]?.shippingAddress;
        if (shippingAddress) {
            fontSize -= 1;
            page.drawText('Ship To:', { x: margin, y, font: boldFont, size: fontSize });
            y -= lineHeight();

            const addressLines = [
                shippingAddress.fullName,
                shippingAddress.company,
                shippingAddress.streetLine1,
                shippingAddress.streetLine2,
                `${shippingAddress.city}${shippingAddress.province ? `, ${shippingAddress.province}` : ''} ${
                    shippingAddress.postalCode
                }`,
                shippingAddress.country,
                shippingAddress.phoneNumber,
                `Via ${fulfillment.customFields.serviceName}`,
            ].filter(line => line); // Remove any undefined or empty lines

            for (const line of addressLines) {
                // Draw with fallback to ASCII if the text is not supported
                const multiHeight = await multiText(page, margin, y, [
                    {
                        text: line,
                        font,
                        size: fontSize,
                    },
                ]);
                y -= multiHeight;
            }
            fontSize += 1;
        }

        // Draw the return address
        {
            fontSize -= 1;
            let returnY = addressY;
            const returnAddressLines = [
                process.env.SHIP_FROM_COMPANY || '',
                process.env.SHIP_FROM_STREET || '',
                `${process.env.SHIP_FROM_CITY || ''}, ${process.env.SHIP_FROM_STATE || ''} ${
                    process.env.SHIP_FROM_ZIP || ''
                }`,
                process.env.SHIP_FROM_EMAIL || '',
            ].filter(line => line); // Remove any undefined or empty lines

            page.drawText('Ship From:', { x: pageWidth / 2, y: returnY, font: boldFont, size: fontSize });
            returnY -= lineHeight();
            for (const line of returnAddressLines) {
                const multiHeight = await multiText(page, pageWidth / 2, returnY, [
                    {
                        text: line,
                        font,
                        size: fontSize,
                    },
                ]);
                returnY -= multiHeight;
            }

            y = Math.min(y, returnY);

            // Move everything else down a bit more
            y -= lineHeight();
        }
        fontSize += 1;

        // Draw column headers
        function drawColumnHeaders() {
            page.drawText('Item', { x: COL_ITEM, y, font: boldFont, size: fontSize });

            if (!isGiftReceipt) {
                const priceText = 'Price';
                const priceWidth = boldFont.widthOfTextAtSize(priceText, fontSize);
                page.drawText(priceText, { x: COL_PRICE - priceWidth, y, font: boldFont, size: fontSize });
            }

            y -= lineHeight() * 1.5;
        }
        drawColumnHeaders();

        let total = 0;

        // Calculate how many items we can fit on the page; uncomment this to calculate
        // if we need to so we know how many fit at different font sizes
        // eslint-disable-next-line no-constant-condition
        if (false) {
            const spaceLeft = y - margin;
            const footerHeight = lineHeight() * 2;
            const totalCostHeight = isGiftReceipt ? 0 : lineHeight() * 2;
            const itemHeight = lineHeight() * 2.5; // 2 lines for the item, 0.5 line for padding

            const itemsPerPage = Math.floor((spaceLeft - footerHeight - totalCostHeight) / itemHeight);
            // console.log("Enough space for item count: ", itemsPerPage);
        }

        const footerHeight =
            (isGiftReceipt ? 0 : lineHeight() * 2) + // total cost
            lineHeight() * 2; // visit and thank you footer

        // Draw fulfillment items
        const lines = [...fulfillment.lines];
        // sort lines by SKU
        // const lines = [
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        //     ...fulfillment.lines,
        // ].slice(0, 7);

        lines.sort((a, b) => a.orderLine.productVariant.sku.localeCompare(b.orderLine.productVariant.sku));

        let curPage = 1;

        if (lines && lines.length === 11) {
            fontSize -= 1;
        }
        for (const item of lines) {
            if (item.quantity < 1) {
                continue; // skip anything that was removed
            }
            // Check if we need to start a new page
            if (y < footerHeight + margin) {
                curPage++;
                page = pdfDoc.addPage([4 * 72, 6 * 72]);
                y = page.getHeight() - margin - lineHeight();
                drawPageHeader(curPage);
                drawColumnHeaders();
            }

            const line = item.orderLine;
            // Line format:
            // [SKU]                  [Qty]  [Price]
            // [Product Name]

            // line.quantity = Math.floor(Math.random() * 28) + 1;
            const qtyStr = `${line.quantity} × `;
            const sku = line.productVariant.sku;

            // Just use the english for now, if we add multi-language support we can change this later
            const translation = line.productVariant.translations.find(t => t.languageCode === 'en');

            const productName = translation.name;
            const lineTotal = line.discountedLinePrice;
            total += lineTotal;

            const multiHeight = await multiText(page, COL_ITEM, y, [
                {
                    text: qtyStr,
                    font,
                    size: fontSize + 2,
                },
                {
                    text: sku,
                    font,
                    size: fontSize,
                },
            ]);

            if (!isGiftReceipt) {
                const priceText = formatMoney(lineTotal);
                const priceWidth = font.widthOfTextAtSize(priceText, fontSize);
                page.drawText(priceText, {
                    x: COL_PRICE - priceWidth,
                    y,
                    font,
                    size: fontSize,
                });
            }

            y -= multiHeight;

            // Draw the product name with ascii fallback
            // page.drawText(productName, { x: COL_ITEM, y, font, size: fontSize });
            const multiHeight2 = await multiText(page, COL_ITEM, y, [
                {
                    text: productName,
                    font,
                    size: fontSize,
                },
            ]);
            y -= multiHeight2 * 2;
        }

        // Draw the total if it's not a gift receipt
        if (!isGiftReceipt) {
            const totalText = 'Total Item Cost:';
            const totalWidth = boldFont.widthOfTextAtSize(totalText, fontSize);
            page.drawText(totalText, { x: COL_PRICE - 60 - totalWidth, y, font: boldFont, size: fontSize });

            const totalAmount = formatMoney(total);
            const totalAmountWidth = boldFont.widthOfTextAtSize(totalAmount, fontSize);
            page.drawText(totalAmount, {
                x: COL_PRICE - totalAmountWidth,
                y,
                font: boldFont,
                size: fontSize,
            });
            y -= lineHeight() * 2;
        }
        y += lineHeight() * 2;
        // If there is still room, draw the thanks logo
        const thanksHeight = PdfWriterService.pdfThanks ? PdfWriterService.pdfThanks.getHeight() : -1;
        if (thanksHeight > -1 && y - thanksHeight > margin + lineHeight() * 2) {
            const thanksPage = await this.getOrEmbedThanks(pdfDoc);
            const box = scaleToBox(
                thanksPage.width,
                thanksPage.height,
                pageWidth - margin * 2,
                thanksPage.height,
            );

            // Center in available space
            const yMin = y;
            const yMax = margin + lineHeight() * 2;

            const yMid = (yMin + yMax) / 2;
            const yPos = yMid - box.height / 2;

            page.drawPage(thanksPage, {
                x: margin + box.x,
                y: yPos,
                width: box.width,
                height: box.height,
            });
        }

        y = margin + lineHeight();
        const helpFooter = 'Visit https://signalstuff.com/faq with any questions.';
        // draw centered
        page.drawText(helpFooter, {
            x: pageWidth / 2 - font.widthOfTextAtSize(helpFooter, fontSize) / 2,
            y,
            font,
            size: fontSize,
        });

        y -= lineHeight();

        // Draw the footer
        await this.drawFooterText({
            text: isGiftReceipt && giftMessage ? giftMessage : '',
            font,
            fontSize,
            page,
            pageWidth,
            y,
        });
    }

    async drawFooterText({ text, font, fontSize, page, pageWidth, y }: DrawFooterOpts) {
        const defaultText = 'Thank you for supporting HamStudy.org and ExamTools!';
        text = text || defaultText;
        try {
            // Try to draw the text but if it fails, convert the text to ASCII and try again
            page.drawText(text, {
                x: pageWidth / 2 - font.widthOfTextAtSize(text, fontSize) / 2,
                y,
                font,
                size: fontSize,
            });
        } catch (e) {
            try {
                const asciiText = await strToAscii(text);
                page.drawText(asciiText, {
                    x: pageWidth / 2 - font.widthOfTextAtSize(asciiText, fontSize) / 2,
                    y,
                    font,
                    size: fontSize,
                });
            } catch (e) {
                page.drawText(defaultText, {
                    x: pageWidth / 2 - font.widthOfTextAtSize(defaultText, fontSize) / 2,
                    y,
                    font,
                    size: fontSize,
                });
            }
        }
    }

    /**
     * Generates a pick list PDF for the given fulfillments.
     * @param fulfillments
     * @returns
     */
    async createPickListPdf(fulfillments: Fulfillment[]) {
        const pdfDoc = (await PDFDocument.create()) as PDFDocument2;
        pdfDoc.properties = new Map();
        const { font, boldFont } = await this.getOrEmbedFonts(pdfDoc);
        let page = pdfDoc.addPage([4 * 72, 6 * 72]); // 4"x6" page size
        const margin = 20;
        const pageWidth = page.getWidth();
        let fontSize = 12;
        const curX = margin;
        const lineHeight = () => font.heightAtSize(fontSize);

        let y = page.getHeight() - margin;

        const drawText = (text: string, size = fontSize, align: 'left' | 'right' = 'left') => {
            const maxWidth = pageWidth - 2 * margin;
            const words = text.split(' ');
            let line = '';
            const lineHeight = () => font.heightAtSize(size);

            for (const word of words) {
                const testLine = line + (line ? ' ' : '') + word;
                const testLineWidth = font.widthOfTextAtSize(testLine, size);

                if (testLineWidth > maxWidth) {
                    // Draw the current line and move to the next line
                    const x =
                        align === 'right' ? pageWidth - margin - font.widthOfTextAtSize(line, size) : curX;
                    page.drawText(line, {
                        x,
                        y: y - lineHeight(),
                        font,
                        size,
                    });
                    y -= lineHeight();

                    // Start the new line with the current word
                    line = word;
                } else {
                    // Add the word to the current line
                    line = testLine;
                }
            }

            // Draw the last line
            const x = align === 'right' ? pageWidth - margin - font.widthOfTextAtSize(line, size) : curX;
            page.drawText(line, {
                x,
                y: y - lineHeight(),
                font,
                size,
            });
            y -= lineHeight();
        };
        // Draw header
        drawText(`Pick List For ${fulfillments.length} Shipment(s)`, fontSize + 2);
        y -= lineHeight();

        // Group items by SKU and calculate total quantity
        const itemMap = new Map<string, { sku: string; name: string; quantity: number }>();
        for (const fulfillment of fulfillments) {
            for (const line of fulfillment.lines) {
                const sku = line.orderLine.productVariant.sku;
                const name =
                    line.orderLine.productVariant.translations.find(t => t.languageCode === 'en')?.name ||
                    sku;
                const quantity = line.quantity;

                if (itemMap.has(sku)) {
                    itemMap.get(sku)!.quantity += quantity;
                } else {
                    itemMap.set(sku, { sku, name, quantity });
                }
            }
        }

        let pageNum = 1;
        const itemValues = Array.from(itemMap.values());
        itemValues.sort((a, b) => a.sku.localeCompare(b.sku));
        // Draw each SKU and total quantity
        for (const item of itemValues) {
            // SKU on the left, quantity right-aligned on the first line
            const qtyStr = `${item.quantity} × ${item.sku}`;
            drawText(qtyStr);

            // Product name on the second line
            drawText(item.name, fontSize - 2);
            y -= lineHeight(); // Extra space between items

            if (y < margin + lineHeight() * 3) {
                // Add new page if the current page is full
                page = pdfDoc.addPage([4 * 72, 6 * 72]);
                y = page.getHeight() - margin;

                fontSize += 2;
                drawText(`Pick List (page ${++pageNum})`, fontSize + 2);
                y -= lineHeight();
                fontSize -= 2;
            }
        }

        return pdfDoc.save();
    }
}

async function latinize(str: string) {
    return (await import('latinize')).default(str);
}

let iconv: import('iconv').Iconv;
async function makeIconv() {
    // const newIconv = new (require('iconv') as typeof import('iconv')).Iconv('UTF-8', 'ASCII//TRANSLIT');
    // using import
    const iconvLib = await import('iconv');
    const newIconv = new iconvLib.Iconv('UTF-8', 'ASCII//TRANSLIT');
    iconv = newIconv;
    return newIconv;
}

async function strToAscii(str: string) {
    if (!iconv) iconv = await makeIconv();
    if (!str) {
        return str;
    }
    str = await latinize(str.normalize());
    return (
        iconv
            .convert(str)
            .toString('utf8')
            // eslint-disable-next-line no-control-regex
            .replace(/[^\x01-\x7F]/g, '')
    );
}
