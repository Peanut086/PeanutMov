import type { MotionOptions, MotionController } from "./motion-runtime";
export type TactilePushButtonOptions = MotionOptions & { text?: string };
export function mountTactilePushButton(target: HTMLElement, options?: TactilePushButtonOptions): MotionController;
