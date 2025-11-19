/**
 * GPT & Gemini 双重检测 (v6.0 宽松判定 + 缓存防超时版)
 * 
 * 核心改进:
 * 1. 宽松判定 (无罪推定): 
 *    - GPT: 只要返回了 200/302/429，或者 403 但不包含"Region/VPN"字样，统统判定为通过。
 *    - 解决 Cloudflare 盾导致被误判为不可用的问题。
 * 2. 保持缓存机制: 解决 Surge 更新超时。
 * 3. 保持 Gemini 检测。
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  
  // --- 参数配置 ---
  const useCache = $arguments.cache !== 'false' 
  const cache = scriptResourceCache
  const concurrency = parseInt($arguments.concurrency || 10)
  // 默认超时 3500ms，给稍微慢点的节点一点机会
  const timeout = parseInt($arguments.timeout || 3500) 
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  // 使用 chatgpt.com，兼容性更好
  const gptUrl = `https://chatgpt.com`
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=AIzaSyD-InvalidKeyForDetection`

  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  return proxies

  async function check(proxy) {
    // 生成缓存 Key
    const fingerprint = JSON.stringify(
        Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
        )
    )
    // 升级 key 版本号，强制刷新旧缓存
    const cacheKey = `ai_check_v6_loose:${fingerprint}`

    try {
      let result = undefined
      
      // 1. 读取缓存
      if (useCache) {
          const cachedData = cache.get(cacheKey)
          if (cachedData) result = cachedData
      }

      // 2. 网络检测
      if (!result) {
          const node = ProxyUtils.produce([proxy], target)
          if (node) {
              result = await performNetworkCheck(node, timeout)
              // 写入缓存
              if (useCache) cache.set(cacheKey, result)
          }
      }

      // 3. 应用前缀
      if (result) {
          let prefix = ""
          // 只有当结果为 true 时才加前缀
          if (result.gemini) {
              prefix += geminiPrefix
              proxy._gemini = true
          }
          if (result.gpt) {
              prefix += gptPrefix
              proxy._gpt = true
          }
          
          // 只有当前缀确实不存在时才添加，避免重复 (针对部分特殊场景)
          if (prefix && !proxy.name.startsWith(prefix.trim())) {
               proxy.name = prefix + proxy.name
          }
      }

    } catch (e) {
      // 忽略错误，保持原样
    }
  }

  async function performNetworkCheck(node, timeout) {
      let isGptOk = false
      let isGeminiOk = false
      
      // --- GPT 宽松检测 ---
      const checkGPT = async () => {
        try {
            const res = await http({
                method: 'get',
                url: gptUrl,
                headers: { 
                    // 模拟桌面 Chrome，减少 CF 拦截概率
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
                },
                node, timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 0)
            const body = res.body ?? res.rawBody ?? ""
            
            // === 宽松判定逻辑 ===
            // 200: 成功加载页面
            // 302: 跳转 (通常也是通的)
            // 429: 请求过快 (说明通了)
            if ([200, 302, 429].includes(status)) {
                isGptOk = true
            } 
            // 403: 需要判断是否是地区封锁
            else if (status === 403) {
                // 如果包含 unsupported_country 或 VPN 字样，才是真的不行
                if (/unsupported_country|VPN|location/i.test(body)) {
                    isGptOk = false
                } else {
                    // 排除掉地区封锁，剩下的 403 通常是 CF 验证盾，
                    // 对于脚本来说是 403，但对于浏览器用户来说是能打开的。
                    // 所以这里“大胆”判为 true
                    isGptOk = true
                }
            }
        } catch (e) {
            // 只有连接超时或 DNS 错误才算 false
        }
      }

      // --- Gemini 检测 (保持严谨) ---
      // Gemini 只有 400 是稳的，Google 封锁很直接
      const checkGemini = async () => {
        try {
            const res = await http({
                method: 'get',
                url: geminiUrl,
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
                node, timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 0)
            if (status === 400) isGeminiOk = true
        } catch (e) {}
      }

      await Promise.all([checkGPT(), checkGemini()])
      return { gpt: isGptOk, gemini: isGeminiOk }
  }

  async function http(opt = {}) {
    const TIMEOUT = parseFloat(opt.timeout || 3500)
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
