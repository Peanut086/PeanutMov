<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { mountAiImageGeneration, type AiImageGenerationOptions } from "./AiImageGenerationEngine.js";
import type { MotionController } from "./motion-runtime";
const props = defineProps<{ options?: AiImageGenerationOptions }>();
const host = ref<HTMLDivElement | null>(null);
let controller: MotionController | undefined;
onMounted(() => { controller = mountAiImageGeneration(host.value!, props.options); });
watch(() => props.options, value => controller?.update(value ?? {}), { deep: true });
onBeforeUnmount(() => controller?.destroy());
</script>

<template><div ref="host" data-motion-component="ai-generating" /></template>
