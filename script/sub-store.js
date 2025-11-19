/**
 * AI 服务全能检测 (适配 Surge/Loon 版)
 *
 * * 警告：此脚本运行时间较长，并发过高可能导致 Surge 卡顿
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge } = $.env
  if (!isLoon && !isSurge) throw new Error('仅支持 Loon 和 Surge(ability=http-client-policy)')
  
  const cacheEnabled = $arguments.cache
  const concurrency = parseInt($arguments.concurrency || 5) // 默认并发降低为 5，避免同时测3个网站导致卡死
  const cache = scriptResourceCache

  // 定义检测目标
  const TARGETS = [
    {
      key: 'gpt',
      tag: '[GPT]',
      url: 'https://ios.chat.openai.com', // 使用 iOS API 端点
      // 逻辑：403 且不是 unsupported_country 通常意味着连通但未登录
      check: (status, body, msg) => status === 403 && !/unsupported_country/.test(msg)
    },
    {
      key: 'gem',
      tag: '[Gem]',
      url: 'https://gemini.google.com',
      // 逻辑：Gemini 通常返回 200 或 302 跳转登录
      check: (status, body, msg) => status === 200 || status === 302 || status === 307
    }
  ];

  await executeAsyncTasks(
    proxies.map(proxy => () => checkAll(proxy)),
    { concurrency }
  )

  return proxies

  // 对单个节点进行所有目标的检测
  async function checkAll(proxy) {
    const targetPlatformName = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
    
    // 生成 Surge/Loon 可识别的代理配置
    let node;
    try {
        node = ProxyUtils.produce([proxy], targetPlatformName);
    } catch(e) {
        $.error(`[${proxy.name}] 配置转换失败`);
        return;
    }

    if (!node) return;

    // 遍历所有目标进行检测
    for (const target of TARGETS) {
      await checkSingle(proxy, node, target);
    }
  }

  // 单个检测逻辑
  async function checkSingle(proxy, node, targetConfig) {
    const id = cacheEnabled
      ? `${targetConfig.key}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined

    // 检查缓存
    if (cacheEnabled && id) {
      const cached = cache.get(id);
      if (cached && cached.success) {
         appendTag(proxy, targetConfig.tag);
         $.info(`[${proxy.name}] ${targetConfig.key} 使用缓存: 通`);
         return;
      }
    }

    try {
      const startedAt = Date.now();
      const res = await http({
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url: targetConfig.url,
        'policy-descriptor': node, // 关键：委托 Surge 连接
        node,
      });

      const status = parseInt(res.status ?? res.statusCode ?? 0);
      let body = String(res.body ?? res.rawBody ?? '');
      let msg = body; // 简化 msg 处理
      try {
        const jsonBody = JSON.parse(body);
        msg = jsonBody?.error?.code || jsonBody?.error?.error_type || jsonBody?.cf_details || '';
      } catch (e) {}

      // 判断是否通过
      const isSuccess = targetConfig.check(status, body, msg);
      const latency = Date.now() - startedAt;

      if (isSuccess) {
        appendTag(proxy, targetConfig.tag);
        $.info(`[${proxy.name}] ${targetConfig.key} 检测通过 (延迟: ${latency}ms)`);
        
        if (cacheEnabled) {
            cache.set(id, { success: true, latency: latency });
        }
      } else {
        // $.info(`[${proxy.name}] ${targetConfig.key} 失败 Status: ${status}`);
        if (cacheEnabled) { // 即使失败也缓存一段时间，避免重复检测死节点
            cache.set(id, { success: false }); 
        }
      }

    } catch (e) {
      // $.error(`[${proxy.name}] ${targetConfig.key} 出错: ${e.message}`);
    }
  }

  // 辅助：添加标签 (避免重复)
  function appendTag(proxy, tag) {
    if (!proxy.name.includes(tag)) {
      proxy.name = `${proxy.name} ${tag}`;
    }
  }

  // HTTP 请求封装 (保持原逻辑)
  async function http(opt = {}) {
    const TIMEOUT = 5000; // 5秒超时
    const RETRIES = 1;    // 重试1次
    const RETRY_DELAY = 1000;

    let count = 0
    const fn = async () => {
      try {
        return await $.http.get({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          await $.wait(RETRY_DELAY * count)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  // 并发执行器 (保持原逻辑)
  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        let index = 0
        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const currentTask = tasks[index++]
            running++
            currentTask().finally(() => {
              running--
              executeNextTask()
            })
          }
          if (running === 0 && index >= tasks.length) {
            resolve()
          }
        }
        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}    
