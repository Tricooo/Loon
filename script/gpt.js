/**
 * Sub-Store 脚本: ChatGPT 独立检测与筛选
 *
 * 功能：
 * 1. 检测节点是否支持 ChatGPT。
 * 2. 默认直接剔除不可用节点，输出纯净列表。
 * 3. 支持缓存，避免重复检测。
 *
 * 参数 (Arguments):
 * - rename: 'true' | 'false' (默认 'false')。如果设为 true，会在节点名前加 [GPT]。
 * - timeout: 检测超时时间 (默认 5000)
 */

async function operator(proxies = [], targetPlatform, context) {
    const $ = $substore
    const { isLoon, isSurge } = $.env

    // --- 用户参数 ---
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

    // --- 1. 读缓存 & 预处理 ---
    for (const proxy of proxies) {
        const fingerprint = getFingerprint(proxy)
        // 使用独立的缓存 Key，避免与其他脚本冲突
        const cacheKey = `gpt_check_standalone_v1:${fingerprint}`
        proxy._cacheKey = cacheKey

        let result = undefined
        if (useCache) result = cache.get(cacheKey)

        if (result) {
            proxy._isOk = result.ok
            if (enableRename && proxy._isOk) addPrefix(proxy)
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

                    if (useCache) {
                        cache.set(task.cacheKey, { ok: isOk })
                    }

                    task.proxy._isOk = isOk
                    if (enableRename && isOk) addPrefix(task.proxy)
                }
            }),
            { concurrency, deadline }
        )
    }

    // --- 3. 筛选输出 (只返回可用的) ---
    return proxies.filter(p => p._isOk === true)

    // --- 辅助函数 ---

    function addPrefix(proxy) {
        // 避免重复添加
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

            // 判定逻辑
            if ([200, 302, 429].includes(status)) return true
            if (status === 403) {
                // 403 时，如果 body 里没有典型的拒绝关键词，通常也是通的
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