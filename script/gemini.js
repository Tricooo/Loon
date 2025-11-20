/**
 * Sub-Store 脚本: Gemini 独立检测 (只缓存成功结果)
 * 
 * 优化策略：
 * 1. 只有检测通过(True)的节点才会被写入缓存。
 * 2. 失败节点下次刷新时会强制重测。
 * 3. 香港节点依然直接排除，且不写入缓存(或者写入失败也无所谓，因为下次正则匹配还会拦住)。
 */

async function operator(proxies = [], targetPlatform, context) {
    const $ = $substore
    const { isLoon, isSurge } = $.env

    const concurrency = parseInt($arguments.concurrency || 10)
    const requestTimeout = parseInt($arguments.timeout || 5000)
    const enableRename = ($arguments.rename === 'true')

    const GLOBAL_TIMEOUT = 28000
    const prefixStr = $arguments.prefix ?? '[Gemini] '
    const checkUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=InvalidKey`
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    const hkRegex = /(?:HongKong|Hong Kong|HK|🇭🇰|香\s*港|港|港中转)/i

    const cache = scriptResourceCache
    const useCache = $arguments.cache !== 'false'
    const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

    const startTime = Date.now()
    const deadline = startTime + GLOBAL_TIMEOUT
    const tasks = []

    // --- 1. 读缓存 ---
    for (const proxy of proxies) {
        const fingerprint = getFingerprint(proxy)
        const cacheKey = `gemini_check_standalone_v2:${fingerprint}`
        proxy._cacheKey = cacheKey

        let cachedRes = undefined
        if (useCache) cachedRes = cache.get(cacheKey)

        // 核心修改：只信任成功的结果
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
                
                if (hkRegex.test(task.proxy.name)) {
                    // 香港节点直接失败，不写缓存（或者写了下次读出来发现不是 true 也会重测，但正则会再次拦截，效率不受影响）
                    task.proxy._isOk = false
                    return
                }

                const node = ProxyUtils.produce([task.proxy], target)
                if (node) {
                    const isOk = await checkGemini(node, requestTimeout)
                    
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

    async function checkGemini(node, timeout) {
        try {
            const res = await $.http.get({
                url: checkUrl,
                headers: { 'User-Agent': UA },
                node, timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 0)
            return status === 400
        } catch (e) { 
            return false
        }
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
