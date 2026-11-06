import BaseEmbedding from "../models/base/embedding";
import UploadManager from "./manager";
import computeSimilarity from "../utils/computeSimilarity";
import { Chunk } from "../types";

type UploadStoreParams = {
    embeddingModel: BaseEmbedding<any>;
    fileIds: string[];
}

type StoreRecord = {
    embedding: number[];
    content: string;
    fileId: string;
    metadata: Record<string, any>
}

class UploadStore {
    embeddingModel: BaseEmbedding<any>;
    fileIds: string[];
    records: StoreRecord[] = [];

    constructor(private params: UploadStoreParams) {
        this.embeddingModel = params.embeddingModel;
        this.fileIds = params.fileIds;
    }

    /* Builds a store with the chunks of every file loaded (async, cached by
       UploadManager.getFileChunksCached). Throws for an unknown file id. */
    static async create(params: UploadStoreParams): Promise<UploadStore> {
        const store = new UploadStore(params);
        await store.initializeStore();
        return store;
    }

    async initializeStore() {
        const perFile = await Promise.all(this.fileIds.map(async (fileId) => {
            const file = UploadManager.getFile(fileId)

            if (!file) {
                throw new Error(`File with ID ${fileId} not found`);
            }

            const chunks = await UploadManager.getFileChunksCached(fileId);

            return chunks.map((chunk) => ({
                embedding: chunk.embedding,
                content: chunk.content,
                fileId: fileId,
                metadata: {
                    fileName: file.name,
                    title: file.name,
                    url: `file_id://${file.id}`,
                }
            }))
        }))

        this.records = perFile.flat();
    }

    /* Ranks every chunk for each query by cosine similarity, then fuses the
       rankings with reciprocal-rank fusion: a chunk scores the sum over
       queries of 1 / (k + rank), rank starting at 1, k = 60. A chunk is
       identified by its file and text, so the same chunk found by several
       queries is merged and its scores add up. */
    async query(queries: string[], topK: number): Promise<Chunk[]> {
        const queryEmbeddings = await this.embeddingModel.embedText(queries)

        const chunkMap: Map<string, Chunk> = new Map();
        const scoreMap: Map<string, number> = new Map();
        const k = 60;

        for (const query of queryEmbeddings) {
            const ranked = this.records
                .map((record) => ({ record, score: computeSimilarity(query, record.embedding) }))
                .sort((a, b) => b.score - a.score)

            ranked.forEach(({ record }, rank) => {
                const key = `${record.fileId}\u0000${record.content}`

                if (!chunkMap.has(key)) {
                    chunkMap.set(key, {
                        content: record.content,
                        metadata: {
                            ...record.metadata,
                            fileId: record.fileId,
                        }
                    });
                }

                scoreMap.set(key, (scoreMap.get(key) || 0) + 1 / (k + rank + 1));
            })
        }

        return Array.from(scoreMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([key]) => chunkMap.get(key)!);
    }

    static async getFileData(fileIds: string[]): Promise<{ fileName: string; initialContent: string }[]> {
        return Promise.all(fileIds.map(async (fileId) => {
            const file = UploadManager.getFile(fileId)

            if (!file) {
                throw new Error(`File with ID ${fileId} not found`);
            }

            const chunks = await UploadManager.getFileChunksCached(fileId);

            return {
                fileName: file.name,
                initialContent: chunks.slice(0, 3).map(c => c.content).join('\n---\n'),
            }
        }))
    }
}

export default UploadStore