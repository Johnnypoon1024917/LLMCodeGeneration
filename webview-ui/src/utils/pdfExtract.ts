// webview-ui/src/utils/pdfExtract.ts
//
// Pure helper for extracting text from PDF files in the webview.
// Uses pdfjs-dist directly (no separate worker file).
//
// CSP note: the extension's webview CSP blocks worker scripts and
// remote chunks. We force pdf.js to run on the main thread by
// nulling out workerSrc. This is slower than the worker variant for
// huge PDFs, but spec docs are typically <50 pages and the perf hit
// is invisible. The alternative (shipping a vendored worker bundle
// + adjusting CSP) is more code surface for marginal benefit.
//
// What this returns:
//   - text: concatenated text from all pages, separated by form-feed
//   - pageCount: total pages
//   - hasExtractableText: true if at least one page had non-empty text.
//     Scanned PDFs (image-only) return false here, signaling to callers
//     that no useful text was extracted.

import * as pdfjsLib from 'pdfjs-dist';

// Disable the worker entirely. With this set, getDocument() runs the
// PDF parser on the main thread. Without setting it, pdf.js tries to
// load a worker from a path the webview CSP forbids, throwing.
//
// We assign empty string (not null/undefined) because the type is
// strictly `string`. Setting it to '' tells pdf.js "no worker URL,
// run inline".
//
// This MUST be set before getDocument() is called. Setting it at
// module-load time means the first import wins and subsequent
// extractions reuse the same configuration.
(pdfjsLib.GlobalWorkerOptions as { workerSrc: string }).workerSrc = '';

export interface PdfExtractResult {
    /** Plain text from all pages, page boundaries marked with \f */
    text: string;
    /** Number of pages in the document */
    pageCount: number;
    /** True if at least one page produced non-empty text */
    hasExtractableText: boolean;
}

/**
 * Extract text from a PDF given as an ArrayBuffer.
 *
 * Throws if the buffer isn't a valid PDF (wrong magic bytes, corrupt
 * structure, encrypted without password, etc.). Caller decides how to
 * surface the failure — typically a banner saying "couldn't read this
 * PDF, try another file".
 *
 * For scanned-image PDFs (no embedded text), the returned text will
 * be empty and `hasExtractableText` will be false. Callers should
 * surface this to the user ("PDF appears to be scanned — text could
 * not be extracted") rather than sending an empty string to the LLM
 * as if it were the document content.
 */
export async function extractPdfText(buffer: ArrayBuffer): Promise<PdfExtractResult> {
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;

    const pageCount = pdf.numPages;
    const pageTexts: string[] = [];
    let hasExtractableText = false;

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        // textContent.items is a mix of TextItem and TextMarkedContent
        // (the latter is metadata, no `.str`). Filter to TextItems and
        // concatenate. Adding spaces between items because pdf.js
        // returns them as separate runs even within the same line.
        const pageText = textContent.items
            .map((item) => {
                // TypeScript can't narrow this without a type guard, so
                // we check at runtime: only TextItem has a `str` field.
                if (typeof (item as { str?: unknown }).str === 'string') {
                    return (item as { str: string }).str;
                }
                return '';
            })
            .join(' ')
            .trim();

        if (pageText.length > 0) {
            hasExtractableText = true;
        }
        pageTexts.push(pageText);
    }

    // \f (form feed) as page separator — distinct enough that the LLM
    // or downstream consumer can split on it if needed. Most consumers
    // will treat it as a regular whitespace, which is fine.
    return {
        text: pageTexts.join('\f'),
        pageCount,
        hasExtractableText,
    };
}