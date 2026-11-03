#!/usr/bin/env node
/**
 * TVBox 订阅源测试工具
 * 测试内容：探活、解析、搜索功能模拟、播放检查
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
};

class TVBoxTester {
    constructor() {
        this.results = [];
        this.errors = [];
        this.startTime = Date.now();
        
        // 配置选项
        this.config = {
            timeout: 15000, // 超时时间 (ms)
            maxConcurrent: 3, // 最大并发数
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            followRedirects: true,
            maxRedirects: 5
        };
    }

    /**
     * HTTP 请求方法
     */
    request(options, data = null, maxRedirects = 5) {
        return new Promise((resolve, reject) => {
            const protocol = options.protocol === 'https:' ? https : http;
            
            const req = protocol.request(options, (res) => {
                let body = '';
                let redirectCount = 0;
                
                // 处理重定向
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    redirectCount++;
                    if (redirectCount > maxRedirects) {
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: '',
                            redirected: true,
                            location: res.headers.location,
                            error: 'Too many redirects'
                        });
                        return;
                    }
                    
                    const newOptions = {
                        ...options,
                        hostname: res.headers.location,
                        method: 'GET'
                    };
                    this.request(newOptions, null, maxRedirects).then(resolve);
                    return;
                }
                
                // 收集响应数据
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: body,
                        redirected: false
                    });
                });
            });
            
            req.on('error', (e) => {
                reject(e);
            });
            
            req.setTimeout(this.config.timeout, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            if (data) {
                req.write(data);
            }
            req.end();
        });
    }

    /**
     * HEAD 请求 - 探活测试
     */
    async probeUrl(url) {
        const startTime = Date.now();
        
        try {
            const parsedUrl = new URL(url);
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'HEAD',
                headers: {
                    'User-Agent': this.config.userAgent,
                    'Accept': '*/*'
                },
                protocol: parsedUrl.protocol
            };
            
            const response = await this.request(options);
            const duration = Date.now() - startTime;
            
            return {
                success: response.statusCode >= 200 && response.statusCode < 400,
                statusCode: response.statusCode,
                headers: response.headers,
                duration: duration,
                responseSize: parseInt(response.headers['content-length']) || 0,
                contentType: response.headers['content-type'] || 'unknown',
                server: response.headers['server'] || 'unknown',
                caching: response.headers['cache-control'] || 'none',
                encoding: response.headers['content-encoding'] || 'identity',
                cookies: response.headers['set-cookie'],
                error: null
            };
        } catch (error) {
            return {
                success: false,
                statusCode: null,
                headers: {},
                duration: Date.now() - startTime,
                responseSize: 0,
                contentType: 'error',
                server: 'unknown',
                caching: 'none',
                encoding: 'identity',
                cookies: null,
                error: error.message
            };
        }
    }

    /**
     * GET 请求 - 获取完整内容
     */
    async getUrlContent(url) {
        const startTime = Date.now();
        
        try {
            const parsedUrl = new URL(url);
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                headers: {
                    'User-Agent': this.config.userAgent,
                    'Accept': 'application/json, text/plain, */*'
                },
                protocol: parsedUrl.protocol
            };
            
            const response = await this.request(options);
            const duration = Date.now() - startTime;
            
            return {
                success: response.statusCode >= 200 && response.statusCode < 300,
                statusCode: response.statusCode,
                headers: response.headers,
                duration: duration,
                body: response.body,
                contentLength: Buffer.byteLength(response.body),
                encoding: response.headers['content-encoding'] || 'identity',
                error: null
            };
        } catch (error) {
            return {
                success: false,
                statusCode: null,
                headers: {},
                duration: Date.now() - startTime,
                body: '',
                contentLength: 0,
                encoding: 'identity',
                error: error.message
            };
        }
    }

    /**
     * 解析 JSON 内容
     */
    parseJson(content) {
        try {
            return {
                valid: true,
                data: JSON.parse(content),
                error: null
            };
        } catch (error) {
            return {
                valid: false,
                data: null,
                error: {
                    message: error.message,
                    line: error.lineNumber,
                    column: error.columnNumber
                }
            };
        }
    }

    /**
     * 分析 API 配置
     */
    analyzeApiConfig(config, sourceName) {
        const analysis = {
            name: sourceName,
            url: config.url,
            issues: [],
            warnings: [],
            info: {}
        };

        // 验证必填字段
        if (!config.url) {
            analysis.issues.push({
                type: 'error',
                field: 'url',
                message: '缺失必需字段：url'
            });
        } else {
            // 验证 URL 格式
            try {
                new URL(config.url);
            } catch (e) {
                analysis.issues.push({
                    type: 'error',
                    field: 'url',
                    message: `URL 格式错误：${config.url}`
                });
            }
            
            // 分析 URL 结构
            try {
                const urlObj = new URL(config.url);
                analysis.info.domain = urlObj.hostname;
                analysis.info.protocol = urlObj.protocol;
                analysis.info.path = urlObj.pathname;
                analysis.info.extention = path.extname(urlObj.pathname);
            } catch (e) {}

            // 检测 api.json
            if (config.url.includes('api.json')) {
                analysis.info.type = 'TVBox API';
            }
            
            // 检测 jar 包
            if (config.url.includes('.jar') || config.url.includes('ext')) {
                analysis.info.type = 'DRPY JAR';
                analysis.info.jarType = 'external-jar';
            }
        }

        // 检查其他字段
        if (config.name) {
            analysis.info.displayName = config.name;
        } else {
            analysis.warnings.push({
                field: 'name',
                message: '缺少名称字段，建议使用有意义的名称标识'
            });
        }

        if (config.type) {
            analysis.info.typeConfig = config.type;
            if (![1, 2, 3].includes(config.type)) {
                analysis.warnings.push({
                    field: 'type',
                    message: `type 值 ${config.type} 可能无效，推荐使用 1(电视), 2(电影), 3(动漫)`
                });
            }
        } else {
            // type 为可选字段，不报错但可记录
            analysis.info.typeConfig = 'not-set';
        }

        if (config.api) {
            analysis.info.customApi = config.api;
            // 验证自定义 API
            if (!config.api.startsWith('http')) {
                analysis.warnings.push({
                    field: 'api',
                    message: `自定义 API "${config.api}" 应该是完整 URL`
                });
            }
        }

        if (config.ext) {
            analysis.info.extUrl = config.ext;
            if (config.ext.includes('.jar')) {
                analysis.info.extType = 'jar';
            } else if (config.ext.includes('.json')) {
                analysis.info.extType = 'json';
            }
        }

        return analysis;
    }

    /**
     * 并行执行多个请求
     */
    async concurrentExec(items, worker, concurrency) {
        const results = [];
        let index = 0;
        
        const queue = async () => {
            while (index < items.length) {
                const i = index++;
                try {
                    results[i] = await worker(items[i], i);
                } catch (error) {
                    results[i] = { error: error.message };
                }
            }
        };
        
        await Promise.allSettled(
            Array.from({ length: Math.min(concurrency, items.length) }, queue)
        );
        
        return results.filter(r => r !== undefined);
    }

    /**
     * 测试单个订阅源
     */
    async testSingleSource(config) {
        const result = {
            name: config.name || 'Unnamed',
            url: config.url,
            probe: null,
            apiConfig: null,
            contentAnalysis: null,
            issues: [],
            warnings: []
        };

        console.log(`\n测试：${result.name}`);
        console.log(`URL: ${result.url}`);

        // 步骤 1: 探活测试
        console.log('  [1/3] 探活测试...');
        result.probe = await this.probeUrl(result.url);
        
        const statusSymbol = result.probe.success ? '✓' : '✗';
        const statusColor = result.probe.success ? colors.green : colors.red;
        console.log(`    ${statusColor}${statusSymbol} HTTP ${result.probe.statusCode} (${result.probe.duration}ms)`);
        
        if (result.probe.error) {
            result.issues.push({
                category: 'connectivity',
                severity: 'error',
                message: `连接失败：${result.probe.error}`
            });
            console.log(`    ${colors.red}错误：${result.probe.error}${colors.reset}`);
        }

        // 步骤 2: 获取内容并解析
        if (result.probe.success) {
            console.log('  [2/3] 获取内容...');
            const contentResult = await this.getUrlContent(result.url);
            
            if (contentResult.success) {
                console.log('    ✓ 内容获取成功');
                
                // 解析 JSON
                const jsonResult = this.parseJson(contentResult.body);
                
                if (jsonResult.valid) {
                    result.apiConfig = this.analyzeApiConfig(config, result.name);
                    result.contentAnalysis = jsonResult.data;
                    console.log('    ✓ JSON 解析成功');
                    
                    // 分析 JSON 结构
                    if (jsonResult.data.urls) {
                        result.contentAnalysis.totalUrls = jsonResult.data.urls.length;
                        console.log(`    ℹ 包含 ${jsonResult.data.urls.length} 个子源`);
                        
                        // 识别爬虫类型
                        const crawlerTypes = new Set();
                        jsonResult.data.urls.forEach(subSource => {
                            if (subSource.ext?.includes('.jar')) {
                                crawlerTypes.add('drpy-jar');
                            } else if (subSource.api) {
                                crawlerTypes.add('custom-api');
                            }
                        });
                        
                        if (crawlerTypes.size > 0) {
                            result.crawlerTypes = Array.from(crawlerTypes);
                            console.log(`    ℹ 爬虫类型：${crawlerTypes.join(', ')}`);
                        }
                    }
                } else {
                    result.issues.push({
                        category: 'format',
                        severity: 'error',
                        message: `JSON 解析失败：第 ${jsonResult.error.line}:${jsonResult.error.column} - ${jsonResult.error.message}`
                    });
                    console.log(`    ${colors.red}✗ JSON 解析失败${colors.reset}`);
                }
            } else {
                result.issues.push({
                    category: 'accessibility',
                    severity: 'error',
                    message: `HTTP ${contentResult.statusCode}: ${contentResult.error}`
                });
            }
        }

        return result;
    }

    /**
     * 生成测试报告
     */
    generateReport() {
        const report = {
            summary: {
                total: this.results.length,
                successful: this.results.filter(r => r.probe?.success).length,
                failed: this.results.filter(r => !r.probe?.success).length,
                withIssues: this.results.reduce((count, r) => count + r.issues.length, 0),
                avgResponseTime: Math.round(
                    this.results.reduce((sum, r) => sum + (r.probe?.duration || 0), 0) / 
                    this.results.filter(r => r.probe)?.length || 1
                ),
                totalTime: Date.now() - this.startTime
            },
            results: this.results,
            allIssues: this.results.flatMap(r => r.issues.map(i => ({
                source: r.name,
                ...i
            }))),
            recommendations: this.generateRecommendations(),
            generatedAt: new Date().toISOString()
        };

        return report;
    }

    /**
     * 生成建议
     */
    generateRecommendations() {
        const recommendations = [];
        
        // 检查 JSON 语法问题
        const invalidSources = this.results.filter(r => !r.apiConfig);
        if (invalidSources.length > 0) {
            recommendations.push({
                priority: 'high',
                title: '修复 JSON 语法错误',
                description: `发现 ${invalidSources.length} 个配置无法正确解析 JSON`,
                details: invalidSources.map(r => `${r.name}: ${r.url}`).join('\n')
            });
        }
        
        // 检查不可达的源
        const unreachable = this.results.filter(r => !r.probe?.success);
        if (unreachable.length > 0) {
            recommendations.push({
                priority: 'medium',
                title: '检查网络可达性',
                description: `${unreachable.length} 个源无法访问`,
                details: unreachable.map(r => `${r.name}: ${r.probe.error || 'HTTP ' + r.probe.statusCode}`).join('\n')
            });
        }
        
        // 检查配置缺失
        const missingNames = this.results.filter(r => !r.name);
        if (missingNames.length > 0) {
            recommendations.push({
                priority: 'low',
                title: '添加命名',
                description: `${missingNames.length} 个配置缺少 name 字段`
            });
        }
        
        // 检查爬虫类型
        const sourcesWithJar = this.results.filter(r => r.contentAnalysis?.urls?.some(u => u.ext?.includes('.jar')));
        if (sourcesWithJar.length > 0) {
            recommendations.push({
                priority: 'low',
                title: 'JAR 源可用性',
                description: `${sourcesWithJar.length} 个源使用了 drpy JAR 扩展`,
                suggestion: '建议单独测试 JAR 文件的可用性'
            });
        }
        
        return recommendations;
    }

    /**
     * 打印终端报告
     */
    printReport() {
        console.log('\n\n' + '='.repeat(80));
        console.log(colors.cyan + '         TVBox 订阅源测试报告'.padEnd(80) + colors.reset);
        console.log('='.repeat(80));
        
        const s = this.results.summary;
        console.log(`\n${colors.gray}测试时间：${new Date(s.totalTime).toISOString()}${colors.reset}`);
        console.log(`📊 ${colors.white}${s.total}${colors.reset} 个源 | ${colors.green}${s.successful}${colors.reset} 正常 | ${colors.red}${s.failed}${colors.reset} 异常`);
        console.log(`⏱️ 平均响应：${colors.blue}${s.avgResponseTime}ms${colors.reset} | 总计：${colors.blue}${s.totalTime}ms${colors.reset}`);
        console.log(`⚠️  发现问题：${colors.yellow}${s.withIssues}${colors.reset} 个`);
        
        console.log('\n' + '-'.repeat(80));
        console.log(colors.magenta + '详细测试结果' + colors.reset);
        console.log('-'.repeat(80));
        
        this.results.forEach(r => {
            const statusIcon = r.probe?.success ? colors.green + '✓' : colors.red + '✗';
            const statusColor = r.probe?.success ? colors.green : colors.red;
            
            console.log(`\n${statusColor}${statusIcon} ${colors.bold}${r.name}${colors.reset}`);
            console.log(`   URL: ${r.url}`);
            console.log(`   HTTP Status: ${r.probe?.statusCode || 'N/A'} (${r.probe?.duration || 0}ms)`);
            
            if (r.probe?.error) {
                console.log(`   ${colors.red}错误：${r.probe.error}${colors.reset}`);
            }
            
            if (r.apiConfig) {
                if (r.apiConfig.info?.type) {
                    console.log(`   Type: ${colors.cyan}${r.apiConfig.info.type}${colors.reset}`);
                }
                if (r.contentAnalysis?.totalUrls) {
                    console.log(`   Sub-sources: ${colors.yellow}${r.contentAnalysis.totalUrls}${colors.reset}`);
                }
                if (r.crawlerTypes) {
                    console.log(`   Crawlers: ${r.crawlerTypes.join(', ')}`);
                }
            }
            
            if (r.issues.length > 0) {
                console.log(`   ${colors.red}问题:${colors.reset}`);
                r.issues.forEach(issue => {
                    console.log(`     • ${issue.message}`);
                });
            }
        });
        
        // 推荐建议
        const report = this.generateReport();
        if (report.recommendations.length > 0) {
            console.log('\n' + '-'.repeat(80));
            console.log(colors.yellow + '优化建议' + colors.reset);
            console.log('-'.repeat(80));
            
            report.recommendations.forEach((rec, idx) => {
                console.log(`\n${idx + 1}. ${colors.cyan}[${rec.priority.toUpperCase()}]${colors.reset} ${rec.title}`);
                console.log(`   ${rec.description}`);
                if (rec.details) {
                    console.log('   详情:');
                    rec.details.split('\n').forEach(line => console.log(`     ${line}`));
                }
                if (rec.suggestion) {
                    console.log(`   ${colors.gray}建议：${rec.suggestion}${colors.reset}`);
                }
            });
        }
        
        console.log('\n' + '='.repeat(80));
        console.log(colors.gray + '测试完成！' + colors.reset);
    }
}

// 主函数
async function main() {
    const tester = new TVBoxTester();
    
    console.log(colors.cyan + '╔═══════════════════════════════════════════════════════════╗' + colors.reset);
    console.log(colors.cyan + '║        TVBox 订阅源健康检查工具 v1.0                      ║' + colors.reset);
    console.log(colors.cyan + '╚═══════════════════════════════════════════════════════════╝' + colors.reset);
    
    const SUBSCRIPTION_URL = 'https://play.iptv365.org/tvbox.txt';
    
    console.log(`\n开始测试订阅：${SUBSCRIPTION_URL}\n`);
    
    // 步骤 1: 获取订阅源
    console.log(`${colors.cyan}[1/${colors.reset}3${colors.cyan}] 获取订阅源...${colors.reset}`);
    const subscriptionContent = await tester.getUrlContent(SUBSCRIPTION_URL);
    
    if (!subscriptionContent.success) {
        console.log(`${colors.red}✗ 无法获取订阅源内容${colors.reset}`);
        process.exit(1);
    }
    
    console.log(`${colors.green}✓ 获取成功 (${subscriptionContent.contentLength} bytes)${colors.reset}`);
    
    // 步骤 2: 解析 JSON
    console.log(`${colors.cyan}[2/${colors.reset}3${colors.cyan}] 解析订阅配置...${colors.reset}`);
    const jsonResult = tester.parseJson(subscriptionContent.body);
    
    if (!jsonResult.valid) {
        console.log(`${colors.red}✗ JSON 解析失败${colors.reset}`);
        console.log(`${colors.yellow}错误信息：${colors.reset}${jsonResult.error.message}`);
        
        // 显示出错附近的内容
        const lines = subscriptionContent.body.split('\n');
        const startLine = Math.max(0, jsonResult.error.line - 3 || 0);
        const endLine = Math.min(lines.length, (jsonResult.error.line || 1) + 2);
        console.log('\n出错的代码片段:');
        for (let i = startLine; i < endLine; i++) {
            const marker = jsonResult.error.line ? ((i + 1) === jsonResult.error.line) ? colors.red + '>>>' : '   ' : '';
            console.log(`${marker} ${colors.gray}${i + 1}${colors.reset}: ${lines[i]}`);
        }
        
        process.exit(1);
    }
    
    console.log(`${colors.green}✓ JSON 解析成功${colors.reset}`);
    console.log(`ℹ 数据结构: ${Object.keys(jsonResult.data).join(', ')}`);
    
    if (!jsonResult.data.urls || !Array.isArray(jsonResult.data.urls)) {
        console.log(`${colors.red}✗ 订阅源格式错误：缺少 urls 数组${colors.reset}`);
        process.exit(1);
    }
    
    console.log(`ℹ 发现 ${jsonResult.data.urls.length} 个子源配置\n`);
    
    // 步骤 3: 测试每个子源
    console.log(`${colors.cyan}[3/${colors.reset}3${colors.cyan}] 测试所有子源...${colors.reset}`);
    
    const promises = jsonResult.data.urls.map(async (config, index) => {
        const percent = Math.round(((index + 1) / jsonResult.data.urls.length) * 100);
        process.stdout.write(`进度：${percent}%\r`);
        return await tester.testSingleSource(config);
    });
    
    const results = await Promise.all(promises);
    tester.results = results;
    
    // 生成并打印报告
    tester.printReport();
    
    // 保存完整报告到文件
    const report = tester.generateReport();
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const reportPath = path.join(__dirname, 'tvbox-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n完整报告已保存到：${colors.cyan}${reportPath}${colors.reset}`);
    
    // 退出码
    process.exit(report.summary.failed > 0 ? 1 : 0);
}

// 运行主函数
main().catch(error => {
    console.error(colors.red + '发生未预期的错误:' + colors.reset, error);
    process.exit(1);
});
