import type { Brain, Constitution } from "./types.js";

/** A workspace's typed config: which Constitution governs it, which Brain runs it. */
export interface MainspringConfig {
  constitution: Constitution;
  brain: Brain;
}

/** Identity helper for editor autocomplete/type-checking in mainspring.config.ts files. */
export function defineConfig(config: MainspringConfig): MainspringConfig {
  return config;
}
