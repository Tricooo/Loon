/**
 * GPT & Gemini 双重检测 (v13.0 地区熔断版)
 *
 * 核心升级:
 * 1. [地区熔断] 针对 Google Gemini 严格的地区限制，脚本会先检查节点名称。
 *    如果节点名包含 "香港/HK/HongKong" 等关键词，直接判定 Gemini 为不可用，不再发起网络请求。
 *    这解决了香港节点常出现的 ERR_CONNECTION_CLOSED 导致的超时和卡顿问题。
 * 2. [保留精华] 继承 v12 的所有优点：URL 统一、伪装升级、正则清洗、双重响应缓存。
 */

async function operator(proxies = [], targetPlatform, context) {
    const $ = $substore
    const { isLoon, isSurge } = $.env

    // --- 用户参数 ---
    const concurrency = parseInt($arguments.concurrency || 10)
    const requestTimeout = parseInt($arguments.timeout || 5000)
    const GLOBAL_TIMEOUT = 28000

    const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
    const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '

    const gptUrl = `https://chatgpt.com`
    // Gemini API (仅对非 HK 节点发起)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=InvalidKey`

    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    const cache = scriptResourceCache
    const useCache = $arguments.cache !== 'false'
    const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

    const startTime = Date.now()
    const deadline = startTime + GLOBAL_TIMEOUT

    const tasks = []

    // --- 1. 读缓存 ---
    for (const proxy of proxies) {
        const fingerprint = getFingerprint(proxy)
        // 升级 Key 到 v13 (逻辑变更，需刷新缓存)
        const cacheKey = `ai_check_v13:${fingerprint}`

        let result = undefined
        if (useCache) {
            result = cache.get(cacheKey)
        }

        if (result) {
            applyPrefix(proxy, result)
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
                    // 传入 proxy 对象以便读取名称进行预判
                    const res = await performNetworkCheck(task.proxy, node, requestTimeout)

                    if (useCache && res.fully_checked) {
                        cache.set(task.cacheKey, res)
                    }

                    applyPrefix(task.proxy, res)
                }
            }),
            { concurrency, deadline }
        )
    }

    return proxies

    // --- 辅助函数 ---

    function applyPrefix(proxy, result) {
        if (!result) return
        let prefix = ""
        if (result.gemini) {
            prefix += geminiPrefix
            proxy._gemini = true
        }
        if (result.gpt) {
            prefix += gptPrefix
            proxy._gpt = true
        }

        if (prefix) {
            const escaped = [gptPrefix, geminiPrefix]
                .filter(Boolean)
                .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

            // 正则清洗旧前缀
            const cleanName = escaped.length
                ? proxy.name.replace(new RegExp(`^(?:${escaped.join('|')}|\\s)+`, 'g'), '')
                : proxy.name

            proxy.name = prefix + cleanName
        }
    }

    // 这里增加了 proxy 参数，用于检查名字
    async function performNetworkCheck(originalProxy, node, timeout) {
        let isGptOk = false
        let isGeminiOk = false
        let gptStatus = 0
        let geminiStatus = 0

        // --- 1. Gemini 地区熔断检测 ---
        // 匹配常见的香港/中国关键词。如果命中，直接判死刑，状态码设为 403 (代表已检测但被拒)
        // 这样 count as "fully_checked"，可以被缓存，且不会发起网络请求
        const hkRegex = /(?:HongKong|Hong Kong|HK|🇭🇰|香\s*港|港|港中转)/i;
        const isRegionBlocked = hkRegex.test(originalProxy.name);

        // --- 2. 定义检测任务 ---

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

                // 宽松判定
                if ([200, 302, 429].includes(gptStatus)) {
                    isGptOk = true
                } else if (gptStatus === 403) {
                    // 排除明确的封锁，其余 403 视为 CF 盾 (Pass)
                    if (!/(unsupported_country|region not supported|country|access denied|vpn|proxy)/i.test(body)) {
                        isGptOk = true
                    }
                }
            } catch (e) {
                gptStatus = 0
            }
        }

        const checkGemini = async () => {
            // 如果地区预判已经由于，直接返回
            if (isRegionBlocked) {
                geminiStatus = 403; // 模拟一个 403 状态码，表示明确拒绝
                isGeminiOk = false;
                return;
            }

            try {
                const res = await http({
                    method: 'get', url: geminiUrl,
                    headers: { 'User-Agent': UA },
                    node, timeout
                })
                geminiStatus = parseInt(res.status ?? res.statusCode ?? 0)
                if (geminiStatus === 400) isGeminiOk = true
            } catch (e) {
                geminiStatus = 0
            }
        }

        // --- 3. 并行执行 ---
        await Promise.all([checkGPT(), checkGemini()])

        // 只要状态码 > 0 (包括我们伪造的 HK 403)，就算检测完成
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
                if (deadline && Date.now() > deadline) {
                    return running === 0 ? resolve() : null
                }

                while (index < tasks.length && running < concurrency) {
                    const currentTask = tasks[index++]
                    running++
                    Promise.resolve()
                        .then(currentTask)
                        .catch(() => {})
                        .finally(() => {
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