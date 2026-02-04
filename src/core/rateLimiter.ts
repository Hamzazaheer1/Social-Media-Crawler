import Bottleneck from "bottleneck";

export const limiters = {
  x: new Bottleneck({ maxConcurrent: 1, minTime: 400 }),         // tune later
  instagram: new Bottleneck({ maxConcurrent: 1, minTime: 800 }),
  tiktok: new Bottleneck({ maxConcurrent: 1, minTime: 800 }),
  youtube: new Bottleneck({ maxConcurrent: 1, minTime: 300 }),
};

export async function runLimited<T>(platform: keyof typeof limiters, fn: () => Promise<T>) {
  return limiters[platform].schedule(fn);
}
