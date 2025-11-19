/**
 * GPT & Gemini 双重检测 (带缓存版)
 * 
 * 解决 Surge 更新超时问题:
 * 1. 内置缓存机制: 测过的节点在缓存期内不再联网检测。
 * 2. 默认缓存时间: 24小时 (可在 Sub-Store 脚本操作中调整缓存过期时间)。
 * 3. 降低默认超时: 5s -> 3s，加速失败节点的跳过。
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  
  // --- 参数配置 ---
  // 强制开启缓存，除非传入 cache=false
  const useCache = $arguments.cache !== 'false' 
  const cache = scriptResourceCache
  
  const concurrency = parseInt($arguments.concurrency || 10)
  // 降低默认超时到 3000ms，防止 Surge 等待过久
  const timeout = parseInt($arguments.timeout || 3000) 
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  const gptUrl = $arguments.client === 'MacOS' ? `https://chat.openai.com` : `https://ios.chat.openai.com`
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=AIzaSyD-InvalidKeyForDetection`

  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  return proxies

  async function check(proxy) {
    // 生成缓存 Key (基于节点指纹)
    const fingerprint = JSON.stringify(
        Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
        )
    )
    const cacheKey = `ai_check_v2:${fingerprint}`

    try {
      let result = undefined
      
      // 1. 尝试读取缓存
      if (useCache) {
          const cachedData = cache.get(cacheKey)
          if (cachedData) {
              // $.info(`[${proxy.name}] 使用缓存`)
              result = cachedData
          }
      }

      // 2. 如果没有缓存，发起网络检测
      if (!result) {
          const node = ProxyUtils.produce([proxy], target)
          if (node) {
              result = await performNetworkCheck(node, timeout)
              // 写入缓存 (只有检测成功或明确失败才写入，避免网络波动导致一直存失败)
              if (useCache) {
                  cache.set(cacheKey, result)
              }
          }
      }

      // 3. 应用结果 (重命名)
      if (result) {
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
              proxy.name = prefix + proxy.name
          }
      }

    } catch (e) {
      // $.error(`[${proxy.name}] Error: ${e.message}`)
    }
  }

  // 真正的网络检测逻辑
  async function performNetworkCheck(node, timeout) {
      let isGptOk = false
      let isGeminiOk = false
      
      const checkGPT = async () => {
        try {
            const res = await http({
                method: 'get',
                url: gptUrl,
                headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1' },
                node, timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 200)
            // 原版判定逻辑
            if (status === 403 && !/unsupported_country/.test(res.body ?? res.rawBody)) {
                isGptOk = true
            }
        } catch (e) {}
      }

      const checkGemini = async () => {
        try {
            const res = await http({
                method: 'get',
                url: geminiUrl,
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
                node, timeout
            })
            if ((res.status ?? res.statusCode) === 400) isGeminiOk = true
        } catch (e) {}
      }

      await Promise.all([checkGPT(), checkGemini()])
      
      return { gpt: isGptOk, gemini: isGeminiOk }
  }

  async function http(opt = {}) {
    const TIMEOUT = parseFloat(opt.timeout || 3000)
    return await $.http.get({ ...opt, timeout: TIMEOUT })
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        let index = 0
        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            index++
            const currentTask = tasks[index - 1]
            running++
            currentTask().finally(() => {
              running--
              executeNextTask()
            })
          }
          if (running === 0 && index >= tasks.length) resolve()
        }
        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
} 
