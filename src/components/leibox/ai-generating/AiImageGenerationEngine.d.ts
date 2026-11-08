import type { MotionOptions, MotionController } from "./motion-runtime";
export type AiImageGenerationOptions = MotionOptions & { title?: string };
export function mountAiImageGeneration(target: HTMLElement, options?: AiImageGenerationOptions): MotionController;
