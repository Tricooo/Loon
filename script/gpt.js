/**
 * Sub-Store 脚本: ChatGPT 独立检测 (只缓存成功结果)
 * 
 * 优化策略：
 * 1. 只有检测通过(True)的节点才会被写入缓存。
 * 2. 读取缓存时，如果发现之前的记录是失败，则强制重测(Retry)，绝不直接丢弃。
 * 3. 这样可以解决 iOS 上因网络波动导致节点被误杀且无法恢复的问题。
 * 
 * 参数:
 * - rename: 'true' | 'false'
 * - timeout: 默认 5000
 * - cache: 'false' (可选，强制清除所有缓存)
 */

async function operator(proxies = [], targetPlatform, context) {
    const $ = $substore
    const { isLoon, isSurge } = $.env

    const concurrency = parseInt($arguments.concurrency || 10)
    const requestTimeout = parseInt($arguments.timeout || 5000)
    const enableRename = ($arguments.rename === 'true')
    
    const GLOBAL_TIMEOUT = 28000
    const prefixStr = $arguments.prefix ?? '[GPT] '
    const checkUrl = `https://chatgpt.com`
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    const cache = scriptResourceCache
    const useCache = $arguments.cache !== 'false'
    const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

    const startTime = Date.now()
    const deadline = startTime + GLOBAL_TIMEOUT
    const tasks = []

    // --- 1. 读缓存 (只信任 True) ---
    for (const proxy of proxies) {
        const fingerprint = getFingerprint(proxy)
        const cacheKey = `gpt_check_standalone_v2:${fingerprint}` // 升级版本号以隔离旧缓存
        proxy._cacheKey = cacheKey

        let cachedRes = undefined
        if (useCache) cachedRes = cache.get(cacheKey)

        // 核心修改：只有缓存明确记录为 ok=true 时，才跳过检测
        // 如果缓存不存在，或者缓存记录是失败，都加入 tasks 重测
        if (cachedRes && cachedRes.ok === true) {
            proxy._isOk = true
            if (enableRename) addPrefix(proxy)
        } else {
            tasks.push({ proxy, cacheKey })
        }
    }

    // --- 2. 执行检测 ---
    if (tasks.length > 0) {
        await executeAsyncTasks(
            tasks.map(task => async () => {
                if (Date.now() > deadline) return

                const node = ProxyUtils.produce([task.proxy], target)
                if (node) {
                    const isOk = await checkGPT(node, requestTimeout)
                    
                    // 核心修改：只有成功才写入缓存
                    if (useCache && isOk) {
                        cache.set(task.cacheKey, { ok: true })
                    }
                    
                    task.proxy._isOk = isOk
                    if (enableRename && isOk) addPrefix(task.proxy)
                }
            }),
            { concurrency, deadline }
        )
    }

    return proxies.filter(p => p._isOk === true)

    // --- 辅助函数 ---

    function addPrefix(proxy) {
        if (!proxy.name.includes(prefixStr)) {
            proxy.name = prefixStr + proxy.name
        }
    }

    async function checkGPT(node, timeout) {
        let status = 0
        try {
            const res = await $.http.get({
                url: checkUrl,
                headers: {
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                node, timeout
            })
            status = parseInt(res.status ?? res.statusCode ?? 0)
            const body = (res.body ?? res.rawBody ?? "") + ""
            
            if ([200, 302, 429].includes(status)) return true
            if (status === 403) {
                if (!/(unsupported_country|region not supported|country|access denied|vpn|proxy)/i.test(body)) {
                    return true
                }
            }
        } catch (e) { }
        return false
    }

    function getFingerprint(proxy) {
        const entries = Object.entries(proxy)
            .filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
            .sort(([a], [b]) => a.localeCompare(b))
        return JSON.stringify(Object.fromEntries(entries))
    }

    function executeAsyncTasks(tasks, { concurrency = 1, deadline } = {}) {
        return new Promise(resolve => {
            let running = 0
            let index = 0
            function executeNextTask() {
                if (deadline && Date.now() > deadline) return running === 0 ? resolve() : null
                while (index < tasks.length && running < concurrency) {
                    const currentTask = tasks[index++]
                    running++
                    Promise.resolve().then(currentTask).catch(() => {}).finally(() => {
                        running--
                        if (running === 0 && index >= tasks.length) return resolve()
                        executeNextTask()
                    })
                }
                if (running === 0 && index >= tasks.length) resolve()
            }
            executeNextTask()
        })
    }
}
