import axios, { AxiosError } from 'axios';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY = 500;
const MAX_PAGES_PER_REQUEST = 50;

const invertZpl = Buffer.from(`^POI`);
const normalZpl = Buffer.from(`^PON`);
const startLabelMarker = Buffer.from('^XA');

export interface ZplLabel {
    itemId: string;
    zpl: Buffer;
}

export interface PdfLabel {
    itemId: string;
    pdf: Buffer;
    pageStart: number;
    pageEnd: number;
}

function bufferReplace(buffer: Buffer, search: Buffer, replace: Buffer): Buffer {
    if (search.length !== replace.length) {
        throw new Error('Search and replace buffers must have the same length.');
    }

    let index = 0;
    const parts: Buffer[] = [];

    while ((index = buffer.indexOf(search, index)) !== -1) {
        parts.push(buffer.slice(0, index));
        parts.push(replace);
        buffer = buffer.slice(index + search.length);
        index = 0;
    }

    parts.push(buffer);
    return Buffer.concat(parts);
}

function bufferCountInstancesOf(haystack: Buffer, needle: Buffer): number {
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
        count++;
        index += needle.length;
    }
    return count;
}

interface BatchItem {
    orderId: string;
    zplBuffer: Buffer;
    pageCount: number;
}

export async function convertZplToPdf(
    labels: ZplLabel[],
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelay = DEFAULT_BASE_DELAY,
): Promise<PdfLabel[]> {
    // Convert ZPL strings to buffers and count pages
    const labelInfos: BatchItem[] = [];

    for (const label of labels) {
        const zplBuffer = Buffer.from(label.zpl);
        // Fix inverted labels
        const fixedBuffer = bufferReplace(zplBuffer, invertZpl, normalZpl);
        const pageCount = bufferCountInstancesOf(fixedBuffer, startLabelMarker);

        labelInfos.push({
            orderId: label.itemId,
            zplBuffer: fixedBuffer,
            pageCount,
        });
    }

    async function makeRequest(batch: BatchItem[], retriesLeft: number = maxRetries): Promise<Buffer> {
        const concatenatedZpl = Buffer.concat(batch.map(item => item.zplBuffer));
        try {
            const zplPdfResponse = await axios.post(
                'https://api.labelary.com/v1/printers/8dpmm/labels/4x6/',
                concatenatedZpl,
                {
                    responseType: 'arraybuffer',
                    headers: {
                        Accept: 'application/pdf',
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                },
            );

            return Buffer.from(zplPdfResponse.data);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                const axiosError = error as AxiosError;
                if (axiosError.response) {
                    switch (axiosError.response.status) {
                        case 429:
                            if (retriesLeft > 0) {
                                const delay = baseDelay + Math.random() * 1000;
                                await new Promise(resolve => setTimeout(resolve, delay));
                                return makeRequest(batch, retriesLeft - 1);
                            } else {
                                throw new Error('Max retries reached for rate limit');
                            }
                        case 413:
                            throw new Error('Payload too large: maximum 50 pages per request');
                        case 400:
                            throw new Error(
                                'Bad request: check label size and embedded object/image constraints',
                            );
                        default:
                            throw new Error(
                                `HTTP error ${axiosError.response.status}: ${axiosError.response.statusText}`,
                            );
                    }
                }
            }
            throw error;
        }
    }

    // Create batches that respect the MAX_PAGES_PER_REQUEST limit
    const batches: BatchItem[][] = [];
    let currentBatch: BatchItem[] = [];
    let currentBatchPages = 0;

    for (const labelInfo of labelInfos) {
        // If adding this label would exceed the page limit, start a new batch
        if (currentBatchPages + labelInfo.pageCount > MAX_PAGES_PER_REQUEST) {
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }
            currentBatch = [];
            currentBatchPages = 0;
        }

        // If a single label has more pages than the limit, throw an error
        if (labelInfo.pageCount > MAX_PAGES_PER_REQUEST) {
            throw new Error(
                `Order ${labelInfo.orderId} has ${labelInfo.pageCount} pages, which exceeds the maximum of ${MAX_PAGES_PER_REQUEST} pages per request`,
            );
        }

        currentBatch.push(labelInfo);
        currentBatchPages += labelInfo.pageCount;
    }

    // Add the last batch if it's not empty
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    // Process each batch and create PdfLabel objects
    const pdfLabels: PdfLabel[] = [];
    for (const batch of batches) {
        const pdfBuffer = await makeRequest(batch);
        let pdfPage = 0;

        // Create PdfLabel objects for each item in the batch
        for (const item of batch) {
            pdfLabels.push({
                itemId: item.orderId,
                pdf: pdfBuffer,
                pageStart: pdfPage,
                pageEnd: pdfPage + item.pageCount - 1,
            });
            pdfPage += item.pageCount;
        }
    }

    return pdfLabels;
}
