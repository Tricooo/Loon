/**
 * GPT & Gemini 双重检测 (v8.0 严格缓存版)
 * 
 * 修复 "后面的节点没有前缀且不再检测" 的问题:
 * 1. 缓存策略升级: 只有当服务器真正返回了数据(无论是成功还是拒绝)才缓存。
 * 2. 超时/错误处理: 网络超时或连接中断 **不写入缓存**。
 *    这意味着：如果第一次有些节点因为网络卡顿没测出来，第二次刷新时脚本会自动重测它们，直到测出来为止。
 * 3. 自动清理旧缓存 (Key升级到 v8)
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  
  // --- 配置 ---
  const concurrency = parseInt($arguments.concurrency || 10) 
  // 适当增加超时时间，保证检测准确率
  const requestTimeout = parseInt($arguments.timeout || 5000) 
  // 全局最大运行时间 (ms)，保留一点余量防止SubStore报错
  const GLOBAL_TIMEOUT = 25000 
  
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  const gptUrl = `https://chatgpt.com`
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=AIzaSyD-InvalidKeyForDetection`

  const cache = scriptResourceCache
  const useCache = $arguments.cache !== 'false'
  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
  const startTime = Date.now()

  // 待检测列表
  const tasks = []

  // --- 1. 缓存读取阶段 ---
  for (const proxy of proxies) {
      const fingerprint = getFingerprint(proxy)
      // 升级 Key 到 v8，强制废弃之前的错误缓存
      const cacheKey = `ai_check_v8:${fingerprint}`
      
      let result = undefined
      if (useCache) {
          result = cache.get(cacheKey)
      }

      if (result) {
          // 命中有效缓存，直接改名
          applyPrefix(proxy, result)
      } else {
          // 未命中，或者之前没测成功，加入重测队列
          tasks.push({ proxy, cacheKey })
      }
  }

  // --- 2. 补漏检测阶段 ---
  if (tasks.length > 0) {
      await executeAsyncTasks(
          tasks.map(task => async () => {
              // 熔断保护：如果时间快到了，停止发起新请求，把机会留给下一次刷新
              if (Date.now() - startTime > GLOBAL_TIMEOUT) return

              const node = ProxyUtils.produce([task.proxy], target)
              if (node) {
                  // 执行网络检测
                  const res = await performNetworkCheck(node, requestTimeout)
                  
                  // !!! 核心修复：只有当 valid=true (即收到了服务器响应) 时才缓存
                  // 如果是超时(valid=false)，则不缓存，下次刷新继续测
                  if (useCache && res.valid) {
                      cache.set(task.cacheKey, res)
                  }

                  // 只要有结果（哪怕是失败的响应），就尝试改名
                  if (res.valid) {
                      applyPrefix(task.proxy, res)
                  }
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
      // Gemini
      if (result.gemini) {
          prefix += geminiPrefix
          proxy._gemini = true
      }
      // GPT
      if (result.gpt) {
          prefix += gptPrefix
          proxy._gpt = true
      }
      
      // 避免前缀重复堆叠
      if (prefix) {
          // 清理旧前缀(如果存在)再添加，或者简单判断
          if (!proxy.name.includes(geminiPrefix) && !proxy.name.includes(gptPrefix)) {
              proxy.name = prefix + proxy.name
          }
      }
  }

  async function performNetworkCheck(node, timeout) {
      let isGptOk = false
      let isGeminiOk = false
      let isValidResponse = false // 标记是否收到了有效的网络响应

      // GPT 检测
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
            const status = parseInt(res.status ?? res.statusCode ?? 0)
            const body = res.body ?? res.rawBody ?? ""
            
            // 只要有状态码，说明连通了 (Valid)
            if (status > 0) isValidResponse = true

            // 判定逻辑
            if ([200, 302, 429].includes(status)) isGptOk = true
            else if (status === 403 && !/unsupported_country|VPN|location/i.test(body)) isGptOk = true
        } catch (e) {
            // 超时或连接错误，isValidResponse 保持 false
        }
      }

      // Gemini 检测
      const checkGemini = async () => {
        try {
            const res = await http({
                method: 'get', url: geminiUrl,
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
                node, timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 0)
            
            // 只要有状态码，说明连通了
            if (status > 0) isValidResponse = true
            
            if (status === 400) isGeminiOk = true
        } catch (e) {}
      }

      await Promise.all([checkGPT(), checkGemini()])
      
      // 返回结构：valid 表示这次检测是否有效（是否应该被缓存）
      return { gpt: isGptOk, gemini: isGeminiOk, valid: isValidResponse }
  }

  function getFingerprint(proxy) {
      // 仅使用配置字段生成指纹，忽略名字变化
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
