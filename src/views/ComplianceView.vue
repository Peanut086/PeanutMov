<script setup lang="ts">
/**
 * 合规声明全文（页面蓝图 §16）
 *
 * 静态全文，随包发布；`user-select: text` 允许长按复制（便于核对条款）。
 */

import AppHeader from '@/components/layout/AppHeader.vue';
import { COMPLIANCE_VERSION } from '@/shared/constants';


const SECTIONS = [
  {
    title: '一、本 App 的定位',
    paragraphs: [
      '本 App 是一个本地播放工具，不内置、不提供、不分发任何影视片源。它的作用是把你已经拥有的内容（自建 NAS、网盘、个人媒体服务器）聚合到同一个海报墙，并提供播放、续播与下载管理能力。',
    ],
  },
  {
    title: '二、不提供的能力',
    list: [
      '不提供破解、盗版聚合、DRM 绕过能力。',
      '不提供任何预置的第三方站点或接口地址。',
      '不进行网页抓取与内容审查。',
      '不内置广告、统计 SDK 与第三方上报。',
    ],
  },
  {
    title: '三、用户责任',
    paragraphs: [
      '你添加的源与播放的内容由你自行负责。仅可用于播放你拥有版权或已获授权的内容（如自有 NAS、网盘文件）。',
      '请勿添加来源不明、需要破解或规避版权保护的源；由此产生的风险与法律责任由添加者自行承担。',
    ],
  },
  {
    title: '四、数据与隐私',
    paragraphs: [
      '所有数据（源配置、收藏、历史、下载记录、设置）仅保存在本机，不上传服务器。无账号体系、无云端同步。',
      '导出的备份文件同样保存在你选择的位置；若勾选「包含凭据」，密码与 Token 会以明文写入文件，请妥善保管。',
    ],
  },
  {
    title: '五、演示内容',
    paragraphs: [
      '内置演示内容为公开版权样片（Blender 开放影片），仅用于功能演示，可随时在设置中隐藏。',
    ],
  },
  {
    title: '六、投屏能力边界',
    paragraphs: [
      '首版仅调用系统投屏/分享选择器，把播放地址或已下载文件交给系统应用处理，不含 App 内 DLNA 设备发现与遥控（二期能力）。',
    ],
  },
];

</script>

<template>
  <main class="compliance-page" data-route="compliance">
    <AppHeader title="合规声明" back />

    <div class="compliance-body">
      <p class="compliance-version">版本 {{ COMPLIANCE_VERSION }} · 更新于 2026-10-20</p>

      <section v-for="section in SECTIONS" :key="section.title" class="compliance-section">
        <h2 class="compliance-section__title">{{ section.title }}</h2>
        <p v-for="(p, idx) in section.paragraphs ?? []" :key="`p-${idx}`" class="compliance-section__p">
          {{ p }}
        </p>
        <ul v-if="section.list" class="compliance-section__list">
          <li v-for="item in section.list" :key="item">{{ item }}</li>
        </ul>
      </section>

      <section class="compliance-section compliance-section--highlight">
        <h2 class="compliance-section__title">要点回顾</h2>
        <ul class="compliance-section__list">
          <li>不内置片源</li>
          <li>不提供破解 / 盗版聚合</li>
          <li>仅播放自有或已授权内容</li>
          <li>数据仅存本机</li>
        </ul>
      </section>

      <p class="compliance-footer">继续使用即表示你已阅读并同意上述条款。</p>
    </div>
  </main>
</template>

<style scoped>
.compliance-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.compliance-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) calc(var(--space-7) + var(--safe-bottom));
  /* 允许长按选中复制（AC-102 的可核对性） */
  user-select: text;
  -webkit-user-select: text;
}

.compliance-version {
  margin-bottom: var(--space-4);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.compliance-section + .compliance-section {
  margin-top: var(--space-6);
}

.compliance-section__title {
  margin-bottom: var(--space-2);
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.compliance-section__p {
  font: var(--text-body);
  line-height: 1.6;
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.compliance-section__p + .compliance-section__p {
  margin-top: var(--space-3);
}

.compliance-section__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-left: var(--space-4);
  list-style: disc;
  font: var(--text-body);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.compliance-section__list li::marker {
  color: var(--color-brand);
}

.compliance-section--highlight {
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.compliance-footer {
  margin-top: var(--space-7);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-align: center;
}
</style>
