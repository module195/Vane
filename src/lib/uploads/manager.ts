import path from "path";
import BaseEmbedding from "../models/base/embedding"
import crypto from "crypto"
import fs from 'fs';
import { splitText } from "../utils/splitText";
import { PDFParse } from 'pdf-parse';
import { CanvasFactory } from 'pdf-parse/worker';
import officeParser from 'officeparser'
import { resolveUploadsDirs } from "./paths";

const supportedMimeTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'] as const

type SupportedMimeType = typeof supportedMimeTypes[number];

type UploadManagerParams = {
    embeddingModel: BaseEmbedding<any>;
}

type RecordedFile = {
    id: string;
    name: string;
    filePath: string;
    contentPath: string;
    uploadedAt: string;
}

type FileChunk = { content: string; embedding: number[] };

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

    /* Parsed .content.json files, keyed by path and checked against mtime and
       size on every read, so a rewritten file is parsed again. Bounded by the
       on-disk size of the cached files; least recently used go first. */
    private static chunksCache = new Map<string, { mtimeMs: number; size: number; chunks: FileChunk[] }>();
    private static chunksCacheBytes = 0;
    static chunksCacheMaxBytes = 256 * 1024 * 1024;

    /* Async, cached version of getFileChunks for the search path. The
       returned array is shared between callers and must not be mutated. */
    static async getFileChunksCached(fileId: string): Promise<FileChunk[]> {
        try {
            const recordedFile = this.getFile(fileId);

            if (!recordedFile) {
                throw new Error(`File with ID ${fileId} not found`);
            }

            const contentPath = recordedFile.contentPath;
            const stat = await fs.promises.stat(contentPath);
            const cached = this.chunksCache.get(contentPath);

            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                // Refresh LRU position.
                this.chunksCache.delete(contentPath);
                this.chunksCache.set(contentPath, cached);
                return cached.chunks;
            }

            const chunks: FileChunk[] = JSON.parse(await fs.promises.readFile(contentPath, 'utf-8')).chunks;

            this.dropCachedChunks(contentPath);
            if (stat.size <= this.chunksCacheMaxBytes) {
                this.chunksCache.set(contentPath, { mtimeMs: stat.mtimeMs, size: stat.size, chunks });
                this.chunksCacheBytes += stat.size;
                for (const [key] of this.chunksCache) {
                    if (this.chunksCacheBytes <= this.chunksCacheMaxBytes) break;
                    this.dropCachedChunks(key);
                }
            }

            return chunks;
        } catch (err) {
            console.log('Error getting file chunks:', err);
            return [];
        }
    }

    private static dropCachedChunks(contentPath: string) {
        const entry = this.chunksCache.get(contentPath);
        if (!entry) return;
        this.chunksCacheBytes -= entry.size;
        this.chunksCache.delete(contentPath);
    }

    static clearChunksCache() {
        this.chunksCache.clear();
        this.chunksCacheBytes = 0;
    }

    private async extractContentAndEmbed(filePath: string, fileType: SupportedMimeType): Promise<string> {
        switch (fileType) {
            case 'text/plain':
                const content = fs.readFileSync(filePath, 'utf-8');

                const splittedText = splitText(content, 512, 128)
                const embeddings = await this.embeddingModel.embedText(splittedText)

                if (embeddings.length !== splittedText.length) {
                    throw new Error('Embeddings and text chunks length mismatch');
                }

                const contentPath = filePath.split('.').slice(0, -1).join('.') + '.content.json';

                const data = {
                    chunks: splittedText.map((text, i) => {
                        return {
                            content: text,
                            embedding: embeddings[i],
                        }
                    })
                }

                fs.writeFileSync(contentPath, JSON.stringify(data, null, 2));

                return contentPath;
            case 'application/pdf':
                const pdfBuffer = fs.readFileSync(filePath);

                const parser = new PDFParse({
                    data: pdfBuffer,
                    CanvasFactory
                })

                const pdfText = await parser.getText().then(res => res.text)

                const pdfSplittedText = splitText(pdfText, 512, 128)
                const pdfEmbeddings = await this.embeddingModel.embedText(pdfSplittedText)

                if (pdfEmbeddings.length !== pdfSplittedText.length) {
                    throw new Error('Embeddings and text chunks length mismatch');
                }

                const pdfContentPath = filePath.split('.').slice(0, -1).join('.') + '.content.json';

                const pdfData = {
                    chunks: pdfSplittedText.map((text, i) => {
                        return {
                            content: text,
                            embedding: pdfEmbeddings[i],
                        }
                    })
                }

                fs.writeFileSync(pdfContentPath, JSON.stringify(pdfData, null, 2));

                return pdfContentPath;
            case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
                const docBuffer = fs.readFileSync(filePath);

                const docText = (await officeParser.parseOffice(docBuffer)).toText()

                const docSplittedText = splitText(docText, 512, 128)
                const docEmbeddings = await this.embeddingModel.embedText(docSplittedText)

                if (docEmbeddings.length !== docSplittedText.length) {
                    throw new Error('Embeddings and text chunks length mismatch');
                }

                const docContentPath = filePath.split('.').slice(0, -1).join('.') + '.content.json';

                const docData = {
                    chunks: docSplittedText.map((text, i) => {
                        return {
                            content: text,
                            embedding: docEmbeddings[i],
                        }
                    })
                }

                fs.writeFileSync(docContentPath, JSON.stringify(docData, null, 2));

                return docContentPath;
            default:
                throw new Error(`Unsupported file type: ${fileType}`);
        }
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