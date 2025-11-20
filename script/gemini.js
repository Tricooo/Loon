/**
 * Sub-Store 脚本: Gemini 独立检测与筛选
 *
 * 功能：
 * 1. 检测节点是否支持 Google Gemini。
 * 2. 自动跳过香港节点（Gemini 不支持香港）。
 * 3. 默认直接剔除不可用节点，输出纯净列表。
 *
 * 参数 (Arguments):
 * - rename: 'true' | 'false' (默认 'false')。如果设为 true，会在节点名前加 [Gemini]。
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
    const prefixStr = $arguments.prefix ?? '[Gemini] '
    // 使用 API key 验证端点 (InvalidKey 也能测连通性)
    const checkUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=InvalidKey`
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    // 香港节点正则 (Gemini 屏蔽区域)
    const hkRegex = /(?:HongKong|Hong Kong|HK|🇭🇰|香\s*港|港|港中转)/i

    const cache = scriptResourceCache
    const useCache = $arguments.cache !== 'false'
    const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

    const startTime = Date.now()
    const deadline = startTime + GLOBAL_TIMEOUT
    const tasks = []

    // --- 1. 读缓存 & 预处理 ---
    for (const proxy of proxies) {
        const fingerprint = getFingerprint(proxy)
        const cacheKey = `gemini_check_standalone_v1:${fingerprint}`
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

                // 预检：如果是香港节点，直接判负，不发请求
                if (hkRegex.test(task.proxy.name)) {
                    saveCache(task, false)
                    return
                }

                const node = ProxyUtils.produce([task.proxy], target)
                if (node) {
                    const isOk = await checkGemini(node, requestTimeout)
                    saveCache(task, isOk)
                    if (enableRename && isOk) addPrefix(task.proxy)
                }
            }),
            { concurrency, deadline }
        )
    }

    // --- 3. 筛选输出 ---
    return proxies.filter(p => p._isOk === true)

    // --- 辅助函数 ---

    function saveCache(task, isOk) {
        if (useCache) {
            cache.set(task.cacheKey, { ok: isOk })
        }
        task.proxy._isOk = isOk
    }

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
            // 400 说明连通了 Google API (Key 无效)，说明 IP 可用
            // 403 通常是地区封锁
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