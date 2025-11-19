/**
 * Sub-Store Script: AI Availability Checker (Local Environment)
 * Targets: OpenAI, Gemini, Claude
 * Feature: Concurrency Control & Real-time HTTP Check
 */

// 配置项
const CONFIG = {
    timeout: 5000, // 超时时间 5s
    concurrency: 5, // 并发数 (建议 5-10，太高会被断流)
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

async function operator(proxies) {
    // 辅助函数：并发控制器
    const runBatch = async (items, fn, limit) => {
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
    };

    // 单个节点检测逻辑
    const checkNode = async (proxy) => {
        let tags = [];

        // 定义检测任务
        const tasks = [
            {
                name: "GPT",
                url: "https://chatgpt.com",
                isValid: (status) => [200, 302, 307].includes(status)
            },
            {
                name: "Gem",
                url: "https://gemini.google.com",
                isValid: (status) => [200, 302, 307].includes(status)
            },
            {
                name: "Cld",
                url: "https://claude.ai/login",
                isValid: (status) => [200, 302, 307].includes(status)
            }
        ];

        // 并行执行三个检测
        const checkResults = await Promise.allSettled(tasks.map(task => {
            return http.get({
                url: task.url,
                headers: { "User-Agent": CONFIG.ua },
                timeout: CONFIG.timeout,
                node: proxy // 关键：指定使用该节点进行请求
            }).then(resp => {
                if (task.isValid(resp.status)) {
                    return task.name;
                }
                throw new Error(`${task.name} blocked: ${resp.status}`);
            });
        }));

        // 收集成功标签
        checkResults.forEach(res => {
            if (res.status === 'fulfilled') {
                tags.push(res.value);
            }
        });

        // 修改节点名称
        if (tags.length > 0) {
            // 清理旧标签防止重复堆叠
            let cleanName = proxy.name.replace(/\[(GPT|Gem|Cld)\]/g, '').trim();
            proxy.name = `${cleanName} [${tags.join('][')}]`;
        }

        return proxy;
    };

    // 开始执行
    // console.log(`Starting check for ${proxies.length} nodes...`);
    return await runBatch(proxies, checkNode, CONFIG.concurrency);
}