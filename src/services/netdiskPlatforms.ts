/**
 * 网盘平台配置（P2）
 *
 * 每个平台的登录 URL、cookie 文件路径、API 端点等配置
 */

export interface NetdiskPlatform {
  key: string;
  name: string;
  icon: string;
  loginUrl: string;
  cookieFile: string;
  cookieDomains: string[];
  memberApi?: string;
  accountApi?: string;
  userAgent?: string;
}

export const NETDISK_PLATFORMS: Record<string, NetdiskPlatform> = {
  quark: {
    key: 'quark',
    name: '夸克网盘',
    icon: '🔵',
    loginUrl: 'https://pan.quark.cn',
    cookieFile: 'quark_cookie.txt',
    cookieDomains: ['https://pan.quark.cn', 'https://drive-pc.quark.cn'],
    memberApi: 'https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&uc_param_str=&fetch_subscribe=true&_ch=home&fetch_identity=true',
    accountApi: 'https://pan.quark.cn/account/info?fr=pc&platform=pc',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  uc: {
    key: 'uc',
    name: 'UC网盘',
    icon: '🟢',
    loginUrl: 'https://drive.uc.cn',
    cookieFile: 'uc_cookie.txt',
    cookieDomains: ['https://drive.uc.cn'],
    // TODO: 需要逆向 UC 网盘的 API 端点
  },
  '123': {
    key: '123',
    name: '123云盘',
    icon: '🟡',
    loginUrl: 'https://www.123pan.com',
    cookieFile: '123_cookie.txt',
    cookieDomains: ['https://www.123pan.com'],
    // TODO: 需要逆向 123 云盘的 API 端点
  },
  tianyi: {
    key: 'tianyi',
    name: '天翼云盘',
    icon: '🔴',
    loginUrl: 'https://cloud.189.cn',
    cookieFile: 'tianyi_cookie.txt',
    cookieDomains: ['https://cloud.189.cn'],
    // TODO: 需要逆向天翼云盘的 API 端点
  },
  ali: {
    key: 'ali',
    name: '阿里云盘',
    icon: '⚪',
    loginUrl: 'https://www.aliyundrive.com',
    cookieFile: 'ali_cookie.txt',
    cookieDomains: ['https://www.aliyundrive.com'],
    // TODO: 需要逆向阿里云盘的 API 端点
  },
};

/**
 * 获取平台配置
 */
export function getPlatform(key: string): NetdiskPlatform | undefined {
  return NETDISK_PLATFORMS[key];
}

/**
 * 获取所有支持的平台列表
 */
export function getAllPlatforms(): NetdiskPlatform[] {
  return Object.values(NETDISK_PLATFORMS);
}
