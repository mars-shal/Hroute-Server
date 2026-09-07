import { pipeline } from '@xenova/transformers';
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import { mkdirSync } from 'fs';
import { log, logger } from "./logger.js";

/** Memory threshold: model won't load if heap exceeds this (if set). */
const MEMORY_LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB) || 0;

/** Model estimates: all-MiniLM-L6-v2 uses ~90MB heap once loaded. */
const MODEL_HEAP_MB = 90;

function heapMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: FeatureExtractionPipeline | null = null;

  private constructor() {}

  static async getInstance(): Promise<EmbeddingService> {
    if (!EmbeddingService.instance) {
      if (!process.env.TRANSFORMERS_CACHE) {
        process.env.TRANSFORMERS_CACHE = '/tmp/transformers_cache';
      }
      try {
        mkdirSync(process.env.TRANSFORMERS_CACHE, { recursive: true });
      } catch {
        // non-fatal — model still loads, just can't cache to disk
      }
      logger.info('[EmbeddingService] Creating singleton instance');
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  /** Unload the model to free ~90MB heap. Safe to call after batch jobs. */
  unload(): void {
    if (this.extractor) {
      this.extractor = null;
      logger.info(`[EmbeddingService] Model unloaded (heap=${heapMB()}MB, rss=${rssMB()}MB)`);
    }
  }

  /** True if the model is currently loaded into memory. */
  get isLoaded(): boolean {
    return this.extractor !== null;
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      const currentHeap = heapMB();
      if (MEMORY_LIMIT_MB > 0 && currentHeap + MODEL_HEAP_MB > MEMORY_LIMIT_MB * 0.85) {
        logger.warn(`[EmbeddingService] MEMORY_LIMIT=${MEMORY_LIMIT_MB}MB, current heap=${currentHeap}MB — model load would exceed 85% threshold`);
      }

      logger.debug(`[EmbeddingService] Loading model Xenova/all-MiniLM-L6-v2 (heap=${currentHeap}MB, rss=${rssMB()}MB)...`);
      await log('[EmbeddingService] Loading embedding model...');
      this.extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
      );
      logger.info(`[EmbeddingService] Model loaded (heap=${heapMB()}MB, rss=${rssMB()}MB)`);
      await log(`[EmbeddingService] Model loaded: heap=${heapMB()}MB`);
    }
    return this.extractor;
  }

  async embed(text: string): Promise<number[]> {
    logger.debug(`[EmbeddingService] embed (text.length=${text.length})`);
    const extractor = await this.getExtractor();
    const result = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    const vec = Array.from(result.data) as number[];
    logger.debug(`[EmbeddingService] embed done (vector_dim=${vec.length})`);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.embed(texts[0]!)];

    logger.debug(`[EmbeddingService] embedBatch (count=${texts.length})`);
    const extractor = await this.getExtractor();
    const results = await extractor(texts, {
      pooling: 'mean',
      normalize: true,
    });

    // Batched output is [batch, dim] — slice one vector per input text.
    const dims = (results as { dims?: number[] }).dims ?? [];
    const dim = dims.length === 2 ? dims[1]! : (results as { data: { length: number } }).data.length / texts.length;
    const flat = Array.from(results.data) as number[];
    const vecs: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      vecs.push(flat.slice(i * dim, (i + 1) * dim));
    }
    logger.debug(`[EmbeddingService] embedBatch done (${vecs.length} vectors, dim=${dim})`);
    return vecs;
  }
}

export { EmbeddingService };
