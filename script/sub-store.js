/**
 * GPT + Gemini 检测(适配 Surge/Loon 版)
 *
 * GPT 检测逻辑保持原样:
 *  - 访问 https://android.chat.openai.com 或 https://ios.chat.openai.com
 *  - status = 403 且返回内容中不包含 unsupported_country 即判定为已解锁
 *
 * Gemini / Google AI Studio 检测逻辑:
 *  - 默认访问 https://aistudio.google.com
 *  - 只要返回 2xx / 3xx 就认为网络层可用(未被地区/风控封死)
 *  - 403 / 5xx / 网络错误 视为不可用
 *
 * 额外字段:
 *  - _gpt / _gpt_latency
 *  - _gemini / _gemini_latency
 *
 * 新增参数:
 *  - [gemini_prefix]   Gemini 检测成功时的前缀, 默认为 "[Gemini] "
 *  - [gemini_url]      Gemini/AI Studio 检测用的 URL, 默认为 "https://aistudio.google.com"
 *  - [enable_gemini]   是否启用 Gemini 检测, 默认 true
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  if (!isLoon && !isSurge) throw new Error('仅支持 Loon 和 Surge(ability=http-client-policy)')

  const cacheEnabled = $arguments.cache
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const cache = scriptResourceCache

  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '

  const method = $arguments.method || 'get'
  const url =
    $arguments.client === 'MacOS' ? `https://chat.openai.com` : `https://ios.chat.openai.com`

  // Gemini / Google AI Studio 检测默认地址
  const geminiUrl = $arguments.gemini_url || 'https://aistudio.google.com'
  const enableGemini = $arguments.enable_gemini ?? true

  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
  const concurrency = parseInt($arguments.concurrency || 10) // 一组并发数

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  return proxies

  async function check(proxy) {
    // 先根据平台生成对应的策略节点
    const node = ProxyUtils.produce([proxy], target)
    if (!node) return

    // ========== GPT 检测 ==========

    const gptCacheId = cacheEnabled
      ? `gpt:${url}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined

    try {
      if (cacheEnabled && gptCacheId) {
        const cached = cache.get(gptCacheId)
        if (cached) {
          if (cached.gpt) {
            proxy.name = `${gptPrefix}${proxy.name}`
            proxy._gpt = true
            proxy._gpt_latency = cached.gpt_latency
            $.info(`[${proxy.name}] 使用 GPT 成功缓存`)
          } else if (disableFailedCache) {
            $.info(`[${proxy.name}] 不使用 GPT 失败缓存`)
          } else {
            $.info(`[${proxy.name}] 使用 GPT 失败缓存`)
            // 直接认为 GPT 不可用，不再发请求
            return
          }
        }
      }

      const startedAt = Date.now()
      const res = await http({
        method,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url,
        'policy-descriptor': node,
        node,
      })

      const status = parseInt(res.status ?? res.statusCode ?? 200)
      let body = String(res.body ?? res.rawBody ?? '')
      try {
        body = JSON.parse(body)
      } catch (e) {}
      const msg = body?.error?.code || body?.error?.error_type || body?.cf_details
      const latency = Date.now() - startedAt
      $.info(`[${proxy.name}] GPT status: ${status}, msg: ${msg}, latency: ${latency}`)

      // cf 拦截是 400 错误, 403 就是没被拦截, 走到了未鉴权的逻辑
      if (status == 403 && !/unsupported_country/.test(msg)) {
        proxy.name = `${gptPrefix}${proxy.name}`
        proxy._gpt = true
        proxy._gpt_latency = latency
        if (cacheEnabled && gptCacheId) {
          $.info(`[${proxy.name}] 设置 GPT 成功缓存`)
          cache.set(gptCacheId, { gpt: true, gpt_latency: latency })
        }
      } else {
        if (cacheEnabled && gptCacheId) {
          $.info(`[${proxy.name}] 设置 GPT 失败缓存`)
          cache.set(gptCacheId, {})
        }
      }
    } catch (e) {
      $.error(`[${proxy.name}] GPT 检测失败: ${e.message ?? e}`)
      if (cacheEnabled && gptCacheId) {
        $.info(`[${proxy.name}] 设置 GPT 失败缓存`)
        cache.set(gptCacheId, {})
      }
    }

    // ========== Gemini / Google AI Studio 检测 ==========

    if (!enableGemini) return

    const geminiCacheId = cacheEnabled
      ? `gemini:${geminiUrl}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined

    try {
      if (cacheEnabled && geminiCacheId) {
        const cached = cache.get(geminiCacheId)
        if (cached) {
          if (cached.gemini) {
            proxy.name = `${geminiPrefix}${proxy.name}`
            proxy._gemini = true
            proxy._gemini_latency = cached.gemini_latency
            $.info(`[${proxy.name}] 使用 Gemini 成功缓存`)
            return
          } else if (disableFailedCache) {
            $.info(`[${proxy.name}] 不使用 Gemini 失败缓存`)
          } else {
            $.info(`[${proxy.name}] 使用 Gemini 失败缓存`)
            return
          }
        }
      }

      const startedAtGemini = Date.now()
      const resGemini = await http({
        method,
        headers: {
          // 模拟桌面浏览器访问 AI Studio / Gemini
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        },
        url: geminiUrl,
        'policy-descriptor': node,
        node,
      })

      const statusGemini = parseInt(resGemini.status ?? resGemini.statusCode ?? 200)
      const latencyGemini = Date.now() - startedAtGemini
      $.info(`[${proxy.name}] Gemini status: ${statusGemini}, latency: ${latencyGemini}`)

      // 与 GPT 不同: 这里 2xx / 3xx 认为可用, 403/5xx 认为不可用/地区限制/服务异常
      if (statusGemini >= 200 && statusGemini < 400) {
        proxy.name = `${geminiPrefix}${proxy.name}`
        proxy._gemini = true
        proxy._gemini_latency = latencyGemini
        if (cacheEnabled && geminiCacheId) {
          $.info(`[${proxy.name}] 设置 Gemini 成功缓存`)
          cache.set(geminiCacheId, { gemini: true, gemini_latency: latencyGemini })
        }
      } else {
        if (cacheEnabled && geminiCacheId) {
          $.info(`[${proxy.name}] 设置 Gemini 失败缓存`)
          cache.set(geminiCacheId, {})
        }
      }
    } catch (e) {
      $.error(`[${proxy.name}] Gemini 检测失败: ${e.message ?? e}`)
      if (cacheEnabled && geminiCacheId) {
        $.info(`[${proxy.name}] 设置 Gemini 失败缓存`)
        cache.set(geminiCacheId, {})
      }
    }
  }

  // 请求封装(保持原逻辑)
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

  // 并发执行工具(保持原逻辑)
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
                if (result) {
                  results[taskIndex] = wrap ? { data } : data
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error
                }
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
 
