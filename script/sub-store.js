/**
 * GPT & Gemini 双重检测 (v13.0 网页实战版)
 * 
 * 针对性修复:
 * 1. Gemini 策略大改: 放弃 API 检测，改为直接访问 https://gemini.google.com
 *    - 解决 API 能通但网页版 (gemini.google.com) 报 403 或重定向到 available-regions 的问题。
 *    - 解决 ERR_CONNECTION_CLOSED (SNI 阻断) 导致的误判。
 * 2. 判定逻辑: 
 *    - 跳转到 "登录页" -> 成功。
 *    - 跳转到 "不支持地区页" -> 失败。
 * 3. 缓存逻辑: 保持 v12 的双重响应机制，防止网络波动导致结果中毒。
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  
  // --- 用户配置 ---
  const concurrency = parseInt($arguments.concurrency || 10) 
  const requestTimeout = parseInt($arguments.timeout || 6000) // 网页版加载慢，增加超时
  const GLOBAL_TIMEOUT = 28000 
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  // [核心变更] Gemini 改为检测网页版
  const gptUrl = `https://chatgpt.com`
  const geminiUrl = `https://gemini.google.com`

  // 模拟 macOS Chrome，带上完整的头部，防止被直接断开
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
      // 升级 Key 到 v13 (因为 Gemini 逻辑变了，必须重测)
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
                  const res = await performNetworkCheck(node, requestTimeout)
                  
                  // 只有当两个检测都有明确结果(非超时)时才缓存
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
          
          const cleanName = escaped.length
            ? proxy.name.replace(new RegExp(`^(?:${escaped.join('|')}|\\s)+`, 'g'), '')
            : proxy.name
            
          proxy.name = prefix + cleanName
      }
  }

  async function performNetworkCheck(node, timeout) {
      let isGptOk = false
      let isGeminiOk = false
      
      // 状态标记：0=超时/中断, >0=有响应
      let gptStatus = 0
      let geminiStatus = 0

      // --- GPT 检测 (保持 v12 逻辑) ---
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
                if (!/(unsupported_country|region not supported|vpn|proxy)/i.test(body)) {
                    isGptOk = true
                }
            }
        } catch (e) {
            gptStatus = 0 
        }
      }

      // --- Gemini 检测 (v13 网页模拟) ---
      const checkGemini = async () => {
        try {
            const res = await http({
                method: 'get', 
                url: geminiUrl, // 访问 gemini.google.com
                headers: { 
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache'
                },
                node, timeout
            })
            geminiStatus = parseInt(res.status ?? res.statusCode ?? 0)
            const body = (res.body ?? res.rawBody ?? "") + ""
            
            // 逻辑分析:
            // 1. 如果节点可用: Google 会重定向到 accounts.google.com 让你登录。
            //    Sub-Store 可能会自动跟随重定向，所以最终状态可能是 200，且 Body 里有 "Sign in" 或 "Google 账号"。
            // 2. 如果节点被封(Region Block): Google 会重定向到 ai.google.dev/.../available-regions。
            //    最终状态也是 200，但 Body 里有 "available regions" 或 "not supported"。
            // 3. 如果节点被断开(Connection Closed): 抛出异常，进入 catch。

            if (geminiStatus === 200) {
                if (/accounts\.google\.com|Sign in|登录|Google/i.test(body) && !/available-regions|not supported/i.test(body)) {
                    isGeminiOk = true
                } else if (/available-regions|not supported/i.test(body)) {
                    isGeminiOk = false
                } else {
                    // 兜底：如果没出现明显的拒绝词，认为是通的 (可能是已登录状态等)
                    isGeminiOk = true
                }
            } else if ([301, 302].includes(geminiStatus)) {
                // 如果没有自动跟随重定向，检查 Location
                const location = res.headers?.Location || res.headers?.location || ""
                if (location.includes('accounts.google.com')) {
                    isGeminiOk = true
                }
            } else if (geminiStatus === 403) {
                isGeminiOk = false
            }

        } catch (e) {
            // 这里捕获 ERR_CONNECTION_CLOSED 等错误
            // 状态码保持 0，意味着 "检测未完成/超时"，不缓存，等待下次重测
            // 除非你确定 Connection Closed 就是被墙了，可以手动设为 status = 503
            // 但为了保险，我们视为网络错误，不缓存。
            geminiStatus = 0
        }
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
    return await $.http.get({ ...opt, timeout: parseFloat(opt.timeout || 6000) })
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
