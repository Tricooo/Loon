/**
 * GPT & Gemini 双重检测 (适配 Surge/Loon 版)
 *
 * 适配 Sub-Store Node.js 版 请查看: https://t.me/zhetengsha/1209
 *
 * 原作: @underHZLY
 * 修改: 增加 Gemini/Google AI Studio 检测逻辑
 *
 * 参数
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [retries] 重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 并发数 默认 10
 * - [gpt_prefix] GPT 显示前缀. 默认为 "[GPT] "
 * - [gemini_prefix] Gemini 显示前缀. 默认为 "[Gemini] "
 * - [check_gpt] 是否检测 GPT, 默认 true
 * - [check_gemini] 是否检测 Gemini, 默认 true
 * 
 * 注: 
 * 节点上会添加 _gpt 和 _gemini 字段 (true/false)
 * 新增 _gpt_latency 和 _gemini_latency 字段
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  if (!isLoon && !isSurge) throw new Error('仅支持 Loon 和 Surge(ability=http-client-policy)')
  
  // 参数获取
  const cacheEnabled = $arguments.cache
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const cache = scriptResourceCache
  
  // 前缀定义
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  // 开关定义 (默认都开启)
  const enableGptCheck = $arguments.check_gpt !== 'false'
  const enableGeminiCheck = $arguments.check_gemini !== 'false'

  const method = $arguments.method || 'get'
  const concurrency = parseInt($arguments.concurrency || 10)

  // GPT URL
  const gptUrl = $arguments.client === 'MacOS' ? `https://chat.openai.com` : `https://ios.chat.openai.com`
  // Gemini URL (使用 API 端点检测，更准确且轻量)
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=AIzaSyD-InvalidKeyForDetection`

  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  return proxies

  async function check(proxy) {
    // 生成缓存 ID (基于节点配置生成指纹)
    const id = cacheEnabled
      ? `ai_check:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined

    try {
      const node = ProxyUtils.produce([proxy], target)
      if (node) {
        // --- 1. 读取缓存 ---
        let cached = cacheEnabled ? cache.get(id) : undefined
        let gptResult = null
        let geminiResult = null

        // 如果有缓存且不强制禁用失败缓存，尝试读取
        if (cached) {
            // 如果缓存是有效的（之前测过且成功，或者允许失败缓存）
            // 这里简单处理：如果存在缓存对象，我们就用它。
            // 但为了更精确，如果用户要求 "禁用失败缓存"，我们需要看具体的字段
            
            // 简单的逻辑：只要缓存里有字段，就认为是上次的结果
            gptResult = cached.gpt_result
            geminiResult = cached.gemini_result
            
            if (disableFailedCache) {
                // 如果禁用了失败缓存，且上次是失败的，则强制重测
                if (gptResult && !gptResult.ok) gptResult = null
                if (geminiResult && !geminiResult.ok) geminiResult = null
            }
        }

        // --- 2. 执行检测 (并行) ---
        const tasks = []
        
        // GPT Check Task
        if (enableGptCheck && !gptResult) {
            tasks.push(http({
                method,
                url: gptUrl,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
                },
                'policy-descriptor': node,
                node
            }).then(res => {
                const status = parseInt(res.status ?? res.statusCode ?? 200)
                let body = String(res.body ?? res.rawBody)
                try { body = JSON.parse(body) } catch (e) {}
                const msg = body?.error?.code || body?.error?.error_type || body?.cf_details
                // 判定逻辑: 403 且非不支持地区
                const ok = status === 403 && !/unsupported_country/.test(msg)
                return { ok, latency: 0, msg: `s:${status} m:${msg}` } // latency 在外层计算
            }).catch(e => ({ ok: false, msg: e.message })))
        } else {
            tasks.push(Promise.resolve(gptResult))
        }

        // Gemini Check Task
        if (enableGeminiCheck && !geminiResult) {
            tasks.push(http({
                method: 'GET', // Gemini API 用 GET 测试
                url: geminiUrl,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
                'policy-descriptor': node,
                node
            }).then(res => {
                const status = parseInt(res.status ?? res.statusCode ?? 200)
                // 判定逻辑: 
                // 400: 请求成功到达 Google API，但 Key 无效 -> 说明地区支持 (可用)
                // 403: User location is not supported -> 地区不支持 (不可用)
                // 200: 理论上不可能，因为 key 是假的
                const ok = status === 400
                return { ok, latency: 0, msg: `s:${status}` }
            }).catch(e => ({ ok: false, msg: e.message })))
        } else {
            tasks.push(Promise.resolve(geminiResult))
        }

        const startTime = Date.now()
        const results = await Promise.all(tasks)
        const endTime = Date.now()
        const requestDuration = endTime - startTime

        // 提取结果 (任务顺序: 0是GPT, 1是Gemini)
        const newGptResult = results[0]
        const newGeminiResult = results[1]

        // 如果是新请求，补全 Latency (近似值，因为是并行，取最大耗时作为参考，或者直接用本次请求耗时)
        if (newGptResult && !newGptResult.latency) newGptResult.latency = requestDuration
        if (newGeminiResult && !newGeminiResult.latency) newGeminiResult.latency = requestDuration

        // --- 3. 处理结果与重命名 ---
        let finalName = proxy.name
        let isGptOk = false
        let isGeminiOk = false

        // 处理 GPT
        if (enableGptCheck && newGptResult) {
            if (newGptResult.ok) {
                isGptOk = true
                proxy._gpt = true
                proxy._gpt_latency = newGptResult.latency
                finalName = `${gptPrefix}${finalName}`
                // $.info(`[${proxy.name}] GPT OK (${newGptResult.latency}ms)`)
            } else {
                // $.info(`[${proxy.name}] GPT FAIL: ${newGptResult.msg}`)
            }
        }

        // 处理 Gemini
        if (enableGeminiCheck && newGeminiResult) {
            if (newGeminiResult.ok) {
                isGeminiOk = true
                proxy._gemini = true
                proxy._gemini_latency = newGeminiResult.latency
                finalName = `${geminiPrefix}${finalName}`
                // $.info(`[${proxy.name}] Gemini OK (${newGeminiResult.latency}ms)`)
            } else {
                // $.info(`[${proxy.name}] Gemini FAIL: ${newGeminiResult.msg}`)
            }
        }

        proxy.name = finalName

        // --- 4. 写入缓存 ---
        if (cacheEnabled) {
            // 只有当至少有一个结果是新获取的时，或者需要更新状态时写入
            const cacheData = {
                gpt_result: newGptResult,
                gemini_result: newGeminiResult
            }
            // 如果两个都检测了，且其中一个成功，就值得缓存。
            // 或者根据 disableFailedCache 逻辑
            cache.set(id, cacheData)
            if (isGptOk || isGeminiOk) {
                 $.info(`[${proxy.name}] 设置成功缓存 G:${isGptOk} B:${isGeminiOk}`)
            }
        }

      }
    } catch (e) {
      $.error(`[${proxy.name}] Error: ${e.message ?? e}`)
    }
  }

  // 通用 HTTP 请求函数
  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          await $.wait(delay)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        const results = []
        let index = 0
        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++
            currentTask()
              .then(data => {
                if (result) results[taskIndex] = wrap ? { data } : data
              })
              .catch(error => {
                if (result) results[taskIndex] = wrap ? { error } : error
              })
              .finally(() => {
                running--
                executeNextTask()
              })
          }
          if (running === 0) {
            return resolve(result ? results : undefined)
          }
        }
        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
