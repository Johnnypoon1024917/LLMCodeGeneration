// webview-ui/src/utils/attachmentTypes.ts
//
// Type definitions for spec-page attachments. Three kinds:
//
//   1. text — code/spec text files (.md, .txt, .ts, etc.). Content goes
//      directly into the LLM prompt as context.
//
//   2. pdf — text-extractable PDFs. Text extracted via pdfjs-dist and
//      sent to the LLM. Preview shows file name + page count.
//
//   3. image — JPG/PNG/etc. Preview only. NOT sent to the LLM because
//      Qwen 3.6 27B is text-only and we don't have a vision endpoint
//      configured. Stage 3 (deferred) wires this up to a vision model.
//
// Why separate types: callers need to know which attachments produce
// LLM-visible content vs which are just visual references. The spec
// generation prompt builder filters by `kind` to decide what to
// concatenate into the context block.

export interface TextAttachment {
    kind: 'text';
    /** Original filename (display only, no path) */
    name: string;
    /** Raw text content — sent to LLM as context */
    content: string;
}

export interface PdfAttachment {
    kind: 'pdf';
    name: string;
    /** Text extracted from PDF — sent to LLM as context */
    extractedText: string;
    /** Total pages, shown in preview */
    pageCount: number;
    /** True if pdfjs returned non-empty text for at least one page.
     *  False for scanned-image PDFs (no embedded text). */
    hasExtractableText: boolean;
    /**
     * Base64 data URL of the first page rendered as an image, used
     * for the thumbnail in the preview. Empty string when rendering
     * was skipped/failed (preview falls back to a generic icon).
     */
    thumbnailDataUrl: string;
}

export interface ImageAttachment {
    kind: 'image';
    name: string;
    /** Base64 data URL — used for preview rendering only.
     *  NOT sent to the LLM (Qwen 3.6 is text-only). */
    dataUrl: string;
    /** Original MIME type, e.g. 'image/png' */
    mimeType: string;
    /** Original byte size, shown in preview */
    sizeBytes: number;
}

export type SpecAttachment = TextAttachment | PdfAttachment | ImageAttachment;

/**
 * Build the LLM-visible context string from a list of attachments.
 * Image attachments are mentioned by name in a clear "not analyzed"
 * note rather than dropped silently — the user should know what the
 * model can and can't see.
 */
export function buildAttachmentContext(attachments: SpecAttachment[]): string {
    if (attachments.length === 0) {
        return '';
    }

    const parts: string[] = [];
    const imageNames: string[] = [];

    for (const att of attachments) {
        if (att.kind === 'text') {
            parts.push(`--- ATTACHED FILE: ${att.name} ---\n${att.content}`);
        } else if (att.kind === 'pdf') {
            if (att.hasExtractableText) {
                parts.push(
                    `--- ATTACHED PDF: ${att.name} (${att.pageCount} page${att.pageCount === 1 ? '' : 's'}) ---\n${att.extractedText}`
                );
            } else {
                // Scanned PDF — no text extracted. Tell the model
                // honestly rather than sending an empty block.
                parts.push(
                    `--- ATTACHED PDF: ${att.name} (${att.pageCount} page${att.pageCount === 1 ? '' : 's'}, scanned/image-only — no text could be extracted) ---`
                );
            }
        } else {
            // image
            imageNames.push(att.name);
        }
    }

    if (imageNames.length > 0) {
        parts.push(
            `--- ATTACHED IMAGES (NOT ANALYZED) ---\n` +
            `The user attached the following images: ${imageNames.join(', ')}.\n` +
            `Note: Image content is not visible to the model in the current configuration. ` +
            `If the user's request depends on understanding diagrams or visual content, ` +
            `ask them to describe the relevant parts in text.`
        );
    }

    return parts.join('\n\n');
}