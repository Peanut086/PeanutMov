<template>
  <div class="netdisk-settings">
    <header class="page-header">
      <button class="back-btn" @click="goBack">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <h1>网盘账号</h1>
    </header>

    <div class="content">
      <!-- 存储权限提示 -->
      <div v-if="!hasAllFilesAccess" class="permission-warning">
        <div class="warning-icon">⚠️</div>
        <div class="warning-text">
          <strong>需要所有文件访问权限</strong>
          <p>网盘登录需要写入配置文件到 /sdcard/TVBox 目录</p>
        </div>
        <button class="grant-btn" @click="requestAllFilesAccess">授权</button>
      </div>

      <!-- 平台列表 -->
      <div class="platform-list">
        <div
          v-for="platform in platforms"
          :key="platform.key"
          class="platform-card"
        >
          <div class="platform-main" @click="login(platform)">
            <div class="platform-icon">{{ platform.icon }}</div>
            <div class="platform-info">
              <div class="platform-name">{{ platform.name }}</div>
              <div class="platform-status" :class="{ logged: platform.loggedIn }">
                {{ platform.loggedIn ? '已登录' : '未登录' }}
              </div>
            </div>
            <div class="platform-action">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
          </div>
          <div v-if="platform.loggedIn" class="platform-actions">
            <button class="action-btn" @click.stop="backup(platform)">备份</button>
            <button class="action-btn" @click.stop="restore(platform)">恢复</button>
          </div>
        </div>
      </div>

      <!-- 高级配置 -->
      <div class="advanced-section">
        <div class="advanced-header" @click="advancedOpen = !advancedOpen">
          <h3>高级配置</h3>
          <svg
            class="chevron"
            :class="{ open: advancedOpen }"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div v-if="advancedOpen" class="advanced-content">
          <div class="config-item">
            <div class="config-label">
              <span>画质</span>
              <span class="config-value">{{ netdiskSettings.quality }}</span>
            </div>
            <div class="quality-options">
              <button
                v-for="opt in qualityOptions"
                :key="opt.value"
                class="quality-btn"
                :class="{ active: netdiskSettings.quality === opt.value }"
                @click="updateQuality(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
          <div class="config-item">
            <div class="config-label">
              <span>下载线程数</span>
              <span class="config-value">{{ netdiskSettings.threadCount }}</span>
            </div>
            <input
              type="range"
              min="1"
              max="8"
              :value="netdiskSettings.threadCount"
              @input="updateThreadCount(Number(($event.target as HTMLInputElement).value))"
              class="thread-slider"
            />
            <div class="thread-labels">
              <span>1</span>
              <span>8</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 说明 -->
      <div class="help-section">
        <h3>使用说明</h3>
        <ul>
          <li>点击平台卡片进入登录页</li>
          <li>使用扫码或账密登录</li>
          <li>登录成功后自动保存配置</li>
          <li>所有 TVBox 系爬虫源共享登录态</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { Netdisk, backupCookieFile, restoreCookieFile } from '@/native/netdiskPlugin';
import { useToast } from '@/composables/useToast';
import { getAllPlatforms, type NetdiskPlatform } from '@/services/netdiskPlatforms';
import { useSettingsStore } from '@/stores/settingsStore';
import { writeNetdiskConfig } from '@/services/netdiskConfig';

const router = useRouter();
const toast = useToast();
const settings = useSettingsStore();

const hasAllFilesAccess = ref(false);
const advancedOpen = ref(false);

const qualityOptions = [
  { value: 'auto', label: '自动' },
  { value: '4K', label: '4K' },
  { value: '1080P', label: '1080P' },
  { value: '720P', label: '720P' },
  { value: '480P', label: '480P' },
];

const netdiskSettings = computed(() => settings.netdisk);

async function updateQuality(quality: string) {
  await settings.update({
    netdisk: {
      ...netdiskSettings.value,
      quality: quality as any,
    },
  });
  await writeNetdiskConfig();
  toast.success('画质设置已更新');
}

async function updateThreadCount(count: number) {
  await settings.update({
    netdisk: {
      ...netdiskSettings.value,
      threadCount: count,
    },
  });
  await writeNetdiskConfig();
}

interface PlatformStatus extends NetdiskPlatform {
  loggedIn: boolean;
}

const platforms = ref<PlatformStatus[]>([]);

onMounted(async () => {
  // 初始化平台列表
  const allPlatforms = getAllPlatforms();
  platforms.value = allPlatforms.map(p => ({ ...p, loggedIn: false }));

  await checkPermissions();
  await checkLoginStatus();
  // P4-3: 确保配置文件存在
  await writeNetdiskConfig();
});

async function checkPermissions() {
  try {
    const result = await Netdisk.hasAllFilesAccess();
    hasAllFilesAccess.value = result.granted;
  } catch (e) {
    console.error('Failed to check permissions', e);
    hasAllFilesAccess.value = false;
  }
}

async function requestAllFilesAccess() {
  try {
    await Netdisk.requestAllFilesAccess();
    // 等待用户授权后重新检查
    setTimeout(async () => {
      await checkPermissions();
      if (hasAllFilesAccess.value) {
        toast.success('授权成功');
      }
    }, 2000);
  } catch (e) {
    console.error('Failed to request permissions', e);
    toast.error('授权失败');
  }
}

async function checkLoginStatus() {
  // 检查每个平台的 cookie 文件是否存在
  for (const platform of platforms.value) {
    try {
      const result = await Netdisk.readCookieFile({ platform: platform.key });
      platform.loggedIn = result.success && result.exists;
    } catch (e) {
      console.error(`Failed to check ${platform.key} login status`, e);
      platform.loggedIn = false;
    }
  }
}

async function login(platform: PlatformStatus) {
  if (!hasAllFilesAccess.value) {
    toast.error('请先授权所有文件访问权限');
    return;
  }

  try {
    await Netdisk.loginWebView({ platform: platform.key, loginUrl: platform.loginUrl });
    // 登录完成后刷新状态
    setTimeout(async () => {
      await checkLoginStatus();
      const updated = platforms.value.find(p => p.key === platform.key);
      if (updated?.loggedIn) {
        toast.success(`${platform.name}登录成功`);
      }
    }, 3000);
  } catch (e) {
    console.error('Login failed', e);
    toast.error('登录失败');
  }
}

async function backup(platform: PlatformStatus) {
  try {
    const success = await backupCookieFile(platform.key);
    if (success) {
      toast.success(`${platform.name}备份成功`);
    } else {
      toast.error(`${platform.name}备份失败`);
    }
  } catch (e) {
    console.error('Backup failed', e);
    toast.error('备份失败');
  }
}

async function restore(platform: PlatformStatus) {
  try {
    const success = await restoreCookieFile(platform.key);
    if (success) {
      toast.success(`${platform.name}恢复成功`);
      // 刷新登录状态
      await checkLoginStatus();
    } else {
      toast.error(`${platform.name}恢复失败：未找到备份`);
    }
  } catch (e) {
    console.error('Restore failed', e);
    toast.error('恢复失败');
  }
}

function goBack() {
  router.back();
}
</script>

<style scoped>
.netdisk-settings {
  min-height: 100vh;
  background: var(--bg-primary, #0a0a0a);
  color: var(--text-primary, #fff);
}

.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--bg-secondary, #1a1a1a);
  border-bottom: 1px solid var(--border-color, #333);
}

.back-btn {
  background: none;
  border: none;
  color: var(--text-primary, #fff);
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.page-header h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}

.content {
  padding: 16px;
}

.permission-warning {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: rgba(255, 165, 0, 0.1);
  border: 1px solid rgba(255, 165, 0, 0.3);
  border-radius: 12px;
  margin-bottom: 20px;
}

.warning-icon {
  font-size: 32px;
}

.warning-text {
  flex: 1;
}

.warning-text strong {
  display: block;
  margin-bottom: 4px;
}

.warning-text p {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary, #aaa);
}

.grant-btn {
  padding: 8px 16px;
  background: var(--accent-color, #007aff);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
}

.platform-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.platform-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--bg-secondary, #1a1a1a);
  border: 1px solid var(--border-color, #333);
  border-radius: 12px;
  transition: all 0.2s;
}

.platform-card:hover {
  background: var(--bg-tertiary, #2a2a2a);
  border-color: var(--accent-color, #007aff);
}

.platform-main {
  display: flex;
  align-items: center;
  gap: 16px;
  cursor: pointer;
}

.platform-actions {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color, #333);
}

.action-btn {
  flex: 1;
  padding: 8px 16px;
  background: var(--bg-tertiary, #2a2a2a);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover {
  background: var(--accent-color, #007aff);
  border-color: var(--accent-color, #007aff);
}

.platform-icon {
  font-size: 32px;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary, #2a2a2a);
  border-radius: 12px;
}

.platform-info {
  flex: 1;
}

.platform-name {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.platform-status {
  font-size: 14px;
  color: var(--text-secondary, #aaa);
}

.platform-status.logged {
  color: var(--success-color, #34c759);
}

.platform-action {
  color: var(--text-secondary, #aaa);
}

.help-section {
  padding: 16px;
  background: var(--bg-secondary, #1a1a1a);
  border-radius: 12px;
}

.help-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 12px 0;
}

.help-section ul {
  margin: 0;
  padding-left: 20px;
}

.help-section li {
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--text-secondary, #aaa);
  line-height: 1.5;
}

/* 高级配置 */
.advanced-section {
  margin-bottom: 24px;
  background: var(--bg-secondary, #1a1a1a);
  border: 1px solid var(--border-color, #333);
  border-radius: 12px;
  overflow: hidden;
}

.advanced-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  cursor: pointer;
  user-select: none;
}

.advanced-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.chevron {
  transition: transform 0.2s;
  color: var(--text-secondary, #aaa);
}

.chevron.open {
  transform: rotate(90deg);
}

.advanced-content {
  padding: 0 16px 16px;
  border-top: 1px solid var(--border-color, #333);
}

.config-item {
  padding: 16px 0;
  border-bottom: 1px solid var(--border-color, #333);
}

.config-item:last-child {
  border-bottom: none;
}

.config-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 500;
}

.config-value {
  color: var(--accent-color, #007aff);
  font-weight: 600;
}

.quality-options {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.quality-btn {
  padding: 8px 16px;
  background: var(--bg-tertiary, #2a2a2a);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.quality-btn:hover {
  border-color: var(--accent-color, #007aff);
}

.quality-btn.active {
  background: var(--accent-color, #007aff);
  border-color: var(--accent-color, #007aff);
  color: #fff;
}

.thread-slider {
  width: 100%;
  height: 4px;
  background: var(--bg-tertiary, #2a2a2a);
  border-radius: 2px;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}

.thread-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  background: var(--accent-color, #007aff);
  border-radius: 50%;
  cursor: pointer;
}

.thread-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  background: var(--accent-color, #007aff);
  border-radius: 50%;
  cursor: pointer;
  border: none;
}

.thread-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary, #aaa);
}
</style>
