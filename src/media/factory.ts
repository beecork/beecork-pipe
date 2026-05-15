import { logger } from '../util/logger.js';
import type { MediaGenerator } from './types.js';
import { DalleGenerator } from './generators/dall-e.js';
import { StableDiffusionGenerator } from './generators/stable-diffusion.js';
import { RunwayGenerator } from './generators/runway.js';
import { VeoGenerator } from './generators/veo.js';
import { KlingGenerator } from './generators/kling.js';
import { ElevenLabsSfxGenerator } from './generators/elevenlabs-sfx.js';
import { NanoBananaGenerator } from './generators/nano-banana.js';
import { ElevenLabsMusicGenerator } from './generators/elevenlabs-music.js';
import { LyriaGenerator } from './generators/lyria.js';
import { RecraftGenerator } from './generators/recraft.js';

type GeneratorBuilder = (apiKey: string, model?: string) => MediaGenerator;

// Lookup table — adding a new generator becomes one entry instead of one switch case.
const GENERATOR_BUILDERS: Record<string, GeneratorBuilder> = {
  'dall-e': (k, m) => new DalleGenerator(k, m),
  'stable-diffusion': (k) => new StableDiffusionGenerator(k),
  runway: (k) => new RunwayGenerator(k),
  veo: (k) => new VeoGenerator(k),
  kling: (k) => new KlingGenerator(k),
  'elevenlabs-sfx': (k) => new ElevenLabsSfxGenerator(k),
  'nano-banana': (k, m) => new NanoBananaGenerator(k, m),
  'elevenlabs-music': (k) => new ElevenLabsMusicGenerator(k),
  lyria: (k, m) => new LyriaGenerator(k, m),
  recraft: (k) => new RecraftGenerator(k),
};

export function createMediaGenerator(config: {
  provider: string;
  apiKey?: string;
  model?: string;
}): MediaGenerator | null {
  if (!config.apiKey) {
    logger.warn(`Media generator ${config.provider}: missing API key`);
    return null;
  }
  const build = GENERATOR_BUILDERS[config.provider];
  if (!build) {
    logger.warn(`Unknown media generator: ${config.provider}`);
    return null;
  }
  return build(config.apiKey, config.model);
}
