import { pipeline } from '@xenova/transformers';

let pipe: any = null
let initError: Error | null = null

export const embed = async (text: string): Promise<number[]> => {
  if (initError) throw initError
  if (!pipe) {
    try {
      pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    } catch (err) {
      initError = err instanceof Error ? err : new Error(String(err))
      throw initError
    }
  }
  let output = await pipe(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}
