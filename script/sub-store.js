/**
 * GPT & Gemini 双重检测 (v9.0 完美主义版)
 * 
 * 核心改进: 
 * 解决 "部分超时导致误判" 的问题。
 * 逻辑：只有当 GPT 和 Gemini **都** 返回了明确状态码时，才写入缓存。
 * 
 * 场景推演：
 * 1. Gemini 秒通，GPT 超时 -> 界面显示 [Gemini]，但**不存缓存**。
 * 2. 下次刷新 -> 因为无缓存，脚本会**重测**该节点。
 * 3. 只有当两者都测通（或明确被拒）时 -> 存入缓存，以后秒开。
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  
  // --- 配置 ---
  const concurrency = parseInt($arguments.concurrency || 10) 
  const requestTimeout = parseInt($arguments.timeout || 5000) 
  const GLOBAL_TIMEOUT = 28000 // 熔断时间
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  const gptUrl = `https://chatgpt.com`
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=AIzaSyD-InvalidKeyForDetection`

  const cache = scriptResourceCache
  const useCache = $arguments.cache !== 'false'
  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
  const startTime = Date.now()

  const tasks = []

  // --- 1. 读缓存 ---
  for (const proxy of proxies) {
      const fingerprint = getFingerprint(proxy)
      // 升级 Key 到 v9，清除旧逻辑的缓存
      const cacheKey = `ai_check_v9:${fingerprint}`
      
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
              if (Date.now() - startTime > GLOBAL_TIMEOUT) return

              const node = ProxyUtils.produce([task.proxy], target)
              if (node) {
                  const res = await performNetworkCheck(node, requestTimeout)
                  
                  // !!! 核心修改 v9 !!!
                  // 只有当 fully_checked 为 true (即两个服务都有响应，没一个是超时的)
                  // 才写入缓存。否则下次继续重测。
                  if (useCache && res.fully_checked) {
                      cache.set(task.cacheKey, res)
                  }

                  // 即使不缓存，这次也要先改名显示给用户看
                  applyPrefix(task.proxy, res)
              }
          }),
          { concurrency }
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
          if (!proxy.name.includes(geminiPrefix) && !proxy.name.includes(gptPrefix)) {
              proxy.name = prefix + proxy.name
          }
      }
  }

  async function performNetworkCheck(node, timeout) {
      let isGptOk = false
      let isGeminiOk = false
      
      // 记录具体的 HTTP 状态码，用于判断是否超时
      let gptStatus = 0
      let geminiStatus = 0

      const checkGPT = async () => {
        try {
            const res = await http({
                method: 'get', url: gptUrl,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
                },
                node, timeout
            })
            gptStatus = parseInt(res.status ?? res.statusCode ?? 0)
            const body = res.body ?? res.rawBody ?? ""
            
            // 宽松判定逻辑
            if ([200, 302, 429].includes(gptStatus)) isGptOk = true
            else if (gptStatus === 403 && !/unsupported_country|VPN|location/i.test(body)) isGptOk = true
        } catch (e) {
            gptStatus = 0 // 异常视为 0 (超时/连接中断)
        }
      }

      const checkGemini = async () => {
        try {
            const res = await http({
                method: 'get', url: geminiUrl,
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
                node, timeout
            })
            geminiStatus = parseInt(res.status ?? res.statusCode ?? 0)
            if (geminiStatus === 400) isGeminiOk = true
        } catch (e) {
            geminiStatus = 0
        }
      }

      await Promise.all([checkGPT(), checkGemini()])
      
      // 核心判定：是否两个都拿到了状态码？
      // 只要状态码 > 0，说明连通了（不管是 200 还是 403 还是 500，至少不是 timeout）
      const fullyChecked = (gptStatus > 0) && (geminiStatus > 0)
      
      return { gpt: isGptOk, gemini: isGeminiOk, fully_checked: fullyChecked }
  }

  function getFingerprint(proxy) {
      return JSON.stringify(Object.fromEntries(Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))))
  }

  async function http(opt = {}) {
    return await $.http.get({ ...opt, timeout: parseFloat(opt.timeout || 5000) })
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
