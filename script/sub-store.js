/**
 * Sub-Store 脚本：AI 服务可用性检测与标记
 * 功能：检测 OpenAI, Gemini, Claude 并重命名节点
 *
 * 作者优化版 - 适配 Surge
 */

const CHECK_TIMEOUT = 5000; // 超时时间 5秒
const CONCURRENCY = 10; // 并发检测数量，太高会被机场封，太低速度慢

async function operator(proxies) {
    const encoder = new TextEncoder();

    // 辅助函数：分批处理避免瞬间高并发
    async function batchRun(items, fn, limit) {
        const results = [];
        const executing = [];
        for (const item of items) {
            const p = Promise.resolve().then(() => fn(item));
            results.push(p);
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= limit) await Promise.race(executing);
        }
        return Promise.all(results);
    }

    // 检测逻辑
    async function checkNode(proxy) {
        // 原始名称
        let newName = proxy.name;
        const tags = [];

        // 1. 检测 OpenAI
        try {
            const resp = await http.get({
                url: 'https://chatgpt.com', // 简单检测主页
                headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
                timeout: CHECK_TIMEOUT,
                node: proxy
            });
            // 403通常是Cloudflare拦截或地区封锁，200/302/307通常是通的
            if (resp.status === 200 || resp.status === 302 || resp.status === 307) {
                tags.push("GPT");
            }
        } catch (e) {}

        // 2. 检测 Gemini
        try {
            const resp = await http.get({
                url: 'https://gemini.google.com',
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
                timeout: CHECK_TIMEOUT,
                node: proxy
            });
            // Gemini 封锁通常返回 403 或重定向到不支持页面，正常是 200 或 302 跳转登录
            if (resp.status === 200 || (resp.status === 302 && !resp.headers['Location'].includes('unavailable'))) {
                tags.push("Gem");
            }
        } catch (e) {}

        // 3. 检测 Claude
        try {
            const resp = await http.get({
                url: 'https://claude.ai/login',
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
                timeout: CHECK_TIMEOUT,
                node: proxy
            });
            if (resp.status === 200 || resp.status === 302) {
                tags.push("Cld");
            }
        } catch (e) {}

        // 如果所有检测都失败（可能是死节点），可以选择标记为 [Dead] 或者保持原样
        // 这里我们只添加成功的标签
        if (tags.length > 0) {
            // 为了美观，去除原名中可能已有的标签，避免重复
            // newName = newName.replace(/\[GPT\]|\[Gem\]|\[Cld\]/gi, "").trim();
            newName += " [" + tags.join("][") + "]";
        }

        proxy.name = newName;
        return proxy;
    }

    return await batchRun(proxies, checkNode, CONCURRENCY);
}