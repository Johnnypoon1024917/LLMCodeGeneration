// webview-ui/src/test/unit/attachmentTypes.test.ts
//
// Tests for buildAttachmentContext — the function that turns a list of
// SpecAttachments into a single context string for the LLM prompt.
//
// Why this matters: the function is the boundary between "user attached
// files" and "LLM sees text". A bug here means either silently dropping
// content or sending image data to a text-only model. We test it because
// the rules (especially "image not analyzed" notes) are easy to regress.

import { describe, it, expect } from 'vitest';
import { buildAttachmentContext, type SpecAttachment } from '../../utils/attachmentTypes';

describe('buildAttachmentContext', () => {
    it('returns empty string for empty list', () => {
        expect(buildAttachmentContext([])).toBe('');
    });

    it('includes text attachment content verbatim with file name', () => {
        const att: SpecAttachment = {
            kind: 'text',
            name: 'spec.md',
            content: '# My Spec\n\nThings to build.',
        };
        const result = buildAttachmentContext([att]);
        expect(result).toContain('spec.md');
        expect(result).toContain('# My Spec');
        expect(result).toContain('Things to build.');
    });

    it('includes PDF text with page count when extractable', () => {
        const att: SpecAttachment = {
            kind: 'pdf',
            name: 'requirements.pdf',
            extractedText: 'Page 1 content. Page 2 content.',
            pageCount: 2,
            hasExtractableText: true,
            thumbnailDataUrl: '',
        };
        const result = buildAttachmentContext([att]);
        expect(result).toContain('requirements.pdf');
        expect(result).toContain('2 pages');
        expect(result).toContain('Page 1 content');
        expect(result).toContain('Page 2 content');
    });

    it('uses singular "page" for single-page PDFs', () => {
        const att: SpecAttachment = {
            kind: 'pdf',
            name: 'one-pager.pdf',
            extractedText: 'Just one page.',
            pageCount: 1,
            hasExtractableText: true,
            thumbnailDataUrl: '',
        };
        const result = buildAttachmentContext([att]);
        expect(result).toContain('1 page');
        // Make sure we didn't say "1 pages"
        expect(result).not.toContain('1 pages');
    });

    it('marks scanned PDFs (no extractable text) with explicit notice', () => {
        const att: SpecAttachment = {
            kind: 'pdf',
            name: 'scanned.pdf',
            extractedText: '',
            pageCount: 5,
            hasExtractableText: false,
            thumbnailDataUrl: '',
        };
        const result = buildAttachmentContext([att]);
        expect(result).toContain('scanned.pdf');
        expect(result).toContain('5 pages');
        // Critical: the model needs to know we couldn't read the content,
        // not be sent an empty block as if it were the document.
        expect(result.toLowerCase()).toMatch(/scanned|image-only|no text/);
    });

    it('includes image attachments by name with NOT ANALYZED note', () => {
        const att: SpecAttachment = {
            kind: 'image',
            name: 'architecture-diagram.png',
            dataUrl: 'data:image/png;base64,XXX',
            mimeType: 'image/png',
            sizeBytes: 12345,
        };
        const result = buildAttachmentContext([att]);
        expect(result).toContain('architecture-diagram.png');
        // The model must know the image content isn't visible to it.
        // Without this, it might confidently describe a diagram it never saw.
        expect(result.toLowerCase()).toContain('not analyzed');
        expect(result.toLowerCase()).toContain('not visible');
    });

    it('does NOT leak base64 image data into the LLM context', () => {
        const att: SpecAttachment = {
            kind: 'image',
            name: 'pic.jpg',
            dataUrl: 'data:image/jpeg;base64,SOMEVERYLONGBASE64STRING12345',
            mimeType: 'image/jpeg',
            sizeBytes: 999,
        };
        const result = buildAttachmentContext([att]);
        expect(result).not.toContain('SOMEVERYLONGBASE64STRING');
        expect(result).not.toContain('data:image');
    });

    it('groups multiple images into a single notice block', () => {
        const attachments: SpecAttachment[] = [
            { kind: 'image', name: 'a.png', dataUrl: '', mimeType: 'image/png', sizeBytes: 1 },
            { kind: 'image', name: 'b.jpg', dataUrl: '', mimeType: 'image/jpeg', sizeBytes: 2 },
            { kind: 'image', name: 'c.gif', dataUrl: '', mimeType: 'image/gif', sizeBytes: 3 },
        ];
        const result = buildAttachmentContext(attachments);
        expect(result).toContain('a.png');
        expect(result).toContain('b.jpg');
        expect(result).toContain('c.gif');
        // Should be mentioned once, not three separate blocks
        const matches = result.match(/NOT ANALYZED/g) ?? [];
        expect(matches.length).toBe(1);
    });

    it('handles a mixed bag (text + pdf + image) correctly', () => {
        const attachments: SpecAttachment[] = [
            { kind: 'text', name: 'notes.md', content: 'Notes here' },
            { kind: 'pdf', name: 'spec.pdf', extractedText: 'PDF text', pageCount: 3, hasExtractableText: true, thumbnailDataUrl: '' },
            { kind: 'image', name: 'diagram.png', dataUrl: '', mimeType: 'image/png', sizeBytes: 100 },
        ];
        const result = buildAttachmentContext(attachments);
        expect(result).toContain('notes.md');
        expect(result).toContain('Notes here');
        expect(result).toContain('spec.pdf');
        expect(result).toContain('PDF text');
        expect(result).toContain('diagram.png');
        expect(result.toLowerCase()).toContain('not analyzed');
    });
});