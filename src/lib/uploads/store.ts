import BaseEmbedding from "../models/base/embedding";
import UploadManager from "./manager";
import computeSimilarity from "../utils/computeSimilarity";
import { Chunk } from "../types";
import { hashObj } from '../utils/hash';

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

    async query(queries: string[], topK: number): Promise<Chunk[]> {
        const queryEmbeddings = await this.embeddingModel.embedText(queries)

        const results: { chunk: Chunk; score: number; }[][] = [];
        const hashResults: string[][] = []

        await Promise.all(queryEmbeddings.map(async (query) => {
            const similarities = this.records.map((record, idx) => {
                return {
                    chunk: {
                        content: record.content,
                        metadata: {
                            ...record.metadata,
                            fileId: record.fileId,
                        }
                    },
                    score: computeSimilarity(query, record.embedding)
                } as { chunk: Chunk; score: number; };
            }).sort((a, b) => b.score - a.score)

            results.push(similarities)
            hashResults.push(similarities.map(s => hashObj(s)))
        }))

        const chunkMap: Map<string, Chunk> = new Map();
        const scoreMap: Map<string, number> = new Map();
        const k = 60;

        for (let i = 0; i < results.length; i++) {
            for (let j = 0; j < results[i].length; j++) {
                const chunkHash = hashResults[i][j]

                chunkMap.set(chunkHash, results[i][j].chunk);
                scoreMap.set(chunkHash, (scoreMap.get(chunkHash) || 0) + results[i][j].score / (j + 1 + k));
            }
        }

        const finalResults = Array.from(scoreMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([chunkHash, _score]) => {
                return chunkMap.get(chunkHash)!;
            })

        return finalResults.slice(0, topK);
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