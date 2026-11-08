<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { mountSoftActionWheel, type SoftActionWheelOptions } from "./SoftActionWheelEngine.js";
import type { MotionController } from "./motion-runtime";
const props = defineProps<{ options?: SoftActionWheelOptions }>();
const host = ref<HTMLDivElement | null>(null);
let controller: MotionController | undefined;
onMounted(() => { controller = mountSoftActionWheel(host.value!, props.options); });
watch(() => props.options, value => controller?.update(value ?? {}), { deep: true });
onBeforeUnmount(() => controller?.destroy());
</script>

<template><div ref="host" data-motion-component="soft-action-wheel" /></template>
