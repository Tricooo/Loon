/**
 * GPT & Gemini 双重检测 (保守修复版)
 *
 * 逻辑说明:
 * 1. GPT: 恢复使用原作的检测逻辑 (ios.chat.openai.com + 403判定)，确保恢复你之前的效果。
 * 2. Gemini: 增加 Google API (400判定) 检测。
 * 3. 两者独立运行，互不影响。
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  
  // --- 参数设置 ---
  const concurrency = parseInt($arguments.concurrency || 10)
  const timeout = parseInt($arguments.timeout || 5000)
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] '
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] '
  
  // 强制指定 GPT 检测地址 (使用原脚本逻辑)
  const gptUrl = `https://ios.chat.openai.com`
  // Gemini API 地址
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=AIzaSyD-InvalidKeyForDetection`

  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  return proxies

  async function check(proxy) {
    try {
      const node = ProxyUtils.produce([proxy], target)
      if (!node) return

      // 初始化状态
      let isGptOk = false
      let isGeminiOk = false
      let gptLatency = 0
      let geminiLatency = 0

      // --- 定义检测任务 ---

      // 1. GPT 任务 (完全复刻原脚本逻辑)
      const checkGPT = async () => {
        try {
            const start = Date.now()
            const res = await http({
                method: 'get',
                url: gptUrl,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
                },
                node,
                timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 200)
            let body = String(res.body ?? res.rawBody)
            const msg = body // 简单记录
            
            // 原脚本的核心判定逻辑
            if (status === 403 && !/unsupported_country/.test(body)) {
                isGptOk = true
                gptLatency = Date.now() - start
            }
        } catch (e) {
            // GPT 检测出错，视为失败，不影响后续
            // $.error(`[${proxy.name}] GPT Error: ${e.message}`)
        }
      }

      // 2. Gemini 任务 (新增)
      const checkGemini = async () => {
        try {
            const start = Date.now()
            const res = await http({
                method: 'get', // Gemini API必须用GET
                url: geminiUrl,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                node,
                timeout
            })
            const status = parseInt(res.status ?? res.statusCode ?? 200)
            // Google API 返回 400 说明连通了但Key不对 -> 成功
            if (status === 400) {
                isGeminiOk = true
                geminiLatency = Date.now() - start
            }
        } catch (e) {
            // Gemini 检测出错
        }
      }

      // --- 并行执行两个任务 ---
      // 使用 Promise.allSettled 的变体逻辑，确保一个崩了不影响另一个
      await Promise.all([checkGPT(), checkGemini()])

      // --- 改名逻辑 ---
      let prefix = ""
      
      if (isGeminiOk) {
        prefix += geminiPrefix
        proxy._gemini = true
        proxy._gemini_latency = geminiLatency
      }

      if (isGptOk) {
        prefix += gptPrefix
        proxy._gpt = true
        proxy._gpt_latency = gptLatency
      }

      if (prefix) {
          proxy.name = prefix + proxy.name
          // $.info(`[${proxy.name}] 检测完成`)
      }

    } catch (e) {
      // 兜底错误
      $.error(`[${proxy.name}] Critical Error: ${e.message}`)
    }
  }

  // 复用原脚本的 HTTP 方法，增强兼容性
  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || 5000)
    const RETRIES = 1 // 减少重试，加快速度
    const RETRY_DELAY = 1000

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          await $.wait(RETRY_DELAY)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
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
