/**
 * GPT & Gemini 双重检测 (v14.0 无痕筛选版)
 *
 * 新增参数:
 * - filter: 'gpt' | 'gemini' | 'all' (默认 'all')
 *   如果设置为 gpt，脚本将在检测后，直接剔除不支持 GPT 的节点。
 *   这样输出到 Surge 的列表就是纯净的 GPT 可用节点，无需改名。
 *
 * - rename: 'true' | 'false' (默认 'false')
 *   是否给节点加前缀。为了保持名字干净，默认设为 false。
 */

async function operator(proxies = [], targetPlatform, context) {
    const $ = $substore
    const { isLoon, isSurge } = $.env

    // --- 用户参数 ---
    const concurrency = parseInt($arguments.concurrency || 10)
    const requestTimeout = parseInt($arguments.timeout || 5000)

    // 新增：筛选模式 (gpt, gemini, all)
    const filterMode = ($arguments.filter || 'all').toLowerCase()
    // 新增：是否重命名 (默认不重命名，保持列表干净)
    const enableRename = ($arguments.rename === 'true')

    const GLOBAL_TIMEOUT = 28000

    const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
    const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '

    const gptUrl = `https://chatgpt.com`
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=InvalidKey`

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
        const cacheKey = `ai_check_v13:${fingerprint}`

        // 挂载缓存Key方便后续使用
        proxy._cacheKey = cacheKey

        let result = undefined
        if (useCache) {
            result = cache.get(cacheKey)
        }

        if (result) {
            // 命中缓存，直接标记内部状态
            proxy._gpt = result.gpt
            proxy._gemini = result.gemini
            if (enableRename) applyPrefix(proxy, result)
        } else {
            tasks.push({ proxy, cacheKey })
        }
    }

    // --- 2. 执行检测 (仅针对未命中缓存的节点) ---
    if (tasks.length > 0) {
        await executeAsyncTasks(
            tasks.map(task => async () => {
                if (Date.now() > deadline) return

                const node = ProxyUtils.produce([task.proxy], target)
                if (node) {
                    const res = await performNetworkCheck(task.proxy, node, requestTimeout)

                    if (useCache && res.fully_checked) {
                        cache.set(task.cacheKey, res)
                    }

                    // 标记内部状态
                    task.proxy._gpt = res.gpt
                    task.proxy._gemini = res.gemini

                    if (enableRename) applyPrefix(task.proxy, res)
                }
            }),
            { concurrency, deadline }
        )
    }

    // --- 3. 核心逻辑：根据 filter 参数筛选输出 ---
    // 注意：这里不会删除原始订阅的节点，只会影响 Sub-Store 输出给 Surge 的结果
    if (filterMode === 'gpt') {
        return proxies.filter(p => p._gpt === true)
    } else if (filterMode === 'gemini') {
        return proxies.filter(p => p._gemini === true)
    }

    // 默认返回全部 (filter=all)，名字未修改
    return proxies

    // --- 辅助函数 ---

    function applyPrefix(proxy, result) {
        if (!result) return
        let prefix = ""
        if (result.gemini) prefix += geminiPrefix
        if (result.gpt) prefix += gptPrefix

        if (prefix) {
            const escaped = [gptPrefix, geminiPrefix]
                .filter(Boolean)
                .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

            const cleanName = escaped.length
                ? proxy.name.replace(new RegExp(`^(?:${escaped.join('|')}|\\s)+`, 'g'), '')
                : proxy.name

            proxy.name = prefix + cleanName
        }
    }

    async function performNetworkCheck(originalProxy, node, timeout) {
        let isGptOk = false
        let isGeminiOk = false
        let gptStatus = 0
        let geminiStatus = 0

        const hkRegex = /(?:HongKong|Hong Kong|HK|🇭🇰|香\s*港|港|港中转)/i;
        const isRegionBlocked = hkRegex.test(originalProxy.name);

        const checkGPT = async () => {
            try {
                const res = await http({
                    method: 'get', url: gptUrl,
                    headers: {
                        'User-Agent': UA,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9'
                    },
                    node, timeout
                })
                gptStatus = parseInt(res.status ?? res.statusCode ?? 0)
                const body = (res.body ?? res.rawBody ?? "") + ""
                if ([200, 302, 429].includes(gptStatus)) {
                    isGptOk = true
                } else if (gptStatus === 403) {
                    if (!/(unsupported_country|region not supported|country|access denied|vpn|proxy)/i.test(body)) {
                        isGptOk = true
                    }
                }
            } catch (e) { gptStatus = 0 }
        }

        const checkGemini = async () => {
            if (isRegionBlocked) {
                geminiStatus = 403; isGeminiOk = false; return;
            }
            try {
                const res = await http({
                    method: 'get', url: geminiUrl,
                    headers: { 'User-Agent': UA },
                    node, timeout
                })
                geminiStatus = parseInt(res.status ?? res.statusCode ?? 0)
                if (geminiStatus === 400) isGeminiOk = true
            } catch (e) { geminiStatus = 0 }
        }

        await Promise.all([checkGPT(), checkGemini()])
        const fullyChecked = (gptStatus > 0) && (geminiStatus > 0)
        return { gpt: isGptOk, gemini: isGeminiOk, fully_checked: fullyChecked }
    }

    function getFingerprint(proxy) {
        const entries = Object.entries(proxy)
            .filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
            .sort(([a], [b]) => a.localeCompare(b))
        return JSON.stringify(Object.fromEntries(entries))
    }

    async function http(opt = {}) {
        return await $.http.get({ ...opt, timeout: parseFloat(opt.timeout || 5000) })
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