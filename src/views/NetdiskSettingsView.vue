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

      <!-- FIX-B：权限缺失时在列表顶部加一行醒目提示（与卡片内状态互补） -->
      <div v-if="!hasAllFilesAccess && platforms.some(p => p.saved)" class="permission-warning permission-warning--inline">
        <div class="warning-text">
          <p>部分平台已保存 Cookie，但当前缺少「所有文件访问」权限，爬虫源无法读取。请先到系统设置授权。</p>
        </div>
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
              <!-- FIX-B：权限缺失时，即使 cookie 文件存在也无法被爬虫源读取，显示异常态 -->
              <div v-if="!hasAllFilesAccess && platform.saved" class="platform-note platform-note--limited">
                <span class="platform-note__line">⚠ 存储权限缺失，cookie 文件无法被爬虫源读取</span>
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
              <!-- 兜底：网页打不开时手动粘贴 Cookie -->
              <button
                class="paste-cookie-link"
                type="button"
                @click.stop="openPasteSheet(platform)"
              >
                网页打不开？手动粘贴 Cookie
              </button>
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
              <span class="config-value">{{ threadCount }}</span>
            </div>
            <input
              type="range"
              min="1"
              max="8"
              :value="threadCount"
              @input="onThreadCountInput(Number(($event.target as HTMLInputElement).value))"
              class="thread-slider"
            />
            <div class="thread-labels">
              <span>1</span>
              <span>8</span>
            </div>
          </div>
          <!-- 这两项只经 ext 合并下发给爬虫源，最终由第三方爬虫自行决定是否采纳（App 不代解网盘直链） -->
          <p class="config-note">
            以上参数会合并进网盘源的 ext 一并下发给爬虫，是否生效取决于该爬虫是否读取；
            App 不代为解析网盘直链，也不会覆盖爬虫自身的画质策略。
          </p>
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
          <li>网页打不开时，可在 PC 浏览器登录后用 EditThisCookie 等扩展导出 cookie 字符串粘贴进来</li>
        </ul>
      </div>
    </div>

    <!-- 手动粘贴 Cookie 兜底弹层 -->
    <BottomSheet v-model="pasteSheetOpen" :title="`${pastePlatform?.name ?? ''} - 手动粘贴 Cookie`">
      <div class="paste-sheet">
        <p class="paste-hint">
          在 PC 浏览器登录对应网盘后，用 EditThisCookie 等扩展导出 cookie 字符串，粘贴到下方输入框。
          格式示例：<code>name1=value1; name2=value2; ...</code>
        </p>
        <textarea
          v-model="pasteCookieText"
          class="paste-textarea"
          placeholder="粘贴 cookie 字符串..."
          rows="6"
          spellcheck="false"
          autocomplete="off"
        />
        <div class="paste-actions">
          <button class="paste-btn paste-btn--cancel" type="button" @click="pasteSheetOpen = false">
            取消
          </button>
          <button class="paste-btn paste-btn--confirm" type="button" @click="confirmPaste">
            保存 Cookie
          </button>
        </div>
      </div>
    </BottomSheet>
  </div>
</template>

<script setup lang="ts">
import { ref, onBeforeUnmount, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { Netdisk, backupCookieFile, loginWebView, restoreCookieFile, writeCookieFile } from '@/native/netdiskPlugin';
import { useToast } from '@/composables/useToast';
import { useDebounce } from '@/composables/useDebounce';
import { toErrorShape } from '@/shared/errors';
import { getAllPlatforms, COOKIE_ONLY_CAPABILITY_NOTE, type NetdiskPlatform } from '@/services/netdiskPlatforms';
import { useSettingsStore } from '@/stores/settingsStore';
import { writeNetdiskConfig } from '@/services/netdiskConfig';
import BottomSheet from '@/components/common/BottomSheet.vue';

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

/**
 * 拖动中的即时值：`null` 表示没有未落盘的草稿，显示回落到存储值。
 * 滑块每帧都会触发 `@input`，直写等于每帧一遍 IDB + 原生配置文件；本地跟手、落盘防抖。
 */
const threadCountDraft = ref<number | null>(null);
const threadCount = computed(() => threadCountDraft.value ?? netdiskSettings.value.threadCount);

const persistThreadCount = useDebounce(async () => {
  const count = threadCountDraft.value;
  if (count === null) return;
  try {
    await applyThreadCount(count);
  } catch (e) {
    // 落盘失败要出声：值没存住却说"改好了"，下次下载仍按旧线程数走
    toast.error(toErrorShape(e).message);
  } finally {
    // 写成功才交还给存储值；提前清空会让滑块闪回旧值
    if (threadCountDraft.value === count) threadCountDraft.value = null;
  }
}, 300);
// 划走页面时挂起的最后一次不能丢（useDebounce 的卸载钩子只 cancel，不补写）
onBeforeUnmount(() => persistThreadCount.flush());

function onThreadCountInput(count: number): void {
  threadCountDraft.value = count;
  persistThreadCount();
}

async function applyThreadCount(count: number): Promise<void> {
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
  /** 读取本身失败（权限、原生异常）：与「确实没有 cookie 文件」是两回事，不能都显示未登录 */
  unknown: boolean;
  nickname: string | null;
  memberType: string | null;
}

const platforms = ref<PlatformStatus[]>([]);
/** 首轮检测是否完成：完成前显示「检测中…」，避免把还没读出的状态说成「未登录」 */
const statusChecked = ref(false);

function applyStatus(
  platform: PlatformStatus,
  next: Pick<PlatformStatus, 'saved' | 'verified' | 'nickname' | 'memberType'> & {
    unknown?: boolean;
  },
): void {
  platform.saved = next.saved;
  platform.verified = next.verified;
  platform.unknown = next.unknown ?? false;
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
  if (!statusChecked.value) return '检测中…';
  // 读失败 ≠ 未登录：说成未登录会把「权限没给 / 原生读挂了」误导成要重新登录
  if (platform.unknown) return '状态读取失败';
  // FIX-B：权限缺失时 cookie 文件存在也等于不可用，优先展示异常态
  if (!hasAllFilesAccess.value && platform.saved) {
    return '权限异常';
  }
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
  return {
    logged: verified,
    saved: platform.saved && !verified,
    error: statusChecked.value && platform.unknown,
  };
}

onMounted(async () => {
  // 初始化平台列表
  const allPlatforms = getAllPlatforms();
  platforms.value = allPlatforms.map(p => ({
    ...p,
    saved: false,
    verified: false,
    unknown: false,
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

/** 原生在取不到真实昵称时写入的兜底占位，不能当成「已验证的真实账号」展示 */
const UNKNOWN_ACCOUNT_PLACEHOLDER = '未知账号';

/** 解析 cookie 文件内容：`a`=昵称（仅账号校验通过时非空）、`b`=会员类型、`c`=cookie */
function parseCookieAccount(content: string | undefined): {
  nickname: string | null;
  memberType: string | null;
} {
  if (!content) return { nickname: null, memberType: null };
  try {
    const parsed = JSON.parse(content) as { a?: unknown; b?: unknown };
    const rawNickname =
      typeof parsed.a === 'string' && parsed.a.trim().length > 0 ? parsed.a.trim() : null;
    // 兜底占位与真实昵称区分：历史文件里的「未知账号」只代表「有 cookie 但没拿到身份」，
    // 若照原样显示会变成误导性的「已登录（未知账号）」，掩盖真实问题。
    const nickname =
      rawNickname && rawNickname !== UNKNOWN_ACCOUNT_PLACEHOLDER ? rawNickname : null;
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
      // 原生调用被拒（存储权限缺失、目录不可访问）时并不等于「没有 cookie 文件」
      applyStatus(platform, {
        saved: false,
        verified: false,
        unknown: true,
        nickname: null,
        memberType: null,
      });
    }
  }
  statusChecked.value = true;
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

// 手动粘贴 Cookie 兜底：网页打不开 / 登录失败时，用户可在 PC 浏览器登录后导出 cookie 粘贴
const pasteSheetOpen = ref(false);
const pastePlatform = ref<PlatformStatus | null>(null);
const pasteCookieText = ref('');

function openPasteSheet(platform: PlatformStatus) {
  if (!hasAllFilesAccess.value) {
    toast.error('请先授权所有文件访问权限');
    return;
  }
  pastePlatform.value = platform;
  pasteCookieText.value = '';
  pasteSheetOpen.value = true;
}

async function confirmPaste() {
  const platform = pastePlatform.value;
  const raw = pasteCookieText.value.trim();
  if (!platform || !raw) {
    toast.error('请先粘贴 Cookie 内容');
    return;
  }
  try {
    const content = JSON.stringify({ a: '', b: '0', c: raw });
    await writeCookieFile(platform.key, content);
    pasteSheetOpen.value = false;
    await checkLoginStatus();
    toast.success(`${platform.name} Cookie 已保存（账号未验证）`);
  } catch (e) {
    console.error('Paste cookie failed', e);
    toast.error('保存失败');
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
  background: var(--color-brand);
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
  border-color: var(--color-brand);
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
  background: var(--color-brand);
  border-color: var(--color-brand);
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

/* 读取失败：与「未登录」区分开，提示的是检测本身出了问题 */
.platform-status.error {
  color: var(--color-danger, #f87171);
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
  color: var(--color-brand);
  font-weight: 600;
}

.config-note {
  margin: var(--space-2) 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-tertiary);
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
  border-color: var(--color-brand);
}

.quality-btn.active {
  background: var(--color-brand);
  border-color: var(--color-brand);
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
  background: var(--color-brand);
  border-radius: 50%;
  cursor: pointer;
}

.thread-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  background: var(--color-brand);
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

/* 手动粘贴 Cookie 兜底入口 */
.paste-cookie-link {
  display: inline-block;
  margin-top: 6px;
  padding: 0;
  background: none;
  border: none;
  color: var(--color-brand);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.paste-cookie-link:hover {
  color: var(--color-brand-strong);
}

/* 粘贴 Cookie 弹层内容 */
.paste-sheet {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 16px 16px;
}

.paste-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary, #aaa);
}

.paste-hint code {
  padding: 2px 6px;
  background: var(--bg-tertiary, #2a2a2a);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary, #fff);
}

.paste-textarea {
  width: 100%;
  min-height: 120px;
  padding: 12px;
  background: var(--bg-tertiary, #2a2a2a);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color 0.2s;
}

.paste-textarea:focus {
  border-color: var(--color-brand);
}

.paste-textarea::placeholder {
  color: var(--text-tertiary, #666);
}

.paste-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 4px;
}

.paste-btn {
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.paste-btn--cancel {
  background: var(--bg-tertiary, #2a2a2a);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #333);
}

.paste-btn--cancel:hover {
  background: var(--bg-secondary, #1a1a1a);
  border-color: var(--color-brand);
}

.paste-btn--confirm {
  background: var(--color-brand);
  color: #fff;
}

.paste-btn--confirm:hover {
  background: var(--color-brand-strong);
}
</style>
