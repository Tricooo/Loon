/**
 * Sub-Store 脚本: GPT / OpenAI 可用性检测（两阶段、两次尝试后放弃、可锁定仅用缓存）
 *
 * 目标改进：
 * 1) 更贴近“AI 服务可用性”：优先探测 OpenAI API（无效 Key -> 401），失败再回退探测 chatgpt.com。
 * 2) 每个节点最多尝试 maxTries 次（默认 2）。两次仍失败则标记为放弃，后续不再重测。
 * 3) 同一批节点列表最多执行 maxRuns 次检测（默认 2）。达到次数后锁定：后续仅使用缓存中 ok=true 的节点，避免 Surge 更新外部订阅超时。
 *
 * 参数：
 * - concurrency: 并发数，默认 10
 * - timeout: 单次请求超时(ms)，默认 5000
 * - rename: 'true' | 'false'（通过的节点加前缀）
 * - prefix: 前缀字符串，默认 '[GPT] '
 * - cache: 'false' 时不读写缓存（默认启用缓存）
 * - maxTries / max_tries: 单节点最大检测次数，默认 2
 * - maxRuns  / max_runs : 同一批节点列表最大检测轮次，默认 2（达到后锁定仅用缓存）
 * - force: 'true' | '1' 时忽略锁定与放弃标记，强制重新检测（需要 cache 不是 false）
 */

async function operator(proxies = [], targetPlatform, context) {
    const $ = $substore
    const { isLoon, isSurge } = $.env

    const concurrency = parseInt($arguments.concurrency || 10)
    const requestTimeout = parseInt($arguments.timeout || 5000)
    const enableRename = ($arguments.rename === 'true')

    const GLOBAL_TIMEOUT = 28000
    const prefixStr = $arguments.prefix ?? '[GPT] '
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15...ebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    const useCache = $arguments.cache !== 'false'
    const force = ($arguments.force === 'true' || $arguments.force === '1') && useCache

    const maxTries = parseInt($arguments.maxTries ?? $arguments.max_tries ?? 2)
    const maxRuns = parseInt($arguments.maxRuns ?? $arguments.max_runs ?? 2)

    const cache = scriptResourceCache
    const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

    const startTime = Date.now()
    const deadline = startTime + GLOBAL_TIMEOUT
    const tasks = []

    // --- 0) 计算批次 key（用于“最多检测两轮后锁定仅用缓存”） ---
    const batchKey = getBatchKey(proxies)
    let batchMeta = (useCache ? cache.get(batchKey) : undefined) || { runs: 0, locked: false }

    const shouldLock = useCache && !force && maxRuns > 0 && (batchMeta.locked === true || batchMeta.runs >= maxRuns)

    // 如果已锁定：仅用缓存中 ok=true 的节点，完全跳过检测
    if (shouldLock) {
        for (const proxy of proxies) {
            const cacheKey = getProxyCacheKey(proxy)
            const cachedRes = cache.get(cacheKey)
            if (cachedRes && cachedRes.ok === true) {
                proxy._isOk = true
                if (enableRename) addPrefix(proxy)
            } else {
                proxy._isOk = false
            }
        }
        return proxies.filter(p => p._isOk === true)
    }

    // --- 1) 读缓存 + 组装检测任务 ---
    for (const proxy of proxies) {
        const cacheKey = getProxyCacheKey(proxy)
        proxy._cacheKey = cacheKey

        let cachedRes = undefined
        if (useCache) cachedRes = cache.get(cacheKey)

        // 只信任成功；失败最多重试 maxTries 次
        if (cachedRes && cachedRes.ok === true) {
            proxy._isOk = true
            if (enableRename) addPrefix(proxy)
            continue
        }

        const tries = (cachedRes && typeof cachedRes.tries === 'number') ? cachedRes.tries : 0
        if (!force && maxTries > 0 && tries >= maxTries) {
            // 两次仍失败：放弃，后续不再重测
            proxy._isOk = false
            continue
        }

        tasks.push({ proxy, cacheKey, tries })
    }

    // --- 2) 执行检测 ---
    let attemptedCount = 0
    if (tasks.length > 0) {
        await executeAsyncTasks(
            tasks.map(task => async () => {
                if (Date.now() > deadline) return

                const node = ProxyUtils.produce([task.proxy], target)
                if (!node) return

                attemptedCount++
                const isOk = await checkGPT(node, requestTimeout)

                // 写缓存：成功写 ok=true；失败写 tries+1（用于“第二次失败后放弃”）
                if (useCache) {
                    const nextTries = (task.tries || 0) + 1
                    if (isOk) {
                        cache.set(task.cacheKey, { ok: true, tries: nextTries, ts: Date.now() })
                    } else {
                        cache.set(task.cacheKey, { ok: false, tries: nextTries, ts: Date.now() })
                    }
                }

                task.proxy._isOk = isOk
                if (enableRename && isOk) addPrefix(task.proxy)
            }),
            { concurrency, deadline }
        )
    }

    // --- 3) 更新批次轮次：达到 maxRuns 后锁定，仅用缓存 ---
    if (useCache && !force && maxRuns > 0 && attemptedCount > 0) {
        const nextRuns = (typeof batchMeta.runs === 'number' ? batchMeta.runs : 0) + 1
        batchMeta = { runs: nextRuns, locked: nextRuns >= maxRuns, ts: Date.now() }
        cache.set(batchKey, batchMeta)
    }

    return proxies.filter(p => p._isOk === true)

    // --- 辅助函数 ---

    function addPrefix(proxy) {
        if (!proxy.name.includes(prefixStr)) {
            proxy.name = prefixStr + proxy.name
        }
    }

    function getProxyCacheKey(proxy) {
        const fingerprint = getFingerprint(proxy)
        // 升级版本号以隔离旧缓存
        return `gpt_check_standalone_v3:${fingerprint}`
    }

    function getBatchKey(proxies) {
        // 用每个节点 fingerprint 的排序结果做稳定 hash，避免顺序变化导致重复检测
        const fps = proxies.map(p => getFingerprint(p)).sort()
        const h = hashStrings(fps)
        return `gpt_check_batch_v1:${h}`
    }

    function hashStrings(list) {
        // DJB2 变体（32-bit）
        let h = 5381
        for (const s of list) {
            for (let i = 0; i < s.length; i++) {
                h = ((h << 5) + h) ^ s.charCodeAt(i)
                h = h >>> 0
            }
        }
        return (h >>> 0).toString(16)
    }

    async function checkGPT(node, timeout) {
        // 优先探测 OpenAI API（更贴近真实“AI 可用性”）
        const apiOk = await checkOpenAIAPI(node, timeout)
        if (apiOk) return true

        // 回退探测 chatgpt.com（适用于仅使用 Web 的场景）
        const webOk = await checkChatGPTWeb(node, timeout)
        return webOk
    }

    async function checkOpenAIAPI(node, timeout) {
        try {
            const res = await $.http.get({
                url: 'https://api.openai.com/v1/models',
                headers: {
                    'User-Agent': UA,
                    'Accept': 'application/json',
                    'Authorization': 'Bearer sk-INVALID',
                },
                node, timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 0)
            const body = (res.body ?? res.rawBody ?? "") + ""

            // 401（无效 Key）通常意味着：已到达 OpenAI API 且未被网络/地域/WAF 阻断
            if (status === 401) {
                if (looksLikeJson(body)) return true
                return true
            }

            // 403/429 往往代表风控/策略限制/限流，按不可用处理以减少假阳性
            if (status === 403) return false
            if (status === 429) return false

            return false
        } catch (e) {
            return false
        }
    }

    async function checkChatGPTWeb(node, timeout) {
        try {
            const res = await $.http.get({
                url: 'https://chatgpt.com',
                headers: {
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                node, timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 0)
            if (status === 200 || status === 302) return true

            // 403/429 直接按不可用处理，避免“可打开但实际被风控”的假阳性
            return false
        } catch (e) {
            return false
        }
    }

    function looksLikeJson(str) {
        try { JSON.parse(str); return true } catch (e) { return false }
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
                    Promise.resolve().then(currentTask).catch(() => { }).finally(() => {
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
