import { pipeline } from '@xenova/transformers';
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import { mkdirSync } from 'fs';
import { log, logger } from "./logger.js";

class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: FeatureExtractionPipeline | null = null;

  private constructor() {}

  static async getInstance(): Promise<EmbeddingService> {
    if (!EmbeddingService.instance) {
      // Vercel serverless runtime: /var/task/ is read-only, so redirect
      // the transformers.js model cache to /tmp/ which is writable.
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

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      logger.info('[EmbeddingService] Loading model Xenova/all-MiniLM-L6-v2...');
      await log('[EmbeddingService] Loading embedding model...');
      this.extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
      );
      logger.info('[EmbeddingService] Model loaded');
      await log('[EmbeddingService] Model loaded');
    }
    return this.extractor;
  }

  async embed(text: string): Promise<number[]> {
    logger.info(`[EmbeddingService] embed (text.length=${text.length})`);
    const extractor = await this.getExtractor();
    const result = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    const vec = Array.from(result.data) as number[];
    logger.info(`[EmbeddingService] embed done (vector_dim=${vec.length})`);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    logger.info(`[EmbeddingService] embedBatch (count=${texts.length})`);
    const extractor = await this.getExtractor();
    const results = await extractor(texts, {
      pooling: 'mean',
      normalize: true,
    });
    const arr = results as { data: { length: number } };
    const vecs = [Array.from(arr.data) as number[]];
    logger.info(`[EmbeddingService] embedBatch done (${vecs.length} vectors)`);
    return vecs;
  }
}

export { EmbeddingService };
