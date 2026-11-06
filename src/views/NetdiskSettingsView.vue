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
              <div class="platform-status" :class="statusClass(platform)">
                {{ statusText(platform) }}
              </div>
              <!-- OPT-05 / EXT-02：cookie-only 平台只声明「Cookie 直填、账号能力未验证」 -->
              <div v-if="isCookieOnly(platform)" class="platform-note platform-note--limited">
                <span class="platform-note__line">{{ capabilityNote(platform) }}</span>
                <span class="platform-note__line platform-note__sub">不提供会员/容量信息</span>
              </div>
              <!-- full-api 平台才展示账号只读信息 -->
              <p v-else-if="platform.memberType" class="platform-note">
                <span class="platform-note__line">会员：{{ platform.memberType }}</span>
              </p>
            </div>
            <div class="platform-action">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
          </div>
          <div v-if="platform.saved" class="platform-actions">
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
          <li>夸克支持账号校验，可显示昵称与会员信息</li>
          <li>UC / 123 / 天翼 / 阿里：Cookie 直填、账号能力未验证，不提供会员/容量信息</li>
          <li>所有 TVBox 系爬虫源共享登录态</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { Netdisk, backupCookieFile, loginWebView, restoreCookieFile } from '@/native/netdiskPlugin';
import { useToast } from '@/composables/useToast';
import { getAllPlatforms, COOKIE_ONLY_CAPABILITY_NOTE, type NetdiskPlatform } from '@/services/netdiskPlatforms';
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

/** 平台状态：`saved` 仅代表 cookie 文件已存在，`verified` 才代表账号信息已校验 */
interface PlatformStatus extends NetdiskPlatform {
  saved: boolean;
  verified: boolean;
  nickname: string | null;
  memberType: string | null;
}

const platforms = ref<PlatformStatus[]>([]);

function applyStatus(
  platform: PlatformStatus,
  next: Pick<PlatformStatus, 'saved' | 'verified' | 'nickname' | 'memberType'>,
): void {
  platform.saved = next.saved;
  platform.verified = next.verified;
  platform.nickname = next.nickname;
  platform.memberType = next.memberType;
}

/** 是否为只做 Cookie 直填、无账号校验能力的平台（OPT-05 / EXT-02） */
function isCookieOnly(platform: NetdiskPlatform): boolean {
  return platform.capabilityLevel === 'cookie-only';
}

/** 能力说明兜底：漏配 `capabilityNote` 时仍必须给出能力声明，不能渲染空提示 */
function capabilityNote(platform: NetdiskPlatform): string {
  return platform.capabilityNote ?? COOKIE_ONLY_CAPABILITY_NOTE;
}

/** 列表状态文案（R-DEV04-02：绝不把「cookie 文件存在」显示成「已登录」） */
function statusText(platform: PlatformStatus): string {
  if (isCookieOnly(platform)) {
    // cookie-only 平台没有账号校验接口，只能确认 cookie 文件是否已保存
    return platform.saved ? 'Cookie 已保存' : '未登录';
  }
  if (platform.verified) {
    return platform.nickname ? `已登录（${platform.nickname}）` : '已登录';
  }
  return platform.saved ? '已保存，账号未验证' : '未登录';
}

/** 状态配色：仅 full-api 平台的账号校验结果可以用「已登录」绿色 */
function statusClass(platform: PlatformStatus): Record<string, boolean> {
  const verified = !isCookieOnly(platform) && platform.verified;
  return { logged: verified, saved: platform.saved && !verified };
}

onMounted(async () => {
  // 初始化平台列表
  const allPlatforms = getAllPlatforms();
  platforms.value = allPlatforms.map(p => ({
    ...p,
    saved: false,
    verified: false,
    nickname: null,
    memberType: null,
  }));

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

/** 解析 cookie 文件内容：`a`=昵称（仅账号校验通过时非空）、`b`=会员类型、`c`=cookie */
function parseCookieAccount(content: string | undefined): {
  nickname: string | null;
  memberType: string | null;
} {
  if (!content) return { nickname: null, memberType: null };
  try {
    const parsed = JSON.parse(content) as { a?: unknown; b?: unknown };
    const nickname =
      typeof parsed.a === 'string' && parsed.a.trim().length > 0 ? parsed.a.trim() : null;
    const memberType =
      typeof parsed.b === 'string' && parsed.b.trim().length > 0 && parsed.b.trim() !== '0'
        ? parsed.b.trim()
        : null;
    return { nickname, memberType };
  } catch {
    // 旧格式 / 纯 cookie 文本：无法判断账号信息，按未验证处理
    return { nickname: null, memberType: null };
  }
}

async function checkLoginStatus() {
  // 读取文件内容而非仅看存在性：存在只代表「已保存」，`a`（昵称）非空才代表账号已校验
  for (const platform of platforms.value) {
    try {
      const result = await Netdisk.readCookieFile({ platform: platform.key });
      const saved = result.success && result.exists;
      const account = saved
        ? parseCookieAccount(result.content)
        : { nickname: null, memberType: null };
      applyStatus(platform, {
        saved,
        verified: account.nickname !== null,
        nickname: account.nickname,
        memberType: account.memberType,
      });
    } catch (e) {
      console.error(`Failed to check ${platform.key} login status`, e);
      applyStatus(platform, { saved: false, verified: false, nickname: null, memberType: null });
    }
  }
}

async function login(platform: PlatformStatus) {
  if (!hasAllFilesAccess.value) {
    toast.error('请先授权所有文件访问权限');
    return;
  }

  try {
    // AND-06：登录页关闭后才返回结果，无需再靠延时 + 轮询文件猜测
    const result = await loginWebView(platform.key, platform.loginUrl);
    if (!result.success) {
      await checkLoginStatus();
      toast.info(result.note ?? `${platform.name}未登录，已取消`);
      return;
    }
    await checkLoginStatus();
    if (result.verified) {
      toast.success(
        result.nickname ? `${platform.name}登录成功（${result.nickname}）` : `${platform.name}登录成功`,
      );
    } else {
      // R-DEV04-02：cookie-only 平台没有账号校验接口，只能确认 cookie 已保存
      toast.info(`${platform.name}已保存，账号未验证`);
    }
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
  overflow-wrap: anywhere;
}

.platform-status.logged {
  color: var(--color-success, #34d399);
}

.platform-status.saved {
  color: var(--color-warning, #fbbf24);
}

/* 能力声明（OPT-05 / EXT-02）：cookie-only 平台的能力边界说明 */
.platform-note {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
  margin: var(--space-2, 8px) 0 0;
  font-size: var(--font-size-12, 12px);
  line-height: var(--line-height-12, 16px);
  color: var(--color-text-tertiary, #6b7480);
  overflow-wrap: anywhere;
}

.platform-note--limited {
  color: var(--color-warning, #fbbf24);
}

.platform-note__line {
  display: block;
}

.platform-note__sub {
  color: var(--color-text-tertiary, #6b7480);
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
