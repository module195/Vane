import path from "path";
import BaseEmbedding from "../models/base/embedding"
import crypto from "crypto"
import fs from 'fs';
import { splitText } from "../utils/splitText";
import { PDFParse } from 'pdf-parse';
import { CanvasFactory } from 'pdf-parse/worker';
import officeParser from 'officeparser'
import { resolveUploadsDirs } from "./paths";
import { withEmbeddingSlot } from "../models/utils/embeddingLimiter";

const supportedMimeTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'] as const

type SupportedMimeType = typeof supportedMimeTypes[number];

type UploadManagerParams = {
    embeddingModel: BaseEmbedding<any>;
    /** Which model made the embeddings, recorded with the chunks. */
    embeddingModelInfo?: { providerId: string; key: string };
}

/** Chunks per embedding request when indexing an upload. */
export const UPLOAD_EMBED_BATCH = 32;

const extractText = async (filePath: string, fileType: SupportedMimeType): Promise<string> => {
    switch (fileType) {
        case 'text/plain':
            return fs.readFileSync(filePath, 'utf-8');
        case 'application/pdf': {
            const parser = new PDFParse({
                data: fs.readFileSync(filePath),
                CanvasFactory
            })
            return parser.getText().then(res => res.text);
        }
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return (await officeParser.parseOffice(fs.readFileSync(filePath))).toText();
        default:
            throw new Error(`Unsupported file type: ${fileType}`);
    }
}

type RecordedFile = {
    id: string;
    name: string;
    filePath: string;
    contentPath: string;
    uploadedAt: string;
}

type FileRes = {
    fileName: string;
    fileExtension: string;
    fileId: string;
}

class UploadManager {
    private embeddingModel: BaseEmbedding<any>;
    // New uploads go to DATA_DIR/data/uploads (cwd/data/uploads when DATA_DIR
    // is unset). Files uploaded before that, when uploads always went to
    // cwd/data/uploads, are left where they are and found through
    // legacyUploadsDir on a lookup miss; nothing is moved or rewritten there.
    static uploadsDir = resolveUploadsDirs().uploadsDir;
    static uploadedFilesRecordPath = path.join(this.uploadsDir, 'uploaded_files.json');
    static legacyUploadsDir: string | null = resolveUploadsDirs().legacyUploadsDir;

    constructor(private params: UploadManagerParams) {
        this.embeddingModel = params.embeddingModel;

        if (!fs.existsSync(UploadManager.uploadsDir)) {
            fs.mkdirSync(UploadManager.uploadsDir, { recursive: true });
        }

        if (!fs.existsSync(UploadManager.uploadedFilesRecordPath)) {
            const data = {
                files: []
            }

            fs.writeFileSync(UploadManager.uploadedFilesRecordPath, JSON.stringify(data, null, 2));
        }
    }

    private static getRecordedFiles(): RecordedFile[] {
        const data = fs.readFileSync(UploadManager.uploadedFilesRecordPath, 'utf-8');
        return JSON.parse(data).files;
    }

    private static addNewRecordedFile(fileRecord: RecordedFile) {
        const currentData = this.getRecordedFiles()

        currentData.push(fileRecord);

        fs.writeFileSync(UploadManager.uploadedFilesRecordPath, JSON.stringify({ files: currentData }, null, 2));
    }

    static getFile(fileId: string): RecordedFile | null {
        const recordedFiles = this.getRecordedFiles();

        return recordedFiles.find(f => f.id === fileId) || this.getLegacyFile(fileId);
    }

    private static getLegacyFile(fileId: string): RecordedFile | null {
        if (!this.legacyUploadsDir) return null;

        const legacyRecordPath = path.join(this.legacyUploadsDir, 'uploaded_files.json');
        if (!fs.existsSync(legacyRecordPath)) return null;

        try {
            const files: RecordedFile[] = JSON.parse(fs.readFileSync(legacyRecordPath, 'utf-8')).files;
            return files.find(f => f.id === fileId) || null;
        } catch (err) {
            console.log('Error reading legacy uploads record:', err);
            return null;
        }
    }

    static getFileChunks(fileId: string): { content: string; embedding: number[] }[] {
        try {
            const recordedFile = this.getFile(fileId);

            if (!recordedFile) {
                throw new Error(`File with ID ${fileId} not found`);
            }

            const contentData = JSON.parse(fs.readFileSync(recordedFile.contentPath, 'utf-8'))

            return contentData.chunks;
        } catch (err) {
            console.log('Error getting file chunks:', err);
            return [];
        }
    }

    /** Extracts the text of an uploaded file, embeds it and writes the
     *  chunks (with the embedding model used) next to the file. */
    private async extractContentAndEmbed(filePath: string, fileType: SupportedMimeType): Promise<string> {
        const text = await extractText(filePath, fileType);
        const chunks = splitText(text, 512, 128);
        const embeddings = await this.embedInBatches(chunks);

        if (embeddings.length !== chunks.length) {
            throw new Error('Embeddings and text chunks length mismatch');
        }

        const contentPath = filePath.split('.').slice(0, -1).join('.') + '.content.json';

        const data = {
            // Recorded so a search can tell uploads made with another
            // embedding model apart (G1-16). Older files do not have it.
            embeddingModel: {
                ...this.params.embeddingModelInfo,
                dims: embeddings[0]?.length ?? 0,
            },
            chunks: chunks.map((content, i) => ({
                content,
                embedding: embeddings[i],
            })),
        };

        fs.writeFileSync(contentPath, JSON.stringify(data, null, 2));

        return contentPath;
    }

    /* A large file used to go out as one request with every chunk, which a
       local server (Ollama, LM Studio) answers with 500/502 or a timeout,
       and outside the limiter the searches share. Batches keep the order. */
    private async embedInBatches(chunks: string[]): Promise<number[][]> {
        const batches: string[][] = [];
        for (let i = 0; i < chunks.length; i += UPLOAD_EMBED_BATCH) {
            batches.push(chunks.slice(i, i + UPLOAD_EMBED_BATCH));
        }

        const results = await Promise.all(
            batches.map((batch) =>
                withEmbeddingSlot(() => this.embeddingModel.embedText(batch)),
            ),
        );

        return results.flat();
    }

    async processFiles(files: File[]): Promise<FileRes[]> {
        const processedFiles: FileRes[] = [];

        await Promise.all(files.map(async (file) => {
            if (!(supportedMimeTypes as unknown as string[]).includes(file.type)) {
                throw new Error(`File type ${file.type} not supported`);
            }

            const fileId = crypto.randomBytes(16).toString('hex');

            // The original file name is client-controlled; keep only a short
            // alphanumeric extension so it can never inject path separators.
            const rawExtension = file.name.includes('.') ? file.name.split('.').pop() || '' : '';
            const fileExtension = /^[a-zA-Z0-9]{1,10}$/.test(rawExtension) ? rawExtension.toLowerCase() : 'bin';
            const fileName = `${crypto.randomBytes(16).toString('hex')}.${fileExtension}`;
            const filePath = path.join(UploadManager.uploadsDir, fileName);

            const buffer = Buffer.from(await file.arrayBuffer())

            fs.writeFileSync(filePath, buffer);

            const contentFilePath = await this.extractContentAndEmbed(filePath, file.type as SupportedMimeType);

            const fileRecord: RecordedFile = {
                id: fileId,
                name: file.name,
                filePath: filePath,
                contentPath: contentFilePath,
                uploadedAt: new Date().toISOString(),
            }

            UploadManager.addNewRecordedFile(fileRecord);

            processedFiles.push({
                fileExtension: fileExtension || '',
                fileId,
                fileName: file.name
            });
        }))

        return processedFiles;
    }
}

export default UploadManager;