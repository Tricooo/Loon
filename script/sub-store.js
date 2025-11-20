/**
 * GPT & Gemini 双重检测 (v12.0 终极融合版)
 *
 * 融合策略:
 * 1. 核心检测逻辑: 沿用 v10 (主页检测 + API检测)。拒绝 v11 的 favicon 方案，因为 CDN 缓存会导致假阳性。
 * 2. 代码健壮性: 吸收 v11 的 "指纹排序" 和 "正则名称清洗"，防止前缀堆叠。
 * 3. 判定精度: 结合 v10 的宽松策略与 v11 的关键词库。
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

    // [策略选择] 坚持使用真实业务 URL，确保检测结果与实际使用一致
    const gptUrl = `https://chatgpt.com`
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=InvalidKey`

    // 模拟 macOS Chrome 120
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    const cache = scriptResourceCache
    const useCache = $arguments.cache !== 'false'
    const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

    const startTime = Date.now()
    const deadline = startTime + GLOBAL_TIMEOUT // 引入 v11 的 deadline 概念

    const tasks = []

    // --- 1. 读缓存 ---
    for (const proxy of proxies) {
        // [优化] 使用 v11 的排序指纹，缓存命中率更高
        const fingerprint = getFingerprint(proxy)
        // 升级 Key 到 v12
        const cacheKey = `ai_check_v12:${fingerprint}`

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
                // 超时检查放进任务内部
                if (Date.now() > deadline) return

                const node = ProxyUtils.produce([task.proxy], target)
                if (node) {
                    const res = await performNetworkCheck(node, requestTimeout)

                    // [核心] 双重响应才缓存 (v9/v10 逻辑)
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

        // [优化] 引入 v11 的正则清洗逻辑，完美解决前缀重复问题
        if (prefix) {
            // 转义正则特殊字符
            const escaped = [gptPrefix, geminiPrefix]
                .filter(Boolean)
                .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

            // 移除旧前缀 (支持任意顺序的堆叠)
            const cleanName = escaped.length
                ? proxy.name.replace(new RegExp(`^(?:${escaped.join('|')}|\\s)+`, 'g'), '')
                : proxy.name

            proxy.name = prefix + cleanName
        }
    }

    async function performNetworkCheck(node, timeout) {
        let isGptOk = false
        let isGeminiOk = false
        let gptStatus = 0
        let geminiStatus = 0

        // [优化] 引入 v11 的关键词库，增强 v10 的判断准确性
        const gptBlockPatterns = /(unsupported_country|region not supported|country|access denied|vpn|proxy)/i

        // GPT 检测
        const checkGPT = async () => {
            try {
                const res = await http({
                    method: 'get', url: gptUrl,
                    headers: {
                        'User-Agent': UA,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9' // 加上语言头更像真人
                    },
                    node, timeout
                })
                gptStatus = parseInt(res.status ?? res.statusCode ?? 0)
                const body = (res.body ?? res.rawBody ?? "") + ""

                // v10 的宽松判定 + v11 的正则排除
                if ([200, 302, 429].includes(gptStatus)) {
                    isGptOk = true
                } else if (gptStatus === 403) {
                    // 只有当 Body 明确包含封锁关键词时，才判定为 False
                    // 否则视作 Cloudflare 盾（浏览器能过），判定为 True
                    if (!gptBlockPatterns.test(body)) {
                        isGptOk = true
                    }
                }
            } catch (e) {
                gptStatus = 0
            }
        }

        // Gemini 检测 (坚持使用 v10 的 API 检测，最准确)
        const checkGemini = async () => {
            try {
                const res = await http({
                    method: 'get', url: geminiUrl,
                    headers: { 'User-Agent': UA },
                    node, timeout
                })
                geminiStatus = parseInt(res.status ?? res.statusCode ?? 0)
                // 400 Bad Request 代表连通了 Google API 但 Key 不对 -> 解锁
                if (geminiStatus === 400) isGeminiOk = true
            } catch (e) {
                geminiStatus = 0
            }
        }

        await Promise.all([checkGPT(), checkGemini()])

        const fullyChecked = (gptStatus > 0) && (geminiStatus > 0)

        return { gpt: isGptOk, gemini: isGeminiOk, fully_checked: fullyChecked }
    }

    // [优化] 使用 v11 的排序指纹，提高缓存健壮性
    function getFingerprint(proxy) {
        const entries = Object.entries(proxy)
            .filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
            .sort(([a], [b]) => a.localeCompare(b))
        return JSON.stringify(Object.fromEntries(entries))
    }

    async function http(opt = {}) {
        return await $.http.get({ ...opt, timeout: parseFloat(opt.timeout || 5000) })
    }

    // [优化] 结合 v11 的调度器逻辑，更加严谨
    function executeAsyncTasks(tasks, { concurrency = 1, deadline } = {}) {
        return new Promise(resolve => {
            let running = 0
            let index = 0

            function executeNextTask() {
                // 检查截止时间
                if (deadline && Date.now() > deadline) {
                    // 如果正在运行的任务都结束了，就退出
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