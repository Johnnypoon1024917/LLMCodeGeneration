// webview-ui/src/components/AttachmentPreview.tsx
//
// Visual preview row for spec-page attachments. Renders each attachment
// as a small chip with an icon/thumbnail, name, metadata, and a remove
// button. Image attachments include an "image not analyzed" badge so
// users know the visual content isn't being sent to the LLM (Stage 2
// scope — vision support comes later).
//
// Why a chip row vs. a list: spec docs might bring 5+ attachments
// (PRD, design diagram, API spec, error log...). Vertical lists eat
// the spec form's vertical space. Chips wrap horizontally and stay
// compact.

import React from 'react';
import type { SpecAttachment } from '../utils/attachmentTypes';
import './AttachmentPreview.css';

interface Props {
    attachments: SpecAttachment[];
    onRemove: (index: number) => void;
}

export const AttachmentPreview: React.FC<Props> = ({ attachments, onRemove }) => {
    if (attachments.length === 0) {
        return null;
    }

    return (
        <div className="attachment-preview" role="list" aria-label="Attached files">
            {attachments.map((att, idx) => (
                <AttachmentChip
                    key={`${att.name}-${idx}`}
                    attachment={att}
                    onRemove={() => onRemove(idx)}
                />
            ))}
        </div>
    );
};

interface ChipProps {
    attachment: SpecAttachment;
    onRemove: () => void;
}

const AttachmentChip: React.FC<ChipProps> = ({ attachment, onRemove }) => {
    return (
        <div className="attachment-chip" role="listitem">
            <ChipThumbnail attachment={attachment} />
            <div className="attachment-chip__body">
                <div className="attachment-chip__name" title={attachment.name}>
                    {attachment.name}
                </div>
                <ChipMeta attachment={attachment} />
            </div>
            <button
                type="button"
                className="attachment-chip__remove"
                onClick={onRemove}
                aria-label={`Remove ${attachment.name}`}
                title="Remove"
            >
                ×
            </button>
        </div>
    );
};

const ChipThumbnail: React.FC<{ attachment: SpecAttachment }> = ({ attachment }) => {
    if (attachment.kind === 'image') {
        return (
            <div className="attachment-chip__thumb attachment-chip__thumb--image">
                <img src={attachment.dataUrl} alt="" />
            </div>
        );
    }

    if (attachment.kind === 'pdf') {
        if (attachment.thumbnailDataUrl) {
            return (
                <div className="attachment-chip__thumb attachment-chip__thumb--pdf">
                    <img src={attachment.thumbnailDataUrl} alt="" />
                </div>
            );
        }
        // Fallback PDF icon
        return (
            <div className="attachment-chip__thumb attachment-chip__thumb--icon">
                <PdfIcon />
            </div>
        );
    }

    // text
    return (
        <div className="attachment-chip__thumb attachment-chip__thumb--icon">
            <TextIcon />
        </div>
    );
};

const ChipMeta: React.FC<{ attachment: SpecAttachment }> = ({ attachment }) => {
    if (attachment.kind === 'image') {
        return (
            <div className="attachment-chip__meta">
                <span className="attachment-chip__size">{formatBytes(attachment.sizeBytes)}</span>
                <span className="attachment-chip__badge attachment-chip__badge--warning" title="Image content is not sent to the model. Describe the diagram in text if it matters for the spec.">
                    image not analyzed
                </span>
            </div>
        );
    }

    if (attachment.kind === 'pdf') {
        return (
            <div className="attachment-chip__meta">
                <span>{attachment.pageCount} page{attachment.pageCount === 1 ? '' : 's'}</span>
                {!attachment.hasExtractableText && (
                    <span className="attachment-chip__badge attachment-chip__badge--warning" title="This PDF appears to be scanned (image-only). No text could be extracted.">
                        no text extracted
                    </span>
                )}
            </div>
        );
    }

    // text
    return (
        <div className="attachment-chip__meta">
            <span>{attachment.content.length.toLocaleString()} chars</span>
        </div>
    );
};

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Icons ────────────────────────────────────────────────────────────

const PdfIcon: React.FC = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <text x="7" y="18" fontSize="6" fill="currentColor" stroke="none" fontWeight="bold">PDF</text>
    </svg>
);

const TextIcon: React.FC = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
);