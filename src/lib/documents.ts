import { fileTypeFromBuffer } from "file-type";

export type DocumentType = { ext: string; mime: string };

// Detected from file contents, never trusted from the client's Content-Type.
export const DOCUMENT_TYPES: Record<string, DocumentType> = {
    pdf: { ext: "pdf", mime: "application/pdf" },
    docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    // Legacy .doc files are OLE compound documents.
    cfb: { ext: "doc", mime: "application/msword" },
};

export const PDF_MIME = DOCUMENT_TYPES.pdf!.mime;

/** Returns the document type (PDF, DOC or DOCX) of a file's contents, or null for anything else. */
export async function detectDocument(buffer: Buffer): Promise<DocumentType | null> {
    const detected = await fileTypeFromBuffer(buffer);
    return (detected && DOCUMENT_TYPES[detected.ext]) ?? null;
}
