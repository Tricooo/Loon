/**
 * GPT & Gemini 双重检测 (v10.0 统一模拟版)
 * 
 * 核心升级:
 * 1. URL 统一: 废弃 ios/macos 分支，统一使用 https://chatgpt.com
 * 2. 伪装升级: 统一模拟 macOS Chrome 浏览器头，这是目前通过 CF 盾概率最高的方式。
 * 3. 逻辑保持: 继承 v9 的 "双重响应才缓存" 逻辑，确保不误判超时节点。
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  
  // --- 配置 ---
  const concurrency = parseInt($arguments.concurrency || 10) 
  const requestTimeout = parseInt($arguments.timeout || 5000) 
  const GLOBAL_TIMEOUT = 28000 
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  // 统一使用官方主域，不再使用旧的 ios 二级域名
  const gptUrl = `https://chatgpt.com`
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=InvalidKey`

  // 统一的 User-Agent (macOS Chrome 120)，模拟真实用户访问
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

  const cache = scriptResourceCache
  const useCache = $arguments.cache !== 'false'
  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
  const startTime = Date.now()

  const tasks = []

  // --- 1. 读缓存 ---
  for (const proxy of proxies) {
      const fingerprint = getFingerprint(proxy)
      // 升级 Key 到 v10 (因为策略变了，需要刷新缓存)
      const cacheKey = `ai_check_v10:${fingerprint}`
      
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
                  
                  // 只有当两个服务都完成了握手（无论成功失败，只要不是超时）才缓存
                  if (useCache && res.fully_checked) {
                      cache.set(task.cacheKey, res)
                  }

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
          // 清理可能存在的旧前缀，防止重复
          const cleanName = proxy.name.replace(gptPrefix, '').replace(geminiPrefix, '')
          proxy.name = prefix + cleanName
      }
  }

  async function performNetworkCheck(node, timeout) {
      let isGptOk = false
      let isGeminiOk = false
      let gptStatus = 0
      let geminiStatus = 0

      // GPT 检测 (统一标准)
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
            const body = res.body ?? res.rawBody ?? ""
            
            // 判定逻辑:
            // 200: 登录页 (成功)
            // 302: 跳转 (成功)
            // 429: 请求过快 (成功)
            // 403: 需要进一步判断
            if ([200, 302, 429].includes(gptStatus)) isGptOk = true
            else if (gptStatus === 403) {
                // 只有明确写了 unsupported_country 或 VPN 才是真的不行
                if (!/unsupported_country|VPN/i.test(body)) {
                    isGptOk = true
                }
            }
        } catch (e) {
            gptStatus = 0
        }
      }

      // Gemini 检测 (API标准)
      const checkGemini = async () => {
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

      await Promise.all([checkGPT(), checkGemini()])
      
      // 只有当两个服务都有响应(状态码>0)时，才标记为 fully_checked
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
            if (Date.now() - startTime > GLOBAL_TIMEOUT) {
              index = tasks.length // 停止调度新任务，避免触发新的网络请求
              break
            }
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
